// One diagnosis's own row layout (her 21:08Z/21:10Z requests, rulings by zeke): a column width change or
// Delete column on a dx's rows applies to those rows only, and to every row a merged cell joins to them.
// Pure operations on the table's stored rows, shared by the editor's commands and the save.
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorState } from "prosemirror-state";
import { spliceRows } from "../../../lib/content/index.ts";
import { mergedRowGroups, placeCells, type PlacedCell } from "../../../lib/wordFormat.ts";

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

/** The whole table now: the stored rows with the editor's rows spliced back in, as the save puts them. */
export const tableNow = (layout: RowsLayout, edited: readonly RowJSON[]): RowJSON[] =>
  spliceRows(layout.stored, layout.shown, edited, rowIdOf).rows;

/** Each row's cells placed on the grid, by row index. */
export function placedRows(rows: readonly RowJSON[]): PlacedCell<CellJSON>[][] {
  const out: PlacedCell<CellJSON>[][] = rows.map(() => []);
  for (const c of placeCells(rows).cells) out[c.row]?.push(c);
  return out;
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
