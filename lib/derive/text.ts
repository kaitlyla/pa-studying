// Plain text of stored ProseMirror JSON, and table rows as the derivations read them.
import { columnCount, tableNode, type RowNodeLike } from "../content/tables.ts";
import type { BlockFile, DocJSON } from "../content/types.ts";
import { isNode, type PMNode } from "../schemaTypes.ts";
import { placeCells } from "../wordFormat.ts";

export type { PMNode };

const TEXTBLOCKS = new Set(["paragraph", "heading_line"]);

/** A node's text: text blocks concatenate their inline content; other containers join children with "\n". */
export function nodeText(node: PMNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hard_break") return "\n";
  const parts = (node.content ?? []).map(nodeText);
  return parts.join(TEXTBLOCKS.has(node.type) ? "" : "\n");
}

export function docText(doc: DocJSON): string {
  return nodeText(doc as PMNode);
}

/** Whitespace (including line breaks and tabs) collapsed to single spaces, trimmed. */
export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Search text: tabs and line breaks as spaces, NFC (60 §60.1). */
export function searchText(text: string): string {
  return text.replace(/[\t\r\n]/g, " ").normalize("NFC");
}

export interface Row {
  id: string;
  kind: "heading" | "content";
  /**
   * Cell texts by grid column: a cell's text sits at its first column, and every column it covers
   * beyond that (a column span), or that a row span from above covers, reads as "".
   */
  cells: string[];
}

export interface Table {
  block: string;
  columns: number;
  rows: Row[];
}

/**
 * Rows of a stored table node (all of its rows, in order), with cell texts by grid column. Her name
 * cell is often merged down over the row below, which stores no cell for it; reading cells by
 * position would take that row's next cell for its name, so cells are placed on the table grid.
 */
export function readRows(rows: readonly RowNodeLike[]): Row[] {
  const { cells: placed, columns } = placeCells(rows as readonly { content?: readonly PMNode[] }[]);
  const out: Row[] = rows.map((r) => ({
    id: String(r.attrs?.id),
    kind: r.attrs?.kind === "heading" ? "heading" : "content",
    cells: Array<string>(columns).fill(""),
  }));
  for (const p of placed) (out[p.row] as Row).cells[p.col] = nodeText(p.node);
  return out;
}

/** The single table of a `table` block. */
export function tableOf(block: BlockFile): Table | null {
  const table = block.kind === "table" ? tableNode(block) : null;
  return table ? { block: block.id, columns: columnCount(table), rows: readRows(table.content ?? []) } : null;
}

export function firstCell(row: Row): string {
  return row.cells[0] ?? "";
}

/** Adds to `out` the `asset` attribute of every image, image_block and drawing shape in a doc. */
export function assetsOf(doc: DocJSON, out: Set<string>): void {
  const walk = (n: PMNode): void => {
    if (isNode(n, "image") || isNode(n, "image_block")) out.add(n.attrs.asset);
    if (isNode(n, "drawing")) {
      for (const s of n.attrs.shapes) if (s.asset !== null) out.add(s.asset);
    }
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc as PMNode);
}

/** Every code point of the text and paragraph markers of a doc. */
export function codePointsOf(doc: DocJSON, out: Set<number>): void {
  const add = (s: string): void => {
    for (const ch of s) out.add(ch.codePointAt(0) ?? 0);
  };
  const walk = (n: PMNode): void => {
    if (n.type === "text") add(n.text ?? "");
    if (isNode(n, "paragraph") && n.attrs.marker) add(n.attrs.marker.text);
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc as PMNode);
}
