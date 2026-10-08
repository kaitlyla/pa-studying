// One diagnosis's own row layout (her 21:08Z/21:10Z requests, rulings by zeke): a column width change or
// Delete column on a dx's rows applies to those rows only, and to every row a merged cell joins to them.
// Pure operations on the table's stored rows, shared by the editor's commands and the save.
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorState } from "prosemirror-state";
import { spliceRows, type SpliceResult } from "../../../lib/content/index.ts";
import { mergedRowGroups, placeCells, shownCells, type PlacedCell, type ShownCell } from "../../../lib/wordFormat.ts";

/** A table cell in its stored form. */
export interface CellJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: unknown[];
}

/** A table row in its stored form. */
export interface RowJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: CellJSON[];
}

/** What a rows editor knows of its table beyond the rows it shows. */
export interface RowsLayout {
  /** "dx": a topic page, whose column changes are that dx's own; "table": a section, system or pharm page. */
  page: "dx" | "table";
  /** The topic (id) of a topic page. */
  topic: string | null;
  /** The table's rows as stored when the page was opened. */
  stored: RowJSON[];
  /** The ids of the stored rows the editor shows, in order. */
  shown: string[];
  /** Per stored row id: the topics whose pages show the row (a content row's own; a heading row's, every topic under it). */
  pages: Record<string, string[]>;
  /** Topic titles by id. */
  titles: Record<string, string>;
}

export const rowsLayoutKey = new PluginKey<RowsLayout>("rows-layout");

/** Gives a rows editor its table's layout facts (read by the column commands). */
export function rowsLayoutPlugin(layout: RowsLayout): Plugin<RowsLayout> {
  return new Plugin<RowsLayout>({ key: rowsLayoutKey, state: { init: () => layout, apply: (_tr, value) => value } });
}

export const rowsLayoutOf = (state: EditorState): RowsLayout | null => rowsLayoutKey.getState(state) ?? null;

export const rowIdOf = (row: RowJSON | undefined): string => String(row?.attrs?.id);

/** Each row's cells placed on the grid, by row index. */
export function placedRows(rows: readonly RowJSON[]): PlacedCell<CellJSON>[][] {
  const out: PlacedCell<CellJSON>[][] = rows.map(() => []);
  for (const c of placeCells(rows).cells) out[c.row]?.push(c);
  return out;
}

const spanOf = (cell: CellJSON, rowspan: unknown): CellJSON => {
  const attrs: Record<string, unknown> = { ...cell.attrs, rowspan };
  if (rowspan === undefined) delete attrs.rowspan;
  return { ...cell, attrs };
};

/** The stored rows `shown` (ids) and the cells each draws when only they are shown (shownCells). */
function projection(stored: readonly RowJSON[], shown: readonly string[]): { at: number[]; placed: PlacedCell<CellJSON>[][]; drawn: ShownCell<CellJSON>[][] } {
  const index = new Map(stored.map((r, i) => [rowIdOf(r), i]));
  const at = shown.map((id) => index.get(id)).filter((i): i is number => i !== undefined);
  const placed = placedRows(stored);
  return { at, placed, drawn: shownCells(placed.flat(), at) };
}

/** A drawn cell that is not where, or not as long as, it is stored: it starts in a hidden row, or hidden rows cut its span. */
const moved = (c: ShownCell<CellJSON>, row: number): boolean => c.cell.row !== row || c.rowspan !== c.cell.rowspan;

/**
 * The rows a rows editor holds for `shown` of a table's `stored` rows: each with the cells the reader
 * draws in it (shownCells), a cell starting in a hidden row in the first shown row it covers, and a
 * span cut by hidden rows covering the shown rows of its span. Rows with neither are as stored.
 */
export function partialRows(stored: readonly RowJSON[], shown: readonly string[]): RowJSON[] {
  const { at, drawn } = projection(stored, shown);
  return at.map((ri, k) => {
    const row = stored[ri] as RowJSON;
    const cells = drawn[k] ?? [];
    if (!cells.some((c) => moved(c, ri))) return row;
    return { ...row, content: cells.map((c) => (moved(c, ri) ? spanOf(c.cell.node, c.rowspan) : c.cell.node)) };
  });
}

/**
 * The inverse of partialRows, then spliceRows: the whole table for the editor's `edited` rows. A cell
 * partialRows drew in another row goes back, as edited, to the hidden row it is stored in, and each cell
 * it moved or cut gets its stored span back. Throws when an edited row no longer holds the cells it was
 * given there (the editor refuses the row and column changes that would do that, at merged cells
 * reaching rows the page does not hold).
 */
export function spliceShown(stored: readonly RowJSON[], shown: readonly string[], edited: readonly RowJSON[]): SpliceResult<RowJSON> {
  const { at, placed, drawn } = projection(stored, shown);
  const full = [...stored];
  const byId = new Map(edited.map((r, i) => [rowIdOf(r), i]));
  const rows = [...edited];
  at.forEach((ri, k) => {
    const cells = drawn[k] ?? [];
    if (!cells.some((c) => moved(c, ri))) return;
    const id = rowIdOf(stored[ri]);
    const e = byId.get(id);
    const row = e === undefined ? undefined : edited[e];
    if (!row || (row.content ?? []).length !== cells.length) {
      throw new Error(`Row ${id} no longer holds the merged cells it shares with rows this page does not show`);
    }
    const content: CellJSON[] = [];
    cells.forEach((c, j) => {
      const now = row.content?.[j] as CellJSON;
      if (!moved(c, ri)) return void content.push(now);
      const back = spanOf(now, c.cell.node.attrs?.rowspan);
      if (c.cell.row === ri) return void content.push(back);
      const origin = full[c.cell.row] as RowJSON;
      const list = [...(origin.content ?? [])];
      list[(placed[c.cell.row] ?? []).indexOf(c.cell)] = back;
      full[c.cell.row] = { ...origin, content: list };
    });
    rows[e as number] = { ...row, content };
  });
  return spliceRows(full, shown, rows, rowIdOf);
}

/** The whole table now: the stored rows with the editor's rows put back in, as the save puts them. */
export const tableNow = (layout: RowsLayout, edited: readonly RowJSON[]): RowJSON[] => spliceShown(layout.stored, layout.shown, edited).rows;

/**
 * Where the cell at `index` of the editor's row `id` is in `rows`, the whole table now (tableNow): its
 * row there (an index) and its index in that row's cells. A cell partialRows drew from a hidden row is that row's.
 */
export function storedCell(layout: RowsLayout, rows: readonly RowJSON[], id: string, index: number): { row: number; index: number } | null {
  const own = rows.findIndex((r) => rowIdOf(r) === id);
  if (own === -1) return null;
  const { at, placed, drawn } = projection(layout.stored, layout.shown);
  const k = at.findIndex((ri) => rowIdOf(layout.stored[ri]) === id);
  const cells = k === -1 ? [] : (drawn[k] ?? []);
  const c = cells[index];
  // A row whose cells are as stored (or a new row) holds its own cells, in order.
  if (!c || !cells.some((x) => moved(x, at[k] as number))) return { row: own, index };
  if (c.cell.row !== at[k]) {
    const row = rows.findIndex((r) => rowIdOf(r) === rowIdOf(layout.stored[c.cell.row]));
    return { row, index: (placed[c.cell.row] ?? []).indexOf(c.cell) };
  }
  return { row: own, index: cells.slice(0, index).filter((x) => x.cell.row === at[k]).length };
}

/** The cell covering grid column `col` in row `r`, wherever it starts. */
function covering(rows: readonly PlacedCell<CellJSON>[][], r: number, col: number): PlacedCell<CellJSON> | null {
  for (const list of rows) {
    for (const c of list) if (c.row <= r && r < c.row + c.rowspan && c.col <= col && col < c.col + c.colspan) return c;
  }
  return null;
}

/** The rows (ids) a change to `seeds` reaches: every row a merged cell joins to one of them, transitively. */
export function rowScope(rows: readonly RowJSON[], seeds: Iterable<string>): Set<string> {
  const want = new Set(seeds);
  const out = new Set<string>();
  for (const group of mergedRowGroups(rows)) {
    const ids = group.map((i) => rowIdOf(rows[i]));
    if (ids.some((id) => want.has(id))) ids.forEach((id) => out.add(id));
  }
  return out;
}

/** A cell's label for a message: its first line of text, without a trailing colon, cut at 40 characters. */
export function cellLabel(cell: CellJSON | undefined): string {
  const lines: string[] = [];
  const walk = (n: unknown, line: string[]): void => {
    const node = n as { type?: string; text?: string; content?: unknown[] };
    if (typeof node.text === "string") line.push(node.text);
    if (node.type === "paragraph") {
      const own: string[] = [];
      (node.content ?? []).forEach((c) => walk(c, own));
      lines.push(own.join(""));
      return;
    }
    (node.content ?? []).forEach((c) => walk(c, line));
  };
  walk(cell ?? {}, []);
  const first = (lines.find((l) => l.trim() !== "") ?? "").trim().replace(/:$/, "");
  return first.length > 40 ? `${first.slice(0, 40)}…` : first;
}

const listOf = (names: readonly string[]): string => names.join(", ");

/**
 * Why a row or column change can't be made in this rows editor, or null: `cell`, a merged cell of
 * `rows` (the whole table now), covers rows the page does not hold, and so only the system page holds
 * all it changes (zeke's rulings). `what` is the thing refused ("This column"), `doing` what to do there.
 */
export function mergedRefusal(rows: readonly RowJSON[], layout: RowsLayout, held: ReadonlySet<string>, cell: PlacedCell<CellJSON> | null, what: string, doing: string): string | null {
  if (!cell) return null;
  const outside = rows.slice(cell.row, cell.row + cell.rowspan).map(rowIdOf).filter((id) => !held.has(id));
  if (outside.length === 0) return null;
  const topics = [...new Set(outside.flatMap((id) => layout.pages[id] ?? []))].filter((t) => t !== layout.topic);
  const names = listOf(topics.map((t) => layout.titles[t] ?? t)) || "other rows";
  return `${what} is merged with rows of ${names} ('${cellLabel(cell.node)}'). ${doing} on the system page.`;
}

/** The first merged cell of `rows` that covers a row of each of two kinds (by id). */
export function joiningCell(rows: readonly RowJSON[], a: (id: string) => boolean, b: (id: string) => boolean): PlacedCell<CellJSON> | null {
  const covers = (c: PlacedCell<CellJSON>, pick: (id: string) => boolean): boolean => rows.slice(c.row, c.row + c.rowspan).some((r) => pick(rowIdOf(r)));
  return placedRows(rows).flat().find((c) => c.rowspan > 1 && covers(c, a) && covers(c, b)) ?? null;
}

const heldIds = (held: readonly RowJSON[]): Set<string> => new Set(held.map(rowIdOf));

/**
 * Why Delete row can't delete the editor's row `id` (`held` are the editor's rows), or null: a merged
 * cell joins it to a row the page does not hold.
 */
export function deleteRowRefusal(layout: RowsLayout, held: readonly RowJSON[], id: string): string | null {
  const rows = tableNow(layout, held);
  const ids = heldIds(held);
  return mergedRefusal(rows, layout, ids, joiningCell(rows, (x) => x === id, (x) => !ids.has(x)), "This row", "Delete it");
}

/**
 * Why Row ↑ / Row ↓ can't add a row at index `at` of the editor's rows `held`, or null: where the save
 * puts the new row (spliceRows), a merged cell covering a row the page does not hold joins the rows
 * either side of it.
 */
export function insertRowRefusal(layout: RowsLayout, held: readonly RowJSON[], at: number): string | null {
  // Not a row id (r_ and 10 letters or digits).
  const mark = "the new row";
  const withNew = [...held.slice(0, at), { type: "table_row", attrs: { id: mark }, content: [] }, ...held.slice(at)];
  const placed = tableNow(layout, withNew);
  const p = placed.findIndex((r) => rowIdOf(r) === mark);
  const rows = placed.filter((r) => rowIdOf(r) !== mark);
  if (p <= 0 || p >= rows.length) return null;
  const ids = heldIds(held);
  const reachesOut = (c: PlacedCell<CellJSON>): boolean => rows.slice(c.row, c.row + c.rowspan).some((r) => !ids.has(rowIdOf(r)));
  const cell = placedRows(rows).flat().find((c) => c.row <= p - 1 && p < c.row + c.rowspan && reachesOut(c)) ?? null;
  return mergedRefusal(rows, layout, ids, cell, "The new row would split a cell that", "Add the row");
}

/**
 * The confirm lines naming the other dxs a change to `scope` reaches (none: []): those whose rows a
 * merged cell joins to the rows changed, and those whose page shows a heading row it changes.
 * `current` is the dx being changed.
 */
export function reachLines(rows: readonly RowJSON[], scope: ReadonlySet<string>, layout: RowsLayout, current: string | null): string[] {
  const title = (topic: string): string => layout.titles[topic] ?? topic;
  const kind = (row: RowJSON | undefined): unknown => row?.attrs?.kind;
  const byContent: string[] = [];
  const byHeading: string[] = [];
  let heading: RowJSON | null = null;
  for (const row of rows) {
    const id = rowIdOf(row);
    if (!scope.has(id)) continue;
    for (const topic of layout.pages[id] ?? []) {
      if (topic === current) continue;
      if (kind(row) === "heading") {
        heading ??= row;
        if (!byHeading.includes(topic)) byHeading.push(topic);
      } else if (!byContent.includes(topic)) byContent.push(topic);
    }
  }
  const lines: string[] = [];
  if (byContent.length > 0) {
    // The merged cell that joins them: the first one covering rows of two different dxs.
    const placed = placedRows(rows).flat();
    const pagesOf = (i: number): string[] => layout.pages[rowIdOf(rows[i])] ?? [];
    const joining = placed.find((c) => {
      if (c.rowspan < 2 || !scope.has(rowIdOf(rows[c.row]))) return false;
      const topics = new Set<string>();
      for (let r = c.row; r < c.row + c.rowspan; r++) if (kind(rows[r]) !== "heading") pagesOf(r).forEach((t) => topics.add(t));
      return topics.size > 1;
    });
    const why = joining ? ` because '${cellLabel(joining.node)}' is merged across them` : "";
    lines.push(`This also changes ${listOf(byContent.map(title))}${why}.`);
  }
  const onlyHeading = byHeading.filter((t) => !byContent.includes(t));
  if (onlyHeading.length > 0 && heading) {
    const label = cellLabel(placedRows([heading])[0]?.find((c) => cellLabel(c.node) !== "")?.node);
    lines.push(`This also changes the heading row '${label}', which the page of ${listOf(onlyHeading.map(title))} also shows.`);
  }
  return lines;
}

/** Delete column on `scope`'s rows: the result, or why it cannot be done. */
export type ColumnDelete = { rows: RowJSON[]; removed: CellJSON[] } | { refused: string };

/**
 * Delete column `col` in the rows of `scope`, as Word deletes a cell and shifts the row left: in each
 * of those rows the cell covering `col` goes (a merged cell once) and the cell to its left widens over
 * the columns it covered. Refused when that cell starts the row (it has no left neighbour), or when a
 * cell to widen would have to widen by different amounts in the rows it covers. Every merged cell of
 * a scope row lies within the scope (rowScope), so no row outside it changes.
 */
export function deleteColumnCells(rows: readonly RowJSON[], scope: ReadonlySet<string>, col: number): ColumnDelete {
  const placed = placedRows(rows);
  const removed = new Set<PlacedCell<CellJSON>>();
  const grow = new Map<PlacedCell<CellJSON>, number>();
  for (let r = 0; r < rows.length; r++) {
    if (!scope.has(rowIdOf(rows[r]))) continue;
    const gone = covering(placed, r, col);
    if (!gone) continue;
    if (gone.col === 0) return { refused: "The first column can't be deleted: it holds the diagnosis's name." };
    const left = covering(placed, r, gone.col - 1);
    if (!left) continue;
    const by = grow.get(left);
    if (by !== undefined && by !== gone.colspan) return { refused: "This column can't be deleted here: the merged cells beside it don't line up." };
    removed.add(gone);
    grow.set(left, gone.colspan);
  }
  if (removed.size === 0) return { refused: "There is no cell to delete in this column." };
  const out = rows.map((row, r) => {
    const content = (placed[r] ?? []).flatMap((c) => {
      if (removed.has(c)) return [];
      const by = grow.get(c);
      return [by === undefined ? c.node : { ...c.node, attrs: { ...c.node.attrs, colspan: c.colspan + by } }];
    });
    return content.length === (row.content ?? []).length && content.every((c, i) => c === row.content?.[i]) ? row : { ...row, content };
  });
  const order = placed.flat();
  return { rows: out, removed: order.filter((c) => removed.has(c)).map((c) => c.node) };
}

const widthsOf = (row: RowJSON | undefined): string => JSON.stringify(row?.attrs?.widths ?? null);

/**
 * The save's rows with rows joined by a merged cell sharing their widths again: a row the editor did not
 * hold (another dx's, joined to an edited row by a merged cell) takes the widths she gave the edited
 * one. `before` is the table as stored, `held` the ids of the rows the editor held.
 */
export function followMergedWidths(before: readonly RowJSON[], after: readonly RowJSON[], held: ReadonlySet<string>): RowJSON[] {
  const was = new Map(before.map((r) => [rowIdOf(r), widthsOf(r)]));
  const out = [...after];
  for (const group of mergedRowGroups(after)) {
    const from = group.map((i) => after[i] as RowJSON).find((r) => held.has(rowIdOf(r)) && widthsOf(r) !== (was.get(rowIdOf(r)) ?? "null"));
    if (!from) continue;
    const widths = from.attrs?.widths ?? null;
    for (const i of group) {
      const row = out[i] as RowJSON;
      if (held.has(rowIdOf(row)) || widthsOf(row) === widthsOf(from)) continue;
      const attrs: Record<string, unknown> = { ...row.attrs, widths };
      if (widths === null) delete attrs.widths;
      out[i] = { ...row, attrs };
    }
  }
  return out;
}
