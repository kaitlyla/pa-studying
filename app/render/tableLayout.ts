// Grid placement of a stored table's cells, and the cells to draw when only some rows are shown
// (topic and section pages show a subset of a table's rows, 40 §40.3).
import { placeCells, shownCells, type PlacedCell as Placed, type ShownCell } from "../../lib/wordFormat.ts";
import type { PMNode } from "../../lib/schemaTypes.ts";

export type PlacedCell = Placed<PMNode>;

export interface PlacedRow {
  node: PMNode;
  id: string;
  cells: PlacedCell[];
}

export interface TableLayout {
  rows: PlacedRow[];
  /** Number of grid columns actually used. */
  columns: number;
}

/** Places every cell on the grid (the shared placement of lib/wordFormat.ts, row spans clamped). */
export function layoutTable(table: PMNode): TableLayout {
  const rowNodes = table.content ?? [];
  const { cells, columns } = placeCells(rowNodes);
  const rows: PlacedRow[] = rowNodes.map((node) => ({ node, id: String(node.attrs?.id ?? ""), cells: [] }));
  for (const c of cells) rows[c.row]?.cells.push(c);
  return { rows, columns };
}

export type DrawCell = ShownCell<PMNode>;

export interface DrawRow {
  row: PlacedRow;
  cells: DrawCell[];
}

/** The rows to draw for `ids` (in the given order) and the cells each draws (shownCells, the editor's rule too). */
export function selectRows(layout: TableLayout, ids: readonly string[] | null): DrawRow[] {
  const index = new Map(layout.rows.map((r, i) => [r.id, i]));
  const shown = ids === null ? layout.rows.map((_, i) => i) : ids.map((id) => index.get(id)).filter((i): i is number => i !== undefined);
  const drawn = shownCells(layout.rows.flatMap((r) => r.cells), shown);
  return shown.map((ri, k) => ({ row: layout.rows[ri] as PlacedRow, cells: drawn[k] ?? [] }));
}
