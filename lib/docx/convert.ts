// Word → ProseMirror conversion (30 §30.3–§30.9). Walks w:body in document order, flattening styles
// onto nodes and marks, and returns the top-level elements the importer turns into blocks (§30.8).
import type { Shape } from "../drawing.ts";
import { isPreset } from "../drawing.ts";
import { isAllowedHref, schema, storedJSON } from "../schema.ts";
import { newId } from "../content/ids.ts";
import type { DocJSON, PageSetup } from "../content/types.ts";
import type { Theme } from "./drawingml.ts";
import { readTheme, shapeFill, shapeOutline } from "./drawingml.ts";
import { cropImage, imageExt } from "./images.ts";
import type { MarkerResult } from "./numbering.ts";
import { Numbering, formatNumber } from "./numbering.ts";
import type { Part, WordPackage } from "./package.ts";
import { openPackage } from "./package.ts";
import type {
  Border, ImageAttrs, ListMarker, MarkJSON, ParagraphAttrs, PMNode, TableAttrs, TableCellAttrs, TableRowAttrs,
} from "../schemaTypes.ts";
import { isMark, isNode } from "../schemaTypes.ts";
import type { Formats, ParaProps, RunProps } from "./styles.ts";
import { Styles, merge, mergeFormats, mergeTable, readPPr, readRPr, readTblPr, readTcPr } from "./styles.ts";
import { isSymbolCode, isSymbolFont, mapSymbol, symbolCode } from "./symbols.ts";
import type { Element } from "./xml.ts";
import {
  CHOICE_PREFIXES, INK_URI, NS, attr, child, children, cssLengthPt, descendant, descendants, emuToPt, hexColor, is,
  kids, numAttr, parseStyle, truthy, twipsToPt, wAttr, wNum,
} from "./xml.ts";

/** ProseMirror node JSON. */
export type J = PMNode;

export interface ReportEntry {
  kind: string;
  [k: string]: unknown;
}

export interface TopElement {
  table: boolean;
  /** NFC paragraph text of a top-level paragraph; "" for tables. */
  text: string;
  /** The element's node, followed by any anchored or floating blocks placed after it. */
  nodes: J[];
}

export interface ConvertOptions {
  /** Stores image bytes; returns the bare asset file name (`<32 hex>.<ext>`). */
  storeAsset(bytes: Uint8Array, ext: string): Promise<string>;
}

export interface ConvertedDoc {
  page: PageSetup;
  basePt: number;
  body: TopElement[];
  report: ReportEntry[];
}

/** Word's built-in run size when nothing sets w:sz. */
const DEFAULT_SIZE = 10;
const ANCHOR_REL = new Set(["column", "character", "margin", "leftMargin", "insideMargin"]);
const SKIP_NOTE_TYPES = new Set(["separator", "continuationSeparator", "continuationNotice"]);

interface Field {
  result: boolean;
}

interface Ctx {
  pkg: WordPackage;
  part: Part;
  styles: Styles;
  numbering: Numbering;
  theme: Theme;
  opts: ConvertOptions;
  report: ReportEntry[];
  sizes: Map<number, number>;
  fields: Field[];
  /** Formats from the enclosing table's style for the current cell, or null outside tables. */
  table: Formats | null;
  notes: { footnote: NoteState; endnote: NoteState };
  /** The number shown by w:footnoteRef/w:endnoteRef inside the note being converted. */
  currentNote: string | null;
  assetCache: Map<string, Promise<string | null>>;
}

interface NoteState {
  fmt: string;
  next: number;
  numbers: Map<string, string>;
}

interface Inline {
  nodes: J[];
  after: J[];
  text: string;
}

// ---------------------------------------------------------------------------------------------
// Marks

function marksOf(p: RunProps, href: string | null): MarkJSON[] {
  const marks: MarkJSON[] = [];
  if (href) marks.push({ type: "link", attrs: { href } });
  if (p.bold) marks.push({ type: "bold" });
  if (p.italic) marks.push({ type: "italic" });
  if (p.underline && p.underline !== "none") marks.push({ type: "underline", attrs: { style: p.underline } });
  if (p.dstrike) marks.push({ type: "strike", attrs: { double: true } });
  else if (p.strike) marks.push({ type: "strike", attrs: { double: false } });
  if (p.vertAlign === "sup" || p.vertAlign === "sub") marks.push({ type: "vertAlign", attrs: { value: p.vertAlign } });
  if (p.caps) marks.push({ type: "caps" });
  if (p.smallCaps) marks.push({ type: "smallCaps" });
  marks.push({ type: "size", attrs: { pt: p.sizePt ?? DEFAULT_SIZE } });
  if (p.color) marks.push({ type: "color", attrs: { hex: p.color } });
  if (p.highlight) marks.push({ type: "highlight", attrs: { hex: p.highlight } });
  if (p.shade) marks.push({ type: "shade", attrs: { hex: p.shade } });
  return marks;
}

function countSize(ctx: Ctx, p: RunProps, chars: number): void {
  const s = p.sizePt ?? DEFAULT_SIZE;
  ctx.sizes.set(s, (ctx.sizes.get(s) ?? 0) + chars);
}

// ---------------------------------------------------------------------------------------------
// Text and symbols (§30.5)

function textNodes(ctx: Ctx, raw: string, p: RunProps, href: string | null, out: Inline): void {
  const text = raw.normalize("NFC");
  if (!text) return;
  const marks = marksOf(p, href);
  countSize(ctx, p, text.length);
  if (!isSymbolFont(p.font) && !isSymbolFont(p.fontH)) {
    out.nodes.push({ type: "text", text, marks });
    out.text += text;
    return;
  }
  for (const ch of text) {
    const font = charFont(p, ch);
    if (/\s/.test(ch) || !isSymbolCode(ch) || !isSymbolFont(font)) {
      out.nodes.push({ type: "text", text: ch, marks });
      out.text += ch;
    } else {
      symbolNode(ctx, font, ch, marks, out);
    }
  }
}

/** The font Word draws a character with: w:ascii below U+0080, w:hAnsi (else w:ascii) above. */
function charFont(p: RunProps, ch: string): string {
  return ((ch.codePointAt(0) ?? 0) < 0x80 ? p.font : (p.fontH ?? p.font)) ?? "";
}

function symbolNode(ctx: Ctx, font: string, ch: string, marks: MarkJSON[], out: Inline): void {
  const mapped = mapSymbol(font, ch);
  if (mapped !== null) {
    out.nodes.push({ type: "text", text: mapped, marks });
    out.text += mapped;
    return;
  }
  ctx.report.push({ kind: "unmappedSymbol", font, code: symbolCode(ch).toString(16).toUpperCase().padStart(4, "0") });
  out.nodes.push({ type: "text", text: ch, marks: [...marks, { type: "font", attrs: { family: font } }] });
  out.text += ch;
}

// ---------------------------------------------------------------------------------------------
// Pictures (§30.9)

async function storePicture(ctx: Ctx, part: Part, relId: string | null, srcRect: Element | null): Promise<string | null> {
  if (!relId) return null;
  const rel = part.rels.get(relId);
  if (!rel || rel.external) {
    ctx.report.push({ kind: "linkedPicture", target: rel?.target ?? relId });
    return null;
  }
  const crop = ["l", "t", "r", "b"].map((k) => Math.max(0, numAttr(srcRect, k) ?? 0));
  const key = `${rel.target}|${crop.join(",")}`;
  let p = ctx.assetCache.get(key);
  if (!p) {
    p = (async () => {
      const bytes = ctx.pkg.files[rel.target];
      const ext = imageExt(rel.target);
      if (!bytes || !ext) {
        ctx.report.push({ kind: "unsupportedImage", target: rel.target });
        return null;
      }
      if (crop.every((v) => v === 0)) return ctx.opts.storeAsset(bytes, ext);
      const cropped = await cropImage(bytes, ext, crop as [number, number, number, number]);
      return ctx.opts.storeAsset(cropped.bytes, cropped.ext);
    })();
    ctx.assetCache.set(key, p);
  }
  return p;
}

const QUARTER_TURNS = [0, 90, 180, 270] as const;

/** Snaps a rotation in degrees to the nearest quarter turn in [0, 360). */
function snapDeg(deg: number): ImageAttrs["rot"] {
  return QUARTER_TURNS[((Math.round(deg / 90) % 4) + 4) % 4]!;
}

interface PicFields {
  asset: string;
  rot: ImageAttrs["rot"];
  flipH: boolean;
  flipV: boolean;
}

/** Stores a pic:pic's (cropped) image and reads its rotation and flips; null when the image cannot be stored. */
async function picFields(ctx: Ctx, picEl: Element): Promise<PicFields | null> {
  const blipFill = child(picEl, NS.pic, "blipFill");
  const blip = descendant(blipFill, NS.a, "blip");
  const asset = await storePicture(ctx, ctx.part, blip?.getAttributeNS(NS.r, "embed") || null, descendant(blipFill, NS.a, "srcRect"));
  if (!asset) return null;
  const xfrm = child(child(picEl, NS.pic, "spPr"), NS.a, "xfrm");
  return {
    asset,
    rot: snapDeg((numAttr(xfrm, "rot") ?? 0) / 60000),
    flipH: truthy(attr(xfrm, "flipH")),
    flipV: truthy(attr(xfrm, "flipV")),
  };
}

async function pictureAttrs(ctx: Ctx, picEl: Element, cx: number, cy: number): Promise<ImageAttrs | null> {
  const pic = await picFields(ctx, picEl);
  if (!pic) return null;
  return { asset: pic.asset, widthPt: emuToPt(cx), heightPt: emuToPt(cy), rot: pic.rot, flipH: pic.flipH, flipV: pic.flipV };
}

// ---------------------------------------------------------------------------------------------
// Shapes, text boxes and groups (§30.9)

async function storyBlocks(ctx: Ctx, container: Element): Promise<J[]> {
  const els = await blockElements(ctx, container);
  const nodes = els.flatMap((e) => e.nodes);
  return nodes.length ? nodes : [emptyParagraph()];
}

function emptyParagraph(): J {
  const attrs: ParagraphAttrs = {
    indLeft: 0, indRight: 0, indFirst: 0, spaceBefore: 0, spaceAfter: 0,
    line: null, align: alignOf(undefined), shade: null, borders: null, marker: null,
  };
  return { type: "paragraph", attrs };
}

async function textbox(ctx: Ctx, wsp: Element, widthPt: number, inline: boolean): Promise<J> {
  const spPr = child(wsp, NS.wps, "spPr");
  const style = child(wsp, NS.wps, "style");
  const content = child(child(wsp, NS.wps, "txbx"), NS.w, "txbxContent")!;
  return {
    type: "textbox",
    attrs: {
      widthPt,
      fill: shapeFill(spPr, style, ctx.theme),
      border: shapeOutline(spPr, style, ctx.theme).border,
      inline,
    },
    content: await storyBlocks(ctx, content),
  };
}

function geomOf(ctx: Ctx, spPr: Element | null): string {
  const prst = attr(child(spPr, NS.a, "prstGeom"), "prst");
  if (prst && isPreset(prst)) return prst;
  ctx.report.push({ kind: "approxGeometry", geom: prst ?? "custom" });
  return "rect";
}

interface Xform {
  /** Maps a child-space point (EMU) to pt in the drawing's space. */
  x(v: number): number;
  y(v: number): number;
  sx: number;
  sy: number;
}

function childXform(parent: Xform, grpXfrm: Element | null): Xform {
  const off = child(grpXfrm, NS.a, "off");
  const ext = child(grpXfrm, NS.a, "ext");
  const chOff = child(grpXfrm, NS.a, "chOff");
  const chExt = child(grpXfrm, NS.a, "chExt");
  const ox = numAttr(off, "x") ?? 0;
  const oy = numAttr(off, "y") ?? 0;
  const cox = numAttr(chOff, "x") ?? 0;
  const coy = numAttr(chOff, "y") ?? 0;
  const kx = (numAttr(ext, "cx") ?? 1) / (numAttr(chExt, "cx") || numAttr(ext, "cx") || 1);
  const ky = (numAttr(ext, "cy") ?? 1) / (numAttr(chExt, "cy") || numAttr(ext, "cy") || 1);
  return {
    x: (v) => parent.x(ox + (v - cox) * kx),
    y: (v) => parent.y(oy + (v - coy) * ky),
    sx: parent.sx * kx,
    sy: parent.sy * ky,
  };
}

interface DrawingParts {
  shapes: Shape[];
  texts: J[];
}

function shapeBox(xf: Xform, xfrm: Element | null): { x: number; y: number; w: number; h: number } {
  const off = child(xfrm, NS.a, "off");
  const ext = child(xfrm, NS.a, "ext");
  return {
    x: xf.x(numAttr(off, "x") ?? 0),
    y: xf.y(numAttr(off, "y") ?? 0),
    w: emuToPt((numAttr(ext, "cx") ?? 0) * xf.sx),
    h: emuToPt((numAttr(ext, "cy") ?? 0) * xf.sy),
  };
}

async function groupMembers(ctx: Ctx, grp: Element, xf: Xform, out: DrawingParts): Promise<void> {
  for (const k of kids(grp)) {
    if (is(k, NS.wps, "wsp")) {
      const spPr = child(k, NS.wps, "spPr");
      const style = child(k, NS.wps, "style");
      const xfrm = child(spPr, NS.a, "xfrm");
      const box = shapeBox(xf, xfrm);
      const content = child(child(k, NS.wps, "txbx"), NS.w, "txbxContent");
      if (content) {
        out.texts.push({
          type: "drawing_text",
          attrs: { ...box, fill: shapeFill(spPr, style, ctx.theme), border: shapeOutline(spPr, style, ctx.theme).border },
          content: await storyBlocks(ctx, content),
        });
      } else {
        out.shapes.push(shapeEntry(ctx, spPr, style, box, null));
      }
    } else if (is(k, NS.pic, "pic")) {
      const pic = await picFields(ctx, k);
      if (!pic) continue;
      const box = shapeBox(xf, child(child(k, NS.pic, "spPr"), NS.a, "xfrm"));
      out.shapes.push({
        geom: "picture", ...box, rot: pic.rot, flipH: pic.flipH, flipV: pic.flipV,
        stroke: null, fill: null, head: null, tail: null, asset: pic.asset,
      });
    } else if (is(k, NS.wpg, "grpSp")) {
      await groupMembers(ctx, k, childXform(xf, child(child(k, NS.wpg, "grpSpPr"), NS.a, "xfrm")), out);
    }
  }
}

function shapeEntry(ctx: Ctx, spPr: Element | null, style: Element | null, box: { x: number; y: number; w: number; h: number }, asset: string | null): Shape {
  const xfrm = child(spPr, NS.a, "xfrm");
  const outline = shapeOutline(spPr, style, ctx.theme);
  return {
    geom: geomOf(ctx, spPr),
    ...box,
    rot: (numAttr(xfrm, "rot") ?? 0) / 60000,
    flipH: truthy(attr(xfrm, "flipH")),
    flipV: truthy(attr(xfrm, "flipV")),
    stroke: outline.border ? { color: outline.border.color, widthPt: outline.border.widthPt, dash: outline.border.style } : null,
    fill: shapeFill(spPr, style, ctx.theme),
    head: outline.head,
    tail: outline.tail,
    asset,
  };
}

/** One wp:inline or wp:anchor. Returns an inline image node, or a block to place after the paragraph. */
async function drawingObject(ctx: Ctx, d: Element): Promise<{ inline?: J; block?: J }> {
  const inline = is(d, NS.wp, "inline");
  const extent = child(d, NS.wp, "extent");
  const cx = numAttr(extent, "cx") ?? 0;
  const cy = numAttr(extent, "cy") ?? 0;
  const data = child(child(d, NS.a, "graphic"), NS.a, "graphicData");
  const uri = attr(data, "uri") ?? "";
  const wrap = (node: J): { inline?: J; block?: J } => {
    if (inline) return { block: node };
    const posH = child(d, NS.wp, "positionH");
    const rel = attr(posH, "relativeFrom") ?? "";
    const off = child(posH, NS.wp, "posOffset");
    const offsetPt = off && ANCHOR_REL.has(rel) ? emuToPt(Number(off.textContent ?? 0)) : 0;
    return { block: { type: "anchored", attrs: { offsetPt }, content: [node] } };
  };

  const pic = child(data, NS.pic, "pic");
  if (pic) {
    const attrs = await pictureAttrs(ctx, pic, cx, cy);
    if (!attrs) return {};
    return inline ? { inline: { type: "image", attrs } } : wrap({ type: "image_block", attrs });
  }
  const wsp = child(data, NS.wps, "wsp");
  if (wsp) {
    if (child(child(wsp, NS.wps, "txbx"), NS.w, "txbxContent")) return wrap(await textbox(ctx, wsp, emuToPt(cx), inline));
    const spPr = child(wsp, NS.wps, "spPr");
    const shape = shapeEntry(ctx, spPr, child(wsp, NS.wps, "style"), { x: 0, y: 0, w: emuToPt(cx), h: emuToPt(cy) }, null);
    return wrap({ type: "drawing", attrs: { widthPt: emuToPt(cx), heightPt: emuToPt(cy), shapes: [shape] } });
  }
  const grp = child(data, NS.wpg, "wgp") ?? descendant(data, NS.wpg, "wgp");
  if (grp) {
    const parts: DrawingParts = { shapes: [], texts: [] };
    const gx = child(child(grp, NS.wpg, "grpSpPr"), NS.a, "xfrm");
    const ext = child(gx, NS.a, "ext");
    const off = child(gx, NS.a, "off");
    // The group's frame (off/ext) maps onto the drawing extent, with its top-left at (0, 0).
    const sx = cx / (numAttr(ext, "cx") || cx || 1);
    const sy = cy / (numAttr(ext, "cy") || cy || 1);
    const ox = numAttr(off, "x") ?? 0;
    const oy = numAttr(off, "y") ?? 0;
    const frame: Xform = { x: (v) => emuToPt((v - ox) * sx), y: (v) => emuToPt((v - oy) * sy), sx, sy };
    await groupMembers(ctx, grp, childXform(frame, gx), parts);
    return wrap({ type: "drawing", attrs: { widthPt: emuToPt(cx), heightPt: emuToPt(cy), shapes: parts.shapes }, content: parts.texts });
  }
  ctx.report.push({ kind: "unsupportedGraphic", uri });
  return {};
}

// VML (w:pict, w:object) outside a Fallback.
async function vml(ctx: Ctx, container: Element, out: Inline): Promise<void> {
  for (const k of kids(container)) {
    if (k.namespaceURI !== NS.v) continue;
    if (k.localName === "shapetype") continue;
    if (k.localName === "group") {
      await vml(ctx, k, out);
      continue;
    }
    const style = parseStyle(attr(k, "style"));
    const width = cssLengthPt(style.width) ?? 0;
    const height = cssLengthPt(style.height) ?? 0;
    if (truthy(k.getAttributeNS(NS.o, "hr"))) {
      const m = /#?([0-9a-fA-F]{6})/.exec(attr(k, "fillcolor") ?? "");
      out.after.push({ type: "rule", attrs: { color: m ? m[1]!.toUpperCase() : "A0A0A0", widthPt: height } });
      continue;
    }
    const absolute = style.position === "absolute";
    const place = (node: J): void => {
      out.after.push(absolute ? { type: "anchored", attrs: { offsetPt: cssLengthPt(style["margin-left"]) ?? 0 }, content: [node] } : node);
    };
    const tb = child(child(k, NS.v, "textbox"), NS.w, "txbxContent");
    if (tb) {
      const fill = attr(k, "filled") === "f" ? null : hexColor(/#?([0-9a-fA-F]{6})/.exec(attr(k, "fillcolor") ?? "")?.[1]);
      const stroked = attr(k, "stroked") !== "f";
      const border: Border | null = stroked
        ? { style: "solid", widthPt: cssLengthPt(attr(k, "strokeweight") ?? "0.75pt") ?? 0.75, color: hexColor(/#?([0-9a-fA-F]{6})/.exec(attr(k, "strokecolor") ?? "")?.[1]) ?? "000000" }
        : null;
      place({ type: "textbox", attrs: { widthPt: width, fill, border, inline: !absolute }, content: await storyBlocks(ctx, tb) });
      continue;
    }
    const img = child(k, NS.v, "imagedata");
    if (img) {
      const asset = await storePicture(ctx, ctx.part, img.getAttributeNS(NS.r, "id") || null, null);
      if (!asset) continue;
      const flip = style.flip ?? "";
      const attrs = {
        asset, widthPt: width, heightPt: height,
        rot: snapDeg(Number(style.rotation ?? 0) || 0),
        flipH: flip.includes("x"), flipV: flip.includes("y"),
      };
      if (absolute) place({ type: "image_block", attrs });
      else out.nodes.push({ type: "image", attrs });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// mc:AlternateContent (§30.3)

export function chooseAlternate(ac: Element): Element[] {
  const choice = child(ac, NS.mc, "Choice");
  const fallback = child(ac, NS.mc, "Fallback");
  if (choice) {
    const req = (attr(choice, "Requires") ?? "").split(/\s+/).filter(Boolean);
    const ink = descendants(choice, NS.a, "graphicData").some((g) => attr(g, "uri") === INK_URI);
    if (!ink && req.every((p) => CHOICE_PREFIXES.has(p))) return kids(choice);
  }
  return fallback ? kids(fallback) : [];
}

// ---------------------------------------------------------------------------------------------
// Runs and inline content (§30.3, §30.5)

function runProps(ctx: Ctx, styleR: RunProps, rPr: Element | null): RunProps {
  const direct = readRPr(rPr);
  return merge<RunProps>(ctx.styles.docR, ctx.table?.r, styleR, ctx.styles.character(direct.rStyle), direct);
}

function visible(ctx: Ctx): boolean {
  return ctx.fields.every((f) => f.result);
}

function noteRef(ctx: Ctx, kind: "footnote" | "endnote", el: Element, p: RunProps, href: string | null, out: Inline): void {
  if (truthy(wAttr(el, "customMarkFollows"))) return;
  const state = ctx.notes[kind];
  const id = wAttr(el, "id") ?? "";
  let n = state.numbers.get(id);
  if (n === undefined) {
    n = formatNumber(state.next++, state.fmt);
    state.numbers.set(id, n);
  }
  textNodes(ctx, n, { ...p, vertAlign: "sup" }, href, out);
}

async function runContent(ctx: Ctx, items: Element[], p: RunProps, href: string | null, out: Inline): Promise<void> {
  for (const c of items) {
    if (c.namespaceURI === NS.mc && c.localName === "AlternateContent") {
      await runContent(ctx, chooseAlternate(c), p, href, out);
      continue;
    }
    if (c.namespaceURI === NS.w16se && c.localName === "symEx") {
      const code = parseInt(c.getAttributeNS(NS.w16se, "char") ?? "", 16);
      if (visible(ctx) && Number.isFinite(code)) textNodes(ctx, String.fromCodePoint(code), p, href, out);
      continue;
    }
    if (c.namespaceURI !== NS.w) continue;
    if (c.localName === "fldChar") {
      const t = wAttr(c, "fldCharType");
      if (t === "begin") ctx.fields.push({ result: false });
      else if (t === "separate") { const f = ctx.fields[ctx.fields.length - 1]; if (f) f.result = true; }
      else if (t === "end") ctx.fields.pop();
      continue;
    }
    if (!visible(ctx)) continue;
    switch (c.localName) {
      case "t":
        textNodes(ctx, c.textContent ?? "", p, href, out);
        break;
      case "tab": case "ptab":
        textNodes(ctx, "\t", p, href, out);
        break;
      case "br":
        if (wAttr(c, "type") === "page") out.nodes.push({ type: "page_break" });
        else { out.nodes.push({ type: "hard_break" }); out.text += "\n"; }
        break;
      case "cr":
        out.nodes.push({ type: "hard_break" });
        out.text += "\n";
        break;
      case "noBreakHyphen":
        textNodes(ctx, "‑", p, href, out);
        break;
      case "sym": {
        const font = wAttr(c, "font") ?? "";
        const code = parseInt(wAttr(c, "char") ?? "", 16);
        if (!Number.isFinite(code)) break;
        const ch = String.fromCodePoint(code);
        symbolNode(ctx, font, ch, marksOf(p, href), out);
        countSize(ctx, p, 1);
        break;
      }
      case "drawing":
        for (const d of kids(c)) {
          const r = await drawingObject(ctx, d);
          if (r.inline) out.nodes.push(r.inline);
          if (r.block) out.after.push(r.block);
        }
        break;
      case "pict": case "object":
        await vml(ctx, c, out);
        break;
      case "footnoteReference":
        noteRef(ctx, "footnote", c, p, href, out);
        break;
      case "endnoteReference":
        noteRef(ctx, "endnote", c, p, href, out);
        break;
      case "footnoteRef": case "endnoteRef":
        if (ctx.currentNote) textNodes(ctx, ctx.currentNote, { ...p, vertAlign: "sup" }, href, out);
        break;
      default:
        // softHyphen, lastRenderedPageBreak, instrText, delText, annotation marks: not content.
        break;
    }
  }
}

function hyperlinkHref(ctx: Ctx, h: Element): string | null {
  const id = h.getAttributeNS(NS.r, "id");
  const anchor = wAttr(h, "anchor");
  let href: string | null = null;
  if (id) {
    const rel = ctx.part.rels.get(id);
    if (rel) href = rel.target + (anchor ? `#${anchor}` : "");
  } else if (anchor) {
    href = `#${anchor}`;
  }
  return isAllowedHref(href) ? href : null;
}

async function inlineContent(ctx: Ctx, items: Element[], styleR: RunProps, href: string | null, out: Inline): Promise<void> {
  for (const el of items) {
    if (el.namespaceURI === NS.mc && el.localName === "AlternateContent") {
      await inlineContent(ctx, chooseAlternate(el), styleR, href, out);
      continue;
    }
    if (el.namespaceURI !== NS.w) continue;
    switch (el.localName) {
      case "r":
        await runContent(ctx, kids(el), runProps(ctx, styleR, child(el, NS.w, "rPr")), href, out);
        break;
      case "hyperlink":
        await inlineContent(ctx, kids(el), styleR, hyperlinkHref(ctx, el) ?? href, out);
        break;
      case "sdt":
        await inlineContent(ctx, kids(child(el, NS.w, "sdtContent") ?? el).filter((k) => !is(k, NS.w, "sdtPr")), styleR, href, out);
        break;
      case "customXml": case "smartTag": case "fldSimple": case "ins": case "moveTo": case "dir": case "bdo":
        await inlineContent(ctx, kids(el), styleR, href, out);
        break;
      default:
        // del, moveFrom, bookmarks, proofErr, permStart/End, pPr: not content.
        break;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Paragraphs (§30.4, §30.6)

function alignOf(jc: string | undefined): ParagraphAttrs["align"] {
  switch (jc) {
    case "center": return "center";
    case "right": case "end": return "right";
    case "both": case "distribute": case "mediumKashida": case "highKashida": case "lowKashida": case "thaiDistribute": return "justify";
    default: return "left";
  }
}

function markerOf(ctx: Ctx, m: MarkerResult, p: ParaProps, markR: RunProps): ListMarker {
  const levelR = readRPr(m.level.rPr);
  const props = merge<RunProps>(markR, levelR);
  let text = m.text;
  let markerFont: string | null = null;
  if (m.level.numFmt === "bullet") {
    text = "";
    for (const ch of m.text) {
      const font = charFont(props, ch);
      if (!isSymbolFont(font) || !isSymbolCode(ch) || /\s/.test(ch)) {
        text += ch;
        if (font.toLowerCase() === "courier new") markerFont = "Courier New";
        continue;
      }
      const mapped = mapSymbol(font, ch);
      if (mapped !== null) text += mapped;
      else {
        text += ch;
        markerFont = font;
        ctx.report.push({ kind: "unmappedSymbol", font, code: symbolCode(ch).toString(16).toUpperCase().padStart(4, "0") });
      }
    }
  }
  if (m.unsupported) ctx.report.push({ kind: "unsupportedNumFmt", numFmt: m.unsupported });
  const indLeft = p.indLeft ?? 0;
  const indFirst = p.indFirst ?? 0;
  let tabPt = 18;
  if (indFirst < 0) tabPt = -indFirst;
  else {
    const tab = readPPr(m.level.pPr).tabs?.[0];
    if (tab !== undefined && tab - (indLeft + indFirst) > 0) tabPt = tab - (indLeft + indFirst);
  }
  return { text: text.normalize("NFC"), font: markerFont, marks: marksOf({ ...props, font: undefined }, null), tabPt };
}

async function paragraph(ctx: Ctx, pEl: Element): Promise<{ node: J; text: string; after: J[] }> {
  const pPr = child(pEl, NS.w, "pPr");
  const direct = readPPr(pPr);
  const style = ctx.styles.paragraph(direct.pStyle);
  const numId = direct.numId ?? style.p.numId;
  const ilvl = direct.ilvl ?? style.p.ilvl ?? 0;
  const level = numId && numId !== "0" ? ctx.numbering.level(numId, ilvl) : null;
  const p = merge<ParaProps>(ctx.styles.docP, ctx.table?.p, style.p, readPPr(level?.pPr ?? null), direct);
  const markRPr = child(pPr, NS.w, "rPr");
  const markDirect = readRPr(markRPr);
  const markR = merge<RunProps>(ctx.styles.docR, ctx.table?.r, style.r, ctx.styles.character(markDirect.rStyle), markDirect);

  const m = numId && numId !== "0" && level ? ctx.numbering.next(numId, ilvl) : null;
  const out: Inline = { nodes: [], after: [], text: "" };
  await inlineContent(ctx, kids(pEl), style.r, null, out);

  const attrs: ParagraphAttrs = {
    indLeft: p.indLeft ?? 0,
    indRight: p.indRight ?? 0,
    indFirst: p.indFirst ?? 0,
    spaceBefore: p.spaceBefore ?? 0,
    spaceAfter: p.spaceAfter ?? 0,
    line: p.line ?? null,
    align: alignOf(p.jc),
    shade: p.shade ?? null,
    borders: p.borders ?? null,
    marker: m ? markerOf(ctx, m, p, markR) : null,
  };
  const node: J = { type: "paragraph", attrs };
  if (out.nodes.length) node.content = out.nodes;
  return { node, text: out.text.normalize("NFC"), after: out.after };
}

// ---------------------------------------------------------------------------------------------
// Tables (§30.7)

interface Look {
  firstRow: boolean;
  lastRow: boolean;
  firstColumn: boolean;
  lastColumn: boolean;
  noHBand: boolean;
  noVBand: boolean;
}

function readLook(tblPr: Element | null): Look {
  const el = child(tblPr, NS.w, "tblLook");
  const hex = parseInt(wAttr(el, "val") ?? "0", 16) || 0;
  const flag = (name: string, bit: number, dflt: boolean): boolean => {
    const v = wAttr(el, name);
    if (v !== null) return truthy(v);
    if (el && wAttr(el, "val") !== null) return (hex & bit) !== 0;
    return dflt;
  };
  return {
    firstRow: flag("firstRow", 0x20, false),
    lastRow: flag("lastRow", 0x40, false),
    firstColumn: flag("firstColumn", 0x80, false),
    lastColumn: flag("lastColumn", 0x100, false),
    noHBand: flag("noHBand", 0x200, false),
    noVBand: flag("noVBand", 0x400, false),
  };
}

/** The table style's formats for a cell at (row, first col .. last col). */
export function cellFormats(
  ts: { base: Formats; cond: Map<string, Formats> }, look: Look, rowBand: number, colBand: number,
  row: number, nRows: number, col: number, lastCol: number, nCols: number,
): Formats {
  let f = ts.base;
  const apply = (t: string): void => {
    const c = ts.cond.get(t);
    if (c) f = mergeFormats(f, c);
  };
  const isFirstRow = look.firstRow && row === 0;
  const isLastRow = look.lastRow && row === nRows - 1;
  const isFirstCol = look.firstColumn && col === 0;
  const isLastCol = look.lastColumn && lastCol === nCols - 1;
  if (!look.noVBand && !isFirstCol && !isLastCol) {
    const c = col - (look.firstColumn ? 1 : 0);
    apply(Math.floor(c / Math.max(1, colBand)) % 2 === 0 ? "band1Vert" : "band2Vert");
  }
  if (!look.noHBand && !isFirstRow && !isLastRow) {
    const r = row - (look.firstRow ? 1 : 0);
    apply(Math.floor(r / Math.max(1, rowBand)) % 2 === 0 ? "band1Horz" : "band2Horz");
  }
  if (isFirstCol) apply("firstCol");
  if (isLastCol) apply("lastCol");
  if (isFirstRow) apply("firstRow");
  if (isLastRow) apply("lastRow");
  if (isFirstRow && isLastCol) apply("neCell");
  if (isFirstRow && isFirstCol) apply("nwCell");
  if (isLastRow && isLastCol) apply("seCell");
  if (isLastRow && isFirstCol) apply("swCell");
  return f;
}

/** Row-level and cell-level children of a table, unwrapping content controls and custom XML. */
function unwrap(el: Element, local: string): Element[] {
  const out: Element[] = [];
  for (const k of kids(el)) {
    if (is(k, NS.w, local)) out.push(k);
    else if (is(k, NS.w, "sdt")) out.push(...unwrap(child(k, NS.w, "sdtContent") ?? k, local));
    else if (is(k, NS.w, "customXml") || is(k, NS.w, "ins") || is(k, NS.w, "moveTo")) out.push(...unwrap(k, local));
    else if (k.namespaceURI === NS.mc && k.localName === "AlternateContent") {
      for (const c of chooseAlternate(k)) if (is(c, NS.w, local)) out.push(c);
    }
  }
  return out;
}

function hasContent(nodes: J[]): boolean {
  return nodes.some((n) => n.type !== "paragraph" || (Array.isArray(n.content) && n.content.length > 0));
}

interface CellRec {
  attrs: TableCellAttrs;
  content: J[];
}

async function table(ctx: Ctx, tbl: Element): Promise<J> {
  const tblPr = child(tbl, NS.w, "tblPr");
  const ts = ctx.styles.table(wAttr(child(tblPr, NS.w, "tblStyle"), "val") ?? undefined);
  const tp = mergeTable(ts.table, readTblPr(tblPr));
  const look = readLook(tblPr);
  const grid = children(child(tbl, NS.w, "tblGrid"), NS.w, "gridCol").map((g) => twipsToPt(wNum(g, "w") ?? 0));
  const rows = unwrap(tbl, "tr").filter((tr) => !child(child(tr, NS.w, "trPr"), NS.w, "del"));
  const nCols = Math.max(grid.length, 1);
  const outer = ctx.table;
  const open = new Map<number, CellRec>();
  const rowNodes: { attrs: TableRowAttrs; cells: CellRec[] }[] = [];

  for (const [ri, tr] of rows.entries()) {
    const trPr = child(tr, NS.w, "trPr");
    let col = wNum(child(trPr, NS.w, "gridBefore"), "val") ?? 0;
    const cells: CellRec[] = [];
    const grown: CellRec[] = [];
    let prev: CellRec | null = null;
    for (const tc of unwrap(tr, "tc")) {
      const tcPr = child(tc, NS.w, "tcPr");
      const span = wNum(child(tcPr, NS.w, "gridSpan"), "val") ?? 1;
      const vMerge = child(tcPr, NS.w, "vMerge");
      const hMerge = wAttr(child(tcPr, NS.w, "hMerge"), "val");
      const f = cellFormats(ts, look, tp.rowBand ?? 1, tp.colBand ?? 1, ri, rows.length, col, col + span - 1, nCols);
      ctx.table = f;
      const content = await storyBlocks(ctx, tc);
      ctx.table = outer;
      const startCol = col;
      col += span;
      if (hMerge !== null && hMerge !== "restart" && prev) {
        prev.attrs.colspan += span;
        if (hasContent(content)) prev.content.push(...content);
        continue;
      }
      if (vMerge && wAttr(vMerge, "val") !== "restart") {
        const rec = open.get(startCol);
        if (rec) {
          rec.attrs.rowspan += 1;
          grown.push(rec);
          if (hasContent(content)) rec.content.push(...content);
          prev = null;
          continue;
        }
      }
      const tcp = merge<ReturnType<typeof readTcPr>>(f.tc, readTcPr(tcPr));
      const borders = f.tc.borders || readTcPr(tcPr).borders ? merge(f.tc.borders, readTcPr(tcPr).borders) : null;
      const va = tcp.vAlign === "center" || tcp.vAlign === "bottom" ? tcp.vAlign : "top";
      const rec: CellRec = {
        attrs: { colspan: span, rowspan: 1, colwidth: null, fill: tcp.fill ?? null, vAlign: va, borders },
        content,
      };
      cells.push(rec);
      prev = rec;
      for (let c = startCol; c < startCol + span; c++) open.delete(c);
      if (vMerge) open.set(startCol, rec);
    }
    if (!cells.length) {
      // Every cell continues a vertical merge: the row has no cell of its own, so the merged cells
      // do not span it (their continuation content was already appended).
      for (const rec of grown) rec.attrs.rowspan -= 1;
      continue;
    }
    const trHeight = child(trPr, NS.w, "trHeight");
    const flag = (name: string): boolean => {
      const e = child(trPr, NS.w, name);
      if (!e) return false;
      const v = wAttr(e, "val");
      return v === null || v === "" || truthy(v);
    };
    rowNodes.push({
      attrs: {
        id: newId("r"),
        kind: "content",
        minHeightPt: trHeight ? twipsToPt(wNum(trHeight, "val") ?? 0) : null,
        repeatHeader: flag("tblHeader"),
        cantSplit: flag("cantSplit"),
      },
      cells,
    });
  }
  const b = tp.borders ?? {};
  const m = tp.cellMargin ?? {};
  const attrs: TableAttrs = {
    grid,
    indentPt: tp.indentPt ?? 0,
    borders: {
      top: b.top ?? null, right: b.right ?? null, bottom: b.bottom ?? null, left: b.left ?? null,
      insideH: b.insideH ?? null, insideV: b.insideV ?? null,
    },
    cellMarginPt: { top: m.top ?? 0, right: m.right ?? 5.4, bottom: m.bottom ?? 0, left: m.left ?? 5.4 },
  };
  return {
    type: "table",
    attrs,
    content: rowNodes.map((r) => ({
      type: "table_row",
      attrs: r.attrs,
      content: r.cells.map((c) => ({ type: "table_cell", attrs: c.attrs, content: c.content })),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Block walk

async function blockElements(ctx: Ctx, container: Element): Promise<TopElement[]> {
  const out: TopElement[] = [];
  const walk = async (items: Element[]): Promise<void> => {
    for (const el of items) {
      if (el.namespaceURI === NS.mc && el.localName === "AlternateContent") {
        await walk(chooseAlternate(el));
        continue;
      }
      if (el.namespaceURI !== NS.w) continue;
      switch (el.localName) {
        case "p": {
          const r = await paragraph(ctx, el);
          out.push({ table: false, text: r.text, nodes: [r.node, ...r.after] });
          break;
        }
        case "tbl": {
          // A table with no rows shows nothing in Word and has no node form.
          const t = await table(ctx, el);
          if ((t.content as J[]).length) out.push({ table: true, text: "", nodes: [t] });
          break;
        }
        case "sdt":
          await walk(kids(child(el, NS.w, "sdtContent") ?? el).filter((k) => !is(k, NS.w, "sdtPr")));
          break;
        case "customXml": case "ins": case "moveTo":
          await walk(kids(el));
          break;
        case "altChunk":
          ctx.report.push({ kind: "altChunk" });
          break;
        default:
          break;
      }
    }
  };
  await walk(kids(container));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Document assembly

function pageOf(sectPr: Element | null): PageSetup {
  const sz = child(sectPr, NS.w, "pgSz");
  const mar = child(sectPr, NS.w, "pgMar");
  const t = (el: Element | null, name: string, d: number): number => twipsToPt(wNum(el, name) ?? d);
  return {
    widthPt: t(sz, "w", 12240),
    heightPt: t(sz, "h", 15840),
    margins: { top: t(mar, "top", 1440), right: t(mar, "right", 1440), bottom: t(mar, "bottom", 1440), left: t(mar, "left", 1440) },
  };
}

/** basePt: the most frequent run size by character count; ties go to the smaller size. */
function basePtOf(sizes: Map<number, number>): number {
  let best = DEFAULT_SIZE;
  let count = -1;
  for (const [s, n] of [...sizes].sort((a, b) => a[0] - b[0])) {
    if (n > count) {
      best = s;
      count = n;
    }
  }
  return best;
}

function stripBaseSize(node: J, basePt: number): void {
  const strip = (marks: MarkJSON[]): MarkJSON[] => marks.filter((m) => !(isMark(m, "size") && m.attrs.pt === basePt));
  if (node.marks) {
    const kept = strip(node.marks);
    if (kept.length) node.marks = kept;
    else delete node.marks;
  }
  if (isNode(node, "paragraph") && node.attrs.marker) node.attrs.marker.marks = strip(node.attrs.marker.marks);
  for (const c of node.content ?? []) stripBaseSize(c, basePt);
}

/** Canonical JSON: validated against the schema, its stored form (storedJSON), marks in schema order, adjacent equal text merged. */
function canonical(node: J): J {
  const n = schema.nodeFromJSON(node);
  n.check();
  return storedJSON(n) as J;
}

function noteState(settings: Element | null, kind: "footnotePr" | "endnotePr", sectPr: Element | null, dflt: string): NoteState {
  const pr = child(sectPr, NS.w, kind) ?? child(settings, NS.w, kind);
  return {
    fmt: wAttr(child(pr, NS.w, "numFmt"), "val") ?? dflt,
    next: wNum(child(pr, NS.w, "numStart"), "val") ?? 1,
    numbers: new Map(),
  };
}

async function notes(ctx: Ctx, part: Part | null, kind: "footnote" | "endnote"): Promise<TopElement[]> {
  if (!part) return [];
  const out: TopElement[] = [];
  const list = children(part.root, NS.w, kind)
    .filter((n) => !SKIP_NOTE_TYPES.has(wAttr(n, "type") ?? ""))
    .sort((a, b) => (wNum(a, "id") ?? 0) - (wNum(b, "id") ?? 0));
  const saved = ctx.part;
  ctx.part = part;
  for (const n of list) {
    const id = wAttr(n, "id") ?? "";
    ctx.currentNote = ctx.notes[kind].numbers.get(id) ?? null;
    ctx.fields = [];
    out.push(...(await blockElements(ctx, n)));
  }
  ctx.currentNote = null;
  ctx.part = saved;
  return out;
}

async function headerFooter(ctx: Ctx, sectPr: Element | null, kind: "headerReference" | "footerReference"): Promise<TopElement[]> {
  const ref = children(sectPr, NS.w, kind).find((r) => wAttr(r, "type") === "default");
  const relId = ref?.getAttributeNS(NS.r, "id");
  const part = relId ? ctx.pkg.part(relId) : null;
  if (!part) return [];
  const saved = ctx.part;
  ctx.part = part;
  ctx.fields = [];
  const out = await blockElements(ctx, part.root);
  ctx.part = saved;
  return out;
}

/** Converts a .docx package into top-level elements (30 §30.3–§30.9). */
export async function convertDocx(bytes: Uint8Array, opts: ConvertOptions): Promise<ConvertedDoc> {
  const pkg = openPackage(bytes);
  const styles = new Styles(pkg.styles);
  const body = child(pkg.main.root, NS.w, "body");
  if (!body) throw new Error("Not a Word document: w:body is missing");
  const finalSect = child(body, NS.w, "sectPr");
  const firstSect = descendants(body, NS.w, "sectPr")[0] ?? null;
  const ctx: Ctx = {
    pkg,
    part: pkg.main,
    styles,
    numbering: new Numbering(pkg.numbering, (id) => styles.numberingStyleNumId(id)),
    theme: readTheme(pkg.theme, pkg.settings),
    opts,
    report: [],
    sizes: new Map(),
    fields: [],
    table: null,
    notes: {
      footnote: noteState(pkg.settings, "footnotePr", finalSect, "decimal"),
      endnote: noteState(pkg.settings, "endnotePr", finalSect, "lowerRoman"),
    },
    currentNote: null,
    assetCache: new Map(),
  };

  const header = await headerFooter(ctx, firstSect, "headerReference");
  ctx.fields = [];
  const main = await blockElements(ctx, body);
  const foot = await notes(ctx, pkg.footnotes, "footnote");
  const end = await notes(ctx, pkg.endnotes, "endnote");
  const footer = await headerFooter(ctx, firstSect, "footerReference");
  const all = [...header, ...main, ...foot, ...end, ...footer];

  const basePt = basePtOf(ctx.sizes);
  for (const el of all) {
    el.nodes = el.nodes.map((n) => {
      stripBaseSize(n, basePt);
      return canonical(n);
    });
  }
  return { page: pageOf(finalSect), basePt, body: all, report: ctx.report };
}

/** One doc per block: a top-level table → a table block; each maximal non-table run → one prose block (30 §30.8). */
export function toBlocks(els: TopElement[]): { kind: "prose" | "table"; doc: DocJSON }[] {
  const out: { kind: "prose" | "table"; doc: DocJSON }[] = [];
  let run: J[] = [];
  const flush = (): void => {
    if (run.length) out.push({ kind: "prose", doc: { type: "doc", content: run } });
    run = [];
  };
  for (const el of els) {
    if (el.table) {
      flush();
      out.push({ kind: "table", doc: { type: "doc", content: el.nodes } });
    } else {
      run.push(...el.nodes);
    }
  }
  flush();
  return out;
}

const fold = (s: string): string => s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

/** Splits a guide's top-level elements into the preamble and one element list per system (30 §30.8). */
export function segmentGuide(
  els: TopElement[], systems: { title: string; match?: string }[],
): { preamble: TopElement[]; systems: TopElement[][] } {
  const starts: number[] = [];
  let from = 0;
  for (const s of systems) {
    const want = fold(s.match ?? s.title);
    let found = -1;
    for (let i = from; i < els.length; i++) {
      const el = els[i]!;
      if (!el.table && fold(el.text).startsWith(want)) {
        found = i;
        break;
      }
    }
    if (found < 0) throw new Error(`system heading not found: ${s.title}`);
    starts.push(found);
    from = found + 1;
  }
  return {
    preamble: els.slice(0, starts[0] ?? els.length),
    systems: starts.map((s, k) => els.slice(s, starts[k + 1] ?? els.length)),
  };
}
