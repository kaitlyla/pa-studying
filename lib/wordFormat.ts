// How stored Word formatting reads, shared by the screen renderer (app/render) and the PDF builder
// (lib/pdf) so both draw a document the same way. Renderer-neutral and browser-safe: each renderer maps
// these answers to CSS or to pdfmake.
import type { Side, TableSide } from "./schemaTypes.ts";

/** Word's default tab stops: every 36 pt from the text margin. */
export const TAB_STOP_PT = 36;
/** Word's default text-box insets: 0.1 in left and right, 0.05 in top and bottom. */
export const TEXTBOX_INSET_X_PT = 7.2;
export const TEXTBOX_INSET_Y_PT = 3.6;

export type UnderlineKind = "solid" | "double" | "dotted" | "dashed" | "wavy";

/**
 * A Word underline style (ST_Underline) as the line it draws. Mixed dash patterns (dotDash,
 * dotDotDash, dashLong…) draw dashed.
 */
export function underlineKind(style: string): UnderlineKind {
  const s = style.toLowerCase();
  if (s.startsWith("double")) return "double";
  if (s.startsWith("wav")) return "wavy";
  if (s.includes("dash")) return "dashed";
  if (s.includes("dot")) return "dotted";
  return "solid";
}

/** True when a stored border draws a line: present, of positive width, and not style none/nil (any case). */
export function borderVisible<B extends { style: string; widthPt: number }>(b: B | null | undefined): b is B {
  if (!b || b.widthPt <= 0) return false;
  const s = b.style.toLowerCase();
  return s !== "none" && s !== "nil";
}

/**
 * The border a cell side starts from: the table's outer border on the table's edge, its inside
 * border otherwise. A cell's own border for that side, when stored, replaces it (`cellSide`).
 */
export function edgeBorder<B>(table: Partial<Record<TableSide, B | null>>, side: Side, onEdge: boolean): B | null {
  if (onEdge) return table[side] ?? null;
  return (side === "top" || side === "bottom" ? table.insideH : table.insideV) ?? null;
}

/** A cell side's border: the cell's own when it stores that side (null included), else `edgeBorder`. */
export function cellSide<B>(
  table: Partial<Record<TableSide, B | null>>,
  cell: Partial<Record<Side, B | null>> | null | undefined,
  side: Side,
  onEdge: boolean,
): B | null {
  if (cell && side in cell) return cell[side] ?? null;
  return edgeBorder(table, side, onEdge);
}

export interface PlacedCell<C> {
  node: C;
  /** Row where the cell starts. */
  row: number;
  col: number;
  colspan: number;
  /** Rows covered, clamped to the rows the table has. */
  rowspan: number;
}

interface CellLike {
  attrs?: Record<string, unknown> | null;
}

const span = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : 1);

/**
 * Grid position of every cell: each cell takes the next column not covered by a row span from
 * above. A row span reaching past the last row is clamped. `columns` is the width of the grid used.
 */
export function placeCells<C extends CellLike>(rows: readonly { content?: readonly C[] | null }[]): { cells: PlacedCell<C>[]; columns: number } {
  const taken: Set<number>[] = rows.map(() => new Set());
  const cells: PlacedCell<C>[] = [];
  let columns = 0;
  rows.forEach((row, r) => {
    let col = 0;
    for (const node of row.content ?? []) {
      while (taken[r]?.has(col)) col++;
      const colspan = span(node.attrs?.colspan);
      const rowspan = Math.min(span(node.attrs?.rowspan), rows.length - r);
      for (let rr = r; rr < r + rowspan; rr++) for (let cc = col; cc < col + colspan; cc++) taken[rr]?.add(cc);
      cells.push({ node, row: r, col, colspan, rowspan });
      col += colspan;
    }
    columns = Math.max(columns, ...[...(taken[r] ?? [])].map((c) => c + 1));
  });
  return { cells, columns };
}
