// Expected paragraph texts of the psych review deck (30 §30.10, §30.13), extracted independently of
// the importer: slides in p:sldIdLst order; per slide, the paragraphs of its text-holding shapes in
// document order; the first shape that holds text is the title (one entry, its paragraphs joined by
// line breaks). Her one requested edit on slide 2 is applied to the expected list.
import { unzipSync } from "fflate";
import type { Element } from "@xmldom/xmldom";
import { A, P, R, elementsOf, parse, plain } from "./xml.ts";

/** The line she asked to remove from slide 2 (fidelity/rules/psychslide). */
export const REMOVED_LINE = "DO NOT USE IN BIPOLAR DISORDER, EVEN IF DEPRESSED!";

const SYMBOLS: Record<string, Record<number, string>> = { wingdings: { 0xf0e0: "→", 0xf0a7: "▪", 0xf06e: "■", 0xf0d8: "➢" }, symbol: { 0xf0b7: "•" } };
const SYMBOL_FONTS = new Set(["symbol", "wingdings", "wingdings 2", "wingdings 3", "webdings"]);

function all(e: Element, ns: string, local: string): Element[] {
  const out: Element[] = [];
  const walk = (x: Element): void => {
    for (const k of elementsOf(x)) {
      if (k.namespaceURI === ns && k.localName === local) out.push(k);
      walk(k);
    }
  };
  walk(e);
  return out;
}

function runFont(r: Element, cp: number): string {
  const rPr = elementsOf(r).find((k) => k.localName === "rPr");
  const pick = (name: string): string => plain(elementsOf(rPr ?? null).find((k) => k.localName === name), "typeface") ?? "";
  return cp >= 0xf000 && cp <= 0xf0ff ? pick("sym") : pick("latin");
}

function paraText(p: Element): string {
  let s = "";
  for (const k of elementsOf(p)) {
    if (k.namespaceURI !== A) continue;
    if (k.localName === "br") { s += "\n"; continue; }
    if (k.localName !== "r" && k.localName !== "fld") continue;
    const t = elementsOf(k).find((x) => x.localName === "t" && x.namespaceURI === A);
    for (const ch of (t?.textContent ?? "").normalize("NFC")) {
      const cp = ch.codePointAt(0) ?? 0;
      const font = runFont(k, cp).toLowerCase();
      const code = cp < 0x100 ? 0xf000 + cp : cp;
      s += SYMBOL_FONTS.has(font) ? (SYMBOLS[font]?.[code] ?? ch) : ch;
    }
  }
  return s.normalize("NFC");
}

/** The expected stored paragraph texts of each slide, in slide order, with the slide-2 edit applied. */
export function deckParagraphs(bytes: Uint8Array): string[][] {
  const files = unzipSync(bytes);
  const read = (name: string): Element => parse(new TextDecoder().decode(files[name]!), name);
  const pres = read("ppt/presentation.xml");
  const relsRoot = read("ppt/_rels/presentation.xml.rels");
  const targets = new Map(elementsOf(relsRoot).map((r) => [plain(r, "Id"), plain(r, "Target")]));
  const ids = all(pres, P, "sldId").map((s) => s.getAttributeNS(R, "id"));
  return ids.map((id, n) => {
    const target = targets.get(id) ?? "";
    const part = target.startsWith("/") ? target.slice(1) : `ppt/${target}`;
    const tree = all(read(part), P, "spTree")[0];
    const shapes: string[][] = [];
    const walk = (e: Element): void => {
      for (const k of elementsOf(e)) {
        if (k.namespaceURI === P && ["sp", "graphicFrame", "cxnSp"].includes(k.localName ?? "")) {
          const paras = all(k, A, "p").map(paraText).filter((t) => t !== "");
          if (paras.length) shapes.push(paras);
        } else if (k.namespaceURI === P && k.localName === "grpSp") walk(k);
      }
    };
    if (tree) walk(tree);
    if (!shapes.length) return [];
    const [title, ...rest] = shapes;
    const list = [title!.join("\n"), ...rest.flat()];
    return n === 1 ? list.filter((t) => t !== REMOVED_LINE) : list;
  });
}
