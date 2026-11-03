// The schema's node and mark types, looked up once and checked, for the editor's commands and views,
// and what both read of a position's table cell.
import type { MarkType, NodeType, ResolvedPos } from "prosemirror-model";
import type { CellMargins } from "../../../lib/schemaTypes.ts";
import { schema } from "../../../lib/schema.ts";

function nodeType(name: string): NodeType {
  const t = schema.nodes[name];
  if (!t) throw new Error(`The schema has no node type ${name}`);
  return t;
}

function markType(name: string): MarkType {
  const t = schema.marks[name];
  if (!t) throw new Error(`The schema has no mark type ${name}`);
  return t;
}

export const N = {
  doc: nodeType("doc"),
  paragraph: nodeType("paragraph"),
  heading_line: nodeType("heading_line"),
  image: nodeType("image"),
  image_block: nodeType("image_block"),
  anchored: nodeType("anchored"),
  table: nodeType("table"),
  table_row: nodeType("table_row"),
  table_cell: nodeType("table_cell"),
} as const;

export const M = {
  bold: markType("bold"),
  italic: markType("italic"),
  underline: markType("underline"),
  highlight: markType("highlight"),
  shade: markType("shade"),
  color: markType("color"),
  size: markType("size"),
} as const;

/** The left margin (pt) of the table cell `$pos` (a position before a block) is directly in, or undefined. */
export function cellMarginLeftAt($pos: ResolvedPos): number | undefined {
  if ($pos.parent.type !== N.table_cell || $pos.depth < 2) return undefined;
  const table = $pos.node($pos.depth - 2);
  return table.type === N.table ? (table.attrs.cellMarginPt as CellMargins).left : undefined;
}
