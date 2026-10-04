// The stored JSON shapes of lib/schema.ts's nodes and marks. schema.ts checks its attribute specs
// against these types, so every consumer (importer, build, renderer, PDF, Word, editor) reads one
// definition instead of redeclaring or casting.

export type Side = "top" | "right" | "bottom" | "left";
export type TableSide = Side | "insideH" | "insideV";

export type Border = {
  /** Word ST_Border value, or a drawing's solid/dash/dot. */
  style: string;
  widthPt: number;
  /** 6-digit uppercase hex, no `#`. */
  color: string;
};

/** A paragraph's borders: every side present, null when that side has none. */
export type ParagraphBorders = Record<Side, Border | null>;
export type TableBorders = Record<TableSide, Border | null>;
/** A cell's overrides of its table's borders: an absent side inherits. */
export type CellBorders = Partial<Record<Side, Border | null>>;
export type CellMargins = Record<Side, number>;

export type LineSpacing = { rule: "auto" | "exact" | "atLeast"; value: number };

/** A list paragraph's resolved marker (number or bullet text). */
export type ListMarker = {
  text: string;
  /** The marker's own font, when it differs from the paragraph's (e.g. Symbol bullets). */
  font: string | null;
  marks: MarkJSON[];
  tabPt: number;
};

export type DrawingStroke = { color: string; widthPt: number; dash: string | null };

export type DrawingShape = {
  geom: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  flipH: boolean;
  flipV: boolean;
  stroke: DrawingStroke | null;
  fill: string | null;
  head: string | null;
  tail: string | null;
  asset: string | null;
};

export type ImageAttrs = {
  asset: string;
  widthPt: number;
  heightPt: number;
  rot: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
};

export type ParagraphAttrs = {
  indLeft: number;
  indRight: number;
  indFirst: number;
  spaceBefore: number;
  spaceAfter: number;
  line: LineSpacing | null;
  align: "left" | "center" | "right" | "justify";
  shade: string | null;
  borders: ParagraphBorders | null;
  marker: ListMarker | null;
};

export type AnchoredAttrs = { offsetPt: number };
export type RuleAttrs = { color: string; widthPt: number };
export type TextboxAttrs = { widthPt: number; fill: string | null; border: Border | null; inline: boolean };
export type DrawingAttrs = { widthPt: number; heightPt: number; shapes: DrawingShape[] };
export type DrawingTextAttrs = { x: number; y: number; w: number; h: number; fill: string | null; border: Border | null };
export type TableAttrs = { grid: number[]; indentPt: number; borders: TableBorders; cellMarginPt: CellMargins };
export type TableRowAttrs = {
  id: string;
  kind: "heading" | "content";
  minHeightPt: number | null;
  repeatHeader: boolean;
  cantSplit: boolean;
};
export type TableCellAttrs = {
  colspan: number;
  rowspan: number;
  colwidth: null;
  fill: string | null;
  vAlign: "top" | "center" | "bottom";
  borders: CellBorders | null;
};

/** Attributes of every node type that has them. */
export type NodeAttrs = {
  paragraph: ParagraphAttrs;
  image: ImageAttrs;
  anchored: AnchoredAttrs;
  image_block: ImageAttrs;
  rule: RuleAttrs;
  textbox: TextboxAttrs;
  drawing: DrawingAttrs;
  drawing_text: DrawingTextAttrs;
  table: TableAttrs;
  table_row: TableRowAttrs;
  table_cell: TableCellAttrs;
};

/** Node types without attributes; their JSON has no `attrs`. */
export type PlainNodeName = "doc" | "heading_line" | "text" | "hard_break" | "page_break" | "slide_card";
export type NodeName = keyof NodeAttrs | PlainNodeName;

/** Attributes of every mark type that has them. */
export type MarkAttrs = {
  link: { href: string };
  underline: { style: string };
  strike: { double: boolean };
  vertAlign: { value: "sup" | "sub" };
  size: { pt: number };
  color: { hex: string };
  highlight: { hex: string };
  shade: { hex: string };
  font: { family: string };
};

export type PlainMarkName = "bold" | "italic" | "caps" | "smallCaps";
export type MarkName = keyof MarkAttrs | PlainMarkName;

/** A stored mark: `attrs` is present exactly when the mark type has attributes. */
export type MarkJSON =
  | { [K in keyof MarkAttrs]: { type: K; attrs: MarkAttrs[K] } }[keyof MarkAttrs]
  | { type: PlainMarkName };

/** Any stored node, as code that walks a doc without regard to node type reads it. */
export type PMNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: MarkJSON[];
};

/** A stored node of type `K`, with that type's attributes. */
export type NodeJSON<K extends NodeName> = K extends "text"
  ? { type: "text"; text: string; marks?: MarkJSON[] }
  : K extends keyof NodeAttrs
    ? { type: K; attrs: NodeAttrs[K]; content?: PMNode[]; marks?: MarkJSON[] }
    : { type: K; content?: PMNode[] };

/** Narrows a node of validated content (lib/content checks every stored doc against the schema) by its type. */
export function isNode<K extends NodeName>(node: PMNode, type: K): node is PMNode & NodeJSON<K> {
  return node.type === type;
}

/** Narrows a stored mark by its type. */
export function isMark<K extends MarkName>(mark: MarkJSON, type: K): mark is Extract<MarkJSON, { type: K }> {
  return mark.type === type;
}
