// One column of a stored table, as a place page's notes show it (content PlaceNote `column`).
// Browser-safe: the app renders it, the tests check it.
import { tableNode } from "../content/tables.ts";
import type { DocJSON } from "../content/types.ts";
import { placeCells, type PlacedCell } from "../wordFormat.ts";
import { collapse, nodeText, type PMNode } from "./text.ts";

/**
 * The table of `doc` cut to its first column and grid column `column` (≥ 1), from its second row on,
 * titled with the text of column `column`'s first-row cell. Cells are taken from the table grid, so
 * merged cells land where the renderers draw them: a cell covering both kept columns is kept once
 * across the two, and a row span keeps the rows it covers among those kept. Null when `doc` is not
 * a single table or has no such column.
 */
export function columnView(doc: DocJSON, column: number): { title: string; doc: DocJSON } | null {
  const table = tableNode({ id: "", doc }) as PMNode | null;
  if (!table || !Number.isInteger(column) || column < 1) return null;
  const rows = table.content ?? [];
  const { cells, columns } = placeCells(rows);
  if (column >= columns) return null;
  const covers = (p: PlacedCell<PMNode>, row: number, col: number): boolean =>
    p.row <= row && row < p.row + p.rowspan && p.col <= col && col < p.col + p.colspan;
  const at = (row: number, col: number): PlacedCell<PMNode> | undefined => cells.find((p) => covers(p, row, col));
  const head = at(0, column);
  const title = head ? collapse(nodeText(head.node)) : "";

  const kept = rows.slice(1).map((row, i) => {
    const r = i + 1;
    const content: PMNode[] = [];
    const seen = new Set<PlacedCell<PMNode>>();
    for (const col of [0, column]) {
      const p = at(r, col);
      // A cell starting on an earlier kept row was already put there, spanning down over this one.
      if (!p || seen.has(p) || (p.row < r && r > 1)) continue;
      seen.add(p);
      const first = Math.max(p.row, 1);
      const both = p.col === 0 && p.col + p.colspan > column;
      content.push({ ...p.node, attrs: { ...p.node.attrs, colspan: both ? 2 : 1, rowspan: p.row + p.rowspan - first, colwidth: null } });
    }
    return { ...row, content };
  });

  const grid = Array.isArray(table.attrs?.grid) ? (table.attrs.grid as number[]) : [];
  const total = grid.reduce((a, b) => a + b, 0);
  const label = grid[0] ?? 0;
  return {
    title,
    doc: { type: "doc", content: [{ ...table, attrs: { ...table.attrs, grid: [label, total - label] }, content: kept }] },
  };
}
