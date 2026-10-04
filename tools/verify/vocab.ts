// Completeness of the abbreviation vocabulary (30 §30.11, §30.13), written without tools/import: the
// expected entries are read from the .docx's own tables and compared with content/vocab/abbreviations.json.
import { unzipSync } from "fflate";
import type { Element } from "@xmldom/xmldom";
import type { VocabFile } from "../../lib/content/index.ts";
import type { Discrepancy } from "./compare.ts";
import { align } from "./compare.ts";
import type { InfoEntry } from "./extract.ts";
import { W, elementsOf, els, parse } from "./xml.ts";

const HEADER = ["Abbreviation", "Meaning", "Notes"];

export interface VocabEntry {
  abbr: string[];
  meanings: string[];
}

/** An expected entry with the table (1-based, among vocabulary tables) and row (1-based, header = 1) it came from. */
export interface ExpectedEntry extends VocabEntry {
  table: number;
  row: number;
}

function descendants(e: Element, local: string): Element[] {
  const out: Element[] = [];
  const walk = (x: Element): void => {
    for (const k of elementsOf(x)) {
      if (k.namespaceURI === W && k.localName === local) out.push(k);
      walk(k);
    }
  };
  walk(e);
  return out;
}

/** A cell's text: each paragraph's w:t text, paragraphs joined by a line break, NFC. */
function cellText(tc: Element): string {
  return descendants(tc, "p").map((p) => descendants(p, "t").map((t) => t.textContent ?? "").join("")).join("\n").normalize("NFC");
}

const split = (s: string): string[] => s.split(" / ").map((x) => x.trim());

/** The expected entries of the vocabulary .docx, and the rows skipped for an empty first or second cell. */
export function vocabEntries(docx: Uint8Array): { tables: number; entries: ExpectedEntry[]; skipped: { table: number; row: number; cells: string[] }[] } {
  const files = unzipSync(docx, { filter: (f) => f.name === "word/document.xml" });
  const doc = files["word/document.xml"];
  if (!doc) throw new Error("word/document.xml is missing");
  const root = parse(new TextDecoder().decode(doc), "word/document.xml");
  const entries: ExpectedEntry[] = [];
  const skipped: { table: number; row: number; cells: string[] }[] = [];
  let tables = 0;
  for (const tbl of descendants(root, "tbl")) {
    const rows = els(tbl, "tr");
    const head = rows[0] ? els(rows[0], "tc").map((c) => cellText(c).trim()) : [];
    if (JSON.stringify(head) !== JSON.stringify(HEADER)) continue;
    tables++;
    rows.slice(1).forEach((tr, i) => {
      const cells = els(tr, "tc").map(cellText);
      const [first = "", second = ""] = cells;
      if (!first.trim() || !second.trim()) skipped.push({ table: tables, row: i + 2, cells });
      else entries.push({ abbr: split(first), meanings: split(second), table: tables, row: i + 2 });
    });
  }
  return { tables, entries, skipped };
}

const key = (e: VocabEntry): string => JSON.stringify([e.abbr, e.meanings]);

/** Discrepancies between the expected entries and the stored vocabulary, in order. */
export function compareVocab(expected: ExpectedEntry[], stored: VocabFile | null): Discrepancy[] {
  if (!stored) return [{ kind: "file", story: "vocab", index: -1, expected: "content/vocab/abbreviations.json", actual: null }];
  const got = stored.entries;
  const out: Discrepancy[] = [];
  const where = (e: ExpectedEntry): string => `table ${e.table} row ${e.row}`;
  const { pairs, missing, extra } = align(expected.map(key), got.map(key));
  for (const i of missing) out.push({ kind: "vocab", story: where(expected[i]!), index: i, expected: { abbr: expected[i]!.abbr, meanings: expected[i]!.meanings }, actual: null });
  for (const j of extra) out.push({ kind: "vocab", story: "stored", index: j, expected: null, actual: got[j] });
  for (const [i, j] of pairs) {
    if (key(expected[i]!) !== key(got[j]!)) {
      out.push({ kind: "vocab", story: where(expected[i]!), index: i, expected: { abbr: expected[i]!.abbr, meanings: expected[i]!.meanings }, actual: got[j] });
    }
  }
  return out;
}

/** Info entries naming each skipped row, so no row is dropped silently. */
export function skippedInfo(skipped: { table: number; row: number; cells: string[] }[]): InfoEntry[] {
  return skipped.map((s) => ({ kind: "vocabRowSkipped", table: s.table, row: s.row, reason: "empty first or second cell", cells: s.cells }));
}
