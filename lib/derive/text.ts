// Plain text of stored ProseMirror JSON, and table rows as the derivations read them.
import { columnCount, tableNode, type RowNodeLike } from "../content/tables.ts";
import type { BlockFile, DocJSON } from "../content/types.ts";

export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
}

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
  cells: string[];
}

export interface Table {
  block: string;
  columns: number;
  rows: Row[];
}

/** Rows of a stored table node, with cell texts. */
export function readRows(rows: readonly RowNodeLike[]): Row[] {
  return rows.map((r) => ({
    id: String(r.attrs?.id),
    kind: r.attrs?.kind === "heading" ? "heading" : "content",
    cells: ((r.content ?? []) as PMNode[]).map(nodeText),
  }));
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
    if ((n.type === "image" || n.type === "image_block") && typeof n.attrs?.asset === "string") out.add(n.attrs.asset);
    if (n.type === "drawing" && Array.isArray(n.attrs?.shapes)) {
      for (const s of n.attrs.shapes as { asset?: unknown }[]) if (typeof s.asset === "string") out.add(s.asset);
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
    const marker = n.attrs?.marker as { text?: unknown } | null | undefined;
    if (marker && typeof marker.text === "string") add(marker.text);
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc as PMNode);
}
