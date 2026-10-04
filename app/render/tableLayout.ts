// Grid placement of a stored table's cells, and the cells to draw when only some rows are shown
// (topic and section pages show a subset of a table's rows, 40 §40.3).
import { placeCells, type PlacedCell as Placed } from "../../lib/wordFormat.ts";
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

export interface DrawCell {
  cell: PlacedCell;
  rowspan: number;
}

export interface DrawRow {
  row: PlacedRow;
  cells: DrawCell[];
}

/**
 * The rows to draw for `ids` (in the given order) and the cells each draws. A cell whose span is cut
 * by hidden rows gets the number of shown rows it covers; a cell starting in a hidden row that covers
 * a shown row is drawn in the first shown row it covers, so no shown position is left empty.
 */
export function selectRows(layout: TableLayout, ids: readonly string[] | null): DrawRow[] {
  const index = new Map(layout.rows.map((r, i) => [r.id, i]));
  const shown = ids === null ? layout.rows.map((_, i) => i) : ids.map((id) => index.get(id)).filter((i): i is number => i !== undefined);
  const shownSet = new Set(shown);
  const drawn = new Set<PlacedCell>();
  const all = layout.rows.flatMap((r) => r.cells);
  return shown.map((ri) => {
    const row = layout.rows[ri] as PlacedRow;
    const cells: DrawCell[] = [];
    for (const cell of all) {
      if (drawn.has(cell)) continue;
      const end = cell.row + cell.rowspan;
      if (ri < cell.row || ri >= end) continue;
      if (cell.row !== ri && shownSet.has(cell.row)) continue;
      // The first shown row this cell covers is ri only if no earlier shown row in its span exists.
      const firstShown = shown.find((s) => s >= cell.row && s < end);
      if (firstShown !== ri) continue;
      drawn.add(cell);
      cells.push({ cell, rowspan: shown.filter((s) => s >= cell.row && s < end && s >= ri).length });
    }
    cells.sort((a, b) => a.cell.col - b.cell.col);
    return { row, cells };
  });
}
