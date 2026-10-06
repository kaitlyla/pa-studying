// Toolbar commands of the editor (plan 50 §50.3): her current editor's controls, with lengths in pt.
import { Fragment } from "prosemirror-model";
import type { Mark, MarkType, Node as PMNode, ResolvedPos, Slice } from "prosemirror-model";
import { NodeSelection, TextSelection } from "prosemirror-state";
import type { EditorState, Transaction } from "prosemirror-state";
import { TableMap } from "prosemirror-tables";
import { schema } from "../../../lib/schema.ts";
import { newId } from "../../../lib/content/index.ts";
import type { TableAttrs } from "../../../lib/schemaTypes.ts";
import { tableColumns } from "../../render/styles.ts";
import { M, N as nodes } from "./types.ts";

/** Meta key set only by Delete picture and Delete row after their confirm (see the picture guard). */
export const CONFIRMED_DELETE = "pa-confirmed-delete";

export type Dispatch = (tr: Transaction) => void;
export type Command = (state: EditorState, dispatch?: Dispatch) => boolean;
/** Shows a confirm dialog with these paragraphs; resolves true when she confirms. */
export type Confirm = (lines: string[]) => Promise<boolean>;
/** The live editor (an EditorView): read again after a dialog, since she may keep typing while it is open. */
export interface LiveEditor {
  readonly state: EditorState;
  dispatch: Dispatch;
}

/**
 * Where `node` sits in `doc` now. Unchanged subtrees keep their node objects across transactions, so
 * the node is found by identity: at its old position, else anywhere. Null when it was changed or removed.
 */
function livePos(doc: PMNode, node: PMNode, oldPos: number): number | null {
  if (oldPos + node.nodeSize <= doc.content.size && doc.nodeAt(oldPos) === node) return oldPos;
  let found: number | null = null;
  doc.descendants((child, pos) => {
    if (found !== null) return false;
    if (child === node) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

/** The owning document's facts the commands need. */
export interface DocContext {
  basePt: number;
  /** Page content width in pt (page width minus side margins): the picture size limit outside tables. */
  pageContentPt: number;
}

export const roundHalf = (x: number): number => Math.round(x * 2) / 2;

const { bold, italic, underline, highlight, shade, size } = M;

// ---- marks ---------------------------------------------------------------------------------------

function toggle(type: MarkType, attrs: Record<string, unknown> | null): Command {
  return (state, dispatch) => {
    const { from, to, empty, $from } = state.selection;
    const has = empty
      ? !!type.isInSet(state.storedMarks ?? $from.marks())
      : state.doc.rangeHasMark(from, to, type);
    if (!dispatch) return true;
    const tr = state.tr;
    if (empty) {
      dispatch(has ? tr.removeStoredMark(type) : tr.addStoredMark(type.create(attrs)));
    } else {
      dispatch((has ? tr.removeMark(from, to, type) : tr.addMark(from, to, type.create(attrs))).scrollIntoView());
    }
    return true;
  };
}

export const toggleBold: Command = toggle(bold, null);
export const toggleItalic: Command = toggle(italic, null);
export const toggleUnderline: Command = toggle(underline, { style: "single" });

/**
 * The colors the Highlight control offers: Word's highlight palette in Word's order (her choice), with
 * the hex values the importer gives Word's highlight names.
 */
export const HIGHLIGHT_COLORS: readonly { name: string; hex: string }[] = [
  { name: "yellow", hex: "FFFF00" },
  { name: "bright green", hex: "00FF00" },
  { name: "turquoise", hex: "00FFFF" },
  { name: "pink", hex: "FF00FF" },
  { name: "blue", hex: "0000FF" },
  { name: "red", hex: "FF0000" },
  { name: "dark blue", hex: "000080" },
  { name: "teal", hex: "008080" },
  { name: "green", hex: "008000" },
  { name: "violet", hex: "800080" },
  { name: "dark red", hex: "800000" },
  { name: "dark yellow", hex: "808000" },
  { name: "gray 50%", hex: "808080" },
  { name: "gray 25%", hex: "C0C0C0" },
  { name: "black", hex: "000000" },
];

/** Highlight the selection (or what she types next) in `hex`, replacing any highlight it had. */
export function setHighlight(hex: string): Command {
  return (state, dispatch) => {
    const mark = highlight.create({ hex });
    const { from, to, empty } = state.selection;
    if (dispatch) dispatch(empty ? state.tr.addStoredMark(mark) : state.tr.addMark(from, to, mark));
    return true;
  };
}

export const removeHighlight: Command = (state, dispatch) => {
  const { from, to, empty } = state.selection;
  if (dispatch) {
    const tr = state.tr;
    if (empty) {
      tr.removeStoredMark(highlight).removeStoredMark(shade);
    } else {
      tr.removeMark(from, to, highlight).removeMark(from, to, shade);
    }
    dispatch(tr);
  }
  return true;
};

/** The smallest text size the size controls set. */
export const MIN_SIZE_PT = 4;

const sizeOf = (marks: readonly Mark[], basePt: number): number => (size.isInSet(marks)?.attrs.pt as number | undefined) ?? basePt;

/**
 * Each text run of the selection takes the size `next(current)`; the `size` mark goes when that is
 * basePt. With nothing selected, what she types next takes it.
 */
function mapSize(ctx: DocContext, next: (cur: number) => number): Command {
  return (state, dispatch) => {
    const { from, to, empty, $from } = state.selection;
    const tr = state.tr;
    const apply = (cur: number): Mark | null => {
      const pt = Math.max(MIN_SIZE_PT, roundHalf(next(cur)));
      return pt === ctx.basePt ? null : size.create({ pt });
    };
    if (empty) {
      const mark = apply(sizeOf(state.storedMarks ?? $from.marks(), ctx.basePt));
      tr.removeStoredMark(size);
      if (mark) tr.addStoredMark(mark);
    } else {
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isText) return true;
        const start = Math.max(from, pos);
        const end = Math.min(to, pos + node.nodeSize);
        const mark = apply(sizeOf(node.marks, ctx.basePt));
        tr.removeMark(start, end, size);
        if (mark) tr.addMark(start, end, mark);
        return false;
      });
    }
    if (dispatch) dispatch(tr);
    return true;
  };
}

/** A− / A+: each text run becomes max(4, roundHalf(cur ± 1)). */
export function changeSize(delta: 1 | -1, ctx: DocContext): Command {
  return mapSize(ctx, (cur) => cur + delta);
}

/** The size box: every text run of the selection becomes `pt`. */
export function setSize(pt: number, ctx: DocContext): Command {
  return mapSize(ctx, () => pt);
}

/** The size box's list: Word's font size list, led by the sizes 6 to 7.5 in half points for small text. */
const SIZE_LIST = [6, 6.5, 7, 7.5, 8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36];

/** The size box's choices: the list, plus the current size when it is not on it. */
export function sizeOptions(current: number | null): number[] {
  return current === null || SIZE_LIST.includes(current) ? SIZE_LIST : [...SIZE_LIST, current].sort((x, y) => x - y);
}

/** The text size the size box shows: the first selected text's, or at the cursor what she types next. */
export function selectionSize(state: EditorState, ctx: DocContext): number {
  const { from, to, empty, $from } = state.selection;
  if (empty) return sizeOf(state.storedMarks ?? $from.marks(), ctx.basePt);
  let found: number | null = null;
  state.doc.nodesBetween(from, to, (node) => {
    if (found !== null) return false;
    if (node.isText) found = sizeOf(node.marks, ctx.basePt);
    return found === null;
  });
  return found ?? sizeOf($from.marks(), ctx.basePt);
}

// ---- paragraphs ----------------------------------------------------------------------------------

/** The paragraphs the selection touches (the cursor's paragraph for an empty selection), with positions. */
function selectedParagraphs(state: EditorState): { node: PMNode; pos: number }[] {
  const out: { node: PMNode; pos: number }[] = [];
  const { from, to } = state.selection;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type === nodes.paragraph) {
      out.push({ node, pos });
      return false;
    }
    return true;
  });
  if (out.length === 0) {
    const $from = state.selection.$from;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type === nodes.paragraph) {
        out.push({ node: $from.node(d), pos: $from.before(d) });
        break;
      }
    }
  }
  return out;
}

function updateParagraphs(state: EditorState, dispatch: Dispatch | undefined, change: (p: PMNode) => Record<string, unknown>): boolean {
  const paras = selectedParagraphs(state);
  if (paras.length === 0) return false;
  if (dispatch) {
    const tr = state.tr;
    for (const { node, pos } of paras) tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...change(node) });
    dispatch(tr);
  }
  return true;
}

/** `fontPt` of a paragraph: the `size` mark of its first text, or the document's basePt. */
export function fontPt(p: PMNode, basePt: number): number {
  let found: number | null = null;
  p.descendants((n) => {
    if (found !== null) return false;
    if (n.isText) {
      found = (size.isInSet(n.marks)?.attrs.pt as number | undefined) ?? basePt;
      return false;
    }
    return true;
  });
  return found ?? basePt;
}

/** Tighter (−1) / Looser (+1): an exact line height one step from the current one, floored at 0.8 × font size. */
export function changeLineSpacing(dir: 1 | -1, ctx: DocContext): Command {
  return (state, dispatch) => updateParagraphs(state, dispatch, (p) => {
    const f = fontPt(p, ctx.basePt);
    const step = Math.max(0.5, roundHalf(0.1 * f));
    const line = p.attrs.line as { rule: string; value: number } | null;
    const now = line === null ? 1.22 * f : line.rule === "auto" ? line.value * 1.22 * f : line.value;
    return { line: { rule: "exact", value: Math.max(roundHalf(0.8 * f), roundHalf(now + dir * step)) } };
  });
}

/** Above −/+ (`spaceBefore`) and Below −/+ (`spaceAfter`): ± 2 pt, floored at 0. */
export function changeSpace(which: "spaceBefore" | "spaceAfter", dir: 1 | -1): Command {
  return (state, dispatch) => updateParagraphs(state, dispatch, (p) => ({
    [which]: Math.max(0, (p.attrs[which] as number) + dir * 2),
  }));
}

/** Move paragraph left/right: `indLeft` ± 9 pt (negative allowed). */
export function moveParagraph(dir: 1 | -1): Command {
  return (state, dispatch) => updateParagraphs(state, dispatch, (p) => ({
    indLeft: roundHalf((p.attrs.indLeft as number) + dir * 9),
  }));
}

/** Enter: split the paragraph, giving the new one all of its attributes (marker included). */
export const splitParagraph: Command = (state, dispatch) => {
  const { $from, $to } = state.selection;
  if ($from.parent.type !== nodes.paragraph || !$from.sameParent($to)) return false;
  if (state.selection instanceof NodeSelection) return false;
  if (dispatch) {
    const tr = state.tr.deleteSelection();
    const marks = state.storedMarks ?? $from.marks();
    tr.split(tr.mapping.map($from.pos), 1, [{ type: nodes.paragraph, attrs: { ...$from.parent.attrs } }]);
    tr.ensureMarks(marks);
    dispatch(tr.scrollIntoView());
  }
  return true;
};

// ---- tables --------------------------------------------------------------------------------------

interface TableAt {
  table: PMNode;
  /** Position of the table node. */
  pos: number;
  map: TableMap;
  /** Grid row of the cursor's cell. */
  row: number;
  /** Position (relative to the table's content start) of the cursor's cell. */
  cellRel: number;
}

function tableAt($pos: ResolvedPos): TableAt | null {
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type === nodes.table_cell && d >= 2 && $pos.node(d - 2).type === nodes.table) {
      const table = $pos.node(d - 2);
      const tableStart = $pos.start(d - 2);
      const cellRel = $pos.before(d) - tableStart;
      const map = TableMap.get(table);
      return { table, pos: $pos.before(d - 2), map, row: map.findCell(cellRel).top, cellRel };
    }
  }
  return null;
}

interface GridCell {
  node: PMNode;
  top: number;
  left: number;
}

/** Every cell with its grid position, grouped by the row it starts in. */
function cellsByRow(t: PMNode, map: TableMap): GridCell[][] {
  const rows: GridCell[][] = Array.from({ length: map.height }, () => []);
  const seen = new Set<number>();
  for (let i = 0; i < map.map.length; i++) {
    const rel = map.map[i] as number;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const rect = map.findCell(rel);
    rows[rect.top]?.push({ node: t.nodeAt(rel) as PMNode, top: rect.top, left: rect.left });
  }
  for (const r of rows) r.sort((a, b) => a.left - b.left);
  return rows;
}

function rowIdsOf(doc: PMNode): Set<string> {
  const ids = new Set<string>();
  doc.descendants((n) => {
    if (n.type === nodes.table_row && typeof n.attrs.id === "string") ids.add(n.attrs.id);
    return true;
  });
  return ids;
}

function firstTextMarks(node: PMNode): readonly Mark[] {
  let marks: readonly Mark[] | null = null;
  node.descendants((n) => {
    if (marks) return false;
    if (n.isText) {
      marks = n.marks;
      return false;
    }
    return true;
  });
  return marks ?? [];
}

function firstParagraph(cell: PMNode): PMNode | null {
  let p: PMNode | null = null;
  cell.descendants((n) => {
    if (p) return false;
    if (n.type === nodes.paragraph) {
      p = n;
      return false;
    }
    return true;
  });
  return p;
}

/**
 * Row ↑ / Row ↓ (her editor's span-aware rule): a new content row above or below the cursor's row. A
 * merged cell spanning the insertion boundary grows by one row; every other column gets a blank cell
 * modeled on the cursor row's cell there. The caret moves to the first new cell.
 */
export function insertRow(where: "above" | "below"): Command {
  return (state, dispatch) => {
    const at = tableAt(state.selection.$from);
    if (!at) return false;
    const { table, map } = at;
    const rows = cellsByRow(table, map);
    const modelRow = table.child(at.row);
    const boundary = where === "above" ? at.row : at.row + 1;

    const grow = new Set<PMNode>();
    const newCells: PMNode[] = [];
    let caretMarks: readonly Mark[] = [];
    for (let c = 0; c < map.width;) {
      const rel = map.map[at.row * map.width + c] as number;
      const rect = map.findCell(rel);
      const cell = table.nodeAt(rel) as PMNode;
      const spans = rect.top < boundary && boundary < rect.bottom;
      if (spans) {
        grow.add(cell);
      } else {
        const para = firstParagraph(cell);
        const blank = nodes.table_cell.create(
          {
            colspan: rect.right - c,
            rowspan: 1,
            colwidth: null,
            fill: cell.attrs.fill,
            vAlign: cell.attrs.vAlign,
            borders: cell.attrs.borders,
          },
          nodes.paragraph.create(para ? { ...para.attrs } : null),
        );
        if (newCells.length === 0) caretMarks = firstTextMarks(cell);
        newCells.push(blank);
      }
      c = rect.right;
    }
    if (newCells.length === 0) return false;
    if (!dispatch) return true;

    const newRow = nodes.table_row.create(
      {
        id: newId("r", rowIdsOf(state.doc)),
        kind: "content",
        minHeightPt: modelRow.attrs.minHeightPt,
        repeatHeader: false,
        cantSplit: modelRow.attrs.cantSplit,
      },
      newCells,
    );
    const outRows: PMNode[] = [];
    for (let r = 0; r < map.height; r++) {
      if (r === boundary) outRows.push(newRow);
      const cells = (rows[r] ?? []).map(({ node }) =>
        grow.has(node) ? node.type.create({ ...node.attrs, rowspan: (node.attrs.rowspan as number) + 1 }, node.content, node.marks) : node);
      outRows.push(table.child(r).type.create(table.child(r).attrs, cells));
    }
    if (boundary === map.height) outRows.push(newRow);
    const newTable = table.type.create(table.attrs, outRows);

    const tr = state.tr.replaceWith(at.pos, at.pos + table.nodeSize, newTable);
    // Position of the first new cell's paragraph content.
    let pos = at.pos + 1;
    for (let r = 0; r < boundary; r++) pos += (outRows[r] as PMNode).nodeSize;
    const caret = pos + 1 /* into row */ + 1 /* into cell */ + 1; /* into paragraph */
    tr.setSelection(TextSelection.create(tr.doc, caret));
    if (caretMarks.length) tr.setStoredMarks(caretMarks);
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** One click of the cell text margin controls, in pt; and their largest margin. */
export const CELL_MARGIN_STEP_PT = 1;
export const MAX_CELL_MARGIN_PT = 36;

/**
 * Cell text margins of the cursor's table: "sides" moves its cells' left and right margins, "topBottom"
 * their top and bottom ones, by one step each, within [0, MAX_CELL_MARGIN_PT].
 */
export function changeCellMargins(which: "sides" | "topBottom", dir: 1 | -1): Command {
  return (state, dispatch) => {
    const at = tableAt(state.selection.$from);
    if (!at) return false;
    const m = at.table.attrs.cellMarginPt as { top: number; right: number; bottom: number; left: number };
    const step = (v: number): number => Math.min(MAX_CELL_MARGIN_PT, Math.max(0, roundHalf(v + dir * CELL_MARGIN_STEP_PT)));
    const next = which === "sides" ? { ...m, left: step(m.left), right: step(m.right) } : { ...m, top: step(m.top), bottom: step(m.bottom) };
    if (dispatch) {
      const tr = state.tr.setNodeMarkup(at.pos, undefined, { ...at.table.attrs, cellMarginPt: next });
      dispatch(tr);
    }
    return true;
  };
}

/** One click of Column narrower / wider, in pt; and the narrowest a column may get. */
export const COLUMN_STEP_PT = 9;
export const MIN_COLUMN_PT = 18;

/** Grid widths are kept to 1/20 pt (Word's twips). */
const roundTwip = (x: number): number => Math.round(x * 20) / 20;

/**
 * The grid after moving the border between column `border` and `border + 1` of `table` by `deltaPt`
 * (positive = right), the two columns trading width so the table keeps its width; null when the border
 * cannot move that way. The widths start from the ones the screen draws (tableColumns), and the result
 * is hers (setTableGrid marks it ownWidths), drawn as stored on the screen and in the PDF alike. No
 * column goes under MIN_COLUMN_PT, the first one included: a move past it stops at it.
 */
export function moveColumnBorder(table: Pick<TableAttrs, "grid" | "ownWidths">, border: number, deltaPt: number): number[] | null {
  const grid = table.grid;
  if (border < 0 || border + 1 >= grid.length) return null;
  const sum = grid.reduce((x, y) => x + y, 0);
  const widths = tableColumns(table).map((pct) => roundTwip((pct * sum) / 100));
  const [grow, shrink] = deltaPt > 0 ? [border, border + 1] : [border + 1, border];
  const step = roundTwip(Math.min(Math.abs(deltaPt), (widths[shrink] ?? 0) - MIN_COLUMN_PT));
  if (step <= 0) return null;
  widths[grow] = roundTwip((widths[grow] ?? 0) + step);
  widths[shrink] = roundTwip((widths[shrink] ?? 0) - step);
  return widths;
}

/** A column border of a table: the one between grid columns `border` and `border + 1`. */
export interface ColumnBorder {
  table: PMNode;
  /** Position of the table node. */
  pos: number;
  border: number;
}

/** The border on the `side` of the cell holding `$pos`; null at the table's outer edges or outside a table. */
export function cellBorder($pos: ResolvedPos, side: "left" | "right"): ColumnBorder | null {
  const at = tableAt($pos);
  if (!at) return null;
  const rect = at.map.findCell(at.cellRel);
  const border = side === "right" ? rect.right - 1 : rect.left - 1;
  const columns = (at.table.attrs.grid as number[]).length;
  if (border < 0 || border + 1 >= Math.min(columns, at.map.width)) return null;
  return { table: at.table, pos: at.pos, border };
}

/** The table at `pos` (a table node's position) with its grid replaced by widths she set (ownWidths). */
export function setTableGrid(state: EditorState, pos: number, grid: number[]): Transaction {
  const table = state.doc.nodeAt(pos);
  return state.tr.setNodeMarkup(pos, undefined, { ...table?.attrs, grid, ownWidths: true });
}

/**
 * Column narrower (−1) / wider (+1) for the cursor's cell: its right border moves one step (its left
 * border when the cell ends the table) — moveColumnBorder, the same move a drag of that border makes.
 * False (the toolbar greys the button) when it cannot act: outside a table, in a one-column table, in a
 * cell spanning every column, or with the column at its limit.
 */
export function changeColumnWidth(dir: 1 | -1): Command {
  return (state, dispatch) => {
    const at = tableAt(state.selection.$from);
    if (!at) return false;
    const t = at.table.attrs as TableAttrs;
    const rect = at.map.findCell(at.cellRel);
    const ends = rect.right >= at.map.width;
    const border = ends ? rect.left - 1 : rect.right - 1;
    if (border < 0 || border + 1 >= t.grid.length) return false;
    const next = moveColumnBorder(t, border, (ends ? -dir : dir) * COLUMN_STEP_PT);
    if (!next) return false;
    if (dispatch) dispatch(setTableGrid(state, at.pos, next));
    return true;
  };
}

/** The confirm text of Delete row: her editor's wording. */
export function deleteRowPrompt(row: PMNode, pictures: number): string[] {
  const text = row.textBetween(0, row.content.size, " ", " ").replace(/\s+/g, " ").trim();
  const cut = text.length > 80 ? `${text.slice(0, 80)}…` : text;
  const lines = ["Delete this table row?", cut];
  if (pictures > 0) lines.push(`This row also holds ${pictures} picture(s), which will be deleted too.`);
  return lines;
}

function countPictures(node: PMNode): number {
  let n = 0;
  node.descendants((c) => {
    if (c.type === nodes.image || c.type === nodes.image_block) n++;
    return true;
  });
  return n;
}

/**
 * Delete row, after her confirm. Refused on a one-row table. Cells spanning into the row shrink; a
 * merged cell starting in the row moves to the next row with one row fewer.
 */
export function deleteRow(confirm: Confirm): (editor: LiveEditor) => Promise<boolean> {
  return async (editor) => {
    const at = tableAt(editor.state.selection.$from);
    if (!at) return false;
    const { table, map } = at;
    if (map.height <= 1 || table.childCount <= 1) return false;
    const rows = cellsByRow(table, map);
    const r = at.row;
    const pictures = (rows[r] ?? []).reduce((sum, c) => sum + countPictures(c.node), 0);
    if (!(await confirm(deleteRowPrompt(table.child(r), pictures)))) return false;

    const outRows: PMNode[] = [];
    for (let i = 0; i < map.height; i++) {
      if (i === r) continue;
      let cells: GridCell[] = (rows[i] ?? []).map((c) => {
        const span = c.node.attrs.rowspan as number;
        if (i < r && c.top + span > r) {
          return { ...c, node: c.node.type.create({ ...c.node.attrs, rowspan: span - 1 }, c.node.content, c.node.marks) };
        }
        return c;
      });
      if (i === r + 1) {
        const moved = (rows[r] ?? [])
          .filter((c) => (c.node.attrs.rowspan as number) > 1)
          .map((c) => ({
            ...c,
            node: c.node.type.create({ ...c.node.attrs, rowspan: (c.node.attrs.rowspan as number) - 1 }, c.node.content, c.node.marks),
          }));
        cells = [...cells, ...moved].sort((a, b) => a.left - b.left);
      }
      outRows.push(table.child(i).type.create(table.child(i).attrs, cells.map((c) => c.node)));
    }
    const newTable = table.type.create(table.attrs, outRows);
    // The document may have changed while the dialog was open: delete only from the same, unchanged table.
    const live = editor.state;
    const pos = livePos(live.doc, table, at.pos);
    if (pos === null) return false;
    const tr = live.tr.replaceWith(pos, pos + table.nodeSize, newTable);
    tr.setMeta(CONFIRMED_DELETE, true);
    const target = Math.min(pos + 1, tr.doc.content.size);
    tr.setSelection(TextSelection.near(tr.doc.resolve(target)));
    editor.dispatch(tr.scrollIntoView());
    return true;
  };
}

// ---- pictures ------------------------------------------------------------------------------------

function selectedPicture(state: EditorState): NodeSelection | null {
  const sel = state.selection;
  if (sel instanceof NodeSelection && (sel.node.type === nodes.image || sel.node.type === nodes.image_block)) return sel;
  return null;
}

/** The width limit for a picture at `$pos`: its table cell's grid width, else the page content width. */
function pictureLimit($pos: ResolvedPos, ctx: DocContext): number {
  const at = tableAt($pos);
  if (!at) return ctx.pageContentPt;
  const rect = at.map.findCell(at.cellRel);
  const grid = at.table.attrs.grid as number[];
  let w = 0;
  for (let c = rect.left; c < rect.right; c++) w += grid[c] ?? 0;
  return w;
}

/** The smallest width Picture − makes a picture, in pt. */
const MIN_PICTURE_PT = 24;

/**
 * One Picture − / + step for a picture `widthPt` wide: × 1/1.15 or × 1.15, clamped to
 * [24, `limitPt`] (the cell or page width; never below 24).
 */
export function steppedPictureWidth(widthPt: number, dir: 1 | -1, limitPt: number): number {
  const max = Math.max(MIN_PICTURE_PT, limitPt);
  return Math.min(max, Math.max(MIN_PICTURE_PT, widthPt * (dir > 0 ? 1.15 : 1 / 1.15)));
}

/** Picture − / +: one steppedPictureWidth step within the cell or page width; height scaled alike. */
export function resizePicture(dir: 1 | -1, ctx: DocContext): Command {
  return (state, dispatch) => {
    const sel = selectedPicture(state);
    if (!sel) return false;
    const { widthPt, heightPt } = sel.node.attrs as { widthPt: number; heightPt: number };
    const width = steppedPictureWidth(widthPt, dir, pictureLimit(sel.$from, ctx));
    const factor = width / widthPt;
    if (dispatch) {
      const tr = state.tr.setNodeMarkup(sel.from, undefined, { ...sel.node.attrs, widthPt: width, heightPt: heightPt * factor });
      tr.setSelection(NodeSelection.create(tr.doc, sel.from));
      dispatch(tr);
    }
    return true;
  };
}

/** A picture file she chose, stored content-addressed (its `asset` name), with its size in pixels. */
export interface NewPicture {
  asset: string;
  widthPx: number;
  heightPx: number;
}

/** CSS pixels per pt: a picture is first shown at its natural pixel size, as Word inserts one. */
const PX_PER_PT = 4 / 3;

/** The width in pt of a picture `widthPx` wide at its natural size, shrunk to fit `limitPt`. */
export function naturalPictureWidth(widthPx: number, limitPt: number): number {
  return Math.min(widthPx / PX_PER_PT, Math.max(MIN_PICTURE_PT, limitPt));
}

/**
 * Add picture: the picture goes in at the cursor (after the selected picture, so none is replaced),
 * at its natural size shrunk to fit the table cell or page there, and is then selected.
 */
export function insertPicture(pic: NewPicture, ctx: DocContext): Command {
  return (state, dispatch) => {
    if (pic.widthPx <= 0 || pic.heightPx <= 0) return false;
    const sel = state.selection;
    const at = sel instanceof NodeSelection ? sel.to : sel.from;
    const $at = state.doc.resolve(at);
    const widthPt = naturalPictureWidth(pic.widthPx, pictureLimit($at, ctx));
    const node = nodes.image.create({ asset: pic.asset, widthPt, heightPt: (widthPt * pic.heightPx) / pic.widthPx });
    if (!dispatch) return true;
    // Collapsed first, so no selected text is replaced.
    const tr = state.tr.setSelection(TextSelection.near($at)).replaceSelectionWith(node, false);
    // The selection ends up just after the inserted picture.
    const $end = tr.selection.$from;
    const before = $end.nodeBefore;
    if (before?.type === nodes.image) tr.setSelection(NodeSelection.create(tr.doc, $end.pos - before.nodeSize));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/**
 * A drop she may make: moving (not copying) a picture dragged within the same editor. Everything
 * else dropped is refused, as before; text is moved with cut and paste.
 */
export function isPictureMove(slice: Slice, moved: boolean): boolean {
  if (!moved || slice.content.childCount !== 1) return false;
  let only: PMNode | null = slice.content.firstChild;
  // A dragged inline picture comes wrapped in the paragraph it left.
  while (only && only.type !== nodes.image && only.childCount === 1) only = only.firstChild;
  return only?.type === nodes.image;
}

/** Delete picture: confirm "Delete this picture?", then remove it with its `anchored` wrapper if any. */
export function deletePicture(confirm: Confirm): (editor: LiveEditor) => Promise<boolean> {
  return async (editor) => {
    const sel = selectedPicture(editor.state);
    if (!sel) return false;
    const picture = sel.node;
    if (!(await confirm(["Delete this picture?"]))) return false;
    // The document may have changed while the dialog was open: delete only the same, unchanged picture.
    const live = editor.state;
    const at = livePos(live.doc, picture, sel.from);
    if (at === null) return false;
    const $pos = live.doc.resolve(at);
    let from = at;
    let to = at + picture.nodeSize;
    if ($pos.parent.type === nodes.anchored) {
      from = $pos.before($pos.depth);
      to = $pos.after($pos.depth);
    }
    const tr = live.tr.delete(from, to).setMeta(CONFIRMED_DELETE, true);
    editor.dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Kinds of node a transaction may not lose without a confirm. */
const GUARDED = new Set(["image", "image_block", "textbox", "drawing", "anchored"]);

export function guardedCount(doc: PMNode): number {
  let n = 0;
  doc.descendants((c) => {
    if (GUARDED.has(c.type.name)) n++;
    return true;
  });
  return n;
}

// ---- copy -----------------------------------------------------------------------------------------

/** Plain text of a doc for "Copy my changes": paragraphs and table rows as lines, cells tab-separated. */
export function docLines(doc: PMNode): string[] {
  const lines: string[] = [];
  const walk = (node: PMNode): void => {
    if (node.type === nodes.table_row) {
      const cells: string[] = [];
      node.forEach((cell) => {
        cells.push(cell.textBetween(0, cell.content.size, " ", " ").replace(/\s+/g, " ").trim());
      });
      lines.push(cells.join("\t"));
      return;
    }
    if (node.isTextblock) {
      lines.push(node.textContent);
      return;
    }
    node.forEach(walk);
  };
  walk(doc);
  return lines;
}

/** Plain text pasted at `$at`: one paragraph per line, each with the paragraph's attributes and the position's marks. */
export function plainTextSlice(text: string, $at: ResolvedPos): Fragment {
  const marks = $at.marks();
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const para = $at.parent.type === nodes.paragraph ? $at.parent : null;
  if (lines.length === 1 || !para) {
    const joined = lines.join(" ");
    return joined ? Fragment.from(schema.text(joined, marks)) : Fragment.empty;
  }
  return Fragment.from(lines.map((line) => nodes.paragraph.create({ ...para.attrs }, line ? schema.text(line, marks) : null)));
}
