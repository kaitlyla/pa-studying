// Pure style computations for stored rich text (plan 40 §40.6). The React renderer and the editor's
// node views (OB9) both use these, so a page looks the same in edit mode.
//
// Scale: the reading root font size represents the document's `basePt`, and every pt length L
// renders as L / basePt em, so her proportions hold on every screen.
import type { CSSProperties } from "react";
import { FONT_FAMILIES } from "../../lib/fonts.ts";
import type { Border, CellBorders, CellMargins, ImageAttrs, MarkJSON, ParagraphAttrs, TableBorders, TextboxAttrs } from "../../lib/schemaTypes.ts";
import { borderVisible, cellSide, TAB_STOP_PT, TEXTBOX_INSET_X_PT, TEXTBOX_INSET_Y_PT, underlineKind, type UnderlineKind } from "../../lib/wordFormat.ts";

export type { Border, MarkJSON, ParagraphAttrs, TableBorders } from "../../lib/schemaTypes.ts";

/** `pt` as an em length relative to `basePt`. */
export function em(pt: number, basePt: number): string {
  const v = Math.round((pt / basePt) * 10000) / 10000;
  return `${v}em`;
}

const hexColor = (hex: string): string => `#${hex}`;

/** Word border style (ST_Border, or a drawing's solid/dash/dot) of a visible border → CSS border-style. */
export function cssBorderStyle(style: string): string {
  const s = style.toLowerCase();
  if (s.startsWith("double") || s.startsWith("triple")) return "double";
  if (s.includes("dash")) return "dashed";
  if (s.includes("dot")) return "dotted";
  if (s === "inset" || s === "outset") return s;
  return "solid";
}

/** A border as a CSS shorthand; `none` for null. */
export function borderCss(b: Border | null | undefined, basePt: number): string {
  if (!borderVisible(b)) return "none";
  return `${em(b.widthPt, basePt)} ${cssBorderStyle(b.style)} ${hexColor(b.color)}`;
}

function sideStyles(sides: CellBorders | null | undefined, basePt: number): CSSProperties {
  if (!sides) return {};
  const out: CSSProperties = {};
  if ("top" in sides) out.borderTop = borderCss(sides.top, basePt);
  if ("right" in sides) out.borderRight = borderCss(sides.right, basePt);
  if ("bottom" in sides) out.borderBottom = borderCss(sides.bottom, basePt);
  if ("left" in sides) out.borderLeft = borderCss(sides.left, basePt);
  return out;
}

export function paragraphStyle(a: Partial<ParagraphAttrs>, basePt: number): CSSProperties {
  const s: CSSProperties = {
    marginLeft: em(a.indLeft ?? 0, basePt),
    marginRight: em(a.indRight ?? 0, basePt),
    textIndent: em(a.indFirst ?? 0, basePt),
    marginTop: em(a.spaceBefore ?? 0, basePt),
    marginBottom: em(a.spaceAfter ?? 0, basePt),
    textAlign: a.align ?? "left",
    whiteSpace: "pre-wrap",
    tabSize: em(TAB_STOP_PT, basePt),
    ...sideStyles(a.borders, basePt),
  };
  if (a.line) s.lineHeight = a.line.rule === "auto" ? String(a.line.value) : em(a.line.value, basePt);
  if (a.shade) s.background = hexColor(a.shade);
  return s;
}

/** The leading marker span of a list paragraph: an inline-block of width `tabPt`. */
export function markerStyle(tabPt: number, basePt: number, font: string | null): CSSProperties {
  const s: CSSProperties = { display: "inline-block", width: em(tabPt, basePt), textIndent: 0, whiteSpace: "pre" };
  if (font) s.fontFamily = fontStack(font);
  return s;
}

/** The site's text font stack (Carlito plus the 70 §70.4 symbol fallbacks). */
export const TEXT_STACK = [...FONT_FAMILIES.map((f) => `"${f}"`), "sans-serif"].join(", ");

export function fontStack(family: string): string {
  return `"${family.replace(/"/g, "")}", ${TEXT_STACK}`;
}

/** Word underline style → CSS text-decoration-style (the shared reading, lib/wordFormat.ts). */
export function underlineStyle(style: string): UnderlineKind {
  return underlineKind(style);
}

/**
 * The combined inline style of the style-only marks of a text run: caps, smallCaps, size, color,
 * highlight, shade and font. Highlight sits on top of shade, so it wins when both are present.
 */
export function runStyle(marks: readonly MarkJSON[], basePt: number): CSSProperties | null {
  const s: CSSProperties = {};
  let any = false;
  let highlight: string | null = null;
  let shade: string | null = null;
  for (const m of marks) {
    switch (m.type) {
      case "caps":
        s.textTransform = "uppercase";
        break;
      case "smallCaps":
        s.fontVariant = "small-caps";
        break;
      case "size":
        s.fontSize = em(m.attrs.pt, basePt);
        break;
      case "color":
        s.color = hexColor(m.attrs.hex);
        break;
      case "highlight":
        highlight = m.attrs.hex;
        break;
      case "shade":
        shade = m.attrs.hex;
        break;
      case "font":
        s.fontFamily = fontStack(m.attrs.family);
        break;
      default:
        continue;
    }
    any = true;
  }
  const bg = highlight ?? shade;
  if (bg) s.backgroundColor = hexColor(bg);
  return any ? s : null;
}

/**
 * Column widths as percentages of the grid sum. A first column under 11% is set to 11% and the
 * others are scaled down proportionally (guide-reader/table-spacing).
 */
export function tableColumns(grid: readonly number[]): number[] {
  const sum = grid.reduce((a, b) => a + b, 0);
  if (grid.length === 0) return [];
  if (sum <= 0) return grid.map(() => 100 / grid.length);
  const pct = grid.map((g) => (100 * g) / sum);
  const first = pct[0] ?? 0;
  if (grid.length > 1 && first < 11) {
    const rest = 100 - first;
    return pct.map((p, i) => (i === 0 ? 11 : rest > 0 ? (p * 89) / rest : 89 / (grid.length - 1)));
  }
  return pct;
}

export interface CellAttrs {
  fill?: string | null;
  vAlign?: "top" | "center" | "bottom";
  borders?: CellBorders | null;
}

/** Where a cell sits in its table, for picking the table's outer or inside default borders. */
export interface CellEdges {
  top: boolean;
  right: boolean;
  bottom: boolean;
  left: boolean;
}

/**
 * A table's left offset on screen. Word measures a table's indent from the text margin, and her tables
 * reach left into the page margin (a negative indent); the screen has no page margin beside the reading
 * column, and the table's horizontal scroll box clips anything left of its edge, so a negative indent
 * starts the table at the column's edge.
 */
export function tableIndent(indentPt: number, basePt: number): string {
  return em(Math.max(0, indentPt), basePt);
}

/** Word's default table cell margins (pt): what the screen's reading padding of a cell stands for. */
export const WORD_CELL_MARGINS: CellMargins = { top: 0, right: 5.4, bottom: 0, left: 5.4 };
/** The screen's reading padding of a cell with Word's default margins (px). */
const READING_PAD_Y_PX = 7;
const READING_PAD_X_PX = 10;

/**
 * A cell's padding on screen: the reading padding, grown or shrunk by how far the table's margins are
 * from Word's default, so a table she never changed looks as it always has and her changes show.
 */
export function cellPadding(m: CellMargins, basePt: number): string {
  const side = (px: number, pt: number, dflt: number): string => {
    const d = pt - dflt;
    return d === 0 ? `${px}px` : `max(0px, calc(${px}px + ${em(d, basePt)}))`;
  };
  return [
    side(READING_PAD_Y_PX, m.top, WORD_CELL_MARGINS.top),
    side(READING_PAD_X_PX, m.right, WORD_CELL_MARGINS.right),
    side(READING_PAD_Y_PX, m.bottom, WORD_CELL_MARGINS.bottom),
    side(READING_PAD_X_PX, m.left, WORD_CELL_MARGINS.left),
  ].join(" ");
}

export function cellStyle(a: CellAttrs, basePt: number, table: TableBorders | null, edges: CellEdges, margins: CellMargins = WORD_CELL_MARGINS): CSSProperties {
  const s: CSSProperties = { verticalAlign: a.vAlign === "center" ? "middle" : (a.vAlign ?? "top"), padding: cellPadding(margins, basePt) };
  if (a.fill) s.background = hexColor(a.fill);
  if (table) {
    s.borderTop = borderCss(cellSide(table, a.borders, "top", edges.top), basePt);
    s.borderBottom = borderCss(cellSide(table, a.borders, "bottom", edges.bottom), basePt);
    s.borderLeft = borderCss(cellSide(table, a.borders, "left", edges.left), basePt);
    s.borderRight = borderCss(cellSide(table, a.borders, "right", edges.right), basePt);
    return s;
  }
  return { ...s, ...sideStyles(a.borders, basePt) };
}

/** CSS transform for a picture's rotation and flips, or undefined. */
export function imageTransform(a: Partial<Pick<ImageAttrs, "rot" | "flipH" | "flipV">>): string | undefined {
  const parts: string[] = [];
  if (a.rot) parts.push(`rotate(${a.rot}deg)`);
  if (a.flipH) parts.push("scaleX(-1)");
  if (a.flipV) parts.push("scaleY(-1)");
  return parts.length ? parts.join(" ") : undefined;
}

export function imageStyle(a: Pick<ImageAttrs, "widthPt" | "heightPt"> & Partial<ImageAttrs>, basePt: number): CSSProperties {
  const s: CSSProperties = {
    width: em(a.widthPt, basePt),
    maxWidth: "100%",
    height: "auto",
    aspectRatio: a.heightPt > 0 ? `${a.widthPt} / ${a.heightPt}` : undefined,
  };
  const t = imageTransform(a);
  if (t) s.transform = t;
  return s;
}

/** A text box with Word's default insets. */
export function textboxStyle(a: TextboxAttrs, basePt: number): CSSProperties {
  const s: CSSProperties = {
    width: em(a.widthPt, basePt),
    maxWidth: "100%",
    border: borderCss(a.border, basePt),
    padding: `${em(TEXTBOX_INSET_Y_PT, basePt)} ${em(TEXTBOX_INSET_X_PT, basePt)}`,
    display: a.inline ? "inline-block" : "block",
    verticalAlign: a.inline ? "top" : undefined,
  };
  if (a.fill) s.background = hexColor(a.fill);
  return s;
}

/** The offset of an anchored child: `min(offset, container − child width)`. */
export function anchoredOffset(offsetPt: number, childWidthPt: number, basePt: number): string {
  return `min(${em(offsetPt, basePt)}, calc(100% - ${em(childWidthPt, basePt)}))`;
}

export function ruleStyle(color: string, widthPt: number, basePt: number): CSSProperties {
  return { border: 0, borderTop: `${em(widthPt, basePt)} solid ${hexColor(color)}`, margin: `${em(4, basePt)} 0` };
}
