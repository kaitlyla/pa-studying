// Independent extractor (30 §30.13), written without lib/docx. It reads the raw package with fflate
// and xmldom and walks it generically: every element is descended into unless it is excluded
// content (deleted text, field codes, a Fallback whose Choice was taken), so a wrapper the
// converter does not know about still yields its text here.
import { unzipSync } from "fflate";
import type { Element } from "@xmldom/xmldom";
import type { Fmt, RunLayer } from "./styles.ts";
import { BASE_FMT, StyleSheet, conditionsFor, paraLayer, runLayer, stack } from "./styles.ts";
import {
  A, MC, O, PIC, R, V, W, W16SE, WP, WPG, WPS, at, el, elementsOf, els, isTrue, num, parse, plain, plainNum,
} from "./xml.ts";

/** One character position of a paragraph's text with its effective formatting (null for breaks). */
export interface CharAtom {
  s: string;
  fmt: Fmt | null;
  link: string | null;
}

export interface ParaAtom {
  text: string;
  marker: string | null;
  indLeft: number;
  indFirst: number;
  indRight: number;
  chars: CharAtom[];
}

export interface PicAtom {
  media: string;
  /** srcRect l, t, r, b (1/1000 %). */
  crop: [number, number, number, number];
  /** Displayed extent in pt; null for pictures inside a group (stored in group space). */
  widthPt: number | null;
  heightPt: number | null;
}

export interface TableAtom {
  depth: number;
  rows: number[];
  fills: (string | null)[][];
}

export interface Story {
  kind: "header" | "body" | "footnote" | "endnote" | "footer" | "textbox" | "grouptext";
  label: string;
  paragraphs: ParaAtom[];
  pictures: PicAtom[];
  tables: TableAtom[];
}

export interface InfoEntry {
  kind: string;
  [k: string]: unknown;
}

export interface Atoms {
  stories: Story[];
  /** The most frequent effective run size by character count (ties → smaller). */
  basePt: number;
  media: Record<string, Uint8Array>;
  info: InfoEntry[];
}

interface Sink {
  paragraphs: ParaAtom[];
  pictures: PicAtom[];
  tables: TableAtom[];
}

const CHOICE_OK = new Set(["wps", "wpg", "wpc", "w14", "w15", "w16se", "a14", "wp14"]);
const INK = "http://schemas.microsoft.com/office/word/2010/wordprocessingInk";
const SYMBOL_FONTS = new Set(["symbol", "wingdings", "wingdings 2", "wingdings 3", "webdings"]);
/** The verifier's own copy of the 30 §30.5 table: font → U+F0xx code → stored text. */
const SYMBOLS: Record<string, Record<number, string>> = {
  wingdings: { 0xf0e0: "→", 0xf0a7: "▪", 0xf06e: "■", 0xf0d8: "➢" },
  symbol: { 0xf0b7: "•" },
};
const SKIP = new Set(["del", "moveFrom", "delText", "instrText", "rPr", "pPr", "sectPr", "tblPr", "trPr", "tcPr", "sdtPr", "tblGrid", "footnotePr", "endnotePr"]);
const NOTE_SKIP = new Set(["separator", "continuationSeparator", "continuationNotice"]);

const isSymFont = (f: string | null | undefined): boolean => !!f && SYMBOL_FONTS.has(f.trim().toLowerCase());
const symCode = (cp: number): number => (cp < 0x100 ? 0xf000 + cp : cp);
const isSymRange = (cp: number): boolean => cp <= 0xff || (cp >= 0xf000 && cp <= 0xf0ff);

function hrefAllowed(h: string): boolean {
  return /^(https?:|mailto:)/.test(h) || h.startsWith("#/");
}

function fmtNumber(n: number, f: string): string {
  if (f === "none") return "";
  if (f === "lowerLetter" || f === "upperLetter") {
    const s = n < 1 ? String(n) : String.fromCharCode(97 + ((n - 1) % 26)).repeat(Math.ceil(n / 26));
    return f === "upperLetter" ? s.toUpperCase() : s;
  }
  if (f === "lowerRoman" || f === "upperRoman") {
    const vals = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
    const syms = ["m", "cm", "d", "cd", "c", "xc", "l", "xl", "x", "ix", "v", "iv", "i"];
    let s = "";
    let v = n;
    vals.forEach((k, i) => { while (v >= k) { s += syms[i]; v -= k; } });
    return f === "upperRoman" ? s.toUpperCase() : s;
  }
  if (f === "decimalZero") return (n < 10 ? "0" : "") + n;
  return String(n);
}

const FORMATS = new Set(["decimal", "lowerLetter", "upperLetter", "lowerRoman", "upperRoman", "decimalZero", "bullet", "none"]);

interface Lvl {
  start: number;
  fmt: string;
  text: string;
  restart: number | null;
  lgl: boolean;
  pPr: Element | null;
  rPr: Element | null;
}

/** The verifier's own §30.6 marker computation. */
class Lists {
  private abs = new Map<string, Map<number, Lvl>>();
  private links = new Map<string, string>();
  private nums = new Map<string, { abs: string; over: Map<number, { start: number | null; lvl: Lvl | null }> }>();
  private counts = new Map<string, Map<number, number>>();
  private seen = new Set<string>();
  private sheet: StyleSheet;

  constructor(root: Element | null, sheet: StyleSheet) {
    this.sheet = sheet;
    const lvl = (l: Element): Lvl => ({
      start: num(el(l, "start"), "val") ?? 1,
      fmt: at(el(l, "numFmt"), "val") ?? "decimal",
      text: at(el(l, "lvlText"), "val") ?? "",
      restart: num(el(l, "lvlRestart"), "val"),
      lgl: el(l, "isLgl") !== null && at(el(l, "isLgl"), "val") !== "0" && at(el(l, "isLgl"), "val") !== "false",
      pPr: el(l, "pPr"),
      rPr: el(l, "rPr"),
    });
    for (const a of els(root, "abstractNum")) {
      const id = at(a, "abstractNumId");
      if (id === null) continue;
      this.abs.set(id, new Map(els(a, "lvl").map((l) => [num(l, "ilvl") ?? 0, lvl(l)])));
      const link = at(el(a, "numStyleLink"), "val");
      if (link) this.links.set(id, link);
    }
    for (const n of els(root, "num")) {
      const id = at(n, "numId");
      const a = at(el(n, "abstractNumId"), "val");
      if (id === null || a === null) continue;
      const over = new Map<number, { start: number | null; lvl: Lvl | null }>();
      for (const o of els(n, "lvlOverride")) {
        const l = el(o, "lvl");
        over.set(num(o, "ilvl") ?? 0, { start: num(el(o, "startOverride"), "val"), lvl: l ? lvl(l) : null });
      }
      this.nums.set(id, { abs: a, over });
    }
  }

  private absId(numId: string, hops = 0): string | null {
    const n = this.nums.get(numId);
    if (!n) return null;
    const link = this.links.get(n.abs);
    if (link && hops < 4 && !(this.abs.get(n.abs)?.size)) {
      const target = this.sheet.numStyleNumId(link);
      if (target && target !== numId) return this.absId(target, hops + 1);
    }
    return n.abs;
  }

  lvl(numId: string, ilvl: number): Lvl | null {
    const n = this.nums.get(numId);
    const a = this.absId(numId);
    if (!n || a === null) return null;
    return n.over.get(ilvl)?.lvl ?? this.abs.get(a)?.get(ilvl) ?? null;
  }

  advance(numId: string, ilvl: number): { text: string; lvl: Lvl; unsupported: string | null } | null {
    const n = this.nums.get(numId);
    const a = this.absId(numId);
    const L = this.lvl(numId, ilvl);
    if (!n || a === null || !L) return null;
    const c = this.counts.get(a) ?? new Map<number, number>();
    this.counts.set(a, c);
    const startOf = (i: number): number => n.over.get(i)?.start ?? this.lvl(numId, i)?.start ?? 1;
    if (!this.seen.has(numId)) {
      this.seen.add(numId);
      n.over.forEach((o, i) => { if (o.start !== null) c.set(i, o.start - 1); });
    }
    c.set(ilvl, c.has(ilvl) ? c.get(ilvl)! + 1 : startOf(ilvl));
    for (const d of [...c.keys()].filter((k) => k > ilvl)) {
      const r = this.lvl(numId, d)?.restart;
      const after = r === null || r === undefined ? d : r;
      if (after !== 0 && ilvl < after) c.delete(d);
    }
    let unsupported: string | null = FORMATS.has(L.fmt) ? null : L.fmt;
    const text = L.text.replace(/%([1-9])/g, (_, k: string) => {
      const i = Number(k) - 1;
      const f = L.lgl ? "decimal" : (this.lvl(numId, i)?.fmt ?? "decimal");
      if (!FORMATS.has(f)) unsupported = f;
      return fmtNumber(c.get(i) ?? startOf(i), f === "bullet" ? "decimal" : f);
    });
    return { text, lvl: L, unsupported };
  }
}

interface PartCtx {
  name: string;
  rels: Map<string, { target: string; external: boolean }>;
}

interface TableCtx {
  run: RunLayer;
  para: ReturnType<typeof paraLayer>;
}

function relsFor(files: Record<string, Uint8Array>, part: string): Map<string, { target: string; external: boolean }> {
  const dir = part.includes("/") ? part.slice(0, part.lastIndexOf("/") + 1) : "";
  const name = `${dir}_rels/${part.slice(dir.length)}.rels`;
  const out = new Map<string, { target: string; external: boolean }>();
  const data = files[name];
  if (!data) return out;
  const root = parse(new TextDecoder().decode(data), name);
  for (const r of elementsOf(root)) {
    const id = plain(r, "Id");
    const t = plain(r, "Target");
    if (!id || t === null) continue;
    const external = plain(r, "TargetMode") === "External";
    let target = t;
    if (!external) {
      const segs: string[] = [];
      for (const s of (t.startsWith("/") ? t.slice(1) : dir + t).split("/")) {
        if (s === "..") segs.pop();
        else if (s && s !== ".") segs.push(s);
      }
      target = segs.join("/");
    }
    out.set(id, { target, external });
  }
  return out;
}

function relType(files: Record<string, Uint8Array>, part: string, suffix: string): string | null {
  const dir = part.includes("/") ? part.slice(0, part.lastIndexOf("/") + 1) : "";
  const data = files[`${dir}_rels/${part.slice(dir.length)}.rels`];
  if (!data) return null;
  const root = parse(new TextDecoder().decode(data), "rels");
  for (const r of elementsOf(root)) {
    if ((plain(r, "Type") ?? "").endsWith(suffix) && plain(r, "TargetMode") !== "External") {
      return relsFor(files, part).get(plain(r, "Id") ?? "")?.target ?? null;
    }
  }
  return null;
}

export class Extractor {
  readonly stories: Story[] = [];
  readonly info: InfoEntry[] = [];
  private sizes = new Map<number, number>();
  private fields: boolean[] = [];
  private sheet: StyleSheet;
  private lists: Lists;
  private notes = { footnote: { fmt: "decimal", next: 1, ids: new Map<string, string>() }, endnote: { fmt: "lowerRoman", next: 1, ids: new Map<string, string>() } };
  private noteNumber: string | null = null;
  private files: Record<string, Uint8Array>;
  private mainName: string;
  private read: (name: string | null) => Element | null;

  constructor(files: Record<string, Uint8Array>) {
    this.files = files;
    const read = (name: string | null): Element | null => {
      const d = name ? files[name] : undefined;
      return d ? parse(new TextDecoder().decode(d), name!) : null;
    };
    this.mainName = relType(files, "", "/officeDocument") ?? "word/document.xml";
    this.sheet = new StyleSheet(read(relType(files, this.mainName, "/styles")));
    this.lists = new Lists(read(relType(files, this.mainName, "/numbering")), this.sheet);
    this.read = read;
  }

  run(): Atoms {
    const main = this.read(this.mainName);
    const body = el(main, "body");
    if (!body) throw new Error("no w:body");
    const settings = this.read(relType(this.files, this.mainName, "/settings"));
    const lastSect = el(body, "sectPr");
    for (const k of ["footnote", "endnote"] as const) {
      const pr = el(lastSect, `${k}Pr`) ?? el(settings, `${k}Pr`);
      const f = at(el(pr, "numFmt"), "val");
      if (f) this.notes[k].fmt = f;
      this.notes[k].next = num(el(pr, "numStart"), "val") ?? 1;
    }
    const mainPart: PartCtx = { name: this.mainName, rels: relsFor(this.files, this.mainName) };
    const firstSect = this.firstSectPr(body);
    const hf = (kind: "header" | "footer"): void => {
      const ref = els(firstSect, `${kind}Reference`).find((r) => at(r, "type") === "default");
      const id = ref ? ref.getAttributeNS(R, "id") : null;
      const target = id ? mainPart.rels.get(id) : undefined;
      const root = target && !target.external ? this.read(target.target) : null;
      if (root) this.story(kind, kind, root, { name: target!.target, rels: relsFor(this.files, target!.target) });
    };
    hf("header");
    this.story("body", "body", body, mainPart);
    for (const k of ["footnote", "endnote"] as const) {
      const name = relType(this.files, this.mainName, `/${k}s`);
      const root = this.read(name);
      if (!root || !name) continue;
      const part = { name, rels: relsFor(this.files, name) };
      const notes = els(root, k).filter((n) => !NOTE_SKIP.has(at(n, "type") ?? "")).sort((a, b) => (num(a, "id") ?? 0) - (num(b, "id") ?? 0));
      for (const n of notes) {
        this.noteNumber = this.notes[k].ids.get(at(n, "id") ?? "") ?? null;
        this.story(k, `${k} ${at(n, "id")}`, n, part);
      }
      this.noteNumber = null;
    }
    hf("footer");
    let basePt = 10;
    let best = -1;
    for (const [s, n] of [...this.sizes].sort((a, b) => a[0] - b[0])) if (n > best) { best = n; basePt = s; }
    const media: Record<string, Uint8Array> = {};
    for (const [k, v] of Object.entries(this.files)) if (k.includes("/media/")) media[k] = v;
    return { stories: this.stories, basePt, media, info: this.info };
  }

  private firstSectPr(body: Element): Element | null {
    let found: Element | null = null;
    const walk = (e: Element): void => {
      for (const k of elementsOf(e)) {
        if (found) return;
        if (k.localName === "sectPr" && k.namespaceURI === W) { found = k; return; }
        walk(k);
      }
    };
    walk(body);
    return found;
  }

  private story(kind: Story["kind"], label: string, root: Element, part: PartCtx): void {
    const s: Story = { kind, label, paragraphs: [], pictures: [], tables: [] };
    this.stories.push(s);
    const savedFields = this.fields;
    this.fields = [];
    this.blocks(root, s, part, null, 0);
    this.fields = savedFields;
    // A text box with no blocks is stored with one empty paragraph, as an empty cell is (30 §30.7).
    if ((kind === "textbox" || kind === "grouptext") && !s.paragraphs.length && !s.tables.length) {
      s.paragraphs.push({ text: "", marker: null, indLeft: 0, indFirst: 0, indRight: 0, chars: [] });
    }
  }

  private choose(ac: Element): Element[] {
    const choice = el(ac, "Choice", MC);
    if (choice) {
      const req = (plain(choice, "Requires") ?? "").split(/\s+/).filter(Boolean);
      let ink = false;
      const scan = (e: Element): void => {
        for (const k of elementsOf(e)) {
          if (k.localName === "graphicData" && k.namespaceURI === A && plain(k, "uri") === INK) ink = true;
          scan(k);
        }
      };
      scan(choice);
      if (!ink && req.every((r) => CHOICE_OK.has(r))) return elementsOf(choice);
    }
    return elementsOf(el(ac, "Fallback", MC));
  }

  private blocks(container: Element, sink: Sink, part: PartCtx, t: TableCtx | null, depth: number): void {
    for (const k of elementsOf(container)) {
      if (k.namespaceURI === MC && k.localName === "AlternateContent") {
        for (const c of this.choose(k)) this.blockOne(c, sink, part, t, depth);
        continue;
      }
      this.blockOne(k, sink, part, t, depth);
    }
  }

  private blockOne(k: Element, sink: Sink, part: PartCtx, t: TableCtx | null, depth: number): void {
    if (k.namespaceURI === W) {
      if (SKIP.has(k.localName ?? "")) return;
      if (k.localName === "p") { this.paragraph(k, sink, part, t); return; }
      if (k.localName === "tbl") { this.table(k, sink, part, depth); return; }
      if (k.localName === "altChunk") { this.info.push({ kind: "altChunk" }); return; }
    }
    this.blocks(k, sink, part, t, depth);
  }

  private paragraph(p: Element, sink: Sink, part: PartCtx, t: TableCtx | null): void {
    const pPr = el(p, "pPr");
    const direct = paraLayer(pPr);
    const ps = this.sheet.paraStyle(direct.style);
    const numId = direct.numId ?? ps.para.numId;
    const ilvl = direct.ilvl ?? ps.para.ilvl ?? 0;
    const L = numId && numId !== "0" ? this.lists.lvl(numId, ilvl) : null;
    const eff = stack({ left: 0, right: 0, first: 0 } as ReturnType<typeof paraLayer>, this.sheet.docPara, t?.para, ps.para, paraLayer(L?.pPr ?? null), direct);
    const markLayer = runLayer(el(pPr, "rPr"));
    const markFmt = stack<Fmt>(BASE_FMT, this.sheet.docRun, t?.run, ps.run, this.sheet.charStyle(markLayer.rStyle), markLayer);
    let marker: string | null = null;
    if (numId && numId !== "0" && L) {
      const m = this.lists.advance(numId, ilvl);
      if (m) {
        if (m.unsupported) this.info.push({ kind: "unsupportedNumFmt", numFmt: m.unsupported });
        marker = m.text;
        if (m.lvl.fmt === "bullet") {
          const lf = stack<Fmt>(markFmt, runLayer(m.lvl.rPr));
          marker = [...m.text].map((ch) => this.symbolText(ch, lf)).join("");
        }
        marker = marker.normalize("NFC");
      }
    }
    const atom: ParaAtom = { text: "", marker, indLeft: eff.left ?? 0, indFirst: eff.first ?? 0, indRight: eff.right ?? 0, chars: [] };
    const floats: PicAtom[] = [];
    const inline: PicAtom[] = [];
    this.inline(p, atom, { styleRun: ps.run, table: t, link: null, part, inline, floats });
    atom.text = atom.chars.map((c) => c.s).join("").normalize("NFC");
    sink.paragraphs.push(atom);
    sink.pictures.push(...inline, ...floats);
  }

  private symbolText(ch: string, f: Fmt): string {
    const cp = ch.codePointAt(0) ?? 0;
    const font = cp < 0x80 ? f.ascii : (f.hAnsi ?? f.ascii);
    if (!isSymFont(font) || !isSymRange(cp) || /\s/.test(ch)) return ch;
    const mapped = SYMBOLS[font.trim().toLowerCase()]?.[symCode(cp)];
    if (mapped !== undefined) return mapped;
    this.info.push({ kind: "unmappedSymbol", font, code: symCode(cp).toString(16).toUpperCase().padStart(4, "0") });
    return ch;
  }

  private inline(
    node: Element, atom: ParaAtom,
    c: { styleRun: RunLayer; table: TableCtx | null; link: string | null; part: PartCtx; inline: PicAtom[]; floats: PicAtom[] },
  ): void {
    for (const k of elementsOf(node)) {
      if (k.namespaceURI === MC && k.localName === "AlternateContent") {
        for (const x of this.choose(k)) this.inlineOne(x, atom, c);
        continue;
      }
      this.inlineOne(k, atom, c);
    }
  }

  private inlineOne(
    k: Element, atom: ParaAtom,
    c: { styleRun: RunLayer; table: TableCtx | null; link: string | null; part: PartCtx; inline: PicAtom[]; floats: PicAtom[] },
  ): void {
    if (k.namespaceURI === W && SKIP.has(k.localName ?? "")) return;
    if (k.namespaceURI === W && k.localName === "r") {
      const layer = runLayer(el(k, "rPr"));
      const fmt = stack<Fmt>(BASE_FMT, this.sheet.docRun, c.table?.run, c.styleRun, this.sheet.charStyle(layer.rStyle), layer);
      this.runItems(k, atom, fmt, c);
      return;
    }
    if (k.namespaceURI === W && k.localName === "hyperlink") {
      const id = k.getAttributeNS(R, "id");
      const anchor = at(k, "anchor");
      let href: string | null = null;
      if (id) {
        const rel = c.part.rels.get(id);
        if (rel) href = rel.target + (anchor ? `#${anchor}` : "");
      } else if (anchor) href = `#${anchor}`;
      this.inline(k, atom, { ...c, link: href !== null && hrefAllowed(href) ? href : c.link });
      return;
    }
    this.inline(k, atom, c);
  }

  private push(atom: ParaAtom, s: string, fmt: Fmt | null, link: string | null): void {
    if (!this.fields.every(Boolean)) return;
    const text = s.normalize("NFC");
    for (const unit of text.split("")) atom.chars.push({ s: unit, fmt, link });
    if (fmt) this.sizes.set(fmt.size, (this.sizes.get(fmt.size) ?? 0) + text.length);
  }

  private runItems(
    r: Element, atom: ParaAtom, fmt: Fmt,
    c: { styleRun: RunLayer; table: TableCtx | null; link: string | null; part: PartCtx; inline: PicAtom[]; floats: PicAtom[] },
  ): void {
    for (const k of elementsOf(r)) {
      if (k.namespaceURI === MC && k.localName === "AlternateContent") {
        for (const x of this.choose(k)) this.runItem(x, atom, fmt, c);
        continue;
      }
      this.runItem(k, atom, fmt, c);
    }
  }

  private runItem(
    k: Element, atom: ParaAtom, fmt: Fmt,
    c: { styleRun: RunLayer; table: TableCtx | null; link: string | null; part: PartCtx; inline: PicAtom[]; floats: PicAtom[] },
  ): void {
    const visible = this.fields.every(Boolean);
    if (k.namespaceURI === W16SE && k.localName === "symEx") {
      const cp = parseInt(k.getAttributeNS(W16SE, "char") ?? "", 16);
      if (Number.isFinite(cp)) this.push(atom, String.fromCodePoint(cp), fmt, c.link);
      return;
    }
    if (k.namespaceURI !== W) {
      if (visible) this.graphics(k, c, false, false);
      return;
    }
    switch (k.localName) {
      case "fldChar": {
        const type = at(k, "fldCharType");
        if (type === "begin") this.fields.push(false);
        else if (type === "separate" && this.fields.length) this.fields[this.fields.length - 1] = true;
        else if (type === "end") this.fields.pop();
        return;
      }
      case "t": {
        const text = (k.textContent ?? "").normalize("NFC");
        const out = [...text].map((ch) => this.symbolText(ch, fmt)).join("");
        this.push(atom, out, fmt, c.link);
        return;
      }
      case "tab": case "ptab": this.push(atom, "\t", fmt, c.link); return;
      case "br": case "cr": this.push(atom, "\n", null, null); return;
      case "noBreakHyphen": this.push(atom, "‑", fmt, c.link); return;
      case "sym": {
        const font = at(k, "font") ?? "";
        const cp = parseInt(at(k, "char") ?? "", 16);
        if (!Number.isFinite(cp)) return;
        const mapped = SYMBOLS[font.trim().toLowerCase()]?.[symCode(cp)];
        if (mapped === undefined) this.info.push({ kind: "unmappedSymbol", font, code: symCode(cp).toString(16).toUpperCase().padStart(4, "0") });
        this.push(atom, mapped ?? String.fromCodePoint(cp), fmt, c.link);
        return;
      }
      case "footnoteReference": case "endnoteReference": {
        if (isTrue(at(k, "customMarkFollows"))) return;
        const n = this.notes[k.localName === "footnoteReference" ? "footnote" : "endnote"];
        const id = at(k, "id") ?? "";
        if (!n.ids.has(id)) n.ids.set(id, fmtNumber(n.next++, n.fmt));
        this.push(atom, n.ids.get(id)!, { ...fmt, vertAlign: "sup" }, c.link);
        return;
      }
      case "footnoteRef": case "endnoteRef":
        if (this.noteNumber) this.push(atom, this.noteNumber, { ...fmt, vertAlign: "sup" }, c.link);
        return;
      case "drawing": case "pict": case "object":
        if (visible) this.graphics(k, c, false, false);
        return;
      default:
        if (SKIP.has(k.localName ?? "")) return;
        // softHyphen, lastRenderedPageBreak and annotation marks hold no text; anything else is descended.
        if (["softHyphen", "lastRenderedPageBreak", "annotationRef", "separator", "continuationSeparator"].includes(k.localName ?? "")) return;
        for (const x of elementsOf(k)) this.runItem(x, atom, fmt, c);
    }
  }

  /** Pictures and text-box stories inside a drawing, VML block, or any nested graphic element. */
  private graphics(
    g: Element, c: { part: PartCtx; inline: PicAtom[]; floats: PicAtom[] }, floating: boolean, inGroup: boolean,
  ): void {
    for (const k of elementsOf(g)) {
      if (k.namespaceURI === MC && k.localName === "AlternateContent") {
        for (const x of this.choose(k)) this.graphicOne(x, c, floating, inGroup);
        continue;
      }
      this.graphicOne(k, c, floating, inGroup);
    }
  }

  private graphicOne(k: Element, c: { part: PartCtx; inline: PicAtom[]; floats: PicAtom[] }, floating: boolean, inGroup: boolean): void {
    if (k.namespaceURI === WP && (k.localName === "anchor" || k.localName === "inline")) {
      this.graphics(k, c, k.localName === "anchor" || this.hasGroupOrShape(k), false);
      return;
    }
    if (k.namespaceURI === WPG && k.localName === "wgp") {
      this.graphics(k, c, true, true);
      return;
    }
    if (k.namespaceURI === W && k.localName === "txbxContent") {
      this.story(inGroup ? "grouptext" : "textbox", inGroup ? "group text" : "text box", k, c.part);
      return;
    }
    if (k.namespaceURI === PIC && k.localName === "pic") {
      const blip = this.find(k, A, "blip");
      const id = blip?.getAttributeNS(R, "embed") ?? "";
      const rel = c.part.rels.get(id);
      if (!rel || rel.external) { this.info.push({ kind: "linkedPicture", id }); return; }
      const src = this.find(k, A, "srcRect");
      const crop = (["l", "t", "r", "b"] as const).map((s) => plainNum(src, s) ?? 0) as [number, number, number, number];
      const anchor = this.ancestorExtent(k);
      const pic: PicAtom = { media: rel.target, crop, widthPt: inGroup ? null : anchor.w, heightPt: inGroup ? null : anchor.h };
      (floating || inGroup ? c.floats : c.inline).push(pic);
      return;
    }
    if (k.namespaceURI === V) {
      if (k.localName === "shapetype") return;
      const style = (plain(k, "style") ?? "").toLowerCase();
      const abs = /position\s*:\s*absolute/.test(style);
      if (k.localName === "imagedata") {
        const id = k.getAttributeNS(R, "id") ?? "";
        const rel = c.part.rels.get(id);
        if (!rel || rel.external) return;
        const host = k.parentNode as Element;
        const hs = plain(host, "style") ?? "";
        const len = (key: string): number | null => {
          const m = new RegExp(`(?:^|;)\\s*${key}\\s*:\\s*([-0-9.]+)(pt|in|px|cm|mm)?`, "i").exec(hs);
          if (!m) return null;
          const v = Number(m[1]);
          return m[2] === "in" ? v * 72 : m[2] === "px" ? v * 0.75 : m[2] === "cm" ? (v * 72) / 2.54 : m[2] === "mm" ? (v * 72) / 25.4 : v;
        };
        const hostAbs = /position\s*:\s*absolute/i.test(hs);
        (hostAbs || floating ? c.floats : c.inline).push({ media: rel.target, crop: [0, 0, 0, 0], widthPt: len("width"), heightPt: len("height") });
        return;
      }
      if (isTrue(k.getAttributeNS(O, "hr"))) return;
      this.graphics(k, c, floating || abs, inGroup);
      return;
    }
    if (k.namespaceURI === WPS && k.localName === "wsp") {
      this.graphics(k, c, true, inGroup);
      return;
    }
    this.graphics(k, c, floating, inGroup);
  }

  private hasGroupOrShape(anchor: Element): boolean {
    const gd = this.find(anchor, A, "graphicData");
    return !!gd && plain(gd, "uri") !== "http://schemas.openxmlformats.org/drawingml/2006/picture";
  }

  private ancestorExtent(k: Element): { w: number | null; h: number | null } {
    for (let p = k.parentNode as Element | null; p; p = p.parentNode as Element | null) {
      if (p.namespaceURI === WP && (p.localName === "inline" || p.localName === "anchor")) {
        const ext = elementsOf(p).find((e) => e.localName === "extent");
        return { w: (plainNum(ext, "cx") ?? 0) / 12700, h: (plainNum(ext, "cy") ?? 0) / 12700 };
      }
    }
    return { w: null, h: null };
  }

  private find(e: Element | null, ns: string, local: string): Element | null {
    if (!e) return null;
    for (const k of elementsOf(e)) {
      if (k.namespaceURI === ns && k.localName === local) return k;
      const d = this.find(k, ns, local);
      if (d) return d;
    }
    return null;
  }

  private rowsOf(e: Element, local: string): Element[] {
    const out: Element[] = [];
    for (const k of elementsOf(e)) {
      if (k.namespaceURI === W && k.localName === local) out.push(k);
      else if (k.namespaceURI === MC && k.localName === "AlternateContent") {
        for (const x of this.choose(k)) if (x.namespaceURI === W && x.localName === local) out.push(x);
      } else if (!(k.namespaceURI === W && SKIP.has(k.localName ?? "")) && !(k.namespaceURI === W && (k.localName === "tbl" || k.localName === "p" || k.localName === "tc" || k.localName === "tr"))) {
        out.push(...this.rowsOf(k, local));
      }
    }
    return out;
  }

  private table(tbl: Element, sink: Sink, part: PartCtx, depth: number): void {
    const tblPr = el(tbl, "tblPr");
    const ts = this.sheet.tableStyle(at(el(tblPr, "tblStyle"), "val") ?? undefined);
    const lookEl = el(tblPr, "tblLook");
    const hexv = parseInt(at(lookEl, "val") ?? "0", 16) || 0;
    const flag = (name: string, bit: number): boolean => {
      const v = at(lookEl, name);
      if (v !== null) return isTrue(v);
      return at(lookEl, "val") !== null ? (hexv & bit) !== 0 : false;
    };
    const look = {
      firstRow: flag("firstRow", 0x20), lastRow: flag("lastRow", 0x40), firstCol: flag("firstColumn", 0x80),
      lastCol: flag("lastColumn", 0x100), hBand: !flag("noHBand", 0x200), vBand: !flag("noVBand", 0x400),
    };
    const styleBands = (name: string): number | null => {
      for (const s of this.sheet.lineage(at(el(tblPr, "tblStyle"), "val"), "table").reverse()) {
        const v = num(el(el(s, "tblPr"), name), "val");
        if (v !== null) return v;
      }
      return null;
    };
    const bands = {
      row: num(el(tblPr, "tblStyleRowBandSize"), "val") ?? styleBands("tblStyleRowBandSize") ?? 1,
      col: num(el(tblPr, "tblStyleColBandSize"), "val") ?? styleBands("tblStyleColBandSize") ?? 1,
    };
    const cols = Math.max(1, els(el(tbl, "tblGrid"), "gridCol").length);
    const rows = this.rowsOf(tbl, "tr").filter((tr) => !el(el(tr, "trPr"), "del"));
    interface Cell { sink: Sink; fill: string | null }
    const grid: Cell[][] = [];
    const open = new Map<number, Cell>();
    rows.forEach((tr, ri) => {
      let col = num(el(el(tr, "trPr"), "gridBefore"), "val") ?? 0;
      const row: Cell[] = [];
      let last: Cell | null = null;
      for (const tc of this.rowsOf(tr, "tc")) {
        const tcPr = el(tc, "tcPr");
        const span = num(el(tcPr, "gridSpan"), "val") ?? 1;
        const types = conditionsFor(look, bands, ri, rows.length, col, col + span - 1, cols);
        let run = ts.run;
        let para = ts.para;
        let fill = ts.fill;
        for (const ty of types) {
          const cd = ts.cond.get(ty);
          if (!cd) continue;
          run = stack(run, cd.run);
          para = stack(para, cd.para);
          if (cd.fill !== undefined) fill = cd.fill;
        }
        const shd = el(tcPr, "shd");
        // A direct w:shd decides the fill; a missing or "auto" w:fill means none.
        if (shd) fill = /^[0-9a-f]{6}$/i.test(at(shd, "fill") ?? "") ? at(shd, "fill")!.toUpperCase() : null;
        const cellSink: Sink = { paragraphs: [], pictures: [], tables: [] };
        this.blocks(tc, cellSink, part, { run, para }, depth + 1);
        // 30 §30.7: a cell without paragraphs is stored with one empty paragraph.
        if (!cellSink.paragraphs.length && !cellSink.tables.length) {
          cellSink.paragraphs.push({ text: "", marker: null, indLeft: 0, indFirst: 0, indRight: 0, chars: [] });
        }
        const filled = cellSink.paragraphs.some((p) => p.text.length > 0) || cellSink.pictures.length > 0 || cellSink.tables.length > 0;
        const at0 = col;
        col += span;
        const h = at(el(tcPr, "hMerge"), "val");
        if (el(tcPr, "hMerge") && h !== "restart" && last) {
          if (filled) appendSink(last.sink, cellSink);
          continue;
        }
        const vm = el(tcPr, "vMerge");
        if (vm && at(vm, "val") !== "restart" && open.has(at0)) {
          if (filled) appendSink(open.get(at0)!.sink, cellSink);
          last = null;
          continue;
        }
        const cell: Cell = { sink: cellSink, fill: fill ?? null };
        row.push(cell);
        last = cell;
        for (let x = at0; x < at0 + span; x++) open.delete(x);
        if (vm) open.set(at0, cell);
      }
      if (row.length) grid.push(row);
    });
    if (!grid.length) return;
    sink.tables.push({ depth, rows: grid.map((r) => r.length), fills: grid.map((r) => r.map((c) => c.fill)) });
    for (const r of grid) for (const c of r) appendSink(sink, c.sink);
  }
}

function appendSink(to: Sink, from: Sink): void {
  to.paragraphs.push(...from.paragraphs);
  to.pictures.push(...from.pictures);
  to.tables.push(...from.tables);
}

/** Extracts the expected atoms of a .docx package. */
export async function extract(bytes: Uint8Array): Promise<Atoms> {
  return new Extractor(unzipSync(bytes)).run();
}
