// Style flattening (30 §30.4): docDefaults → table style (with conditional formats) → paragraph style
// chain → character style chain → numbering level → direct properties. Later wins.
import type { Border, LineSpacing, ParagraphBorders, Side, TableSide } from "../schemaTypes.ts";
import type { Element } from "./xml.ts";
import { NS, child, children, hexColor, onOff, twipsToPt, wAttr, wNum } from "./xml.ts";

export interface RunProps {
  bold?: boolean;
  italic?: boolean;
  /** Underline style, or "none". */
  underline?: string;
  strike?: boolean;
  dstrike?: boolean;
  vertAlign?: "sup" | "sub" | "baseline";
  caps?: boolean;
  smallCaps?: boolean;
  sizePt?: number;
  color?: string | null;
  highlight?: string | null;
  shade?: string | null;
  /** The font for characters below U+0080 (w:ascii); "" when it is a theme font. */
  font?: string;
  /** The font for other characters (w:hAnsi); "" when it is a theme font. */
  fontH?: string;
  rStyle?: string;
}

export interface ParaProps {
  indLeft?: number;
  indRight?: number;
  indFirst?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  line?: LineSpacing | null;
  jc?: string;
  shade?: string | null;
  borders?: ParagraphBorders | null;
  numId?: string;
  ilvl?: number;
  pStyle?: string;
  /** Tab stop positions (pt). */
  tabs?: number[];
}

export interface TableProps {
  indentPt?: number;
  borders?: Partial<Record<TableSide, Border | null>>;
  cellMargin?: Partial<Record<Side, number>>;
  rowBand?: number;
  colBand?: number;
}

export interface CellProps {
  fill?: string | null;
  vAlign?: string;
  borders?: Partial<Record<Side, Border | null>>;
}

export interface Formats {
  p: ParaProps;
  r: RunProps;
  tc: CellProps;
}

interface StyleDef {
  type: string;
  basedOn: string | null;
  pPr: Element | null;
  rPr: Element | null;
  tblPr: Element | null;
  tcPr: Element | null;
  cond: Map<string, { pPr: Element | null; rPr: Element | null; tcPr: Element | null }>;
}

export interface TableStyle {
  base: Formats;
  table: TableProps;
  cond: Map<string, Formats>;
}

const HIGHLIGHT: Record<string, string> = {
  yellow: "FFFF00", green: "00FF00", cyan: "00FFFF", magenta: "FF00FF", blue: "0000FF", red: "FF0000",
  darkBlue: "000080", darkCyan: "008080", darkGreen: "008000", darkMagenta: "800080", darkRed: "800000",
  darkYellow: "808000", darkGray: "808080", lightGray: "C0C0C0", black: "000000", white: "FFFFFF",
};

/** Merge defined keys of each layer, later wins. */
export function merge<T extends object>(...layers: (Partial<T> | undefined)[]): T {
  const out: Record<string, unknown> = {};
  for (const l of layers) {
    if (!l) continue;
    for (const [k, v] of Object.entries(l)) if (v !== undefined) out[k] = v;
  }
  return out as T;
}

function readBorder(el: Element | null): Border | null | undefined {
  if (!el) return undefined;
  const val = wAttr(el, "val");
  if (!val || val === "nil" || val === "none") return null;
  return { style: val, widthPt: (wNum(el, "sz") ?? 0) / 8, color: hexColor(wAttr(el, "color")) ?? "000000" };
}

/** A border side element by its name or its logical alias (left/start, right/end). An explicit nil side counts as present. */
function sideEl(bdr: Element, name: string, alias: string): Element | null {
  return child(bdr, NS.w, name) ?? child(bdr, NS.w, alias);
}

function shadeFill(el: Element | null): string | null | undefined {
  if (!el) return undefined;
  return hexColor(wAttr(el, "fill"));
}

export function readRPr(rPr: Element | null): RunProps {
  const out: RunProps = {};
  if (!rPr) return out;
  const flag = (name: string): boolean | undefined => {
    const e = child(rPr, NS.w, name);
    return e ? (onOff(e) ?? undefined) : undefined;
  };
  out.bold = flag("b");
  out.italic = flag("i");
  out.strike = flag("strike");
  out.dstrike = flag("dstrike");
  out.caps = flag("caps");
  out.smallCaps = flag("smallCaps");
  const u = child(rPr, NS.w, "u");
  if (u) out.underline = wAttr(u, "val") || "single";
  const va = wAttr(child(rPr, NS.w, "vertAlign"), "val");
  if (va === "superscript") out.vertAlign = "sup";
  else if (va === "subscript") out.vertAlign = "sub";
  else if (va === "baseline") out.vertAlign = "baseline";
  const sz = wNum(child(rPr, NS.w, "sz"), "val");
  if (sz !== null) out.sizePt = sz / 2;
  const color = child(rPr, NS.w, "color");
  if (color) out.color = hexColor(wAttr(color, "val"));
  const hl = child(rPr, NS.w, "highlight");
  if (hl) out.highlight = HIGHLIGHT[wAttr(hl, "val") ?? ""] ?? null;
  const shd = child(rPr, NS.w, "shd");
  if (shd) out.shade = shadeFill(shd);
  const fonts = child(rPr, NS.w, "rFonts");
  if (fonts) {
    const pick = (name: string): string | undefined =>
      wAttr(fonts, `${name}Theme`) !== null ? "" : (wAttr(fonts, name) ?? undefined);
    out.font = pick("ascii");
    out.fontH = pick("hAnsi");
  }
  const rStyle = wAttr(child(rPr, NS.w, "rStyle"), "val");
  if (rStyle) out.rStyle = rStyle;
  return out;
}

export function readPPr(pPr: Element | null): ParaProps {
  const out: ParaProps = {};
  if (!pPr) return out;
  const ind = child(pPr, NS.w, "ind");
  if (ind) {
    const left = wNum(ind, "left") ?? wNum(ind, "start");
    const right = wNum(ind, "right") ?? wNum(ind, "end");
    const first = wNum(ind, "firstLine");
    const hanging = wNum(ind, "hanging");
    if (left !== null) out.indLeft = twipsToPt(left);
    if (right !== null) out.indRight = twipsToPt(right);
    if (hanging !== null) out.indFirst = -twipsToPt(hanging);
    else if (first !== null) out.indFirst = twipsToPt(first);
  }
  const sp = child(pPr, NS.w, "spacing");
  if (sp) {
    const before = wNum(sp, "before");
    const after = wNum(sp, "after");
    const line = wNum(sp, "line");
    if (before !== null) out.spaceBefore = twipsToPt(before);
    if (after !== null) out.spaceAfter = twipsToPt(after);
    if (line !== null) {
      const rule = wAttr(sp, "lineRule");
      out.line = rule === "exact" || rule === "atLeast"
        ? { rule, value: twipsToPt(line) }
        : { rule: "auto", value: line / 240 };
    }
  }
  const jc = wAttr(child(pPr, NS.w, "jc"), "val");
  if (jc) out.jc = jc;
  const shd = child(pPr, NS.w, "shd");
  if (shd) out.shade = shadeFill(shd);
  const bdr = child(pPr, NS.w, "pBdr");
  if (bdr) {
    const side = (a: string, b: string): Border | null => readBorder(sideEl(bdr, a, b)) ?? null;
    const b = { top: side("top", "top"), right: side("right", "end"), bottom: side("bottom", "bottom"), left: side("left", "start") };
    out.borders = b.top || b.right || b.bottom || b.left ? b : null;
  }
  const numPr = child(pPr, NS.w, "numPr");
  if (numPr) {
    const numId = wAttr(child(numPr, NS.w, "numId"), "val");
    const ilvl = wNum(child(numPr, NS.w, "ilvl"), "val");
    if (numId !== null) out.numId = numId;
    if (ilvl !== null) out.ilvl = ilvl;
  }
  const pStyle = wAttr(child(pPr, NS.w, "pStyle"), "val");
  if (pStyle) out.pStyle = pStyle;
  const tabs = child(pPr, NS.w, "tabs");
  if (tabs) {
    out.tabs = children(tabs, NS.w, "tab")
      .filter((t) => wAttr(t, "val") !== "clear")
      .map((t) => twipsToPt(wNum(t, "pos") ?? 0));
  }
  return out;
}

const SIDE_NAMES: [TableSide, string, string][] = [
  ["top", "top", "top"], ["right", "right", "end"], ["bottom", "bottom", "bottom"], ["left", "left", "start"],
  ["insideH", "insideH", "insideH"], ["insideV", "insideV", "insideV"],
];

export function readTblPr(tblPr: Element | null): TableProps {
  const out: TableProps = {};
  if (!tblPr) return out;
  const ind = child(tblPr, NS.w, "tblInd");
  if (ind && (wAttr(ind, "type") ?? "dxa") === "dxa") out.indentPt = twipsToPt(wNum(ind, "w") ?? 0);
  const bdr = child(tblPr, NS.w, "tblBorders");
  if (bdr) {
    out.borders = {};
    for (const [side, a, b] of SIDE_NAMES) {
      const v = readBorder(sideEl(bdr, a, b));
      if (v !== undefined) out.borders[side] = v;
    }
  }
  const mar = child(tblPr, NS.w, "tblCellMar");
  if (mar) {
    out.cellMargin = {};
    for (const [side, a, b] of SIDE_NAMES.slice(0, 4)) {
      const e = child(mar, NS.w, a) ?? child(mar, NS.w, b);
      if (e) out.cellMargin[side as "top"] = twipsToPt(wNum(e, "w") ?? 0);
    }
  }
  const rb = wNum(child(tblPr, NS.w, "tblStyleRowBandSize"), "val");
  if (rb !== null) out.rowBand = rb;
  const cb = wNum(child(tblPr, NS.w, "tblStyleColBandSize"), "val");
  if (cb !== null) out.colBand = cb;
  return out;
}

export function readTcPr(tcPr: Element | null): CellProps {
  const out: CellProps = {};
  if (!tcPr) return out;
  const shd = child(tcPr, NS.w, "shd");
  if (shd) out.fill = shadeFill(shd);
  const va = wAttr(child(tcPr, NS.w, "vAlign"), "val");
  if (va) out.vAlign = va;
  const bdr = child(tcPr, NS.w, "tcBorders");
  if (bdr) {
    out.borders = {};
    for (const [side, a, b] of SIDE_NAMES.slice(0, 4)) {
      const v = readBorder(sideEl(bdr, a, b));
      if (v !== undefined) out.borders[side as "top"] = v;
    }
  }
  return out;
}

function mergeTable(a: TableProps, b: TableProps): TableProps {
  return {
    ...merge<TableProps>(a, b),
    borders: a.borders || b.borders ? merge(a.borders, b.borders) : undefined,
    cellMargin: a.cellMargin || b.cellMargin ? merge(a.cellMargin, b.cellMargin) : undefined,
  };
}

function mergeFormats(a: Formats, b: Formats): Formats {
  return { p: merge(a.p, b.p), r: merge(a.r, b.r), tc: merge(a.tc, b.tc) };
}

const EMPTY: Formats = { p: {}, r: {}, tc: {} };

export class Styles {
  readonly docP: ParaProps;
  readonly docR: RunProps;
  private readonly defs = new Map<string, StyleDef>();
  private readonly defaults = new Map<string, string>();
  private readonly paraCache = new Map<string, { p: ParaProps; r: RunProps }>();
  private readonly charCache = new Map<string, RunProps>();
  private readonly tableCache = new Map<string, TableStyle>();

  constructor(root: Element | null) {
    const dd = child(root, NS.w, "docDefaults");
    this.docP = readPPr(child(child(dd, NS.w, "pPrDefault"), NS.w, "pPr"));
    this.docR = readRPr(child(child(dd, NS.w, "rPrDefault"), NS.w, "rPr"));
    for (const s of children(root, NS.w, "style")) {
      const id = wAttr(s, "styleId");
      const type = wAttr(s, "type") ?? "paragraph";
      if (id === null) continue;
      const cond = new Map<string, { pPr: Element | null; rPr: Element | null; tcPr: Element | null }>();
      for (const c of children(s, NS.w, "tblStylePr")) {
        const t = wAttr(c, "type");
        if (t) cond.set(t, { pPr: child(c, NS.w, "pPr"), rPr: child(c, NS.w, "rPr"), tcPr: child(c, NS.w, "tcPr") });
      }
      this.defs.set(id, {
        type,
        basedOn: wAttr(child(s, NS.w, "basedOn"), "val"),
        pPr: child(s, NS.w, "pPr"),
        rPr: child(s, NS.w, "rPr"),
        tblPr: child(s, NS.w, "tblPr"),
        tcPr: child(s, NS.w, "tcPr"),
        cond,
      });
      if (["1", "true", "on"].includes(wAttr(s, "default") ?? "")) this.defaults.set(type, id);
    }
  }

  /** The style chain from the root ancestor down to `id` (cycle-safe). */
  private chain(id: string | null | undefined, type: string): StyleDef[] {
    const out: StyleDef[] = [];
    const seen = new Set<string>();
    let cur = id && this.defs.get(id)?.type === type ? id : (this.defaults.get(type) ?? null);
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const def = this.defs.get(cur);
      if (!def) break;
      out.unshift(def);
      cur = def.basedOn;
    }
    return out;
  }

  paragraph(id: string | undefined): { p: ParaProps; r: RunProps } {
    const key = id ?? "";
    let v = this.paraCache.get(key);
    if (!v) {
      const chain = this.chain(id, "paragraph");
      v = {
        p: merge<ParaProps>(...chain.map((d) => readPPr(d.pPr))),
        r: merge<RunProps>(...chain.map((d) => readRPr(d.rPr))),
      };
      delete v.p.pStyle;
      delete v.r.rStyle;
      this.paraCache.set(key, v);
    }
    return v;
  }

  character(id: string | undefined): RunProps {
    if (!id) return {};
    let v = this.charCache.get(id);
    if (!v) {
      const chain = this.defs.get(id)?.type === "character" ? this.chain(id, "character") : [];
      v = merge<RunProps>(...chain.map((d) => readRPr(d.rPr)));
      delete v.rStyle;
      this.charCache.set(id, v);
    }
    return v;
  }

  table(id: string | undefined): TableStyle {
    const key = id ?? "";
    let v = this.tableCache.get(key);
    if (!v) {
      const chain = this.chain(id, "table");
      let base: Formats = EMPTY;
      let table: TableProps = {};
      const cond = new Map<string, Formats>();
      for (const d of chain) {
        base = mergeFormats(base, { p: readPPr(d.pPr), r: readRPr(d.rPr), tc: readTcPr(d.tcPr) });
        table = mergeTable(table, readTblPr(d.tblPr));
        for (const [t, c] of d.cond) {
          cond.set(t, mergeFormats(cond.get(t) ?? EMPTY, { p: readPPr(c.pPr), r: readRPr(c.rPr), tc: readTcPr(c.tcPr) }));
        }
      }
      v = { base, table, cond };
      this.tableCache.set(key, v);
    }
    return v;
  }

  /** The numbering style link target: a numbering style's numId. */
  numberingStyleNumId(id: string): string | null {
    const def = this.defs.get(id);
    return def ? wAttr(child(child(def.pPr, NS.w, "numPr"), NS.w, "numId"), "val") : null;
  }
}

export { mergeTable, mergeFormats };
