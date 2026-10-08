// One diagnosis's own row layout: the column commands on a topic page's rows and on a table page's,
// and the pure row operations they share with the save.
import { describe, expect, it } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import { TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { schema } from "../../../lib/schema.ts";
import type { DocJSON } from "../../../lib/content/index.ts";
import { canDeleteColumn, changeColumnWidth, changeColumnWidthAsking, COLUMN_STEP_PT, CONFIRMED_DELETE, deleteColumn, deleteRow, insertRow } from "./commands.ts";
import {
  cellLabel, deleteColumnCells, followMergedWidths, partialRows, reachLines, rowScope, rowsLayoutOf, tableNow, type CellJSON, type RowJSON, type RowsLayout,
} from "./rowLayout.ts";
import { createEditorState } from "./state.ts";
import { markViews, nodeViews } from "./views.ts";

const text = (t: string) => ({ type: "text", text: t });
const para = (t: string) => ({ type: "paragraph", content: t ? [text(t)] : [] });
const cell = (t: string, attrs: Record<string, unknown> = {}): CellJSON => ({ type: "table_cell", attrs, content: [para(t)] });
const row = (id: string, cells: CellJSON[], attrs: Record<string, unknown> = {}): RowJSON => ({ type: "table_row", attrs: { id, ...attrs }, content: cells });
const NONE = { top: null, right: null, bottom: null, left: null, insideH: null, insideV: null };
const GRID = [60, 100, 100, 100, 100];
const tableOf = (rows: RowJSON[]) => ({ type: "table", attrs: { grid: GRID, borders: NONE, cellMarginPt: { top: 0, right: 5.4, bottom: 0, left: 5.4 } }, content: rows });
const docOf = (rows: RowJSON[]): DocJSON => ({ type: "doc", content: [tableOf(rows)] });

// Her hepatitis table: "Prodromal sxs" (column 3) is one cell merged down the five hepatitis rows; "Other" stands alone.
const HEP = ["A", "B", "C", "D", "E"];
const hepRow = (x: string): RowJSON =>
  row(`r_HEP000000${x}`, [cell(`HAV`.replace("A", x)), cell(`${x} etiology`), cell(`${x} clinical`), ...(x === "A" ? [cell("Prodromal sxs:", { rowspan: 5 })] : []), cell(`${x} serology`)]);
const HEADING = row("r_HEAD000000", [cell("Dx"), cell("Etiology"), cell("Clinical"), cell("Prodromal"), cell("Serology")], { kind: "heading" });
const OTHER = row("r_XTHER00000", [cell("Other"), cell("O etiology"), cell("O clinical"), cell("O prodromal"), cell("O serology")]);
const STORED = [HEADING, ...HEP.map(hepRow), OTHER];
const idOf = (x: string): string => `r_HEP000000${x}`;
const topicOf = (x: string): string => `t_${x}`;

const PAGES: Record<string, string[]> = {
  r_HEAD000000: [...HEP.map(topicOf), "t_O"],
  ...Object.fromEntries(HEP.map((x) => [idOf(x), [topicOf(x)]])),
  r_XTHER00000: ["t_O"],
};
const TITLES: Record<string, string> = { ...Object.fromEntries(HEP.map((x) => [topicOf(x), `Hepatitis ${x}`])), t_O: "Other" };

/** The rows editor of a topic page: its heading row and its own rows, as units.ts cuts them from the stored table. */
function dxPage(stored: RowJSON[], topic: string, pages = PAGES, titles = TITLES, confirm?: (lines: string[]) => Promise<boolean>): EditorState {
  const shown = stored.filter((r) => (pages[String(r.attrs?.id)] ?? []).includes(topic)).map((r) => String(r.attrs?.id));
  const layout: RowsLayout = { page: "dx", topic, stored, shown, pages, titles };
  return createEditorState(docOf(partialRows(stored, shown)), { rows: layout, ...(confirm ? { confirm } : {}) });
}

/** The rows editor of a system page: every row. */
function systemPage(stored: RowJSON[]): EditorState {
  const shown = stored.map((r) => String(r.attrs?.id));
  return createEditorState(docOf(stored), { rows: { page: "table", topic: null, stored, shown, pages: PAGES, titles: TITLES } });
}

function posOf(doc: PMNode, t: string): number {
  let found = -1;
  doc.descendants((n, pos) => {
    if (found >= 0) return false;
    if (n.type === schema.nodes.paragraph && n.textContent === t) found = pos + 1;
    return found < 0;
  });
  if (found < 0) throw new Error(`no paragraph "${t}"`);
  return found;
}
const at = (state: EditorState, t: string): EditorState => state.apply(state.tr.setSelection(TextSelection.create(state.doc, posOf(state.doc, t))));

function live(state: EditorState): { state: EditorState; dispatch: (tr: Transaction) => void; trs: Transaction[] } {
  const editor = {
    state,
    trs: [] as Transaction[],
    dispatch(tr: Transaction) {
      editor.trs.push(tr);
      editor.state = editor.state.apply(tr);
    },
  };
  return editor;
}

/** Records what she was asked and answers `answer`. */
function asker(answer: boolean): { asked: string[][]; confirm: (lines: string[]) => Promise<boolean> } {
  const asked: string[][] = [];
  return { asked, confirm: (lines) => { asked.push(lines); return Promise.resolve(answer); } };
}
const never = (): Promise<boolean> => { throw new Error("asked"); };

const rowsOf = (state: EditorState): RowJSON[] => ((state.doc.firstChild?.toJSON() as { content: RowJSON[] }).content);
const widthsOf = (state: EditorState): Record<string, unknown> => Object.fromEntries(rowsOf(state).map((r) => [String(r.attrs?.id), r.attrs?.widths ?? null]));
const cellsOf = (r: RowJSON | undefined): string[] => (r?.content ?? []).map((c) => `${cellLabel(c)}${(c.attrs?.colspan ?? 1) === 1 ? "" : `×${String(c.attrs?.colspan)}`}`);
const gridOf = (state: EditorState): unknown => state.doc.firstChild?.attrs.grid;

describe("a column width change on a topic page", () => {
  it("gives the new widths to the dx's rows only: the heading row and the table's grid keep theirs, asking nothing", async () => {
    const editor = live(at(dxPage(STORED, "t_O"), "O clinical"));
    expect(await changeColumnWidthAsking(1, never)(editor)).toBe(true);
    expect(gridOf(editor.state)).toEqual(GRID);
    expect(widthsOf(editor.state)).toEqual({ r_HEAD000000: null, r_XTHER00000: [60, 100, 100 + COLUMN_STEP_PT, 100 - COLUMN_STEP_PT, 100] });
  });

  it("asks before changing the dxs a merged cell joins to the dx, naming them and the cell, and changes nothing when she declines", async () => {
    const no = asker(false);
    const declined = live(at(dxPage(STORED, topicOf("B")), "B clinical"));
    expect(await changeColumnWidthAsking(1, no.confirm)(declined)).toBe(false);
    expect(no.asked).toEqual([["This also changes Hepatitis A, Hepatitis C, Hepatitis D, Hepatitis E because 'Prodromal sxs' is merged across them."]]);
    expect(declined.trs).toEqual([]);

    const yes = asker(true);
    const accepted = live(at(dxPage(STORED, topicOf("B")), "B clinical"));
    expect(await changeColumnWidthAsking(1, yes.confirm)(accepted)).toBe(true);
    expect(yes.asked).toHaveLength(1);
    // The page holds Hepatitis B's row; the save gives the other hepatitis rows the same widths (followMergedWidths).
    expect(widthsOf(accepted.state)).toEqual({ r_HEAD000000: null, [idOf("B")]: [60, 100, 100 + COLUMN_STEP_PT, 100 - COLUMN_STEP_PT, 100] });
    expect(gridOf(accepted.state)).toEqual(GRID);
  });

  it("asks before changing a heading row that another dx's page shows, when a merged cell joins it to the dx", async () => {
    // F's name cell starts in the heading row; the heading row also heads G's page.
    const stored = [
      row("r_HEADF00000", [cell("F name", { rowspan: 2 }), cell("Label 1"), cell("Label 2"), cell("Label 3"), cell("Label 4")], { kind: "heading" }),
      row("r_F000000000", [cell("f1"), cell("f2"), cell("f3"), cell("f4")]),
      row("r_G000000000", [cell("G"), cell("g1"), cell("g2"), cell("g3"), cell("g4")]),
    ];
    const pages = { r_HEADF00000: ["t_F", "t_G"], r_F000000000: ["t_F"], r_G000000000: ["t_G"] };
    const titles = { t_F: "F", t_G: "G" };
    const yes = asker(true);
    const editor = live(at(dxPage(stored, "t_F", pages, titles), "f2"));
    expect(await changeColumnWidthAsking(1, yes.confirm)(editor)).toBe(true);
    expect(yes.asked).toEqual([["This also changes the heading row 'F name', which the page of G also shows."]]);
    const w = [60, 100, 100 + COLUMN_STEP_PT, 100 - COLUMN_STEP_PT, 100];
    expect(widthsOf(editor.state)).toEqual({ r_HEADF00000: w, r_F000000000: w });
  });

  it("does not act in a heading row no merged cell joins to the dx: that row is every dx's", () => {
    const state = at(dxPage(STORED, "t_O"), "Clinical");
    expect(changeColumnWidth(1)(state)).toBe(false);
    expect(changeColumnWidth(-1)(state)).toBe(false);
    expect(canDeleteColumn(state)).toBe(false);
  });

  it("starts the dx row's widths from the screen's columns at full precision, so the borders she didn't move stay on the other rows'", () => {
    // 36 of 468 pt is under the 11% first-column minimum: the screen draws 51.48 pt, then 138.84 pt each,
    // none a whole number of twips.
    const rows = [row("r_HEAD000000", [cell("Dx"), cell("A"), cell("B"), cell("C")], { kind: "heading" }), row("r_XTHER00000", [cell("Other"), cell("a"), cell("b"), cell("c")])];
    const stored: DocJSON = { type: "doc", content: [{ ...tableOf(rows), attrs: { ...tableOf(rows).attrs, grid: [36, 144, 144, 144] } }] };
    const layout: RowsLayout = { page: "dx", topic: "t_O", stored: rows, shown: rows.map((r) => String(r.attrs?.id)), pages: PAGES, titles: TITLES };
    const state = at(createEditorState(stored, { rows: layout }), "a");
    let next = state;
    expect(changeColumnWidth(1)(state, (tr) => { next = state.apply(tr); })).toBe(true);
    const w = widthsOf(next).r_XTHER00000 as number[];
    const edges = w.reduce<number[]>((e, x) => [...e, (e.at(-1) ?? 0) + x], [0]);
    expect(Math.abs((edges[1] ?? NaN) - 51.48)).toBeLessThan(1e-9);
    expect(Math.abs((edges[2] ?? NaN) - (190.32 + COLUMN_STEP_PT))).toBeLessThanOrEqual(0.05);
    expect(Math.abs((edges[3] ?? NaN) - 329.16)).toBeLessThan(1e-9);
    expect(Math.abs((edges[4] ?? NaN) - 468)).toBeLessThan(1e-9);
  });

  it("redraws the editor's columns from the dx row's widths, its cells spanning the drawn columns", () => {
    const view = new EditorView(document.createElement("div"), { state: at(dxPage(STORED, "t_O"), "O clinical"), nodeViews: nodeViews(11), markViews: markViews(11) });
    try {
      expect(changeColumnWidth(1)(view.state, view.dispatch)).toBe(true);
      // Edges: the heading's at 60, 160, 260, 360 of 460; the dx row's at 60, 160, 269, 360.
      const cols = [...view.dom.querySelectorAll("col")].map((c) => (parseFloat(c.style.width) * 460) / 100);
      expect(cols).toHaveLength(6);
      [60, 100, 100, 9, 91, 100].forEach((pt, i) => expect(cols[i]).toBeCloseTo(pt, 6));
      const spans = [...view.dom.querySelectorAll("tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.colSpan));
      expect(spans).toEqual([[1, 1, 1, 2, 1], [1, 1, 2, 1, 1]]);
    } finally {
      view.destroy();
    }
  });
});

describe("a column width change on a system page", () => {
  it("changes the table's grid in a row without its own widths, as before", () => {
    const state = at(systemPage(STORED), "O clinical");
    let next = state;
    expect(changeColumnWidth(1)(state, (tr) => { next = state.apply(tr); })).toBe(true);
    expect(gridOf(next)).toEqual([60, 100, 100 + COLUMN_STEP_PT, 100 - COLUMN_STEP_PT, 100]);
    expect(Object.values(widthsOf(next)).every((w) => w === null)).toBe(true);
  });

  it("changes that row's dx in a row with its own widths, as its topic page would", () => {
    const own = [60, 100, 120, 80, 100];
    const stored = STORED.map((r) => (r === OTHER ? row("r_XTHER00000", OTHER.content ?? [], { widths: own }) : r));
    const state = at(systemPage(stored), "O clinical");
    let next = state;
    expect(changeColumnWidth(1)(state, (tr) => { next = state.apply(tr); })).toBe(true);
    expect(gridOf(next)).toEqual(GRID);
    expect(widthsOf(next).r_XTHER00000).toEqual([60, 100, 120 + COLUMN_STEP_PT, 80 - COLUMN_STEP_PT, 100]);
    expect(widthsOf(next).r_HEAD000000).toBeNull();
  });
});

describe("Delete column", () => {
  it("deletes the dx's cell, after her confirm naming the dx and the text, and the cell to its left widens over it", async () => {
    const yes = asker(true);
    const editor = live(at(dxPage(STORED, "t_O"), "O prodromal"));
    expect(canDeleteColumn(editor.state)).toBe(true);
    expect(await deleteColumn(yes.confirm, () => { throw new Error("refused"); })(editor)).toBe(true);
    expect(yes.asked).toEqual([["Delete this column in Other?", "O prodromal"]]);
    expect(editor.trs[0]?.getMeta(CONFIRMED_DELETE)).toBe(true);
    const [heading, other] = rowsOf(editor.state);
    expect(cellsOf(other)).toEqual(["Other", "O etiology", "O clinical×2", "O serology"]);
    expect(cellsOf(heading)).toEqual(["Dx", "Etiology", "Clinical", "Prodromal", "Serology"]);
    expect(gridOf(editor.state)).toEqual(GRID);
  });

  it("changes nothing when she declines", async () => {
    const no = asker(false);
    const editor = live(at(dxPage(STORED, "t_O"), "O prodromal"));
    expect(await deleteColumn(no.confirm, () => undefined)(editor)).toBe(false);
    expect(editor.trs).toEqual([]);
  });

  it("is refused in the first column, which holds the dx's name", async () => {
    const state = at(dxPage(STORED, "t_O"), "Other");
    expect(canDeleteColumn(state)).toBe(false);
    const told: string[] = [];
    expect(await deleteColumn(never, (m) => told.push(m))(live(state))).toBe(false);
    expect(told).toEqual(["The first column can't be deleted: it holds the diagnosis's name."]);
  });

  it("is refused on a topic page when a merged cell joins rows the page does not hold, pointing to the system page", async () => {
    const told: string[] = [];
    const editor = live(at(dxPage(STORED, topicOf("B")), "B clinical"));
    expect(await deleteColumn(never, (m) => told.push(m))(editor)).toBe(false);
    expect(told).toEqual(["This column is merged with rows of Hepatitis A, Hepatitis C, Hepatitis D, Hepatitis E ('Prodromal sxs'). Delete it on the system page."]);
    expect(editor.trs).toEqual([]);
  });

  it("on the system page deletes a cell merged down five dxs, after naming them, and every one of their left cells widens", async () => {
    const yes = asker(true);
    const editor = live(at(systemPage(STORED), "Prodromal sxs:"));
    expect(await deleteColumn(yes.confirm, () => { throw new Error("refused"); })(editor)).toBe(true);
    expect(yes.asked).toEqual([[
      "Delete this column in Hepatitis A?", "Prodromal sxs:",
      "This also changes Hepatitis B, Hepatitis C, Hepatitis D, Hepatitis E because 'Prodromal sxs' is merged across them.",
    ]]);
    const rows = rowsOf(editor.state);
    for (const x of HEP) expect(cellsOf(rows.find((r) => r.attrs?.id === idOf(x)))).toEqual([`H${x}V`, `${x} etiology`, `${x} clinical×2`, `${x} serology`]);
    expect(cellsOf(rows.find((r) => r.attrs?.id === "r_XTHER00000"))).toEqual(["Other", "O etiology", "O clinical", "O prodromal", "O serology"]);
    expect(cellsOf(rows[0])).toEqual(["Dx", "Etiology", "Clinical", "Prodromal", "Serology"]);
  });

  it("deletes on a topic page in the heading row a merged cell joins to the dx, as well, after naming the other dx's page", async () => {
    const stored = [
      row("r_HEADF00000", [cell("F name", { rowspan: 2 }), cell("Label 1"), cell("Label 2"), cell("Label 3"), cell("Label 4")], { kind: "heading" }),
      row("r_F000000000", [cell("f1"), cell("f2"), cell("f3"), cell("f4")]),
      row("r_G000000000", [cell("G"), cell("g1"), cell("g2"), cell("g3"), cell("g4")]),
    ];
    const pages = { r_HEADF00000: ["t_F", "t_G"], r_F000000000: ["t_F"], r_G000000000: ["t_G"] };
    const yes = asker(true);
    const editor = live(at(dxPage(stored, "t_F", pages, { t_F: "F", t_G: "G" }), "f3"));
    expect(await deleteColumn(yes.confirm, () => { throw new Error("refused"); })(editor)).toBe(true);
    expect(yes.asked).toEqual([["Delete this column in F?", "Label 3 / f3", "This also changes the heading row 'F name', which the page of G also shows."]]);
    const [heading, f] = rowsOf(editor.state);
    expect(cellsOf(heading)).toEqual(["F name", "Label 1", "Label 2×2", "Label 4"]);
    expect(cellsOf(f)).toEqual(["f1", "f2×2", "f4"]);
  });
});

describe("a merged cell reaching rows the page does not hold", () => {
  const prodromal = (rows: RowJSON[]): CellJSON | undefined => rows.flatMap((r) => r.content ?? []).find((c) => cellLabel(c) === "Prodromal sxs");

  it("is drawn in the first row of a topic page it covers, where Wider changes the dx's rows after naming the others", async () => {
    const yes = asker(true);
    const editor = live(at(dxPage(STORED, topicOf("B")), "Prodromal sxs:"));
    expect(cellsOf(rowsOf(editor.state)[1])).toEqual(["HBV", "B etiology", "B clinical", "Prodromal sxs", "B serology"]);
    expect(await changeColumnWidthAsking(1, yes.confirm)(editor)).toBe(true);
    expect(yes.asked).toEqual([["This also changes Hepatitis A, Hepatitis C, Hepatitis D, Hepatitis E because 'Prodromal sxs' is merged across them."]]);
    expect(widthsOf(editor.state)[idOf("B")]).toEqual([60, 100, 100, 100 + COLUMN_STEP_PT, 100 - COLUMN_STEP_PT]);
  });

  it("Delete row on Hepatitis A's page is refused, naming the dxs and the cell, and Prodromal survives; the system page deletes the row", async () => {
    const told: string[] = [];
    const page = dxPage(STORED, topicOf("A"));
    const editor = live(at(page, "HAV"));
    expect(await deleteRow(never, (m) => told.push(m))(editor)).toBe(false);
    expect(told).toEqual(["This row is merged with rows of Hepatitis B, Hepatitis C, Hepatitis D, Hepatitis E ('Prodromal sxs'). Delete it on the system page."]);
    expect(editor.trs).toEqual([]);
    const layout = rowsLayoutOf(editor.state) as RowsLayout;
    expect(prodromal(tableNow(layout, rowsOf(editor.state)))?.attrs?.rowspan).toBe(5);

    const yes = asker(true);
    const system = live(at(systemPage(STORED), "HAV"));
    expect(await deleteRow(yes.confirm, () => { throw new Error("refused"); })(system)).toBe(true);
    const rows = rowsOf(system.state);
    expect(rows.map((r) => r.attrs?.id)).toEqual(["r_HEAD000000", ...["B", "C", "D", "E"].map(idOf), "r_XTHER00000"]);
    expect(prodromal(rows)?.attrs?.rowspan).toBe(4);
  });

  it("Row ↑ / Row ↓ are refused on a topic page only where the new row would split the cell, and act on the system page", () => {
    const tryInsert = (state: EditorState, where: "above" | "below"): { told: string[]; next: EditorState | null } => {
      const told: string[] = [];
      let next: EditorState | null = null;
      insertRow(where, (m) => told.push(m))(state, (tr) => { next = state.apply(tr); });
      return { told, next };
    };
    const refusal = (others: string): string =>
      `The new row would split a cell that is merged with rows of ${others} ('Prodromal sxs'). Add the row on the system page.`;

    const aboveB = tryInsert(at(dxPage(STORED, topicOf("B")), "HBV"), "above");
    expect(aboveB).toEqual({ told: [refusal("Hepatitis A, Hepatitis C, Hepatitis D, Hepatitis E")], next: null });
    const belowA = tryInsert(at(dxPage(STORED, topicOf("A")), "HAV"), "below");
    expect(belowA).toEqual({ told: [refusal("Hepatitis B, Hepatitis C, Hepatitis D, Hepatitis E")], next: null });
    // Without a dispatch (the toolbar asking whether it can act) nothing is told.
    const told: string[] = [];
    expect(insertRow("below", (m) => told.push(m))(at(dxPage(STORED, topicOf("A")), "HAV"))).toBe(false);
    expect(told).toEqual([]);

    // Above Hepatitis A and below Hepatitis E the new row splits nothing.
    const aboveA = tryInsert(at(dxPage(STORED, topicOf("A")), "HAV"), "above");
    expect(aboveA.told).toEqual([]);
    expect(rowsOf(aboveA.next as unknown as EditorState)).toHaveLength(3);
    const belowE = tryInsert(at(dxPage(STORED, topicOf("E")), "HEV"), "below");
    expect(belowE.told).toEqual([]);
    expect(rowsOf(belowE.next as unknown as EditorState)).toHaveLength(3);

    // The system page holds every row: the cell grows over the new row.
    const system = tryInsert(at(systemPage(STORED), "HAV"), "below");
    expect(system.told).toEqual([]);
    expect(prodromal(rowsOf(system.next as unknown as EditorState))?.attrs?.rowspan).toBe(6);
  });

  it("Row ↓ is refused when a cell merged over the dx's own rows comes before the one that reaches another dx", () => {
    // "Dx T" joins T's two rows only; "Shared", placed after it, also covers U's row.
    const x1 = row("r_XA00000000", [cell("Dx T", { rowspan: 2 }), cell("Shared", { rowspan: 3 }), cell("t1a"), cell("t1b"), cell("t1c")]);
    const x2 = row("r_XB00000000", [cell("t2a"), cell("t2b"), cell("t2c")]);
    const y = row("r_YA00000000", [cell("Dx U"), cell("u1a"), cell("u1b"), cell("u1c")]);
    const pages = { r_XA00000000: ["t_T"], r_XB00000000: ["t_T"], r_YA00000000: ["t_U"] };
    const titles = { t_T: "T", t_U: "U" };
    const told: string[] = [];
    const state = at(dxPage([x1, x2, y], "t_T", pages, titles), "t1a");
    let dispatched = false;
    insertRow("below", (m) => told.push(m))(state, () => { dispatched = true; });
    expect(told).toEqual(["The new row would split a cell that is merged with rows of U ('Shared'). Add the row on the system page."]);
    expect(dispatched).toBe(false);
  });
});

describe("row operations", () => {
  it("rowScope takes every row a merged cell joins to a seed", () => {
    expect([...rowScope(STORED, [idOf("C")])].sort()).toEqual(HEP.map(idOf).sort());
    expect([...rowScope(STORED, ["r_XTHER00000"])]).toEqual(["r_XTHER00000"]);
  });

  it("cellLabel is the first line of text, without its colon, cut at 40 characters", () => {
    expect(cellLabel({ type: "table_cell", content: [para(""), para("Prodromal sxs:"), para("fever")] })).toBe("Prodromal sxs");
    expect(cellLabel(cell("x".repeat(45)))).toBe(`${"x".repeat(40)}…`);
    expect(cellLabel(undefined)).toBe("");
  });

  it("reachLines names no one when the change stays within the dx", () => {
    const layout: RowsLayout = { page: "dx", topic: "t_O", stored: STORED, shown: [], pages: PAGES, titles: TITLES };
    expect(reachLines(STORED, new Set(["r_XTHER00000"]), layout, "t_O")).toEqual([]);
  });

  it("deleteColumnCells refuses when the cells to widen would widen by different amounts", () => {
    // X (rows 1-2) is column 2's left neighbour in both rows: it would widen by 1 over "b" in row 1 but by 3 over "e" in row 2.
    const rows = [
      row("r_1", [cell("a"), cell("X", { rowspan: 2 }), cell("b"), cell("c", { colspan: 2 })]),
      row("r_2", [cell("d"), cell("e", { colspan: 3 })]),
    ];
    expect(deleteColumnCells(rows, new Set(["r_1", "r_2"]), 2)).toEqual({ refused: "This column can't be deleted here: the merged cells beside it don't line up." });
  });

  it("followMergedWidths gives the widths of an edited row to the rows a merged cell joins to it that the editor did not hold", () => {
    const w = [60, 100, 109, 91, 100];
    const after = STORED.map((r) => (r.attrs?.id === idOf("B") ? { ...r, attrs: { ...r.attrs, widths: w } } : r));
    const out = followMergedWidths(STORED, after, new Set(["r_HEAD000000", idOf("B")]));
    expect(out.map((r) => r.attrs?.widths ?? null)).toEqual([null, w, w, w, w, w, null]);
    // A row nothing changed stays the same object.
    expect(out[0]).toBe(STORED[0]);
    expect(out[6]).toBe(STORED[6]);
  });

  it("followMergedWidths takes widths off the joined rows when she resets the edited row's", () => {
    const w = [60, 100, 109, 91, 100];
    const before = STORED.map((r) => (HEP.map(idOf).includes(String(r.attrs?.id)) ? { ...r, attrs: { ...r.attrs, widths: w } } : r));
    const after = before.map((r) => (r.attrs?.id === idOf("B") ? { ...r, attrs: { id: idOf("B") } } : r));
    const out = followMergedWidths(before, after, new Set([idOf("B")]));
    expect(out.map((r) => "widths" in (r.attrs ?? {}))).toEqual([false, false, false, false, false, false, false]);
  });
});
