// The verifier's own resolver for the 30 §30.4 cascade, written without lib/docx: docDefaults →
// table style (with tblStylePr per tblLook and cell position) → paragraph style chain → character
// style chain → numbering level pPr → direct properties. Later wins, attribute by attribute.
import type { Element } from "@xmldom/xmldom";
import { W, at, el, els, hex6, num, on } from "./xml.ts";

/** Effective character formatting, as compared against stored marks. */
export interface Fmt {
  bold: boolean;
  italic: boolean;
  underline: string | null;
  strike: boolean;
  caps: boolean;
  smallCaps: boolean;
  vertAlign: "sup" | "sub" | null;
  size: number;
  color: string | null;
  highlight: string | null;
  shade: string | null;
  ascii: string;
  hAnsi: string | null;
}

/** A partial layer of run properties; undefined = not set at this layer. */
export type RunLayer = { [K in keyof Fmt]?: Fmt[K] };

export interface ParaLayer {
  left?: number;
  right?: number;
  first?: number;
  numId?: string;
  ilvl?: number;
  style?: string;
}

const HL: Record<string, string> = {
  black: "000000", blue: "0000FF", cyan: "00FFFF", green: "00FF00", magenta: "FF00FF", red: "FF0000",
  yellow: "FFFF00", white: "FFFFFF", darkBlue: "000080", darkCyan: "008080", darkGreen: "008000",
  darkMagenta: "800080", darkRed: "800000", darkYellow: "808000", darkGray: "808080", lightGray: "C0C0C0",
};

export const BASE_FMT: Fmt = {
  bold: false, italic: false, underline: null, strike: false, caps: false, smallCaps: false, vertAlign: null,
  size: 10, color: null, highlight: null, shade: null, ascii: "", hAnsi: null,
};

export function runLayer(rPr: Element | null): RunLayer & { rStyle?: string } {
  const L: RunLayer & { rStyle?: string } = {};
  if (!rPr) return L;
  for (const [tag, key] of [["b", "bold"], ["i", "italic"], ["caps", "caps"], ["smallCaps", "smallCaps"]] as const) {
    const e = el(rPr, tag);
    if (e) L[key] = on(e);
  }
  const strike = el(rPr, "strike");
  const dstrike = el(rPr, "dstrike");
  if (strike || dstrike) L.strike = (strike ? on(strike) : false) || (dstrike ? on(dstrike) : false);
  const u = el(rPr, "u");
  if (u) {
    const v = at(u, "val") || "single";
    L.underline = v === "none" ? null : v;
  }
  const va = el(rPr, "vertAlign");
  if (va) {
    const v = at(va, "val");
    L.vertAlign = v === "superscript" ? "sup" : v === "subscript" ? "sub" : null;
  }
  const sz = num(el(rPr, "sz"), "val");
  if (sz !== null) L.size = sz / 2;
  const color = el(rPr, "color");
  if (color) L.color = hex6(at(color, "val"));
  const hl = el(rPr, "highlight");
  if (hl) L.highlight = HL[at(hl, "val") ?? ""] ?? null;
  const shd = el(rPr, "shd");
  if (shd) L.shade = hex6(at(shd, "fill"));
  const f = el(rPr, "rFonts");
  if (f) {
    if (at(f, "asciiTheme") !== null) L.ascii = "";
    else if (at(f, "ascii") !== null) L.ascii = at(f, "ascii")!;
    if (at(f, "hAnsiTheme") !== null) L.hAnsi = "";
    else if (at(f, "hAnsi") !== null) L.hAnsi = at(f, "hAnsi");
  }
  const rs = at(el(rPr, "rStyle"), "val");
  if (rs) L.rStyle = rs;
  return L;
}

export function paraLayer(pPr: Element | null): ParaLayer {
  const L: ParaLayer = {};
  if (!pPr) return L;
  const ind = el(pPr, "ind");
  if (ind) {
    const left = num(ind, "left") ?? num(ind, "start");
    const right = num(ind, "right") ?? num(ind, "end");
    if (left !== null) L.left = left / 20;
    if (right !== null) L.right = right / 20;
    const hanging = num(ind, "hanging");
    const first = num(ind, "firstLine");
    if (hanging !== null) L.first = -hanging / 20;
    else if (first !== null) L.first = first / 20;
  }
  const numPr = el(pPr, "numPr");
  if (numPr) {
    const id = at(el(numPr, "numId"), "val");
    const lvl = num(el(numPr, "ilvl"), "val");
    if (id !== null) L.numId = id;
    if (lvl !== null) L.ilvl = lvl;
  }
  const ps = at(el(pPr, "pStyle"), "val");
  if (ps) L.style = ps;
  return L;
}

function over<T extends object>(base: T, layer: Partial<T> | undefined): T {
  if (!layer) return base;
  const out = { ...base };
  for (const k of Object.keys(layer) as (keyof T)[]) if (layer[k] !== undefined) out[k] = layer[k] as T[keyof T];
  return out;
}

/** Layers applied over a base, later wins. */
export function stack<T extends object>(base: T, ...layers: (Partial<T> | undefined)[]): T {
  return layers.reduce<T>((acc, l) => over(acc, l), base);
}

interface Def {
  type: string;
  basedOn: string | null;
  node: Element;
}

export interface Cond {
  run: RunLayer;
  para: ParaLayer;
  fill: string | null | undefined;
}

export class StyleSheet {
  docRun: RunLayer = {};
  docPara: ParaLayer = {};
  private defs = new Map<string, Def>();
  private dflt = new Map<string, string>();

  constructor(root: Element | null) {
    if (!root) return;
    const dd = el(root, "docDefaults");
    this.docRun = runLayer(el(el(dd, "rPrDefault"), "rPr"));
    this.docPara = paraLayer(el(el(dd, "pPrDefault"), "pPr"));
    for (const s of els(root, "style")) {
      const id = at(s, "styleId");
      if (!id) continue;
      const type = at(s, "type") ?? "paragraph";
      this.defs.set(id, { type, basedOn: at(el(s, "basedOn"), "val"), node: s });
      const d = at(s, "default");
      if (d === "1" || d === "true" || d === "on") this.dflt.set(type, id);
    }
  }

  /** Root-first ancestry of a style of the given type (the type's default style when id is absent). */
  lineage(id: string | null | undefined, type: string): Element[] {
    let cur = id && this.defs.get(id)?.type === type ? id : (this.dflt.get(type) ?? null);
    const out: Element[] = [];
    const seen = new Set<string>();
    while (cur && !seen.has(cur) && this.defs.has(cur)) {
      seen.add(cur);
      const d = this.defs.get(cur)!;
      out.push(d.node);
      cur = d.basedOn;
    }
    return out.reverse();
  }

  paraStyle(id: string | undefined): { run: RunLayer; para: ParaLayer } {
    const lin = this.lineage(id, "paragraph");
    const run = lin.map((s) => runLayer(el(s, "rPr"))).reduce<RunLayer>((a, l) => over(a, stripStyle(l)), {});
    const para = lin.map((s) => paraLayer(el(s, "pPr"))).reduce<ParaLayer>((a, l) => over(a, { ...l, style: undefined }), {});
    return { run, para };
  }

  charStyle(id: string | undefined): RunLayer {
    if (!id || this.defs.get(id)?.type !== "character") return {};
    return this.lineage(id, "character").map((s) => runLayer(el(s, "rPr"))).reduce<RunLayer>((a, l) => over(a, stripStyle(l)), {});
  }

  /** A table style's whole-table layers and its conditional layers by type, root first. */
  tableStyle(id: string | undefined): { run: RunLayer; para: ParaLayer; fill: string | null | undefined; cond: Map<string, Cond> } {
    const lin = this.lineage(id, "table");
    let run: RunLayer = {};
    let para: ParaLayer = {};
    let fill: string | null | undefined;
    const cond = new Map<string, Cond>();
    for (const s of lin) {
      run = over(run, stripStyle(runLayer(el(s, "rPr"))));
      para = over(para, paraLayer(el(s, "pPr")));
      const shd = el(el(s, "tcPr"), "shd");
      if (shd) fill = hex6(at(shd, "fill"));
      for (const c of els(s, "tblStylePr")) {
        const t = at(c, "type");
        if (!t) continue;
        const prev = cond.get(t) ?? { run: {}, para: {}, fill: undefined };
        const cshd = el(el(c, "tcPr"), "shd");
        cond.set(t, {
          run: over(prev.run, stripStyle(runLayer(el(c, "rPr")))),
          para: over(prev.para, paraLayer(el(c, "pPr"))),
          fill: cshd ? hex6(at(cshd, "fill")) : prev.fill,
        });
      }
    }
    return { run, para, fill, cond };
  }

  numStyleNumId(id: string): string | null {
    const d = this.defs.get(id);
    return d ? at(el(el(el(d.node, "pPr"), "numPr"), "numId"), "val") : null;
  }
}

function stripStyle(l: RunLayer & { rStyle?: string }): RunLayer {
  const { rStyle: _ignored, ...rest } = l;
  void _ignored;
  return rest;
}

/** The tblStylePr types that apply to a cell, in application order. */
export function conditionsFor(
  look: { firstRow: boolean; lastRow: boolean; firstCol: boolean; lastCol: boolean; hBand: boolean; vBand: boolean },
  bands: { row: number; col: number }, r: number, rows: number, c0: number, c1: number, cols: number,
): string[] {
  const top = look.firstRow && r === 0;
  const bottom = look.lastRow && r === rows - 1;
  const left = look.firstCol && c0 === 0;
  const right = look.lastCol && c1 === cols - 1;
  const out: string[] = [];
  if (look.vBand && !left && !right) out.push(Math.floor((c0 - (look.firstCol ? 1 : 0)) / Math.max(1, bands.col)) % 2 ? "band2Vert" : "band1Vert");
  if (look.hBand && !top && !bottom) out.push(Math.floor((r - (look.firstRow ? 1 : 0)) / Math.max(1, bands.row)) % 2 ? "band2Horz" : "band1Horz");
  if (left) out.push("firstCol");
  if (right) out.push("lastCol");
  if (top) out.push("firstRow");
  if (bottom) out.push("lastRow");
  if (top && right) out.push("neCell");
  if (top && left) out.push("nwCell");
  if (bottom && right) out.push("seCell");
  if (bottom && left) out.push("swCell");
  return out;
}

export { W };
