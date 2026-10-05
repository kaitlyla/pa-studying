// Which pharm-notes lines a card leaves out where her guide table, shown beside it, already says
// them (content/pharm/trims.json). Shared by the pages and the PDFs, and run on the published page
// data, so an edit to a line or a row — saved, or still in the editor overlay — shows the line again.
import type { DocJSON } from "../content/types.ts";
import type { PubTrimLine, SystemJson } from "./published.ts";
import { collapse, nodeText, readRows, type PMNode, type Row } from "./text.ts";

/** A row's text as judgments record it: its cells, each collapsed, in grid order. */
export function trimRowText(row: Row): string {
  return row.cells.map(collapse).join(" | ");
}

/** A notes line's text as judgments record it. */
export function trimLineText(node: PMNode): string {
  return collapse(nodeText(node));
}

const rowTextCache = new WeakMap<object, Map<string, string>>();

function rowTexts(doc: DocJSON): Map<string, string> {
  let m = rowTextCache.get(doc);
  if (!m) {
    const table = (doc.content as PMNode[] | undefined)?.find((n) => n.type === "table");
    m = new Map(readRows(table?.content ?? []).map((r) => [r.id, trimRowText(r)]));
    rowTextCache.set(doc, m);
  }
  return m;
}

export type TrimSource = Pick<SystemJson, "blocks" | "rows" | "notesBlocks" | "trims">;

/** Content rows of the given table blocks: what a pharm section page shows with its cards. */
export function tableRows(system: Pick<SystemJson, "rows">, tables: readonly string[]): Set<string> {
  const set = new Set(tables);
  return new Set(Object.entries(system.rows).filter(([, r]) => set.has(r.block)).map(([id]) => id));
}

const indentOf = (n: PMNode): number => (typeof n.attrs?.indLeft === "number" ? n.attrs.indLeft : 0);

/**
 * Paragraph indexes to leave out of each of the card's notes blocks, where the card is shown with the
 * rows in `shown`. A covered line goes when one of its rows is shown and reads as judged, and a
 * label when it heads at least one line; either stays while any line under it (more indented, up to
 * the next line that is not) stays, so nothing is left hanging under the wrong heading.
 */
export function hiddenLines(system: TrimSource, blocks: readonly string[], shown: ReadonlySet<string>): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  const blockDocs = new Map(system.blocks.map((b) => [b.id, b.doc]));
  const rowReads = (id: string, text: string): boolean => {
    const block = system.rows[id]?.block;
    const doc = block === undefined ? undefined : blockDocs.get(block);
    return shown.has(id) && doc !== undefined && rowTexts(doc).get(id) === text;
  };
  for (const id of blocks) {
    const judged = system.trims[id];
    const nodes = (system.notesBlocks[id]?.doc.content as PMNode[] | undefined) ?? [];
    if (!judged || nodes.length === 0) continue;
    const byText = new Map<string, PubTrimLine>(judged.map((l) => [l.text, l]));
    const hidden = new Set<number>();
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i] as PMNode;
      if (n.type !== "paragraph") continue;
      const line = byText.get(trimLineText(n));
      if (!line) continue;
      if (!line.label && !line.rows.some((r) => rowReads(r.id, r.text))) continue;
      let under = 0;
      let allHidden = true;
      for (let j = i + 1; j < nodes.length; j++) {
        const m = nodes[j] as PMNode;
        if (m.type !== "paragraph" || indentOf(m) <= indentOf(n)) break;
        if (trimLineText(m) === "") continue;
        under++;
        if (!hidden.has(j)) allHidden = false;
      }
      if (allHidden && (!line.label || under > 0)) hidden.add(i);
    }
    if (hidden.size > 0) out.set(id, hidden);
  }
  return out;
}

/** The doc without the given top-level paragraphs. */
export function withoutLines(doc: DocJSON, hidden: ReadonlySet<number> | undefined): DocJSON {
  if (!hidden || hidden.size === 0) return doc;
  return { ...doc, content: (doc.content as PMNode[]).filter((_, i) => !hidden.has(i)) } as DocJSON;
}

/** Whether every line of the blocks with any text is left out. */
export function allLinesHidden(system: TrimSource, blocks: readonly string[], hidden: ReadonlyMap<string, ReadonlySet<number>>): boolean {
  return blocks.every((id) => ((system.notesBlocks[id]?.doc.content as PMNode[] | undefined) ?? []).every((n, i) => (hidden.get(id)?.has(i) ?? false) || (n.type === "paragraph" && trimLineText(n) === "")));
}
