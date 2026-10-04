// The abbreviation vocabulary (30 §30.11) from the converted Master_Abbreviation_Vocabulary.docx.
import type { VocabFile } from "../../lib/content/index.ts";

interface NodeJSON {
  type: string;
  text?: string;
  content?: NodeJSON[];
}

const HEADER = ["Abbreviation", "Meaning", "Notes"];

/** Every `table` node in document order, nested tables included. */
function tables(nodes: readonly NodeJSON[]): NodeJSON[] {
  const out: NodeJSON[] = [];
  const walk = (n: NodeJSON): void => {
    if (n.type === "table") out.push(n);
    n.content?.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

/** A node's text: text nodes verbatim, a hard break as `\n`, paragraphs separated by `\n`. */
function textOf(n: NodeJSON): string {
  if (n.type === "text") return n.text ?? "";
  if (n.type === "hard_break") return "\n";
  const kids = n.content ?? [];
  const sep = kids.some((k) => k.type === "paragraph") ? "\n" : "";
  return kids.map(textOf).join(sep);
}

const split = (cell: string): string[] => cell.split(" / ").map((s) => s.trim()).filter((s) => s !== "");

/**
 * Read the vocabulary tables: those whose first row's cells read Abbreviation, Meaning, Notes. Each
 * later row pairs every abbreviation (first cell, split on " / ") with every meaning (second cell,
 * split likewise) in one entry, text kept as written. Rows with an empty first or second cell are
 * skipped and counted.
 */
export function readVocab(nodes: readonly unknown[]): { vocab: VocabFile; tables: number; skipped: number } {
  const entries: VocabFile["entries"] = [];
  let count = 0;
  let skipped = 0;
  for (const table of tables(nodes as NodeJSON[])) {
    const [head, ...rows] = table.content ?? [];
    const headCells = (head?.content ?? []).map((c) => textOf(c).trim());
    if (headCells.join("\u0000") !== HEADER.join("\u0000")) continue;
    count++;
    for (const row of rows) {
      const cells = (row.content ?? []).map(textOf);
      const abbr = split(cells[0] ?? "");
      const meanings = split(cells[1] ?? "");
      if (abbr.length === 0 || meanings.length === 0) skipped++;
      else entries.push({ abbr, meanings });
    }
  }
  return { vocab: { v: 1, entries }, tables: count, skipped };
}
