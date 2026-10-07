// Stored rich text (20 §20.13) → pdfmake content, following the PDF layout rules of plan 70 §70.3.
import type { DocJSON } from "../content/types.ts";
import { cropOrNull } from "../crop.ts";
import type { Border, CellBorders, Crop, DrawingShape as Shape, ListMarker, MarkJSON as Mark, ParagraphBorders, PMNode, TableBorders } from "../schemaTypes.ts";
import { FontSplitter, TEXT_FAMILY } from "./fonts.ts";
import { CARLITO_LINE_FACTOR, faceOf, spaceWidth, textWidth } from "./metrics.ts";
import { drawingSvg } from "./svg.ts";
import { borderVisible as visible, cellSide, placeCells, TAB_STOP_PT as TAB_STOP, TEXTBOX_INSET_X_PT as BOX_INSET_X, TEXTBOX_INSET_Y_PT as BOX_INSET_Y, underlineKind, type PlacedCell } from "../wordFormat.ts";
import { imageKey, type Content, type ImageData, type ImageVariant } from "./types.ts";
import { SITE_URL } from "../site.ts";

/** Internal `#/` links in a PDF point at the published route under the site's address. */
export { SITE_URL };

/** Shared conversion state for one PDF. */
export interface RichEnv {
  fonts: FontSplitter;
  images: ImageData;
  /** Keys of the images the definition references. */
  used: Set<string>;
  /** A `page_break` was seen and the next top-level node starts a new page. */
  pendingBreak: boolean;
}

interface Ctx {
  env: RichEnv;
  basePt: number;
  /** Width available to the content, pt. */
  width: number;
  /** In the page's block flow (not inside a table, text box or drawing): page breaks apply. */
  flow: boolean;
}

const attr = <T>(n: { attrs?: Record<string, unknown> }, key: string, dflt: T): T => (n.attrs?.[key] as T | undefined) ?? dflt;
const hex = (h: string): string => `#${h}`;

// ---------------------------------------------------------------------------------------------
// Inline text

interface RunStyle {
  size: number;
  bold: boolean;
  italic: boolean;
  caps: boolean;
  smallCaps: boolean;
  props: Content;
}

export function resolveHref(href: string): string {
  return href.startsWith("#/") ? `${SITE_URL}${href}` : href;
}

function runStyle(marks: readonly Mark[], basePt: number): RunStyle {
  const s: RunStyle = { size: basePt, bold: false, italic: false, caps: false, smallCaps: false, props: {} };
  const decoration: string[] = [];
  let decorationStyle: string | undefined;
  let highlight: string | undefined;
  let shade: string | undefined;
  for (const m of marks) {
    switch (m.type) {
      case "bold": s.bold = true; break;
      case "italic": s.italic = true; break;
      case "underline": {
        decoration.push("underline");
        // pdfmake's default decoration is the solid line.
        const kind = underlineKind(m.attrs.style);
        if (kind !== "solid") decorationStyle = kind;
        break;
      }
      case "strike":
        decoration.push("lineThrough");
        if (m.attrs.double && decorationStyle === undefined) decorationStyle = "double";
        break;
      case "vertAlign": s.props[m.attrs.value] = true; break;
      case "caps": s.caps = true; break;
      case "smallCaps": s.smallCaps = true; break;
      case "size": s.size = m.attrs.pt; break;
      case "color": s.props.color = hex(m.attrs.hex); break;
      case "highlight": highlight = m.attrs.hex; break;
      case "shade": shade = m.attrs.hex; break;
      case "link": s.props.link = resolveHref(m.attrs.href); break;
      // `font` names the symbol font a code point was typed in; the font map chooses the PDF font.
      case "font": break;
    }
  }
  if (decoration.length > 0) s.props.decoration = decoration.length === 1 ? decoration[0] : decoration;
  if (decorationStyle) s.props.decorationStyle = decorationStyle;
  const background = highlight ?? shade;
  if (background) s.props.background = hex(background);
  return s;
}

/** Builds a paragraph's inline segments, expanding tabs against estimated line positions. */
class InlineWriter {
  readonly out: Content[] = [];
  /** Estimated x of the pen from the text margin, pt. */
  private x: number;
  private readonly lineStart: number;
  private readonly ctx: Ctx;

  constructor(ctx: Ctx, firstLineX: number, laterLineX: number) {
    this.ctx = ctx;
    this.x = firstLineX;
    this.lineStart = laterLineX;
  }

  text(raw: string, marks: readonly Mark[]): void {
    const style = runStyle(marks, this.ctx.basePt);
    const face = faceOf(style.bold, style.italic);
    let text = "";
    for (const ch of raw) {
      if (ch === "\t") {
        const next = (Math.floor(this.x / TAB_STOP + 1e-6) + 1) * TAB_STOP;
        const space = spaceWidth(style.size, face);
        const count = Math.max(1, Math.round((next - this.x) / space));
        text += " ".repeat(count);
        this.x += count * space;
      } else if (ch === "\n") {
        text += ch;
        this.x = this.lineStart;
      } else {
        text += ch;
        this.x += textWidth(ch, style.size, face);
      }
    }
    if (style.caps) text = text.toUpperCase();
    if (style.smallCaps) {
      for (const part of text.match(/\p{Ll}+|[^\p{Ll}]+/gu) ?? []) {
        const lower = /^\p{Ll}/u.test(part);
        this.emit(lower ? part.toUpperCase() : part, style, lower ? style.size * 0.8 : style.size);
      }
    } else {
      this.emit(text, style, style.size);
    }
  }

  private emit(text: string, style: RunStyle, size: number): void {
    for (const seg of this.ctx.env.fonts.split(text)) {
      const isText = seg.family === TEXT_FAMILY;
      // Symbol fonts have a Regular face only (70 §70.4).
      this.out.push({ text: seg.text, font: seg.family, bold: isText && style.bold, italics: isText && style.italic, fontSize: size, ...style.props });
    }
  }

  /** The segments so far, or one space so that an empty line keeps its height. */
  take(): Content[] {
    const taken = this.out.splice(0, this.out.length);
    return taken.length > 0 ? taken : [{ text: " ", font: TEXT_FAMILY, bold: false, italics: false, fontSize: this.ctx.basePt }];
  }
}

// ---------------------------------------------------------------------------------------------
// Blocks

function lineHeight(node: PMNode, basePt: number): number | undefined {
  const line = attr<{ rule: string; value: number } | null>(node, "line", null);
  if (!line) return undefined;
  if (line.rule === "auto") return line.value;
  const factor = line.value / (basePt * CARLITO_LINE_FACTOR);
  return line.rule === "atLeast" ? Math.max(1, factor) : factor;
}

/** Applies a pending page break to a top-level node. */
function placed(ctx: Ctx, node: Content): Content {
  if (ctx.flow && ctx.env.pendingBreak) {
    ctx.env.pendingBreak = false;
    return { ...node, pageBreak: "before" };
  }
  return node;
}

function paragraph(node: PMNode, ctx: Ctx): Content[] {
  const indLeft = attr(node, "indLeft", 0);
  const indRight = attr(node, "indRight", 0);
  const indFirst = attr(node, "indFirst", 0);
  const spaceBefore = attr(node, "spaceBefore", 0);
  const spaceAfter = attr(node, "spaceAfter", 0);
  const align = attr(node, "align", "left");
  const shade = attr<string | null>(node, "shade", null);
  const borders = attr<ParagraphBorders | null>(node, "borders", null);
  const marker = attr<ListMarker | null>(node, "marker", null);
  const lh = lineHeight(node, ctx.basePt);
  const textWidthAvail = Math.max(1, ctx.width - indLeft - indRight - (marker ? indFirst + marker.tabPt : 0));
  const markerX = indLeft + indFirst;
  const writer = marker ? new InlineWriter(ctx, markerX + marker.tabPt, markerX + marker.tabPt) : new InlineWriter(ctx, indLeft + indFirst, indLeft);

  // A paragraph is cut at its pictures (pdfmake has no inline images) and at page breaks.
  const parts: { node: Content; breakBefore: boolean }[] = [];
  let breakNext = false;
  const flushText = (): void => {
    if (writer.out.length === 0) return;
    parts.push({ node: { text: writer.take() }, breakBefore: breakNext });
    breakNext = false;
  };
  for (const child of node.content ?? []) {
    if (child.type === "text") writer.text(child.text ?? "", child.marks ?? []);
    else if (child.type === "hard_break") writer.text("\n", []);
    else if (child.type === "page_break") {
      flushText();
      if (ctx.flow) breakNext = true;
    } else if (child.type === "image") {
      flushText();
      parts.push({ node: { ...image(child, { ...ctx, width: textWidthAvail }), alignment: align }, breakBefore: breakNext });
      breakNext = false;
    }
  }
  flushText();
  if (parts.length === 0) parts.push({ node: { text: writer.take() }, breakBefore: false });
  // A break with nothing after it in this paragraph starts the next block on a new page.
  const carry = breakNext;

  const out: Content[] = parts.map((p, i) => {
    const first = i === 0;
    const last = i === parts.length - 1;
    const isText = "text" in p.node;
    let n: Content = { ...p.node };
    if (isText) {
      n.alignment = align;
      n.preserveLeadingSpaces = true;
      if (lh !== undefined) n.lineHeight = lh;
    }
    if (marker && first && isText) {
      const markerWriter = new InlineWriter({ ...ctx }, markerX, markerX);
      markerWriter.text(marker.text, marker.marks);
      n = { columns: [{ width: marker.tabPt, text: markerWriter.take(), preserveLeadingSpaces: true, ...(lh !== undefined ? { lineHeight: lh } : {}) }, { width: "*", ...n }], columnGap: 0 };
    } else if (isText && first && indFirst !== 0 && !marker) {
      n.leadingIndent = indFirst;
    }
    const left = marker ? markerX : indLeft;
    const margin: [number, number, number, number] = [left, first ? spaceBefore : 0, indRight, last ? spaceAfter : 0];
    if (shade || (borders && Object.values(borders).some(visible))) {
      n = boxed(n, shade, borders, ctx.width - left - indRight);
    }
    n.margin = margin;
    if (p.breakBefore) n.pageBreak = "before";
    return n;
  });
  out[0] = placed(ctx, out[0] as Content);
  if (carry) ctx.env.pendingBreak = true;
  return out;
}

/** A paragraph with shading or borders, drawn as a one-cell table. */
function boxed(inner: Content, shade: string | null, borders: ParagraphBorders | null, width: number): Content {
  const side = (k: "left" | "top" | "right" | "bottom"): Border | null => {
    const b = borders?.[k];
    return visible(b) ? b : null;
  };
  const sides = [side("left"), side("top"), side("right"), side("bottom")];
  const cell: Content = { stack: [inner], border: sides.map((b) => b !== null), borderColor: sides.map((b) => (b ? hex(b.color) : "#000000")) };
  if (shade) cell.fillColor = hex(shade);
  const lw = (b: Border | null): number => b?.widthPt ?? 0;
  return {
    table: { widths: [Math.max(1, width - lw(sides[0] ?? null) - lw(sides[2] ?? null))], body: [[cell]] },
    layout: {
      defaultBorder: false,
      hLineWidth: (i: number) => lw((i === 0 ? sides[1] : sides[3]) ?? null),
      vLineWidth: (i: number) => lw((i === 0 ? sides[0] : sides[2]) ?? null),
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
  };
}

function variantOf(n: PMNode): ImageVariant {
  const v: ImageVariant = { asset: attr(n, "asset", ""), rot: attr(n, "rot", 0), flipH: attr(n, "flipH", false), flipV: attr(n, "flipV", false) };
  const crop = cropOrNull(attr<Crop | null>(n, "crop", null));
  return crop ? { ...v, crop } : v;
}

function useImage(env: RichEnv, v: ImageVariant): string {
  const key = imageKey(v);
  if (env.images[key] === undefined) throw new Error(`PDF: no image data for ${v.asset} (rot ${v.rot}, flipH ${v.flipH}, flipV ${v.flipV})`);
  env.used.add(key);
  return key;
}

/** An image at its stored extent (rotated box when turned 90°/270°), scaled down to fit. */
function image(n: PMNode, ctx: Ctx): Content & { width: number; height: number } {
  const v = variantOf(n);
  const turned = v.rot % 180 !== 0;
  let width = turned ? attr(n, "heightPt", 0) : attr(n, "widthPt", 0);
  let height = turned ? attr(n, "widthPt", 0) : attr(n, "heightPt", 0);
  if (width > ctx.width && width > 0) {
    height = (height * ctx.width) / width;
    width = ctx.width;
  }
  return { image: useImage(ctx.env, v), width, height };
}

function textbox(n: PMNode, ctx: Ctx): Content & { width: number } {
  const width = Math.min(attr(n, "widthPt", ctx.width), ctx.width);
  const border = attr<Border | null>(n, "border", null);
  const fill = attr<string | null>(n, "fill", null);
  const bw = visible(border) ? border.widthPt : 0;
  const inner = Math.max(1, width - 2 * BOX_INSET_X - 2 * bw);
  const cell: Content = { stack: blocks(n.content ?? [], { ...ctx, width: inner, flow: false }), border: [true, true, true, true].map(() => bw > 0), borderColor: Array(4).fill(visible(border) ? hex(border.color) : "#000000") };
  if (fill) cell.fillColor = hex(fill);
  return {
    width,
    table: { widths: [inner], body: [[cell]] },
    layout: {
      defaultBorder: false,
      hLineWidth: () => bw,
      vLineWidth: () => bw,
      paddingLeft: () => BOX_INSET_X,
      paddingRight: () => BOX_INSET_X,
      paddingTop: () => BOX_INSET_Y,
      paddingBottom: () => BOX_INSET_Y,
    },
  };
}

function drawing(n: PMNode, ctx: Ctx): Content & { width: number } {
  const w = attr(n, "widthPt", 0) || 1;
  const h = attr(n, "heightPt", 0) || 1;
  const scale = Math.min(1, ctx.width / w);
  const shapes = attr<Shape[]>(n, "shapes", []);
  const svg = drawingSvg(w, h, shapes, (asset) => ctx.env.images[useImage(ctx.env, { asset, rot: 0, flipH: false, flipV: false })]);
  const stack: Content[] = [{ svg, width: w * scale, height: h * scale }];
  for (const t of n.content ?? []) {
    if (t.type !== "drawing_text") continue;
    const tw = attr(t, "w", 0) * scale;
    const border = attr<Border | null>(t, "border", null);
    const fill = attr<string | null>(t, "fill", null);
    const bw = visible(border) ? border.widthPt : 0;
    const cell: Content = { stack: blocks(t.content ?? [], { ...ctx, width: Math.max(1, tw - 2 * bw), flow: false }), border: Array(4).fill(bw > 0), borderColor: Array(4).fill(visible(border) ? hex(border.color) : "#000000") };
    if (fill) cell.fillColor = hex(fill);
    stack.push({
      relativePosition: { x: attr(t, "x", 0) * scale, y: (attr(t, "y", 0) - h) * scale },
      table: { widths: [Math.max(1, tw - 2 * bw)], body: [[cell]] },
      layout: { defaultBorder: false, hLineWidth: () => bw, vLineWidth: () => bw, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0 },
    });
  }
  return { stack, width: w * scale };
}

function anchored(n: PMNode, ctx: Ctx): Content {
  const child = n.content?.[0];
  if (!child) return { text: "" };
  let node: Content & { width: number };
  if (child.type === "image_block") node = image(child, ctx);
  else if (child.type === "textbox") node = textbox(child, ctx);
  else node = drawing(child, ctx);
  const offset = Math.max(0, Math.min(attr(n, "offsetPt", 0), ctx.width - node.width));
  return placed(ctx, { ...node, margin: [offset, 0, 0, 0] });
}

function rule(n: PMNode, ctx: Ctx): Content {
  const w = attr(n, "widthPt", 0.75);
  return placed(ctx, { canvas: [{ type: "line", x1: 0, y1: w / 2, x2: ctx.width, y2: w / 2, lineWidth: w, lineColor: hex(attr(n, "color", "000000")) }] });
}

// ---------------------------------------------------------------------------------------------
// Tables

function table(n: PMNode, ctx: Ctx): Content {
  const rows = n.content ?? [];
  const tb = attr<Partial<TableBorders>>(n, "borders", {});
  const m = attr<{ top: number; right: number; bottom: number; left: number }>(n, "cellMarginPt", { top: 0, right: 5.4, bottom: 0, left: 5.4 });
  const indent = attr(n, "indentPt", 0);
  const { cells, columns: placedCols } = placeCells(rows);
  const grid = attr<number[]>(n, "grid", []);
  const columns = Math.max(grid.length, placedCols, 1);
  const gridFull = Array.from({ length: columns }, (_, i) => grid[i] ?? grid.at(-1) ?? TAB_STOP);
  const nrows = rows.length;

  const sideOf = (p: PlacedCell<PMNode>, side: "left" | "top" | "right" | "bottom"): Border | null => {
    const onEdge = side === "left" ? p.col === 0 : side === "right" ? p.col + p.colspan >= columns : side === "top" ? p.row === 0 : p.row + p.rowspan >= nrows;
    const b = cellSide(tb, attr<CellBorders | null>(p.node, "borders", null), side, onEdge);
    return visible(b) ? b : null;
  };
  const hW: number[] = Array(nrows + 1).fill(0);
  const vW: number[] = Array(columns + 1).fill(0);
  const sides = cells.map((p) => {
    const s = { left: sideOf(p, "left"), top: sideOf(p, "top"), right: sideOf(p, "right"), bottom: sideOf(p, "bottom") };
    const w = (b: Border | null): number => b?.widthPt ?? 0;
    hW[p.row] = Math.max(hW[p.row] ?? 0, w(s.top));
    hW[p.row + p.rowspan] = Math.max(hW[p.row + p.rowspan] ?? 0, w(s.bottom));
    vW[p.col] = Math.max(vW[p.col] ?? 0, w(s.left));
    vW[p.col + p.colspan] = Math.max(vW[p.col + p.colspan] ?? 0, w(s.right));
    return s;
  });

  // Her grid in pt, scaled by one factor when wider than the space (70 §70.3).
  const avail = Math.max(1, ctx.width - indent);
  const sum = gridFull.reduce((a, b) => a + b, 0);
  const scale = sum > avail ? avail / sum : 1;
  const widths = gridFull.map((g, i) => Math.max(1, g * scale - m.left - m.right - (vW[i] ?? 0) - (i === columns - 1 ? (vW[columns] ?? 0) : 0)));

  const body: Content[][] = Array.from({ length: nrows }, () => Array.from({ length: columns }, () => ({ text: "" })));
  cells.forEach((p, i) => {
    let inner = 0;
    for (let c = p.col; c < p.col + p.colspan; c++) inner += widths[c] ?? 0;
    inner += (p.colspan - 1) * (m.left + m.right);
    for (let c = p.col + 1; c < p.col + p.colspan; c++) inner += vW[c] ?? 0;
    const s = sides[i] as { left: Border | null; top: Border | null; right: Border | null; bottom: Border | null };
    const order = [s.left, s.top, s.right, s.bottom];
    const cell: Content = {
      stack: blocks(p.node.content ?? [], { ...ctx, width: inner, flow: false }),
      border: order.map((b) => b !== null),
      borderColor: order.map((b) => (b ? hex(b.color) : "#000000")),
    };
    if (p.colspan > 1) cell.colSpan = p.colspan;
    if (p.rowspan > 1) cell.rowSpan = p.rowspan;
    const fill = attr<string | null>(p.node, "fill", null);
    if (fill) cell.fillColor = hex(fill);
    const vAlign = attr<string>(p.node, "vAlign", "top");
    if (vAlign === "center") cell.verticalAlignment = "middle";
    else if (vAlign === "bottom") cell.verticalAlignment = "bottom";
    (body[p.row] as Content[])[p.col] = cell;
  });

  const headerRows = rows.findIndex((r) => !attr(r, "repeatHeader", false));
  const leading = headerRows === -1 ? nrows : headerRows;
  const minHeights = rows.map((r) => attr<number | null>(r, "minHeightPt", null) ?? 0);
  const spec: Content = { widths, body };
  if (leading > 0 && leading < nrows) spec.headerRows = leading;
  if (nrows > 0 && rows.every((r) => attr(r, "cantSplit", false))) spec.dontBreakRows = true;
  if (minHeights.some((h) => h > 0)) spec.heights = (i: number) => minHeights[i] || "auto";
  return placed(ctx, {
    table: spec,
    margin: [indent, 0, 0, 0],
    layout: {
      defaultBorder: false,
      hLineWidth: (i: number) => hW[i] ?? 0,
      vLineWidth: (i: number) => vW[i] ?? 0,
      paddingLeft: () => m.left,
      paddingRight: () => m.right,
      paddingTop: () => m.top,
      paddingBottom: () => m.bottom,
    },
  });
}

// ---------------------------------------------------------------------------------------------

function blocks(nodes: readonly PMNode[], ctx: Ctx): Content[] {
  const out: Content[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "paragraph":
      case "heading_line":
        out.push(...paragraph(node, ctx));
        break;
      case "table": out.push(table(node, ctx)); break;
      case "anchored": out.push(anchored(node, ctx)); break;
      case "textbox": out.push(placed(ctx, textbox(node, ctx))); break;
      case "drawing": out.push(placed(ctx, drawing(node, ctx))); break;
      case "rule": out.push(rule(node, ctx)); break;
      case "image_block": out.push(placed(ctx, image(node, ctx))); break;
      case "slide_card": out.push(...blocks(node.content ?? [], ctx)); break;
      default: break;
    }
  }
  return out;
}

/** One stored doc as top-level PDF content. */
export function docContent(doc: DocJSON, basePt: number, width: number, env: RichEnv): Content[] {
  return blocks((doc.content ?? []) as PMNode[], { env, basePt, width, flow: true });
}

/** Every image variant a doc references: pictures, and drawing pictures (unrotated, the SVG turns them). */
export function imagesOf(doc: DocJSON, out: Map<string, ImageVariant>): void {
  const walk = (n: PMNode): void => {
    if ((n.type === "image" || n.type === "image_block") && typeof n.attrs?.asset === "string") {
      const v = variantOf(n);
      out.set(imageKey(v), v);
    }
    if (n.type === "drawing") {
      for (const s of attr<Shape[]>(n, "shapes", [])) {
        if (s.asset) {
          const v = { asset: s.asset, rot: 0, flipH: false, flipV: false };
          out.set(imageKey(v), v);
        }
      }
    }
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc as PMNode);
}
