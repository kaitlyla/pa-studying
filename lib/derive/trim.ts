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

export type TrimSource = Pick<SystemJson, "blocks" | "rows" | "notesBlocks" | "trims" | "uses">;

/** Whether notes written for the pharm sections `use` (none: any use) show where `at` is relevant. */
const relevant = (use: readonly string[] | undefined, at: ReadonlySet<string>): boolean => use === undefined || use.some((s) => at.has(s));

/** The card's parts that show where the pharm sections `at` are relevant: those written for any use or one of them. */
export function shownParts<P extends { for?: string[] }>(card: { parts: readonly P[] }, at: ReadonlySet<string>): P[] {
  return card.parts.filter((p) => relevant(p.for, at));
}

/**
 * The pharm sections relevant where a meds panel shows: those its topic's condition section is
 * mapped to (`SystemJson.panelSections`).
 */
export function panelUses(system: Pick<SystemJson, "panelSections">, topic: { section: string | null }): Set<string> {
  return new Set(system.panelSections[topic.section ?? ""] ?? []);
}

/** Content rows of the given table blocks: what a pharm section page shows with its cards. */
export function tableRows(system: Pick<SystemJson, "rows">, tables: readonly string[]): Set<string> {
  const set = new Set(tables);
  return new Set(Object.entries(system.rows).filter(([, r]) => set.has(r.block)).map(([id]) => id));
}

const indentOf = (n: PMNode): number => (typeof n.attrs?.indLeft === "number" ? n.attrs.indLeft : 0);

/**
 * Each line's place in its block: the texts of the lines it sits under (each less indented line
 * before it, up to the last that is not), then its own text; null for a line without text or that is
 * not a paragraph. The block's first line — the part's title, which names the class differently in
 * each of her files — counts for no line under it.
 */
function lineKeys(nodes: readonly PMNode[]): (string | null)[] {
  const path: { indent: number; text: string }[] = [];
  return nodes.map((n, i) => {
    if (n.type !== "paragraph") {
      path.length = 0;
      return null;
    }
    const text = trimLineText(n);
    if (text === "") return null;
    while (path.length > 0 && (path[path.length - 1] as { indent: number }).indent >= indentOf(n)) path.pop();
    const key = [...path.map((p) => p.text), text].join("\n");
    path.push({ indent: indentOf(n), text: i === 0 ? "" : text });
    return key;
  });
}

/** Whether every line under paragraph `i` (more indented, up to the next that is not) is in `hidden`, and how many there are. */
function linesUnder(nodes: readonly PMNode[], i: number, hidden: ReadonlySet<number>): { under: number; allHidden: boolean } {
  const n = nodes[i] as PMNode;
  let under = 0;
  let allHidden = true;
  for (let j = i + 1; j < nodes.length; j++) {
    const m = nodes[j] as PMNode;
    if (m.type !== "paragraph" || indentOf(m) <= indentOf(n)) break;
    if (trimLineText(m) === "") continue;
    under++;
    if (!hidden.has(j)) allHidden = false;
  }
  return { under, allHidden };
}

/**
 * Paragraph indexes to leave out of each of the card's notes blocks (in card order), where the card
 * is shown with the rows in `shown` on a page where the pharm sections `at` are relevant. A line
 * written for another use goes (content/pharm/uses.json); a covered line goes when one of its rows is
 * shown and reads as judged; a label when it heads at least one line; and a line the card already
 * showed word for word under the same lines — her files on one class repeat each other. A line written
 * for another use is never shown, so it never makes a later line a repeat. Each stays while any line
 * under it (more indented, up to the next line that is not) stays, so nothing is left hanging under
 * the wrong heading.
 */
export function hiddenLines(system: TrimSource, blocks: readonly string[], shown: ReadonlySet<string>, at: ReadonlySet<string>): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  const blockDocs = new Map(system.blocks.map((b) => [b.id, b.doc]));
  const rowReads = (id: string, text: string): boolean => {
    const block = system.rows[id]?.block;
    const doc = block === undefined ? undefined : blockDocs.get(block);
    return shown.has(id) && doc !== undefined && rowTexts(doc).get(id) === text;
  };
  const seen = new Set<string>();
  for (const id of blocks) {
    const nodes = (system.notesBlocks[id]?.doc.content as PMNode[] | undefined) ?? [];
    const byText = new Map<string, PubTrimLine>((system.trims[id] ?? []).map((l) => [l.text, l]));
    const uses = new Map((system.uses[id] ?? []).map((l) => [l.text, l.for]));
    const offUse = nodes.map((n) => n.type === "paragraph" && !relevant(uses.get(trimLineText(n)), at));
    const offHidden = new Set<number>();
    for (let i = nodes.length - 1; i >= 0; i--) if (offUse[i] && linesUnder(nodes, i, offHidden).allHidden) offHidden.add(i);
    const repeated = lineKeys(nodes).map((k, i) => {
      if (k === null || offHidden.has(i)) return false;
      const again = seen.has(k);
      seen.add(k);
      return again;
    });
    const hidden = new Set<number>();
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i] as PMNode;
      if (n.type !== "paragraph") continue;
      const line = byText.get(trimLineText(n));
      const covered = line !== undefined && (line.label || line.rows.some((r) => rowReads(r.id, r.text)));
      if (!covered && !repeated[i] && !offUse[i]) continue;
      const { under, allHidden } = linesUnder(nodes, i, hidden);
      if (allHidden && (repeated[i] || offUse[i] || !line?.label || under > 0)) hidden.add(i);
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
