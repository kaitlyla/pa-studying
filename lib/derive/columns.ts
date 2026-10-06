// One column, or some rows, of a stored table, as a place page's notes show it (content PlaceNote `column`, `rows`).
// Browser-safe: the app renders it, the tests check it.
import { tableNode } from "../content/tables.ts";
import type { DocJSON } from "../content/types.ts";
import { placeCells, type PlacedCell } from "../wordFormat.ts";
import { collapse, nodeText, type PMNode } from "./text.ts";

/**
 * The table of `doc` cut to grid column `label` (the first, by default) and grid column `column`
 * (right of `label`), from its second row on, titled with the text of column `column`'s first-row
 * cell. Cells are taken from the table grid, so merged cells land where the renderers draw them: a
 * cell covering both kept columns is kept once across the two, and a row span keeps the rows it
 * covers among those kept. Null when `doc` is not a single table or has no such columns.
 */
export function columnView(doc: DocJSON, column: number, label = 0): { title: string; doc: DocJSON } | null {
  const table = tableNode({ id: "", doc }) as PMNode | null;
  if (!table || !Number.isInteger(column) || !Number.isInteger(label) || label < 0 || column <= label) return null;
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
    for (const col of [label, column]) {
      const p = at(r, col);
      // A cell starting on an earlier kept row was already put there, spanning down over this one.
      if (!p || seen.has(p) || (p.row < r && r > 1)) continue;
      seen.add(p);
      const first = Math.max(p.row, 1);
      const both = p.col <= label && p.col + p.colspan > column;
      content.push({ ...p.node, attrs: { ...p.node.attrs, colspan: both ? 2 : 1, rowspan: p.row + p.rowspan - first, colwidth: null } });
    }
    return { ...row, content };
  });

  const grid = Array.isArray(table.attrs?.grid) ? (table.attrs.grid as number[]) : [];
  const total = grid.reduce((a, b) => a + b, 0);
  const width = grid[label] ?? 0;
  return {
    title,
    doc: { type: "doc", content: [{ ...table, attrs: { ...table.attrs, grid: [width, total - width] }, content: kept }] },
  };
}

/**
 * A stored block's doc as a note (a place note, a pharm part) shows it: whole; cut to some rows
 * (rowsView); cut to one column, titled with that column's first-row text (columnView); or both,
 * the rows and then that column of them, titled with the column's text in the first kept row. Null
 * when the cut does not apply to `doc`.
 */
export function noteView(
  doc: DocJSON, cut: { column?: number | null; label?: number | null; rows?: readonly string[] | null }, opts: RowsOptions,
): { title: string | null; doc: DocJSON } | null {
  let view = doc;
  if (cut.rows !== undefined && cut.rows !== null) {
    const rows = rowsView(doc, cut.rows, opts);
    if (!rows) return null;
    view = rows;
  }
  if (cut.column !== undefined && cut.column !== null) return columnView(view, cut.column, cut.label ?? 0);
  return { title: null, doc: view };
}

export interface RowsOptions {
  /**
   * Keep the table's first row whether listed or not. A place note's rows sit under that heading
   * row. A pharm card part keeps only the rows it lists: her pharm tables hold several class groups,
   * each under its own heading row, which the part lists first.
   */
  firstRow: boolean;
}

/**
 * The table of `doc` cut to the rows whose ids are in `rows` (content PlaceNote `rows`, a pharm part's
 * `rows`), plus its first row when `firstRow`, in table order. Cells are taken from the table grid: a
 * cell spanning rows is kept once, on the first kept row it covers, spanning only the kept rows it
 * covers, so a merged cell starting on a left-out row still shows beside the kept rows under it. Null
 * when `doc` is not a single table, or when no row is kept.
 */
export function rowsView(doc: DocJSON, rows: readonly string[], { firstRow }: RowsOptions = { firstRow: true }): DocJSON | null {
  const table = tableNode({ id: "", doc }) as PMNode | null;
  if (!table) return null;
  const wanted = new Set(rows);
  const keep = (table.content ?? []).map((r, i) => (firstRow && i === 0) || wanted.has(String(r.attrs?.id)));
  if (!keep.includes(true)) return null;
  return { type: "doc", content: [keepTableRows(table, keep)] };
}

/**
 * `table` with only the rows `keep` marks, in table order, cut on the table grid as the screen draws
 * a row subset: a cell spanning rows is kept once, on the first kept row it covers, spanning only the
 * kept rows it covers, so a merged cell starting on a left-out row keeps its text beside the kept
 * rows under it.
 */
export function keepTableRows(table: PMNode, keep: readonly boolean[]): PMNode {
  const all = table.content ?? [];
  const { cells } = placeCells(all);
  const keptIn = (from: number, to: number): number => keep.slice(from, to).filter(Boolean).length;
  const content = all.flatMap((row, r) => {
    if (!keep[r]) return [];
    // A cell goes on the first kept row it covers.
    const here = cells.filter((p) => p.row <= r && r < p.row + p.rowspan && keptIn(p.row, r) === 0).sort((a, b) => a.col - b.col);
    return [{ ...row, content: here.map((p) => ({ ...p.node, attrs: { ...p.node.attrs, rowspan: keptIn(r, p.row + p.rowspan) } })) }];
  });
  return { ...table, content };
}
