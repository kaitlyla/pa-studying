// How stored Word formatting reads, shared by the screen renderer (app/render) and the PDF builder
// (lib/pdf) so both draw a document the same way. Renderer-neutral and browser-safe: each renderer maps
// these answers to CSS or to pdfmake.
import type { Side, TableAttrs, TableSide } from "./schemaTypes.ts";

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

/**
 * The narrowest the screen draws a table's first (name) column, in % of the table, for widths that
 * came from her Word files (guide-reader/table-spacing; widths she set in the editor are drawn as set).
 */
export const MIN_FIRST_COLUMN_PCT = 11;

/**
 * Column widths as percentages of the grid sum, as the screen and the editor draw them. Unless she
 * set the widths herself (`ownWidths`), a first column under MIN_FIRST_COLUMN_PCT is set to it and the
 * others are scaled down proportionally. The PDF draws these too in a table whose rows have their own
 * widths, since those widths start from them.
 */
export function tableColumns(table: Pick<TableAttrs, "grid" | "ownWidths">): number[] {
  const grid = table.grid;
  const sum = grid.reduce((a, b) => a + b, 0);
  if (grid.length === 0) return [];
  if (sum <= 0) return grid.map(() => 100 / grid.length);
  const pct = grid.map((g) => (100 * g) / sum);
  const first = pct[0] ?? 0;
  if (table.ownWidths !== true && grid.length > 1 && first < MIN_FIRST_COLUMN_PCT) {
    const rest = 100 - first;
    const others = 100 - MIN_FIRST_COLUMN_PCT;
    return pct.map((p, i) => (i === 0 ? MIN_FIRST_COLUMN_PCT : rest > 0 ? (p * others) / rest : others / (grid.length - 1)));
  }
  return pct;
}

/** A row's own widths (table_row `widths`) when they fit a grid of `columns` columns: one positive width per column. */
export function ownRowWidths(widths: unknown, columns: number): number[] | null {
  return Array.isArray(widths) && widths.length === columns && widths.every((w) => typeof w === "number" && w > 0) ? (widths as number[]) : null;
}

/** A row as drawn: its stored `widths` attribute and its cells, placed on the table grid. */
export interface DrawnRow<C> {
  widths: unknown;
  cells: readonly C[];
}

export interface DrawnGrid {
  /** Width of each drawn column, in the unit of the `base` widths. */
  widths: number[];
  /** Per row, per cell (in the rows' order): the drawn column it starts on and how many it spans. */
  spans: { col: number; colspan: number }[][];
}

/**
 * The columns a table is drawn on, given each row's own widths. A row with widths (scaled to the
 * table's width) has its cells' edges where those widths put them; a row without has the table's
 * columns, `base`, as the renderer draws them. The drawn columns are the union of those edges, and
 * each cell spans the drawn columns between its edges. A cell's edges are read from the row it is
 * listed in (rows joined by a merged cell share their widths). With no row widths this is `base`,
 * with every cell where the grid places it.
 */
export function drawnGrid<C extends { col: number; colspan: number }>(rows: readonly DrawnRow<C>[], base: readonly number[]): DrawnGrid {
  const n = base.length;
  const total = base.reduce((a, b) => a + b, 0);
  const own = rows.map((r) => ownRowWidths(r.widths, n));
  if (total <= 0 || own.every((w) => w === null)) {
    return { widths: [...base], spans: rows.map((r) => r.cells.map((c) => ({ col: c.col, colspan: c.colspan }))) };
  }
  const edgesOf = (w: readonly number[], scale: number): number[] => {
    const out = [0];
    for (const x of w) out.push((out.at(-1) ?? 0) + x * scale);
    return out;
  };
  const baseEdges = edgesOf(base, 1);
  const rowEdges = own.map((w) => (w ? edgesOf(w, total / w.reduce((a, b) => a + b, 0)) : baseEdges));
  const edge = (r: number, k: number): number => rowEdges[r]?.[Math.min(Math.max(k, 0), n)] ?? total;
  const points = [0, total];
  if (own.includes(null)) points.push(...baseEdges);
  rows.forEach((row, r) => {
    if (own[r] === null) return;
    for (const c of row.cells) points.push(edge(r, c.col), edge(r, c.col + c.colspan));
  });
  // Edges from different rows that meet within a twip (1/20 pt, the precision widths are kept to) are
  // one edge. Row widths are in pt, so a twip is that fraction of a row's width in the base's unit.
  const ptWidth = own.find((w) => w !== null)?.reduce((a, b) => a + b, 0) ?? total;
  const eps = (total * 0.05) / ptWidth;
  const drawn: number[] = [];
  for (const p of points.sort((a, b) => a - b)) if (drawn.length === 0 || p - (drawn.at(-1) ?? 0) > eps) drawn.push(p);
  const index = (x: number): number => {
    let best = 0;
    drawn.forEach((p, i) => { if (Math.abs(p - x) < Math.abs((drawn[best] ?? 0) - x)) best = i; });
    return best;
  };
  return {
    widths: drawn.slice(1).map((p, i) => p - (drawn[i] ?? 0)),
    spans: rows.map((row, r) => row.cells.map((c) => {
      const col = index(edge(r, c.col));
      return { col, colspan: Math.max(1, index(edge(r, c.col + c.colspan)) - col) };
    })),
  };
}

/**
 * The rows a merged cell joins, as groups of row indexes in table order: a cell spanning rows joins
 * them, and a row no merged cell reaches is a group of its own.
 */
export function mergedRowGroups(rows: readonly { content?: readonly CellLike[] | null }[]): number[][] {
  const parent = rows.map((_, i) => i);
  const root = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] ?? r;
    return r;
  };
  for (const c of placeCells(rows).cells) {
    for (let r = c.row + 1; r < c.row + c.rowspan; r++) {
      const [a, b] = [root(c.row), root(r)];
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  }
  const groups = new Map<number, number[]>();
  rows.forEach((_, i) => groups.set(root(i), [...(groups.get(root(i)) ?? []), i]));
  return [...groups.values()];
}

interface RowLike {
  attrs?: Record<string, unknown> | null;
  content?: readonly CellLike[] | null;
}

/**
 * What is wrong with a table's row widths, or null: each row's widths, when set, number its grid
 * columns, and rows joined by a merged cell have the same widths (a merged cell has one shape).
 */
export function rowWidthsProblem(table: { attrs?: Record<string, unknown> | null; content?: readonly RowLike[] | null }): string | null {
  const g = table.attrs?.grid;
  const grid: unknown[] = Array.isArray(g) ? g : [];
  const rows = table.content ?? [];
  const widthsOf = (r: RowLike | undefined): unknown => r?.attrs?.widths ?? null;
  for (const row of rows) {
    const w = widthsOf(row);
    if (w !== null && ownRowWidths(w, grid.length) === null) return `row ${String(row.attrs?.id)} has widths for ${Array.isArray(w) ? w.length : 0} columns; its table has ${grid.length}`;
  }
  for (const group of mergedRowGroups(rows)) {
    const first = JSON.stringify(widthsOf(rows[group[0] ?? 0]));
    if (group.some((i) => JSON.stringify(widthsOf(rows[i])) !== first)) {
      return `rows ${group.map((i) => String(rows[i]?.attrs?.id)).join(", ")} share a merged cell but not their widths`;
    }
  }
  return null;
}
