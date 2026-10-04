// Editor behavior (plan 50 §50.3; 99 §99.1 app/edit/editor.test.ts).
import { afterEach, describe, expect, it } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState, NodeSelection, TextSelection } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";
import { redo, undo } from "prosemirror-history";
import { EditorView } from "prosemirror-view";
import { schema } from "../../../lib/schema.ts";
import type { DocJSON } from "../../../lib/content/index.ts";
import {
  addHighlight, changeLineSpacing, changeSize, changeSpace, CONFIRMED_DELETE, deletePicture, deleteRow, deleteRowPrompt,
  docLines, moveParagraph, removeHighlight, resizePicture, splitParagraph, toggleBold, toggleUnderline, insertRow,
  type Command,
} from "./commands.ts";
import { createEditorState, editorProps, PICTURE_REFUSED } from "./state.ts";
import { clipboardSerializer, markViews, nodeViews } from "./views.ts";

const ctx = { basePt: 11, pageContentPt: 540 };
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

  it("is a no-op on an empty selection", () => {
    const state = selectText(createEditorState(docOf(para([text("w")]))), 1, 1);
    expect(changeSize(1, ctx)(state, () => { throw new Error("dispatched"); })).toBe(false);
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

  it("Highlight adds FFFF00; Remove highlight clears highlight and shade", () => {
    let state = selectText(createEditorState(docOf(para([text("ab", [{ type: "shade", attrs: { hex: "CCCCCC" } }])]))), 1, 3);
    state = run(state, addHighlight);
    expect(state.doc.firstChild?.firstChild?.marks.map((m) => m.toJSON())).toEqual([
      { type: "highlight", attrs: { hex: "FFFF00" } },
      { type: "shade", attrs: { hex: "CCCCCC" } },
    ]);
    state = run(state, removeHighlight);
    expect(state.doc.firstChild?.firstChild?.marks).toEqual([]);
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
});
