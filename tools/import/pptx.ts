// PowerPoint reading (30 §30.10): slide order, search text of a deck shown as-is, the psych
// review deck's conversion to slide blocks, and her requested slide-2 edit to that deck.
import { XMLSerializer } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { Node } from "prosemirror-model";
import type { DocJSON } from "../../lib/content/index.ts";
import { resolveTarget } from "../../lib/docx/package.ts";
import { isSymbolCode, isSymbolFont, mapSymbol } from "../../lib/docx/symbols.ts";
import { child, children, descendants, kids, NS, parseXml } from "../../lib/docx/xml.ts";
import type { Document as XmlDocument, Element as XmlElement } from "../../lib/docx/xml.ts";
import { schema } from "../../lib/schema.ts";

const NS_A = NS.a;
const NS_P = NS.p;

export type Entries = Record<string, Uint8Array>;

function part(entries: Entries, name: string): Uint8Array {
  const bytes = entries[name];
  if (!bytes) throw new Error(`PowerPoint package has no ${name}`);
  return bytes;
}

/** Parse a package part; malformed XML throws (lib/docx parseXml). */
function parsePart(entries: Entries, name: string): { doc: XmlDocument; root: XmlElement } {
  const doc = parseXml(strFromU8(part(entries, name)), name);
  const root = doc.documentElement;
  if (!root) throw new Error(`${name}: no document element`);
  return { doc, root };
}

const rootOf = (entries: Entries, name: string): XmlElement => parsePart(entries, name).root;

/** Slide part names in `ppt/presentation.xml` `p:sldIdLst` order. */
export function slideParts(entries: Entries): string[] {
  const pres = rootOf(entries, "ppt/presentation.xml");
  const rels = rootOf(entries, "ppt/_rels/presentation.xml.rels");
  const targets = new Map<string, string>();
  for (const r of children(rels, NS.rel, "Relationship")) targets.set(r.getAttribute("Id") ?? "", r.getAttribute("Target") ?? "");
  const list = child(pres, NS_P, "sldIdLst");
  if (!list) return [];
  return children(list, NS_P, "sldId").map((s) => {
    const rid = s.getAttributeNS(NS.r, "id") ?? "";
    const target = targets.get(rid);
    if (target === undefined) throw new Error(`ppt/presentation.xml: slide relationship ${rid} not found`);
    const name = resolveTarget("ppt/presentation.xml", target);
    part(entries, name);
    return name;
  });
}

// ---- runs and paragraphs ------------------------------------------------------------------

interface TextRun {
  text: string;
  marks: { type: string; attrs?: Record<string, unknown> }[];
}

interface Para {
  el: XmlElement;
  level: number;
  runs: TextRun[];
  text: string;
}

const isPuaSymbol = (ch: string): boolean => {
  const cp = ch.codePointAt(0) ?? 0;
  return cp >= 0xf000 && cp <= 0xf0ff;
};

/**
 * A run's characters through the symbol map (30 §30.5). Symbol-range characters (U+F000–F0FF) use
 * the run's `a:sym` font; others use its `a:latin` font. A symbol code in a symbol font that is not
 * mapped is kept as its code point with a `font` mark; other Unicode characters are ordinary text.
 */
function mapRunText(text: string, symFont: string | null, latinFont: string | null): { text: string; font: string | null }[] {
  const out: { text: string; font: string | null }[] = [];
  const push = (t: string, font: string | null): void => {
    const last = out.at(-1);
    if (last && last.font === font) last.text += t;
    else out.push({ text: t, font });
  };
  for (const ch of text) {
    const font = isPuaSymbol(ch) && symFont ? symFont : latinFont;
    if (font && isSymbolFont(font) && isSymbolCode(ch)) {
      const mapped = mapSymbol(font, ch);
      if (mapped !== null) push(mapped, null);
      else push(ch, font);
    } else {
      push(ch, null);
    }
  }
  return out;
}

/** Theme colors for `a:schemeClr` (theme `a:clrScheme`, through the master's `p:clrMap`). */
type SchemeColors = Map<string, string>;

function hexOf(el: XmlElement | null, scheme: SchemeColors): string | null {
  if (!el) return null;
  const srgb = child(el, NS_A, "srgbClr");
  if (srgb) return applyLum(srgb, (srgb.getAttribute("val") ?? "").toUpperCase());
  const sch = child(el, NS_A, "schemeClr");
  if (sch) {
    const base = scheme.get(sch.getAttribute("val") ?? "");
    return base ? applyLum(sch, base) : null;
  }
  return null;
}

/** Apply `a:lumMod` / `a:lumOff` (percent × 1000) in HSL, as Office does for theme tints. */
function applyLum(colorEl: XmlElement, hex: string): string | null {
  if (!/^[0-9A-F]{6}$/.test(hex)) return null;
  const mod = Number(child(colorEl, NS_A, "lumMod")?.getAttribute("val") ?? "100000") / 100000;
  const off = Number(child(colorEl, NS_A, "lumOff")?.getAttribute("val") ?? "0") / 100000;
  if (mod === 1 && off === 0) return hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  const l2 = Math.min(1, Math.max(0, l * mod + off));
  const hue = (p: number, q: number, t: number): number => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  let rgb: number[];
  if (s === 0) rgb = [l2, l2, l2];
  else {
    const q = l2 < 0.5 ? l2 * (1 + s) : l2 + s - l2 * s;
    const p = 2 * l2 - q;
    rgb = [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)];
  }
  return rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
}

const UNDERLINE: Readonly<Record<string, string>> = { sng: "single", dbl: "double" };

function runMarks(rPr: XmlElement | null, font: string | null, scheme: SchemeColors): TextRun["marks"] {
  const marks: TextRun["marks"] = [];
  const on = (name: string): boolean => ["1", "true"].includes(rPr?.getAttribute(name) ?? "");
  if (on("b")) marks.push({ type: "bold" });
  if (on("i")) marks.push({ type: "italic" });
  const u = rPr?.getAttribute("u");
  if (u && u !== "none") marks.push({ type: "underline", attrs: { style: UNDERLINE[u] ?? u } });
  const color = hexOf(child(rPr, NS_A, "solidFill"), scheme);
  if (color) marks.push({ type: "color", attrs: { hex: color } });
  const hl = hexOf(child(rPr, NS_A, "highlight"), scheme);
  if (hl) marks.push({ type: "highlight", attrs: { hex: hl } });
  if (font) marks.push({ type: "font", attrs: { family: font } });
  return marks;
}

function readPara(p: XmlElement, scheme: SchemeColors): Para {
  const level = Number(child(p, NS_A, "pPr")?.getAttribute("lvl") ?? "0");
  const runs: TextRun[] = [];
  for (const el of kids(p)) {
    if (el.namespaceURI !== NS_A) continue;
    if (el.localName === "br") {
      runs.push({ text: "\n", marks: [] });
      continue;
    }
    if (el.localName !== "r" && el.localName !== "fld") continue;
    const rPr = child(el, NS_A, "rPr");
    const raw = (child(el, NS_A, "t")?.textContent ?? "").normalize("NFC");
    const sym = child(rPr, NS_A, "sym")?.getAttribute("typeface") ?? null;
    const latin = child(rPr, NS_A, "latin")?.getAttribute("typeface") ?? null;
    for (const piece of mapRunText(raw, sym, latin)) runs.push({ text: piece.text, marks: runMarks(rPr, piece.font, scheme) });
  }
  return { el: p, level: Number.isInteger(level) && level >= 0 ? level : 0, runs, text: runs.map((r) => r.text).join("") };
}

/** Every shape on a slide holding text, in document order, each with its paragraphs. */
function slideShapes(slide: XmlElement, scheme: SchemeColors): Para[][] {
  const tree = child(child(slide, NS_P, "cSld"), NS_P, "spTree");
  if (!tree) return [];
  const shapes: Para[][] = [];
  const walk = (el: XmlElement): void => {
    for (const ce of kids(el)) {
      if (ce.namespaceURI === NS_P && ce.localName === "grpSp") walk(ce);
      else if (ce.namespaceURI === NS_P && (ce.localName === "sp" || ce.localName === "graphicFrame" || ce.localName === "cxnSp")) {
        shapes.push(descendants(ce, NS_A, "p").map((p) => readPara(p, scheme)));
      }
    }
  };
  walk(tree);
  return shapes;
}

/** Theme colors by scheme name, mapped through the first slide master's `p:clrMap`. */
function schemeColors(entries: Entries): SchemeColors {
  const out: SchemeColors = new Map();
  const themeName = Object.keys(entries).filter((n) => /^ppt\/theme\/theme\d+\.xml$/.test(n)).sort()[0];
  if (!themeName) return out;
  const scheme = descendants(rootOf(entries, themeName), NS_A, "clrScheme")[0];
  if (!scheme) return out;
  const base = new Map<string, string>();
  for (const el of kids(scheme)) {
    const val = child(el, NS_A, "srgbClr")?.getAttribute("val") ?? child(el, NS_A, "sysClr")?.getAttribute("lastClr");
    if (el.localName && val) base.set(el.localName, val.toUpperCase());
  }
  for (const [k, v] of base) out.set(k, v);
  const masterName = Object.keys(entries).filter((n) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(n)).sort()[0];
  const clrMap = masterName ? child(rootOf(entries, masterName), NS_P, "clrMap") : null;
  const mapping: Record<string, string> = { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2" };
  for (const alias of Object.keys(mapping)) {
    const target = clrMap?.getAttribute(alias) || mapping[alias];
    const hex = target ? base.get(target) : undefined;
    if (hex) out.set(alias, hex);
  }
  return out;
}

function slideParas(entries: Entries, name: string, scheme: SchemeColors): Para[][] {
  return slideShapes(rootOf(entries, name), scheme);
}

// ---- as-is decks: search text ---------------------------------------------------------------

/**
 * `text.json` pages of a PowerPoint shown as-is (30 §30.10): per slide, in `p:sldIdLst` order, the
 * text of its paragraphs in shape order joined with `\n`.
 */
export function slideTexts(bytes: Uint8Array): string[] {
  const entries = unzipSync(bytes);
  const scheme = schemeColors(entries);
  return slideParts(entries).map((name) => slideParas(entries, name, scheme).flat().map((p) => p.text).join("\n"));
}

// ---- the psych review deck ------------------------------------------------------------------

type InlineJSON = { type: "text"; text: string; marks?: TextRun["marks"] } | { type: "hard_break" };

function inline(runs: readonly TextRun[]): InlineJSON[] {
  const out: InlineJSON[] = [];
  for (const r of runs) {
    r.text.split("\n").forEach((piece, i) => {
      if (i > 0) out.push({ type: "hard_break" });
      if (piece !== "") out.push(r.marks.length ? { type: "text", text: piece, marks: r.marks } : { type: "text", text: piece });
    });
  }
  return out;
}

const BULLET = { text: "•", font: null, marks: [], tabPt: 12 };

function paragraphJSON(p: Para, inCardBody: boolean): Record<string, unknown> {
  const content = inline(p.runs);
  const attrs = inCardBody || p.level >= 1 ? { indLeft: 18 * Math.max(0, p.level - 1), marker: BULLET } : undefined;
  return { type: "paragraph", ...(attrs ? { attrs } : {}), ...(content.length ? { content } : {}) };
}

/**
 * One slide's doc (30 §30.10): the first shape holding text is the title (`heading_line`, its
 * paragraphs separated by hard breaks); the remaining text paragraphs, in order, are lead
 * paragraphs (level 0 with nothing deeper after it) or slide cards (a level-0 paragraph followed
 * by its deeper paragraphs). A deeper paragraph with no level-0 paragraph before it stays a
 * bulleted paragraph in place. Paragraphs with no text are skipped.
 */
export function slideDoc(shapes: readonly Para[][]): DocJSON {
  const withText = shapes.map((s) => s.filter((p) => p.text !== "")).filter((s) => s.length > 0);
  const [title = [], ...rest] = withText;
  const titleRuns: TextRun[] = title.flatMap((p, i) => (i === 0 ? p.runs : [{ text: "\n", marks: [] }, ...p.runs]));
  const titleContent = inline(titleRuns);
  const content: unknown[] = [{ type: "heading_line", ...(titleContent.length ? { content: titleContent } : {}) }];
  const paras = rest.flat();
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i] as Para;
    const next = paras[i + 1];
    if (p.level === 0 && next !== undefined && next.level > 0) {
      const card = [paragraphJSON(p, false)];
      while (i + 1 < paras.length && (paras[i + 1] as Para).level > 0) card.push(paragraphJSON(paras[++i] as Para, true));
      content.push({ type: "slide_card", content: card });
    } else {
      content.push(paragraphJSON(p, false));
    }
  }
  // The schema's own serialization: attribute defaults filled in, schema key and mark order.
  return Node.fromJSON(schema, { type: "doc", content }).toJSON() as DocJSON;
}

/** The deck's slides as docs, in `p:sldIdLst` order (30 §30.10 psych review deck). */
export function convertDeck(bytes: Uint8Array): DocJSON[] {
  const entries = unzipSync(bytes);
  const scheme = schemeColors(entries);
  return slideParts(entries).map((name) => slideDoc(slideParas(entries, name, scheme)));
}

/** Her requested edit (fidelity/rules/psychslide): on slide 2, this paragraph is removed. */
export const PSYCH_REMOVED_LINE = "DO NOT USE IN BIPOLAR DISORDER, EVEN IF DEPRESSED!";

export interface ParaOutline {
  text: string;
  level: number;
}

/** The slide's paragraph texts and levels in document order (every `a:p`, empty ones included). */
function outline(entries: Entries, name: string): ParaOutline[] {
  return descendants(rootOf(entries, name), NS_A, "p").map((p) => {
    const para = readPara(p, new Map());
    return { text: para.text, level: para.level };
  });
}

/** The expected outline after the slide-2 edit: the line removed and the next paragraph one level up. */
export function applyPsychEdit(paras: readonly ParaOutline[]): ParaOutline[] {
  const at = paras.findIndex((p) => p.text === PSYCH_REMOVED_LINE);
  if (at === -1 || paras.findIndex((p, i) => i > at && p.text === PSYCH_REMOVED_LINE) !== -1) {
    throw new Error(`slide 2: expected exactly one paragraph "${PSYCH_REMOVED_LINE}"`);
  }
  const next = paras[at + 1];
  if (!next || next.level < 1) throw new Error("slide 2: the paragraph after the removed line must exist and be at level 1 or deeper");
  return [...paras.slice(0, at), { text: next.text, level: next.level - 1 }, ...paras.slice(at + 2)];
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Her psych deck with the slide-2 edit applied (30 §30.10 download decision): in the slide-2 part,
 * the `a:p` reading {@link PSYCH_REMOVED_LINE} is deleted and the next `a:p`'s level lowered by one;
 * every other entry keeps identical bytes. The result is proven before it is returned: the same
 * entries in the same order, every other entry's SHA-256 unchanged, and the edited part's paragraph
 * texts and levels equal to her file's with exactly the edit applied. Returns the new package.
 */
export async function editPsychDeck(bytes: Uint8Array): Promise<{ bytes: Uint8Array; slidePart: string }> {
  const entries = unzipSync(bytes);
  const slidePart = slideParts(entries)[1];
  if (!slidePart) throw new Error("psych deck: no slide 2");
  const { doc, root } = parsePart(entries, slidePart);
  const paras = descendants(root, NS_A, "p");
  const target = paras.filter((p) => readPara(p, new Map()).text === PSYCH_REMOVED_LINE);
  if (target.length !== 1) throw new Error(`slide 2: expected exactly one paragraph "${PSYCH_REMOVED_LINE}", found ${target.length}`);
  const removed = target[0] as XmlElement;
  const next = paras[paras.indexOf(removed) + 1];
  if (!next) throw new Error("slide 2: no paragraph follows the removed line");
  const pPr = child(next, NS_A, "pPr");
  const level = Number(pPr?.getAttribute("lvl") ?? "0");
  if (!pPr || !(level >= 1)) throw new Error("slide 2: the paragraph after the removed line is not at level 1 or deeper");
  if (level - 1 === 0) pPr.removeAttribute("lvl");
  else pPr.setAttribute("lvl", String(level - 1));
  removed.parentNode?.removeChild(removed);

  const edited: Entries = {};
  for (const name of Object.keys(entries)) {
    edited[name] = name === slidePart ? strToU8(new XMLSerializer().serializeToString(doc)) : (entries[name] as Uint8Array);
  }
  const out = zipSync(edited);

  // Proof (30 §30.10), read back from the archive actually produced.
  const back = unzipSync(out);
  const names = Object.keys(entries);
  if (Object.keys(back).join("\n") !== names.join("\n")) throw new Error("psych deck edit: the edited package's entries differ from her file's");
  for (const name of names) {
    if (name === slidePart) continue;
    if ((await sha256(back[name] as Uint8Array)) !== (await sha256(entries[name] as Uint8Array))) {
      throw new Error(`psych deck edit: entry ${name} changed`);
    }
  }
  const want = applyPsychEdit(outline(entries, slidePart));
  const got = outline(back, slidePart);
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error("psych deck edit: slide 2 does not equal her slide with exactly the edit applied");
  return { bytes: out, slidePart };
}
