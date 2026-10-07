// Editor behavior (plan 50 §50.3; 99 §99.1 app/edit/editor.test.ts).
import { afterEach, describe, expect, it } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState, NodeSelection, TextSelection } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";
import { redo, undo } from "prosemirror-history";
import { EditorView } from "prosemirror-view";
import { schema } from "../../../lib/schema.ts";
import type { DocJSON } from "../../../lib/content/index.ts";
import type { TableAttrs } from "../../../lib/schemaTypes.ts";
import {
  changeCellMargins, changeColumnWidth, changeLineSpacing, changeSize, changeSpace, COLUMN_STEP_PT, CONFIRMED_DELETE, MIN_COLUMN_PT, deletePicture, deleteRow, deleteRowPrompt,
  cropWindow, docLines, dragPicture, dragPictureCrop, draggedPictureCrop, draggedPictureSize, insertPicture, isPictureMove, MAX_CELL_MARGIN_PT, moveColumnBorder,
  moveParagraph, naturalPictureWidth, removeHighlight, resetPictureCrop, resetPictureShape, resizePicture, scaledPictureSize, seenPictureSize, selectedPictureSize,
  selectionSize, setHighlight, shownPictureWidth, steppedPictureSize, setSize, uncroppedPictureSize,
  sizeOptions, splitParagraph, toggleBold, toggleItalic, toggleUnderline, insertRow, unturnedDrag,
  type Command,
} from "./commands.ts";
import { createEditorState, editorProps, PICTURE_REFUSED } from "./state.ts";
import { clipboardSerializer, markViews, nodeViews } from "./views.ts";
import { cellPadding, MIN_FIRST_COLUMN_PCT, tableColumns } from "../../render/styles.ts";

const ctx = { basePt: 11, pageContentPt: 540, pageContentHeightPt: 720 };
const ASSET = `${"a".repeat(32)}.png`;

const text = (t: string, marks: unknown[] = []) => ({ type: "text", text: t, ...(marks.length ? { marks } : {}) });
const para = (content: unknown[] = [], attrs: Record<string, unknown> = {}) => ({ type: "paragraph", attrs, content });
const cell = (t: string, attrs: Record<string, unknown> = {}) => ({ type: "table_cell", attrs, content: [para(t ? [text(t)] : [])] });
const row = (id: string, cells: unknown[], attrs: Record<string, unknown> = {}) => ({ type: "table_row", attrs: { id, ...attrs }, content: cells });
const NONE = { top: null, right: null, bottom: null, left: null, insideH: null, insideV: null };
const MARGINS = { top: 0, right: 5.4, bottom: 0, left: 5.4 };
const table = (rows: unknown[], grid = [100, 200]) => ({ type: "table", attrs: { grid, borders: NONE, cellMarginPt: MARGINS }, content: rows });
const docOf = (...content: unknown[]): DocJSON => ({ type: "doc", content });
const rid = (n: number) => `r_${String(n).padStart(10, "0")}`;

function run(state: EditorState, cmd: Command): EditorState {
  let next = state;
  const ok = cmd(state, (tr) => {
    next = state.apply(tr);
  });
  expect(ok).toBe(true);
  return next;
}

function selectText(state: EditorState, from: number, to: number): EditorState {
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
}

/** Position just inside the first paragraph whose text is `t`. */
function posOf(doc: PMNode, t: string): number {
  let found = -1;
  doc.descendants((n, pos) => {
    if (found >= 0) return false;
    if (n.type === schema.nodes.paragraph && n.textContent === t) {
      found = pos + 1;
      return false;
    }
    return true;
  });
  if (found < 0) throw new Error(`no paragraph "${t}"`);
  return found;
}

function at(state: EditorState, t: string): EditorState {
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, posOf(state.doc, t))));
}

/** A stand-in for the EditorView the async commands read after their dialog. */
function live(state: EditorState): { state: EditorState; dispatch: (tr: Transaction) => void; dispatched: number } {
  const editor = {
    state,
    dispatched: 0,
    dispatch(tr: Transaction) {
      editor.state = editor.state.apply(tr);
      editor.dispatched++;
    },
  };
  return editor;
}

function rowsOf(doc: PMNode): PMNode[] {
  const t = doc.firstChild as PMNode;
  const out: PMNode[] = [];
  t.forEach((r) => out.push(r));
  return out;
}

describe("picture guard", () => {
  const withImage = docOf(para([text("a"), { type: "image", attrs: { asset: ASSET, widthPt: 100, heightPt: 50 } }, text("b")]));

  it("rejects a transaction that removes an image without the confirm meta, and says why", () => {
    let refused = 0;
    const state = createEditorState(withImage, { onPictureRefused: () => { refused++; } });
    const after = state.apply(state.tr.delete(2, 3));
    expect(after.doc.eq(state.doc)).toBe(true);
    expect(refused).toBe(1);
    expect(PICTURE_REFUSED).toBe("That would remove a picture. To remove a picture, click it and press \"Delete picture\".");
  });

  it("does not report an edit that keeps every picture", () => {
    let refused = 0;
    const state = createEditorState(withImage, { onPictureRefused: () => { refused++; } });
    const after = state.apply(state.tr.insertText("z", 1));
    expect(after.doc.textContent).toBe("zab");
    expect(refused).toBe(0);
  });

  it("lets undo and redo replay a confirmed picture delete", async () => {
    const s0 = createEditorState(withImage);
    const editor = live(s0.apply(s0.tr.setSelection(NodeSelection.create(s0.doc, 2))));
    const images = (): number => {
      let n = 0;
      editor.state.doc.descendants((c) => { if (c.type === schema.nodes.image) n++; });
      return n;
    };
    expect(await deletePicture(async () => true)(editor)).toBe(true);
    expect(images()).toBe(0);
    expect(undo(editor.state, editor.dispatch)).toBe(true);
    expect(images()).toBe(1);
    expect(redo(editor.state, editor.dispatch)).toBe(true);
    expect(images()).toBe(0);
    // Redo history is not stuck: undo/redo keep working.
    expect(undo(editor.state, editor.dispatch)).toBe(true);
    expect(images()).toBe(1);
  });

  it("applies the same removal when it carries pa-confirmed-delete", () => {
    const state = createEditorState(withImage);
    const after = state.apply(state.tr.delete(2, 3).setMeta(CONFIRMED_DELETE, true));
    expect(after.doc.textContent).toBe("ab");
    let images = 0;
    after.doc.descendants((n) => { if (n.type === schema.nodes.image) images++; });
    expect(images).toBe(0);
  });

  it("Delete picture removes the selected picture and its anchored wrapper after the confirm", async () => {
    const d = docOf(para([text("x")]), { type: "anchored", attrs: { offsetPt: 10 }, content: [{ type: "image_block", attrs: { asset: ASSET, widthPt: 50, heightPt: 50 } }] });
    let state = createEditorState(d);
    const imgPos = (state.doc.firstChild as PMNode).nodeSize + 1;
    state = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, imgPos)));
    const asked: string[][] = [];
    const editor = live(state);
    const ok = await deletePicture(async (lines) => { asked.push(lines); return true; })(editor);
    expect(ok).toBe(true);
    expect(asked).toEqual([["Delete this picture?"]]);
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.textContent).toBe("x");
  });

  it("Delete picture does nothing when the confirm is declined", async () => {
    const state0 = createEditorState(withImage);
    const editor = live(state0.apply(state0.tr.setSelection(NodeSelection.create(state0.doc, 2))));
    const ok = await deletePicture(async () => false)(editor);
    expect(ok).toBe(false);
    expect(editor.dispatched).toBe(0);
  });

  it("Delete picture removes the same picture when she typed before it while the confirm was open", async () => {
    const state0 = createEditorState(withImage);
    const editor = live(state0.apply(state0.tr.setSelection(NodeSelection.create(state0.doc, 2))));
    const ok = await deletePicture(async () => {
      editor.dispatch(editor.state.tr.insertText("QQ", 1));
      return true;
    })(editor);
    expect(ok).toBe(true);
    expect(editor.state.doc.textContent).toBe("QQab");
    let images = 0;
    editor.state.doc.descendants((n) => { if (n.type === schema.nodes.image) images++; });
    expect(images).toBe(0);
  });

  it("Delete picture is abandoned when the picture changed while the confirm was open", async () => {
    const state0 = createEditorState(withImage);
    const editor = live(state0.apply(state0.tr.setSelection(NodeSelection.create(state0.doc, 2))));
    const ok = await deletePicture(async () => {
      const img = editor.state.doc.nodeAt(2) as PMNode;
      editor.dispatch(editor.state.tr.setNodeMarkup(2, undefined, { ...img.attrs, widthPt: 80 }));
      return true;
    })(editor);
    expect(ok).toBe(false);
    expect(editor.dispatched).toBe(1);
    expect(editor.state.doc.nodeAt(2)?.attrs.widthPt).toBe(80);
  });
});

describe("paste", () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
  });

  it("pasting HTML <b>x</b> inserts plain text x", () => {
    const host = document.createElement("div");
    document.body.append(host);
    view = new EditorView(host, {
      state: createEditorState(docOf(para([text("ab")]))),
      nodeViews: nodeViews(11),
      markViews: markViews(11),
      clipboardSerializer: clipboardSerializer(11),
      ...editorProps,
    });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    const event = { clipboardData: { getData: (t: string) => (t === "text/html" ? "<b>x</b>" : "") } } as unknown as ClipboardEvent;
    const handled = editorProps.handlePaste?.call(null as never, view, event, null as never);
    expect(handled).toBe(true);
    const p = view.state.doc.firstChild as PMNode;
    expect(p.textContent).toBe("axb");
    p.forEach((child) => expect(child.marks).toEqual([]));
  });

  it("multi-line plain text becomes paragraphs with the current paragraph's attributes", () => {
    const host = document.createElement("div");
    view = new EditorView(host, { state: createEditorState(docOf(para([text("ab")], { indLeft: 18 }))), nodeViews: nodeViews(11), markViews: markViews(11), ...editorProps });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    const event = { clipboardData: { getData: (t: string) => (t === "text/plain" ? "1\n2" : "") } } as unknown as ClipboardEvent;
    editorProps.handlePaste?.call(null as never, view, event, null as never);
    const texts: string[] = [];
    view.state.doc.forEach((n) => { texts.push(n.textContent); expect(n.attrs.indLeft).toBe(18); });
    expect(texts).toEqual(["a1", "2b"]);
  });

  it("drops are refused", () => {
    expect(editorProps.handleDrop?.call(null as never, null as never, null as never, null as never, false)).toBe(true);
  });
});

describe("Enter", () => {
  it("gives the new paragraph the same marker and attributes", () => {
    const marker = { text: "•", font: null, marks: [], tabPt: 18 };
    let state = createEditorState(docOf(para([text("first")], { marker, indLeft: 36, indFirst: -18, spaceAfter: 3 })));
    state = selectText(state, 6, 6);
    state = run(state, splitParagraph);
    expect(state.doc.childCount).toBe(2);
    const second = state.doc.child(1);
    expect(second.attrs).toEqual(state.doc.child(0).attrs);
    expect(second.attrs.marker).toEqual(marker);
  });
});

describe("rows", () => {
  it("Row ↓ grows a cell that spans the insertion boundary and adds blank cells elsewhere", () => {
    // Row 1's first cell spans rows 1–2; inserting below row 1 lands inside that span.
    const d = docOf(table([
      row(rid(1), [cell("A", { rowspan: 2, fill: "FFEE00" }), cell("B", { fill: "112233", vAlign: "center" })], { cantSplit: true, minHeightPt: 12 }),
      row(rid(2), [cell("C")]),
    ]));
    let state = at(createEditorState(d), "B");
    state = run(state, insertRow("below"));
    const rows = rowsOf(state.doc);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.firstChild?.attrs.rowspan).toBe(3);
    const added = rows[1] as PMNode;
    expect(added.attrs.id).toMatch(/^r_[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(added.attrs).toMatchObject({ kind: "content", repeatHeader: false, cantSplit: true, minHeightPt: 12 });
    expect(added.childCount).toBe(1);
    expect(added.firstChild?.attrs).toMatchObject({ fill: "112233", vAlign: "center", colspan: 1, rowspan: 1 });
    expect(added.textContent).toBe("");
    // The caret is in the new row.
    expect(state.selection.$from.node(state.selection.$from.depth - 2)).toBe(added);
    expect(rows[2]?.attrs.id).toBe(rid(2));
  });

  it("Row ↑ above the first row adds a full row of blank cells", () => {
    const d = docOf(table([row(rid(1), [cell("A"), cell("B")]), row(rid(2), [cell("C"), cell("D")])]));
    const state = run(at(createEditorState(d), "A"), insertRow("above"));
    const rows = rowsOf(state.doc);
    expect(rows.map((r) => r.textContent)).toEqual(["", "AB", "CD"]);
    expect(rows[0]?.childCount).toBe(2);
  });

  it("Delete row is refused on a one-row table", async () => {
    const state = at(createEditorState(docOf(table([row(rid(1), [cell("A"), cell("B")])]))), "A");
    let asked = false;
    const ok = await deleteRow(async () => { asked = true; return true; })(live(state));
    expect(ok).toBe(false);
    expect(asked).toBe(false);
  });

  it("Delete row deletes the same row when she typed above the table while the confirm was open", async () => {
    const d = docOf(para([text("intro")]), table([row(rid(1), [cell("A"), cell("B")]), row(rid(2), [cell("C"), cell("D")])]));
    const editor = live(at(createEditorState(d), "C"));
    const ok = await deleteRow(async () => {
      editor.dispatch(editor.state.tr.insertText("more ", 1));
      return true;
    })(editor);
    expect(ok).toBe(true);
    expect(editor.state.doc.firstChild?.textContent).toBe("more intro");
    const t = editor.state.doc.child(1);
    const ids: unknown[] = [];
    t.forEach((r) => ids.push(r.attrs.id));
    expect(ids).toEqual([rid(1)]);
  });

  it("Delete row is abandoned when the table changed while the confirm was open", async () => {
    const d = docOf(table([row(rid(1), [cell("A"), cell("B")]), row(rid(2), [cell("C"), cell("D")])]));
    const editor = live(at(createEditorState(d), "C"));
    const ok = await deleteRow(async () => {
      editor.dispatch(editor.state.tr.insertText("x", posOf(editor.state.doc, "A")));
      return true;
    })(editor);
    expect(ok).toBe(false);
    expect(rowsOf(editor.state.doc).map((r) => r.textContent)).toEqual(["xAB", "CD"]);
  });

  it("Delete row shrinks spans into the row and moves a merged cell starting in it to the next row", async () => {
    const d = docOf(table([
      row(rid(1), [cell("A", { rowspan: 2 }), cell("B")]),
      row(rid(2), [cell("C", { rowspan: 2 })]),
      row(rid(3), [cell("D")]),
    ]));
    const editor = live(at(createEditorState(d), "C"));
    let prompt: string[] = [];
    const ok = await deleteRow(async (lines) => { prompt = lines; return true; })(editor);
    expect(ok).toBe(true);
    expect(prompt).toEqual(["Delete this table row?", "C"]);
    const rows = rowsOf(editor.state.doc);
    expect(rows.map((r) => r.attrs.id)).toEqual([rid(1), rid(3)]);
    expect(rows[0]?.firstChild?.attrs.rowspan).toBe(1);
    expect(rows[1]?.childCount).toBe(2);
    expect(rows[1]?.child(0).textContent).toBe("D");
    expect(rows[1]?.child(1).textContent).toBe("C");
    expect(rows[1]?.child(1).attrs.rowspan).toBe(1);
  });

  it("Delete row of a row holding pictures names them in the confirm and is applied past the guard", async () => {
    const picCell = { type: "table_cell", attrs: {}, content: [para([{ type: "image", attrs: { asset: ASSET, widthPt: 20, heightPt: 20 } }])] };
    const d = docOf(table([row(rid(1), [cell("A"), cell("B")]), row(rid(2), [cell("C"), picCell])]));
    const editor = live(at(createEditorState(d), "C"));
    let prompt: string[] = [];
    await deleteRow(async (lines) => { prompt = lines; return true; })(editor);
    expect(prompt[2]).toBe("This row also holds 1 picture(s), which will be deleted too.");
    expect(rowsOf(editor.state.doc)).toHaveLength(1);
  });

  it("the delete-row prompt cuts the row text at 80 characters", () => {
    const long = "x ".repeat(60);
    const node = schema.nodeFromJSON(row(rid(1), [cell(long)]));
    expect(deleteRowPrompt(node, 0)[1]).toBe(`${"x ".repeat(40).slice(0, 80)}…`);
  });
});

describe("text size", () => {
  it("A+ on 11pt text with basePt 11 gives size 12; A− back to 11 removes the size mark", () => {
    let state = selectText(createEditorState(docOf(para([text("word")]))), 1, 5);
    state = run(state, changeSize(1, ctx));
    expect(state.doc.firstChild?.firstChild?.marks.map((m) => m.toJSON())).toEqual([{ type: "size", attrs: { pt: 12 } }]);
    state = run(state, changeSize(-1, ctx));
    expect(state.doc.firstChild?.firstChild?.marks).toEqual([]);
  });

  it("A− floors at 4 pt and rounds to the nearest half point", () => {
    let state = selectText(createEditorState(docOf(para([text("w", [{ type: "size", attrs: { pt: 4.2 } }])]))), 1, 2);
    state = run(state, changeSize(-1, ctx));
    expect(state.doc.firstChild?.firstChild?.marks[0]?.attrs.pt).toBe(4);
  });

  it("with nothing selected sets the size of what she types next", () => {
    let state = selectText(createEditorState(docOf(para([text("w")]))), 2, 2);
    state = run(state, changeSize(1, ctx));
    expect(state.storedMarks?.map((m) => m.toJSON())).toEqual([{ type: "size", attrs: { pt: 12 } }]);
    state = state.apply(state.tr.insertText("x"));
    expect(state.doc.firstChild?.lastChild?.marks.map((m) => m.toJSON())).toEqual([{ type: "size", attrs: { pt: 12 } }]);
    expect(state.doc.firstChild?.firstChild?.marks).toEqual([]);
  });

  it("the size box sets each selected run to the chosen size, and its base size removes the mark", () => {
    let state = selectText(createEditorState(docOf(para([text("a", [{ type: "size", attrs: { pt: 9 } }]), text("b")]))), 1, 3);
    state = run(state, setSize(16, ctx));
    expect(state.doc.firstChild?.childCount).toBe(1);
    expect(state.doc.firstChild?.firstChild?.marks.map((m) => m.toJSON())).toEqual([{ type: "size", attrs: { pt: 16 } }]);
    state = run(state, setSize(11, ctx));
    expect(state.doc.firstChild?.firstChild?.marks).toEqual([]);
  });

  it("the size box shows the first selected text's size, or at the cursor the size of what she types next", () => {
    const state = createEditorState(docOf(para([text("a"), text("b", [{ type: "size", attrs: { pt: 14 } }])])));
    expect(selectionSize(selectText(state, 2, 3), ctx)).toBe(14);
    expect(selectionSize(selectText(state, 1, 3), ctx)).toBe(11);
    expect(selectionSize(selectText(state, 3, 3), ctx)).toBe(14);
  });

  it("the size box offers Word's list, plus a current size that is not on it, in order", () => {
    expect(sizeOptions(11)).toContain(36);
    expect(sizeOptions(11).filter((x) => x === 11)).toHaveLength(1);
    const odd = sizeOptions(13.5);
    expect(odd).toContain(13.5);
    expect(odd).toEqual([...odd].sort((x, y) => x - y));
  });

  it("the size box offers 7.5 and the half sizes down to 6, and sets 7.5 pt", () => {
    const list = sizeOptions(11);
    expect(list.slice(0, 5)).toEqual([6, 6.5, 7, 7.5, 8]);
    const state = run(selectText(createEditorState(docOf(para([text("small")]))), 1, 6), setSize(7.5, ctx));
    expect(state.doc.firstChild?.firstChild?.marks.map((m) => m.toJSON())).toEqual([{ type: "size", attrs: { pt: 7.5 } }]);
    expect(selectionSize(selectText(state, 1, 6), ctx)).toBe(7.5);
  });
});

describe("column width", () => {
  const gridOf = (state: EditorState): unknown => state.doc.firstChild?.attrs.grid;
  const three = (grid: number[]): EditorState =>
    createEditorState(docOf(table([row(rid(1), [cell("A"), cell("B"), cell("C")]), row(rid(2), [cell("D", { colspan: 2 }), cell("E")])], grid)));

  it("Wider moves the cell's right border one step, taking it from the column to its right; Narrower gives it back", () => {
    let state = run(at(three([100, 200, 300]), "B"), changeColumnWidth(1));
    expect(gridOf(state)).toEqual([100, 200 + COLUMN_STEP_PT, 300 - COLUMN_STEP_PT]);
    state = run(state, changeColumnWidth(-1));
    state = run(state, changeColumnWidth(-1));
    expect(gridOf(state)).toEqual([100, 200 - COLUMN_STEP_PT, 300 + COLUMN_STEP_PT]);
  });

  it("in the last column moves its left border, and in a merged cell the border after its last column", () => {
    let state = run(at(three([100, 200, 300]), "C"), changeColumnWidth(1));
    expect(gridOf(state)).toEqual([100, 200 - COLUMN_STEP_PT, 300 + COLUMN_STEP_PT]);
    state = run(at(three([100, 200, 300]), "D"), changeColumnWidth(1));
    expect(gridOf(state)).toEqual([100, 200 + COLUMN_STEP_PT, 300 - COLUMN_STEP_PT]);
  });

  it("stops at the narrowest column, the first one included, where it can no longer act", () => {
    let state = at(three([100, 200, 300]), "B");
    while (changeColumnWidth(1)(state)) state = run(state, changeColumnWidth(1));
    expect(gridOf(state)).toEqual([100, 600 - 100 - MIN_COLUMN_PT, MIN_COLUMN_PT]);
    // Narrower still acts there: only the way that is blocked is.
    expect(changeColumnWidth(-1)(state)).toBe(true);
    state = at(state, "A");
    while (changeColumnWidth(-1)(state)) state = run(state, changeColumnWidth(-1));
    expect((gridOf(state) as number[])[0]).toBe(MIN_COLUMN_PT);
    expect(changeColumnWidth(1)(state)).toBe(true);
  });

  it("narrows a first column drawn at the screen's minimum below it, and the screen then draws it as set", () => {
    // 30 of 600 pt is 5%: from her Word file, so the screen draws it at MIN_FIRST_COLUMN_PCT.
    const before = three([30, 270, 300]);
    expect(tableColumns(before.doc.firstChild?.attrs as TableAttrs)[0]).toBe(MIN_FIRST_COLUMN_PCT);
    const state = run(at(before, "A"), changeColumnWidth(-1));
    const t = state.doc.firstChild?.attrs as TableAttrs;
    expect(t.ownWidths).toBe(true);
    expect(t.grid[0]).toBeCloseTo((600 * MIN_FIRST_COLUMN_PCT) / 100 - COLUMN_STEP_PT, 6);
    expect(tableColumns(t)[0]).toBeCloseTo((100 * (t.grid[0] ?? 0)) / 600, 6);
    expect(tableColumns(t)[0]).toBeLessThan(MIN_FIRST_COLUMN_PCT);
  });

  it("cannot act in a cell spanning every column", () => {
    const spanning = at(createEditorState(docOf(table([row(rid(1), [cell("A"), cell("B")]), row(rid(2), [cell("W", { colspan: 2 })])], [100, 200]))), "W");
    expect(changeColumnWidth(1)(spanning)).toBe(false);
    expect(changeColumnWidth(-1)(spanning)).toBe(false);
  });

  it("starts from the widths the screen draws, so a narrow first column is saved as shown", () => {
    const grid = [30, 270, 300];
    const shown = tableColumns({ grid }).map((p) => (p * 600) / 100);
    const state = run(at(three(grid), "B"), changeColumnWidth(1));
    const saved = gridOf(state) as number[];
    expect(saved[0]).toBeCloseTo(shown[0] ?? 0, 1);
    expect(saved[1]).toBeCloseTo((shown[1] ?? 0) + COLUMN_STEP_PT, 1);
    expect(saved[2]).toBeCloseTo((shown[2] ?? 0) - COLUMN_STEP_PT, 1);
    // What the screen then draws is what was saved.
    expect(tableColumns(state.doc.firstChild?.attrs as TableAttrs)[0]).toBeCloseTo(100 * (saved[0] ?? 0) / 600, 1);
  });

  it("redraws the editor's columns from the new grid", () => {
    const view = new EditorView(document.createElement("div"), { state: at(three([100, 200, 300]), "B"), nodeViews: nodeViews(11), markViews: markViews(11) });
    try {
      expect(changeColumnWidth(1)(view.state, view.dispatch)).toBe(true);
      const cols = [...view.dom.querySelectorAll("col")].map((c) => c.style.width);
      expect(cols).toEqual(tableColumns(view.state.doc.firstChild?.attrs as TableAttrs).map((p) => `${p}%`));
      expect(cols[1]).not.toBe(`${100 * 200 / 600}%`);
    } finally {
      view.destroy();
    }
  });

  it("does nothing outside a table or in a one-column table", () => {
    const outside = selectText(createEditorState(docOf(para([text("p")]))), 1, 1);
    expect(changeColumnWidth(1)(outside)).toBe(false);
    const one = at(createEditorState(docOf(table([row(rid(1), [cell("A")])], [300]))), "A");
    expect(changeColumnWidth(1)(one)).toBe(false);
  });

  it("moving a border trades width between the two columns beside it, stopping at their limits", () => {
    const g = (grid: number[]): { grid: number[] } => ({ grid });
    expect(moveColumnBorder(g([100, 200, 300]), 1, 40)).toEqual([100, 240, 260]);
    expect(moveColumnBorder(g([100, 200, 300]), 0, -30.02)).toEqual([70, 230, 300]);
    expect(moveColumnBorder(g([100, 200, 300]), 1, 1000)).toEqual([100, 500 - MIN_COLUMN_PT, MIN_COLUMN_PT]);
    expect(moveColumnBorder(g([100, 200, 300]), 0, -1000)).toEqual([MIN_COLUMN_PT, 300 - MIN_COLUMN_PT, 300]);
    expect(moveColumnBorder(g([100, 500 - MIN_COLUMN_PT, MIN_COLUMN_PT]), 1, 5)).toBeNull();
    expect(moveColumnBorder(g([100, 200, 300]), 2, 5)).toBeNull();
    expect(moveColumnBorder(g([100, 200, 300]), -1, 5)).toBeNull();
    // Her Word widths start from the screen's (a 5% first column drawn at the minimum); her own, as set.
    expect(moveColumnBorder(g([30, 270, 300]), 0, -10)?.[0]).toBeCloseTo((600 * MIN_FIRST_COLUMN_PCT) / 100 - 10, 6);
    expect(moveColumnBorder({ grid: [30, 270, 300], ownWidths: true }, 0, -10)).toEqual([20, 280, 300]);
  });
});

describe("dragging a column border", () => {
  const gridOf = (view: EditorView): unknown => view.state.doc.firstChild?.attrs.grid;
  // A 600 px table of grid [100, 200, 300] pt: 1 px is 1 pt, columns A 0–100, B 100–300, C 300–600.
  const mount = (grid = [100, 200, 300]): EditorView => {
    const state = createEditorState(docOf(table([row(rid(1), [cell("A"), cell("B"), cell("C")]), row(rid(2), [cell("D", { colspan: 3 })])], grid)));
    const view = new EditorView(document.createElement("div"), { state, nodeViews: nodeViews(11), markViews: markViews(11) });
    const box = (left: number, width: number): (() => DOMRect) => () =>
      ({ left, right: left + width, top: 0, bottom: 40, width, height: 40, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
    (view.dom.querySelector("table") as HTMLElement).getBoundingClientRect = box(0, 600);
    const pct = tableColumns({ grid });
    let left = 0;
    view.dom.querySelectorAll("tr")[0]?.querySelectorAll("td").forEach((td, i) => {
      const w = ((pct[i] ?? 0) * 600) / 100;
      td.getBoundingClientRect = box(left, w);
      left += w;
    });
    (view.dom.querySelectorAll("tr")[1]?.querySelector("td") as HTMLElement).getBoundingClientRect = box(0, 600);
    return view;
  };
  const td = (view: EditorView, i: number): HTMLElement => view.dom.querySelectorAll("td")[i] as HTMLElement;
  const mouse = (target: EventTarget, type: string, clientX: number, buttons = 0): MouseEvent => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0, buttons });
    target.dispatchEvent(e);
    return e;
  };

  it("shows the resize pointer on a cell's inside border, not inside the cell or on the table's outer edge", () => {
    const view = mount();
    try {
      mouse(td(view, 1), "mousemove", 298);
      expect(view.dom.style.cursor).toBe("col-resize");
      mouse(td(view, 1), "mousemove", 200);
      expect(view.dom.style.cursor).toBe("");
      mouse(td(view, 0), "mousemove", 2);
      expect(view.dom.style.cursor).toBe("");
      mouse(td(view, 3), "mousemove", 597);
      expect(view.dom.style.cursor).toBe("");
    } finally {
      view.destroy();
    }
  });

  it("drags B's right border 40 px: a guide line follows, and on release B is 40 pt wider and C 40 pt narrower", () => {
    const view = mount();
    try {
      const down = mouse(td(view, 1), "mousedown", 299);
      expect(down.defaultPrevented).toBe(true);
      mouse(document, "mousemove", 339, 1);
      const guide = document.querySelector(".col-drag-guide") as HTMLElement;
      expect(parseFloat(guide.style.left)).toBeCloseTo(340, 6);
      expect(gridOf(view)).toEqual([100, 200, 300]);
      mouse(document, "mouseup", 339);
      expect(gridOf(view)).toEqual([100, 240, 260]);
      expect(document.querySelector(".col-drag-guide")).toBeNull();
      expect(view.state.doc.firstChild?.attrs.ownWidths).toBe(true);
      expect([...view.dom.querySelectorAll("col")].map((c) => c.style.width)).toEqual(tableColumns({ grid: [100, 240, 260], ownWidths: true }).map((p) => `${p}%`));
      // One drag is one undo step.
      undo(view.state, view.dispatch);
      expect(gridOf(view)).toEqual([100, 200, 300]);
    } finally {
      view.destroy();
    }
  });

  it("drags a cell's left border, and a drag past a limit stops at it", () => {
    const view = mount();
    try {
      mouse(td(view, 2), "mousedown", 301);
      mouse(document, "mouseup", 1000);
      expect(gridOf(view)).toEqual([100, 600 - 100 - MIN_COLUMN_PT, MIN_COLUMN_PT]);
    } finally {
      view.destroy();
    }
  });

  it("drags the first column's border left past the screen's first-column minimum, and the columns are redrawn as set", () => {
    // 30 of 600 pt (5%) is drawn at MIN_FIRST_COLUMN_PCT: A spans 0–66 px.
    const view = mount([30, 270, 300]);
    try {
      mouse(td(view, 0), "mousedown", 65);
      mouse(document, "mousemove", 35, 1);
      expect(parseFloat((document.querySelector(".col-drag-guide") as HTMLElement).style.left)).toBeCloseTo(36, 1);
      mouse(document, "mouseup", 35);
      const t = view.state.doc.firstChild?.attrs as TableAttrs;
      expect(t.ownWidths).toBe(true);
      expect(t.grid[0]).toBeCloseTo(36, 1);
      expect(t.grid.reduce((a, b) => a + b, 0)).toBeCloseTo(600, 1);
      expect(view.dom.querySelector("col")?.style.width).toBe(`${(100 * (t.grid[0] ?? 0)) / 600}%`);
    } finally {
      view.destroy();
    }
  });

  it("Escape cancels the drag, and a border on a read-only editor does not drag", () => {
    const view = mount();
    try {
      mouse(td(view, 1), "mousedown", 299);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(document.querySelector(".col-drag-guide")).toBeNull();
      mouse(document, "mouseup", 339);
      expect(gridOf(view)).toEqual([100, 200, 300]);
      view.setProps({ editable: () => false });
      mouse(td(view, 1), "mousemove", 298);
      expect(view.dom.style.cursor).toBe("");
      // Unclaimed, the mousedown reaches ProseMirror's own handler, which asks the document what is under
      // the pointer: jsdom has no elementFromPoint, so it answers "nothing" here.
      Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => null });
      expect(mouse(td(view, 1), "mousedown", 299).defaultPrevented).toBe(false);
      mouse(document, "mouseup", 339);
      expect(gridOf(view)).toEqual([100, 200, 300]);
    } finally {
      Reflect.deleteProperty(document, "elementFromPoint");
      view.destroy();
    }
  });
});

describe("cell text margins", () => {
  const marginsOf = (state: EditorState): unknown => state.doc.firstChild?.attrs.cellMarginPt;
  const inCell = (): EditorState => at(createEditorState(docOf(table([row(rid(1), [cell("A"), cell("B")])]))), "A");

  it("Sides + and Top/bottom + widen the table's margins by 1 pt; − narrows them", () => {
    let state = run(inCell(), changeCellMargins("sides", 1));
    expect(marginsOf(state)).toEqual({ top: 0, right: 6.5, bottom: 0, left: 6.5 });
    state = run(state, changeCellMargins("topBottom", 1));
    expect(marginsOf(state)).toEqual({ top: 1, right: 6.5, bottom: 1, left: 6.5 });
    state = run(state, changeCellMargins("sides", -1));
    expect(marginsOf(state)).toEqual({ top: 1, right: 5.5, bottom: 1, left: 5.5 });
  });

  it("stop at 0 and at the largest margin", () => {
    let state = run(inCell(), changeCellMargins("topBottom", -1));
    expect(marginsOf(state)).toEqual(MARGINS);
    for (let i = 0; i < 40; i++) state = run(state, changeCellMargins("sides", 1));
    expect(marginsOf(state)).toEqual({ top: 0, right: MAX_CELL_MARGIN_PT, bottom: 0, left: MAX_CELL_MARGIN_PT });
  });

  it("do nothing outside a table", () => {
    const state = selectText(createEditorState(docOf(para([text("p")]))), 1, 1);
    expect(changeCellMargins("sides", 1)(state, () => { throw new Error("dispatched"); })).toBe(false);
  });

  it("redraw every cell's padding in the editor, keeping each cell's fill and borders", () => {
    const OUTER = { style: "single", widthPt: 2, color: "FF0000" };
    const INSIDE = { style: "single", widthPt: 1, color: "0000FF" };
    const borders = { top: OUTER, right: OUTER, bottom: OUTER, left: OUTER, insideH: INSIDE, insideV: INSIDE };
    const d = docOf({ type: "table", attrs: { grid: [100, 200], borders, cellMarginPt: MARGINS }, content: [
      row(rid(1), [cell("A", { fill: "00FF00" }), cell("B")]), row(rid(2), [cell("C"), cell("D")]),
    ] });
    const host = document.createElement("div");
    const view = new EditorView(host, { state: at(createEditorState(d), "A"), nodeViews: nodeViews(11), markViews: markViews(11), ...editorProps });
    try {
      const styles = (): string[] => [...host.querySelectorAll("td")].map((td) => td.getAttribute("style") ?? "");
      const pads = (): string[] => [...host.querySelectorAll("td")].map((td) => td.style.padding);
      const before = styles();
      const padsBefore = pads();
      expect(changeCellMargins("sides", 1)(view.state, view.dispatch)).toBe(true);
      expect(changeCellMargins("topBottom", 1)(view.state, view.dispatch)).toBe(true);
      // What the renderer draws for the new margins, read back through the DOM as the cells are.
      const probe = document.createElement("td");
      probe.style.padding = cellPadding({ top: 1, right: 6.5, bottom: 1, left: 6.5 }, 11);
      expect(pads()).toEqual(Array(4).fill(probe.style.padding));
      expect(pads()).not.toEqual(padsBefore);
      // Only the padding changed: each cell keeps its fill and the borders of its place.
      const withoutPadding = (s: string): string => s.replace(/padding:[^;]*;\s*/, "");
      expect(styles().map(withoutPadding)).toEqual(before.map(withoutPadding));
      // Undo draws the old margins again.
      undo(view.state, view.dispatch);
      undo(view.state, view.dispatch);
      expect(styles()).toEqual(before);
    } finally {
      view.destroy();
    }
  });
});

describe("paragraph spacing and indent", () => {
  const one = (attrs: Record<string, unknown> = {}, marks: unknown[] = []) =>
    selectText(createEditorState(docOf(para([text("p", marks)], attrs))), 1, 1);

  it("Tighter from no line rule steps down from 1.22 × font size", () => {
    const state = run(one(), changeLineSpacing(-1, ctx));
    // fontPt 11: now = 13.42, step = roundHalf(1.1) = 1 → roundHalf(12.42) = 12.5
    expect(state.doc.firstChild?.attrs.line).toEqual({ rule: "exact", value: 12.5 });
  });

  it("Tighter floors at 0.8 × font size, using the paragraph's first size mark", () => {
    const state = run(one({ line: { rule: "exact", value: 8.5 } }, [{ type: "size", attrs: { pt: 10 } }]), changeLineSpacing(-1, ctx));
    expect(state.doc.firstChild?.attrs.line).toEqual({ rule: "exact", value: 8 });
  });

  it("Looser on an auto multiple converts it to an exact height", () => {
    const state = run(one({ line: { rule: "auto", value: 1 } }), changeLineSpacing(1, ctx));
    // now = 1 × 1.22 × 11 = 13.42; + 1 → 14.5
    expect(state.doc.firstChild?.attrs.line).toEqual({ rule: "exact", value: 14.5 });
  });

  it("Above − and Below − floor at 0; Above + adds 2", () => {
    let state = run(one({ spaceBefore: 1, spaceAfter: 0 }), changeSpace("spaceBefore", -1));
    expect(state.doc.firstChild?.attrs.spaceBefore).toBe(0);
    state = run(state, changeSpace("spaceAfter", -1));
    expect(state.doc.firstChild?.attrs.spaceAfter).toBe(0);
    state = run(state, changeSpace("spaceBefore", 1));
    expect(state.doc.firstChild?.attrs.spaceBefore).toBe(2);
  });

  it("Move paragraph left may make the indent negative", () => {
    const state = run(one({ indLeft: 4 }), moveParagraph(-1));
    expect(state.doc.firstChild?.attrs.indLeft).toBe(-5);
  });
});

describe("marks", () => {
  it("Bold toggles on and off; Underline uses the single style", () => {
    let state = selectText(createEditorState(docOf(para([text("ab")]))), 1, 3);
    state = run(state, toggleBold);
    state = run(state, toggleUnderline);
    expect(state.doc.firstChild?.firstChild?.marks.map((m) => m.toJSON())).toEqual([{ type: "bold" }, { type: "underline", attrs: { style: "single" } }]);
    state = run(state, toggleBold);
    expect(state.doc.firstChild?.firstChild?.marks.map((m) => m.type.name)).toEqual(["underline"]);
  });

  it("Italic toggles on and off, and Mod-i is bound to it", () => {
    let state = selectText(createEditorState(docOf(para([text("ab")]))), 1, 3);
    state = run(state, toggleItalic);
    expect(state.doc.firstChild?.firstChild?.marks.map((m) => m.toJSON())).toEqual([{ type: "italic" }]);
    state = run(state, toggleItalic);
    expect(state.doc.firstChild?.firstChild?.marks).toEqual([]);

    const host = document.createElement("div");
    const view = new EditorView(host, { state: selectText(createEditorState(docOf(para([text("ab")]))), 1, 3), nodeViews: nodeViews(11), markViews: markViews(11), ...editorProps });
    view.someProp("handleKeyDown", (f) => f(view, new KeyboardEvent("keydown", { key: "i", ctrlKey: true })));
    expect(view.state.doc.firstChild?.firstChild?.marks.map((m) => m.type.name)).toEqual(["italic"]);
    view.destroy();
  });

  it("Highlight in a chosen color replaces the old color and keeps the shade; Remove highlight clears both", () => {
    let state = selectText(createEditorState(docOf(para([text("ab", [{ type: "shade", attrs: { hex: "CCCCCC" } }])]))), 1, 3);
    state = run(state, setHighlight("FFFF00"));
    state = run(state, setHighlight("00FFFF"));
    expect(state.doc.firstChild?.firstChild?.marks.map((m) => m.toJSON())).toEqual([
      { type: "highlight", attrs: { hex: "00FFFF" } },
      { type: "shade", attrs: { hex: "CCCCCC" } },
    ]);
    state = run(state, removeHighlight);
    expect(state.doc.firstChild?.firstChild?.marks).toEqual([]);
  });

  it("Highlight with nothing selected highlights what she types next", () => {
    let state = run(selectText(createEditorState(docOf(para([text("a")]))), 2, 2), setHighlight("FF00FF"));
    state = state.apply(state.tr.insertText("b"));
    expect(state.doc.firstChild?.lastChild?.marks.map((m) => m.toJSON())).toEqual([{ type: "highlight", attrs: { hex: "FF00FF" } }]);
  });
});

describe("add and move pictures", () => {
  const pic = (widthPx: number, heightPx: number) => ({ asset: ASSET, widthPx, heightPx });
  const images = (state: EditorState): PMNode[] => {
    const out: PMNode[] = [];
    state.doc.descendants((n) => { if (n.type === schema.nodes.image) out.push(n); });
    return out;
  };

  it("goes in at the cursor at its natural size (96 px = 72 pt), selected", () => {
    const state = run(selectText(createEditorState(docOf(para([text("ab")]))), 2, 2), insertPicture(pic(96, 48), ctx));
    expect(state.doc.firstChild?.toJSON().content.map((n: { type: string }) => n.type)).toEqual(["text", "image", "text"]);
    expect(images(state)[0]?.attrs).toEqual({ asset: ASSET, widthPt: 72, heightPt: 36, rot: 0, flipH: false, flipV: false, crop: null });
    expect(state.selection instanceof NodeSelection && state.selection.node.type.name).toBe("image");
  });

  it("shrinks to the page width, or to its table cell's width, keeping its proportions", () => {
    let state = run(selectText(createEditorState(docOf(para([text("ab")]))), 1, 1), insertPicture(pic(1440, 720), ctx));
    expect(images(state)[0]?.attrs).toMatchObject({ widthPt: 540, heightPt: 270 });
    state = run(at(createEditorState(docOf(table([row(rid(1), [cell("A"), cell("B")])], [100, 300]))), "A"), insertPicture(pic(1440, 720), ctx));
    expect(images(state)[0]?.attrs).toMatchObject({ widthPt: 100, heightPt: 50 });
  });

  it("never replaces selected text or a selected picture", () => {
    let state = run(selectText(createEditorState(docOf(para([text("abc")]))), 1, 3), insertPicture(pic(96, 96), ctx));
    expect(state.doc.textContent).toBe("abc");
    state = run(state, insertPicture({ asset: `${"b".repeat(32)}.png`, widthPx: 96, heightPx: 96 }, ctx));
    expect(images(state).map((n) => n.attrs.asset)).toEqual([ASSET, `${"b".repeat(32)}.png`]);
  });

  it("a picture with no size is refused", () => {
    const state = createEditorState(docOf(para([text("a")])));
    expect(insertPicture(pic(0, 10), ctx)(state, () => { throw new Error("dispatched"); })).toBe(false);
  });

  it("only moving a dragged picture within the editor is a drop she may make", () => {
    const state = createEditorState(docOf(para([text("a"), { type: "image", attrs: { asset: ASSET, widthPt: 20, heightPt: 20 } }])));
    // A dragged picture: the paragraph it left, open, holding only the picture.
    const picSlice = state.doc.slice(2, 3);
    const textSlice = state.doc.slice(1, 2);
    expect(isPictureMove(picSlice, true)).toBe(true);
    expect(isPictureMove(state.doc.slice(1, 3), true)).toBe(false);
    expect(isPictureMove(picSlice, false)).toBe(false);
    expect(isPictureMove(textSlice, true)).toBe(false);
    const drop = (slice: unknown, moved: boolean): unknown => editorProps.handleDrop?.call(null as never, null as never, null as never, slice as never, moved);
    expect(drop(picSlice, true)).toBe(false);
    expect(drop(picSlice, false)).toBe(true);
    expect(drop(textSlice, true)).toBe(true);
  });

  it("a moved picture is not counted as lost by the picture guard", () => {
    let state = createEditorState(docOf(para([text("a"), { type: "image", attrs: { asset: ASSET, widthPt: 20, heightPt: 20 } }]), para([text("b")])));
    const slice = state.doc.slice(2, 3);
    state = state.apply(state.tr.delete(2, 3).replace(5, 5, slice));
    expect(images(state)).toHaveLength(1);
    expect(state.doc.child(1).childCount).toBe(2);
  });
});

describe("picture size", () => {
  const img = (w: number) => ({ type: "image", attrs: { asset: ASSET, widthPt: w, heightPt: w / 2 } });

  it("clamps to 24 pt when shrinking", () => {
    const s0 = createEditorState(docOf(para([img(26)])));
    const state = run(s0.apply(s0.tr.setSelection(NodeSelection.create(s0.doc, 1))), resizePicture(-1, ctx));
    const attrs = (state.doc.firstChild?.firstChild as PMNode).attrs;
    expect(attrs.widthPt).toBe(24);
    expect(attrs.heightPt).toBeCloseTo(12, 10);
  });

  it("clamps to the containing cell's grid width when growing", () => {
    const pic = { type: "table_cell", attrs: {}, content: [para([img(95)])] };
    const s0 = createEditorState(docOf(table([row(rid(1), [pic, cell("B")])], [100, 300])));
    let imgPos = -1;
    s0.doc.descendants((n, pos) => { if (n.type === schema.nodes.image) imgPos = pos; });
    const state = run(s0.apply(s0.tr.setSelection(NodeSelection.create(s0.doc, imgPos))), resizePicture(1, ctx));
    let width = 0;
    state.doc.descendants((n) => { if (n.type === schema.nodes.image) width = n.attrs.widthPt as number; });
    expect(width).toBe(100);
  });

  it("clamps to the page content width outside tables", () => {
    const s0 = createEditorState(docOf(para([img(500)])));
    const state = run(s0.apply(s0.tr.setSelection(NodeSelection.create(s0.doc, 1))), resizePicture(1, ctx));
    expect((state.doc.firstChild?.firstChild as PMNode).attrs.widthPt).toBe(540);
  });

  const size = (widthPt: number, heightPt: number) => ({ widthPt, heightPt });
  const LIMIT = size(468, 648);
  const near = (got: { widthPt: number; heightPt: number }, want: { widthPt: number; heightPt: number }) => {
    expect(got.widthPt).toBeCloseTo(want.widthPt, 10);
    expect(got.heightPt).toBeCloseTo(want.heightPt, 10);
  };

  it("one step (shared by doc pictures and a gap box's figures) is × 1.15 or ÷ 1.15 of both sides within the limits", () => {
    near(steppedPictureSize(size(200, 100), 1, LIMIT), size(230, 115));
    near(steppedPictureSize(size(230, 115), -1, LIMIT), size(200, 100));
    near(steppedPictureSize(size(450, 225), 1, LIMIT), size(468, 234));
    near(steppedPictureSize(size(26, 13), -1, LIMIT), size(24, 12));
    // A limit under 24 never forces a picture below 24.
    near(steppedPictureSize(size(30, 15), 1, size(10, 648)), size(24, 12));
    // A squished picture stays squished, and a tall one stops at the page's height.
    near(steppedPictureSize(size(300, 60), -1, LIMIT), size(300 / 1.15, 60 / 1.15));
    near(steppedPictureSize(size(100, 600), 1, LIMIT), size(108, 648));
  });

  it("Picture − steps down from the shown width when the column shows the picture narrower; + and a wider shown width don't", () => {
    near(steppedPictureSize(size(540, 270), -1, size(540, 720), 400), size(400 / 1.15, 200 / 1.15));
    near(steppedPictureSize(size(300, 150), -1, size(540, 720), 400), size(300 / 1.15, 150 / 1.15));
    near(steppedPictureSize(size(500, 250), 1, size(540, 720), 400), size(540, 270));
    near(steppedPictureSize(size(540, 270), -1, size(540, 720), null), size(540 / 1.15, 270 / 1.15));
    near(seenPictureSize(size(540, 100), 400), size(400, (100 * 400) / 540));
    near(seenPictureSize(size(300, 100), 400), size(300, 100));
  });

  it("scaling keeps proportions, the width at least 24, and both sides within the limits", () => {
    near(scaledPictureSize(size(100, 50), 2, LIMIT), size(200, 100));
    near(scaledPictureSize(size(100, 50), 0.1, LIMIT), size(24, 12));
    near(scaledPictureSize(size(400, 100), 2, LIMIT), size(468, 117));
    near(scaledPictureSize(size(100, 400), 2, LIMIT), size(162, 648));
  });

  it("a corner drag scales both sides by the side that changed more; a side drag changes only its own side", () => {
    // Dragging away from the middle makes it bigger: right/down on se, left/up on nw.
    near(draggedPictureSize(size(200, 100), "se", 100, 10, LIMIT), size(300, 150));
    near(draggedPictureSize(size(200, 100), "nw", -20, -50, LIMIT), size(300, 150));
    // Pulled in, the corner follows the side that moved more, even when the other barely moved.
    near(draggedPictureSize(size(200, 100), "ne", -100, 25, LIMIT), size(100, 50));
    near(draggedPictureSize(size(200, 100), "se", -80, 0, LIMIT), size(120, 60));
    near(draggedPictureSize(size(200, 100), "nw", 0, 30, LIMIT), size(140, 70));
    near(draggedPictureSize(size(200, 100), "sw", 1000, -1000, LIMIT), size(24, 12));
    near(draggedPictureSize(size(200, 100), "e", 50, 999, LIMIT), size(250, 100));
    near(draggedPictureSize(size(200, 100), "w", 50, 0, LIMIT), size(150, 100));
    near(draggedPictureSize(size(200, 100), "s", 999, 80, LIMIT), size(200, 180));
    near(draggedPictureSize(size(200, 100), "n", 0, 90, LIMIT), size(200, 24));
    // Squished to the minimum, stretched to the limit; a side drag never moves the other side.
    near(draggedPictureSize(size(200, 10), "e", -500, 0, LIMIT), size(24, 10));
    near(draggedPictureSize(size(200, 100), "s", 0, 5000, LIMIT), size(200, 648));
    near(draggedPictureSize(size(200, 100), "e", 5000, 0, LIMIT), size(468, 100));
  });

  it("a drag on a turned picture is read in the picture's own frame", () => {
    // As "handle dx dy" (so a −0 reads as 0).
    const own = (...a: Parameters<typeof unturnedDrag>): string => {
      const d = unturnedDrag(...a);
      return `${d.handle} ${d.dx} ${d.dy}`;
    };
    expect(own("se", 10, 20, {})).toBe("se 10 20");
    // A quarter turn clockwise: the handle seen on the right is its top one, and right is up.
    expect(own("e", 10, 0, { rot: 90 })).toBe("n 0 -10");
    expect(own("se", 10, 20, { rot: 90 })).toBe("ne 20 -10");
    expect(own("e", 10, 0, { rot: 180 })).toBe("w -10 0");
    // Three quarter turns: its own left side is seen at the bottom, and down is left.
    expect(own("s", 0, 10, { rot: 270 })).toBe("w -10 0");
    expect(own("e", 10, 0, { flipH: true })).toBe("w -10 0");
    expect(own("n", 0, -10, { flipV: true })).toBe("s 0 10");
    // Dragged outward, the turned picture's own side grows either way.
    const d = unturnedDrag("e", 30, 0, { rot: 90 });
    near(draggedPictureSize(size(200, 100), d.handle, d.dx, d.dy, LIMIT), size(200, 130));
  });

  it("dragPicture saves the dragged size, within the cell's width; Reset shape gives back the file's proportions", () => {
    const pic = { type: "table_cell", attrs: {}, content: [para([img(90)])] };
    const s0 = createEditorState(docOf(table([row(rid(1), [pic, cell("B")])], [100, 300])));
    let imgPos = -1;
    s0.doc.descendants((n, pos) => { if (n.type === schema.nodes.image) imgPos = pos; });
    const picked = s0.apply(s0.tr.setSelection(NodeSelection.create(s0.doc, imgPos)));
    const attrsOf = (st: typeof s0) => st.doc.nodeAt(imgPos)?.attrs as { widthPt: number; heightPt: number };
    expect(selectedPictureSize(picked, ctx)).toEqual({ size: size(90, 45), crop: null, limit: size(100, 720) });
    // Stretched down 30 pt: only the height changes.
    const tall = run(picked, dragPicture(size(90, 45), "s", 0, 30, ctx));
    near(attrsOf(tall), size(90, 75));
    expect(tall.selection).toBeInstanceOf(NodeSelection);
    // Widened past the cell: stops at its 100 pt.
    near(attrsOf(run(tall, dragPicture(size(90, 75), "e", 500, 0, ctx))), size(100, 75));
    // Reset shape: its width kept, its height back to the file's 2:1.
    near(attrsOf(run(tall, resetPictureShape(0.5, ctx))), size(90, 45));
    // Picture + on the stretched picture keeps it stretched.
    near(attrsOf(run(tall, resizePicture(1, ctx))), size(100, (75 * 100) / 90));
  });

  it("no picture selected: the size commands do nothing", () => {
    const s0 = createEditorState(docOf(para([img(90)])));
    expect(selectedPictureSize(s0, ctx)).toBeNull();
    expect(dragPicture(size(90, 45), "e", 10, 0, ctx)(s0)).toBe(false);
    expect(resetPictureShape(0.5, ctx)(s0)).toBe(false);
  });

  it("a picture put in taller than the page is shrunk to its height, its proportions kept", () => {
    const s0 = createEditorState(docOf(para([text("x")])));
    const state = run(s0, insertPicture({ asset: ASSET, widthPx: 400, heightPx: 2000 }, ctx));
    const pics: { widthPt: number; heightPt: number }[] = [];
    state.doc.descendants((n) => { if (n.type === schema.nodes.image) pics.push(n.attrs as never); });
    expect(pics).toHaveLength(1);
    near(pics[0] ?? size(0, 0), size(144, 720));
  });

  it("resizePicture's Picture − on a capped picture saves a width below the shown one, height scaled alike", () => {
    const s0 = createEditorState(docOf(para([img(540)])));
    const state = run(s0.apply(s0.tr.setSelection(NodeSelection.create(s0.doc, 1))), resizePicture(-1, ctx, 400));
    const attrs = (state.doc.firstChild?.firstChild as PMNode).attrs;
    expect(attrs.widthPt).toBeCloseTo(400 / 1.15, 10);
    expect(attrs.heightPt).toBeCloseTo(400 / 1.15 / 2, 10);
  });

  it("the shown width is read from layout sizes, so the page drawn smaller by a scale transform doesn't change it", () => {
    const el = document.createElement("img");
    el.style.fontSize = "15px";
    document.body.append(el);
    try {
      // With the page drawn at scale(0.79) beside the open sidebar, the box is drawn at 237 px; its layout width stays 300 px.
      Object.defineProperty(el, "offsetWidth", { configurable: true, value: 300 });
      el.getBoundingClientRect = () => ({ width: 237, height: 100, x: 0, y: 0, top: 0, left: 0, right: 237, bottom: 100, toJSON: () => ({}) });
      expect(shownPictureWidth(el, 11)).toBeCloseTo((300 / 15) * 11, 10);
      Object.defineProperty(el, "offsetWidth", { configurable: true, value: 0 });
      expect(shownPictureWidth(el, 11)).toBeNull();
      expect(shownPictureWidth(null, 11)).toBeNull();
      expect(shownPictureWidth(document.createTextNode("x"), 11)).toBeNull();
    } finally {
      el.remove();
    }
  });

  it("a picture's natural width is 96 px = 72 pt, shrunk to the limit", () => {
    expect(naturalPictureWidth(96, 468)).toBe(72);
    expect(naturalPictureWidth(960, 468)).toBe(468);
    expect(naturalPictureWidth(960, 10)).toBe(24);
  });
});

describe("picture crop", () => {
  const size = (widthPt: number, heightPt: number) => ({ widthPt, heightPt });
  const LIMIT = size(468, 648);
  const crop = (l: number, t: number, r: number, b: number) => ({ l, t, r, b });
  /** A crop drag's result, its box rounded to a millionth of a pt (the fractions are stored to 6 decimals). */
  const cropped = (...a: Parameters<typeof draggedPictureCrop>) => {
    const out = draggedPictureCrop(...a);
    const pt = (v: number) => Math.round(v * 1e6) / 1e6;
    return { size: size(pt(out.size.widthPt), pt(out.size.heightPt)), crop: out.crop };
  };
  // A 200 × 100 pt picture showing its whole file.
  const whole = { size: size(200, 100), crop: null };

  it("a side handle cuts its own edge, and the box shrinks with what it keeps, at the picture's scale", () => {
    expect(cropped(whole, "e", -50, 999, LIMIT)).toEqual({ size: size(150, 100), crop: crop(0, 0, 0.25, 0) });
    expect(cropped(whole, "w", 40, 0, LIMIT)).toEqual({ size: size(160, 100), crop: crop(0.2, 0, 0, 0) });
    expect(cropped(whole, "n", 999, 30, LIMIT)).toEqual({ size: size(200, 70), crop: crop(0, 0.3, 0, 0) });
    expect(cropped(whole, "s", 0, -20, LIMIT)).toEqual({ size: size(200, 80), crop: crop(0, 0, 0, 0.2) });
  });

  it("a corner cuts both of its edges", () => {
    expect(cropped(whole, "se", -50, -20, LIMIT)).toEqual({ size: size(150, 80), crop: crop(0, 0, 0.25, 0.2) });
    expect(cropped(whole, "nw", 20, 10, LIMIT)).toEqual({ size: size(180, 90), crop: crop(0.1, 0.1, 0, 0) });
  });

  it("dragging an edge outward brings back what was cut, up to the file's own edge", () => {
    // Cut 25% off each side: the box shows 100 of the file's 200 pt.
    const start = { size: size(100, 100), crop: crop(0.25, 0, 0.25, 0) };
    expect(cropped(start, "e", 30, 0, LIMIT)).toEqual({ size: size(130, 100), crop: crop(0.25, 0, 0.1, 0) });
    expect(cropped(start, "e", 500, 0, LIMIT)).toEqual({ size: size(150, 100), crop: crop(0.25, 0, 0, 0) });
    // An uncropped picture has nothing to bring back; dragging both cuts away leaves no crop.
    expect(cropped(whole, "e", 50, 0, LIMIT)).toEqual({ size: size(200, 100), crop: null });
    expect(cropped({ size: size(150, 100), crop: crop(0, 0, 0.25, 0) }, "e", 80, 0, LIMIT)).toEqual({ size: size(200, 100), crop: null });
  });

  it("keeps at least 24 pt of the picture, and brings back no more than its size limit allows", () => {
    expect(cropped(whole, "e", -190, 0, LIMIT)).toEqual({ size: size(24, 100), crop: crop(0, 0, 0.88, 0) });
    expect(cropped(whole, "sw", 500, -500, LIMIT)).toEqual({ size: size(24, 24), crop: crop(0.88, 0, 0, 0.76) });
    const start = { size: size(100, 100), crop: crop(0.25, 0, 0.25, 0) };
    expect(cropped(start, "e", 500, 0, size(120, 648))).toEqual({ size: size(120, 100), crop: crop(0.25, 0, 0.15, 0) });
  });

  it("cuts a squished picture in its own proportions", () => {
    // Its file drawn 200 × 50: cutting 25 pt off the bottom cuts half the file's height.
    expect(cropped({ size: size(200, 50), crop: null }, "s", 0, -25, LIMIT)).toEqual({ size: size(200, 25), crop: crop(0, 0, 0, 0.5) });
  });

  it("a crop drag on a turned picture cuts the edge seen under the pointer", () => {
    // Turned a quarter clockwise, the edge seen on the right is its own top.
    const d = unturnedDrag("e", -30, 0, { rot: 90 });
    expect(cropped(whole, d.handle, d.dx, d.dy, LIMIT)).toEqual({ size: size(200, 70), crop: crop(0, 0.3, 0, 0) });
  });

  it("crop mode outlines where the new kept part sits in the picture's current box", () => {
    expect(cropWindow(crop(0.25, 0, 0.25, 0), crop(0.25, 0, 0.5, 0))).toEqual({ left: 0, top: 0, width: 0.5, height: 1 });
    expect(cropWindow(crop(0.25, 0, 0.25, 0), crop(0, 0, 0.25, 0))).toEqual({ left: -0.5, top: 0, width: 1.5, height: 1 });
    expect(cropWindow(null, crop(0.1, 0.2, 0, 0))).toEqual({ left: 0.1, top: 0.2, width: 0.9, height: 0.8 });
    expect(cropWindow(null, null)).toEqual({ left: 0, top: 0, width: 1, height: 1 });
  });

  it("Reset crop shows the whole file at the picture's scale, within the limits", () => {
    const start = { size: size(100, 100), crop: crop(0.25, 0, 0.25, 0) };
    expect(uncroppedPictureSize(start, LIMIT)).toEqual(size(200, 100));
    expect(uncroppedPictureSize(start, size(150, 648))).toEqual(size(150, 75));
    expect(uncroppedPictureSize(whole, LIMIT)).toEqual(size(200, 100));
  });

  describe("on a selected picture", () => {
    const img = { type: "image", attrs: { asset: ASSET, widthPt: 200, heightPt: 100 } };
    const picked = (() => {
      const s0 = createEditorState(docOf(para([img])));
      return s0.apply(s0.tr.setSelection(NodeSelection.create(s0.doc, 1)));
    })();
    const attrsOf = (st: EditorState) => st.doc.nodeAt(1)?.attrs as { widthPt: number; heightPt: number; crop: unknown };

    it("a crop drag saves the crop and the box, and the picture stays selected", () => {
      const st = run(picked, dragPictureCrop(whole, "e", -50, 0, ctx));
      expect(attrsOf(st)).toMatchObject({ widthPt: 150, heightPt: 100, crop: crop(0, 0, 0.25, 0) });
      expect(st.selection).toBeInstanceOf(NodeSelection);
      expect(selectedPictureSize(st, ctx)).toEqual({ size: size(150, 100), crop: crop(0, 0, 0.25, 0), limit: size(540, 720) });
    });

    it("Picture − / + and a resize drag keep the crop", () => {
      const st = run(picked, dragPictureCrop(whole, "e", -50, 0, ctx));
      expect(attrsOf(run(st, resizePicture(1, ctx))).crop).toEqual(crop(0, 0, 0.25, 0));
      expect(attrsOf(run(st, dragPicture(size(150, 100), "s", 0, 20, ctx)))).toMatchObject({ widthPt: 150, heightPt: 120, crop: crop(0, 0, 0.25, 0) });
    });

    it("Reset shape gives the kept part the file's proportions", () => {
      // The file is 2:1 (height/width 0.5); keeping the left half, the kept part is square.
      const st = run(picked, dragPictureCrop(whole, "e", -100, 0, ctx));
      const squished = run(st, dragPicture(size(100, 100), "s", 0, -40, ctx));
      expect(attrsOf(squished)).toMatchObject({ widthPt: 100, heightPt: 60 });
      expect(attrsOf(run(squished, resetPictureShape(0.5, ctx)))).toMatchObject({ widthPt: 100, heightPt: 100, crop: crop(0, 0, 0.5, 0) });
    });

    it("Reset crop brings back the whole file and stores no crop", () => {
      const st = run(run(picked, dragPictureCrop(whole, "se", -50, -20, ctx)), resetPictureCrop(ctx));
      expect(attrsOf(st)).toMatchObject({ widthPt: 200, heightPt: 100, crop: null });
      expect(st.selection).toBeInstanceOf(NodeSelection);
    });

    it("no picture selected: the crop commands do nothing", () => {
      const s0 = createEditorState(docOf(para([img])));
      expect(dragPictureCrop(whole, "e", -50, 0, ctx)(s0)).toBe(false);
      expect(resetPictureCrop(ctx)(s0)).toBe(false);
    });
  });
});

describe("Copy my changes text", () => {
  it("writes paragraphs and table rows as lines with tab-separated cells", () => {
    const d = schema.nodeFromJSON(docOf(para([text("Intro")]), table([row(rid(1), [cell("A1"), cell("B 1")]), row(rid(2), [cell("A2"), cell("")])])));
    expect(docLines(d)).toEqual(["Intro", "A1\tB 1", "A2\t"]);
  });
});

describe("table cell borders", () => {
  const OUTER = { style: "single", widthPt: 2, color: "FF0000" };
  const INSIDE = { style: "single", widthPt: 1, color: "0000FF" };
  const borders = { top: OUTER, right: OUTER, bottom: OUTER, left: OUTER, insideH: INSIDE, insideV: INSIDE };

  it("take the outer or inside border of their new place after Row ↓ at the bottom and deleting the first row", async () => {
    const d = docOf({ type: "table", attrs: { grid: [100, 200], borders, cellMarginPt: MARGINS }, content: [
      row(rid(1), [cell("A"), cell("B")]), row(rid(2), [cell("C"), cell("D")]),
    ] });
    const host = document.createElement("div");
    const view = new EditorView(host, { state: at(createEditorState(d), "C"), nodeViews: nodeViews(11), markViews: markViews(11), ...editorProps });
    const tds = (): HTMLTableCellElement[][] => [...host.querySelectorAll("tr")].map((tr) => [...tr.querySelectorAll("td")]);
    const red = (s: string): boolean => s.includes("255, 0, 0") || s.toLowerCase().includes("#ff0000");

    expect(insertRow("below")(view.state, view.dispatch)).toBe(true);
    let rows = tds();
    expect(rows).toHaveLength(3);
    // The old last row (C D) now draws the inside border below; the new row draws the outer one.
    expect(rows[1]?.every((td) => !red(td.style.borderBottom))).toBe(true);
    expect(rows[2]?.every((td) => red(td.style.borderBottom))).toBe(true);

    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, posOf(view.state.doc, "A"))));
    expect(await deleteRow(async () => true)(view)).toBe(true);
    rows = tds();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.map((td) => td.textContent)).toEqual(["C", "D"]);
    expect(rows[0]?.every((td) => red(td.style.borderTop))).toBe(true);
    expect(rows[1]?.every((td) => red(td.style.borderBottom) && !red(td.style.borderTop))).toBe(true);
    view.destroy();
  });
});

describe("node views", () => {
  it("draws a document the way the renderer styles it", () => {
    const host = document.createElement("div");
    const d = docOf(
      para([text("hi", [{ type: "bold" }, { type: "size", attrs: { pt: 22 } }])], { indLeft: 11, marker: { text: "•", font: null, marks: [], tabPt: 11 } }),
      table([row(rid(1), [cell("A", { fill: "FF0000" }), cell("B")])]),
      { type: "rule", attrs: { color: "A0A0A0", widthPt: 1 } },
    );
    const view = new EditorView(host, { state: createEditorState(d), nodeViews: nodeViews(11), markViews: markViews(11), ...editorProps });
    const p = host.querySelector("p") as HTMLElement;
    expect(p.style.marginLeft).toBe("1em");
    expect(p.querySelector(".marker")?.textContent).toBe("•");
    expect(p.querySelector("strong")).not.toBeNull();
    expect(host.querySelector("span[style*='font-size']")?.getAttribute("style")).toContain("2em");
    expect(host.querySelectorAll("col")).toHaveLength(2);
    expect((host.querySelector("td") as HTMLElement).style.background).toContain("255, 0, 0");
    expect(host.querySelector("hr")).not.toBeNull();
    view.destroy();
  });

  it("starts a table that reaches into Word's page margin at the column's edge, as the renderer does", () => {
    const host = document.createElement("div");
    const d = docOf({ type: "table", attrs: { grid: [100, 200], indentPt: -27.25, borders: NONE, cellMarginPt: MARGINS }, content: [row(rid(1), [cell("A"), cell("B")])] });
    const view = new EditorView(host, { state: createEditorState(d), nodeViews: nodeViews(11), markViews: markViews(11), ...editorProps });
    expect((host.querySelector("table") as HTMLElement).style.marginLeft).toBe("0em");
    view.destroy();
  });
});
