// The schema's node and mark types, looked up once and checked, for the editor's commands and views.
import type { MarkType, NodeType } from "prosemirror-model";
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
  underline: markType("underline"),
  highlight: markType("highlight"),
  shade: markType("shade"),
  size: markType("size"),
} as const;
