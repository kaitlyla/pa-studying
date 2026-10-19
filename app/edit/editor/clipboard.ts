// What a paste brings into the editor: its lines, each a list of text runs with their marks. Copied
// HTML (her site, another editor, Word, a web page) keeps bold, italic, underline, text color and
// highlight (her 2026-10-19 request); plain text takes the formatting of the place it is pasted.
import type { Mark } from "prosemirror-model";
import { M } from "./types.ts";

export interface PastedRun {
  text: string;
  marks: readonly Mark[];
}

/** One pasted line: a paragraph of its own when the paste has several. */
export type PastedLine = PastedRun[];

/** The mark types a paste carries from copied HTML; every other mark comes from where it is pasted. */
const CARRIED = [M.bold, M.italic, M.underline, M.color, M.highlight];

/** Plain text, one line per line break, each with `marks` (the pasted-at position's). */
export function textLines(text: string, marks: readonly Mark[]): PastedLine[] {
  return text.replace(/\r\n?/g, "\n").split("\n").map((line) => (line ? [{ text: line, marks }] : []));
}

const BLOCKS = new Set(["P", "DIV", "LI", "UL", "OL", "TABLE", "TBODY", "THEAD", "TFOOT", "TR", "TD", "TH", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "SECTION", "ARTICLE"]);
const PARAGRAPHS = new Set(["P", "LI", "H1", "H2", "H3", "H4", "H5", "H6"]);
const SKIPPED = new Set(["HEAD", "META", "STYLE", "SCRIPT", "TITLE", "TEMPLATE"]);

/**
 * A CSS color as the schema's 6-digit uppercase hex, or null for none or transparent. A named color
 * (Word writes a highlight as `background:yellow`) is resolved by the browser: the computed color of a
 * probe element holding it.
 */
export function cssColorHex(value: string): string | null {
  if (value === "") return null;
  const direct = rgbHex(value);
  if (direct !== null) return direct;
  const probe = document.createElement("span");
  probe.style.color = value;
  if (probe.style.color === "") return null;
  document.body.append(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  return rgbHex(computed);
}

/** A hex or rgb()/rgba() color as 6-digit uppercase hex; null for any other form or a transparent one. */
function rgbHex(value: string): string | null {
  const v = value.trim();
  const short = /^#([0-9a-f]{3})$/i.exec(v);
  if (short) return [...(short[1] as string)].map((c) => c + c).join("").toUpperCase();
  const long = /^#([0-9a-f]{6})$/i.exec(v);
  if (long) return (long[1] as string).toUpperCase();
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(v);
  if (!rgb) return null;
  if (rgb[4] !== undefined && Number(rgb[4]) === 0) return null;
  return rgb.slice(1, 4).map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** `marks` as `el` changes them: its tag and inline style turn bold, italic and underline on or off and set color and highlight. */
function elementMarks(el: HTMLElement, marks: readonly Mark[]): readonly Mark[] {
  let out = marks;
  const set = (mark: Mark): void => void (out = mark.addToSet(out));
  const unset = (type: (typeof CARRIED)[number]): void => void (out = type.removeFromSet(out));
  const tag = el.tagName;
  const s = el.style;
  if (tag === "B" || tag === "STRONG") set(M.bold.create());
  if (tag === "I" || tag === "EM") set(M.italic.create());
  if (tag === "U") set(M.underline.create());
  const weight = s.fontWeight;
  if (weight === "bold" || weight === "bolder" || Number(weight) >= 600) set(M.bold.create());
  else if (weight === "normal" || weight === "lighter" || (weight !== "" && Number(weight) < 600)) unset(M.bold);
  if (s.fontStyle === "italic" || s.fontStyle === "oblique") set(M.italic.create());
  else if (s.fontStyle === "normal") unset(M.italic);
  const deco = `${s.textDecorationLine} ${s.textDecoration}`;
  if (deco.includes("underline")) set(M.underline.create());
  // A block's color is the copied page's text color around it, not a color she gave the text.
  if (!BLOCKS.has(tag)) {
    const color = cssColorHex(s.color);
    if (color) set(M.color.create({ hex: color }));
    const bg = cssColorHex(s.backgroundColor);
    if (bg) set(M.highlight.create({ hex: bg }));
  }
  return out;
}

/**
 * Copied HTML as lines: one per block (paragraph, list item, table cell) and per line break, an empty
 * block (`<p><br></p>`) being one empty line. Each run has `base` (the pasted-at position's marks less
 * the carried ones) plus the bold, italic, underline, color and highlight it has in the copy. A list
 * marker drawn beside a paragraph (`.marker`) is not text and is left out.
 */
export function htmlLines(html: string, base: readonly Mark[]): PastedLine[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const start = CARRIED.reduce<readonly Mark[]>((ms, t) => t.removeFromSet(ms), base);
  const lines: PastedLine[] = [];
  let line: PastedLine = [];
  let open = false;
  const flush = (): void => {
    lines.push(line);
    line = [];
    open = false;
  };
  const walk = (node: Node, marks: readonly Mark[]): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = node.nodeValue ?? "";
      // Whitespace holding a line break is the HTML's own layout (Word wraps its HTML at 80 columns):
      // nothing before a line's text, one space within it.
      if (/^\s*$/.test(raw) && /[\r\n]/.test(raw)) {
        if (open) line.push({ text: " ", marks });
        return;
      }
      line.push({ text: raw.replace(/\r?\n/g, " "), marks });
      open = true;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (SKIPPED.has(el.tagName) || el.classList.contains("marker") || el.style.display === "none") return;
    if (el.tagName === "BR") {
      flush();
      return;
    }
    const block = BLOCKS.has(el.tagName);
    if (block && open) flush();
    const before = lines.length;
    const own = elementMarks(el, marks);
    el.childNodes.forEach((c) => walk(c, own));
    if (block && open) flush();
    // An empty paragraph (an editor copies hers as <p></p>) is an empty line of its own.
    else if (PARAGRAPHS.has(el.tagName) && lines.length === before) flush();
  };
  walk(doc.body, start);
  if (open) flush();
  return lines.map((l) => l.filter((r) => r.text !== ""));
}
