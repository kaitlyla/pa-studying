import { describe, expect, it } from "vitest";
import type { DocJSON } from "../content/types.ts";
import { columnView, noteView, rowsView } from "./columns.ts";
import { nodeText, type PMNode } from "./text.ts";

type Cell = string | { text: string; colspan?: number; rowspan?: number };

/** A one-table doc; each row is its id and its cells (a cell may span). */
function tableOf(grid: number[], rows: [string, ...Cell[]][]): DocJSON {
  return {
    type: "doc",
    content: [{
      type: "table",
      attrs: { grid, cellMarginPt: 0 },
      content: rows.map(([id, ...cells]) => ({
        type: "table_row",
        attrs: { id, kind: "content" },
        content: cells.map((c) => {
          const { text, colspan = 1, rowspan = 1 } = typeof c === "string" ? { text: c } : c;
          return { type: "table_cell", attrs: { colspan, rowspan, colwidth: [grid[0] ?? 0], fill: null }, content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
        }),
      })),
    }],
  };
}

/** Each row of the view: its id, then each cell's text with its spans. */
function shape(doc: DocJSON): [string, ...string[]][] {
  const table = doc.content[0] as PMNode;
  return (table.content ?? []).map((r) => [
    String(r.attrs?.id),
    ...(r.content ?? []).map((c) => `${nodeText(c)}${c.attrs?.colspan === 1 ? "" : `|c${String(c.attrs?.colspan)}`}${c.attrs?.rowspan === 1 ? "" : `|r${String(c.attrs?.rowspan)}`}`),
  ]);
}

const vitamins = tableOf([60, 100, 120, 140], [
  ["r0", "Vitamin", "Vitamin A", "Vitamin D", "Vitamin E"],
  ["r1", "RDA", "900 mcg", "15 mcg", "15 mg"],
  ["r2", "Toxicity", "Liver damage", "Hypercalcemia", "Bleeding"],
]);

describe("columnView: one column of a table, under its first-row text", () => {
  it("keeps the first column and the chosen one from the second row on, titled by the chosen column's header", () => {
    const view = columnView(vitamins, 2);
    expect(view?.title).toBe("Vitamin D");
    expect(shape(view?.doc as DocJSON)).toEqual([["r1", "RDA", "15 mcg"], ["r2", "Toxicity", "Hypercalcemia"]]);
    expect(columnView(vitamins, 3)?.title).toBe("Vitamin E");
    expect(shape(columnView(vitamins, 1)?.doc as DocJSON)).toEqual([["r1", "RDA", "900 mcg"], ["r2", "Toxicity", "Liver damage"]]);
  });

  it("keeps the table's attributes and row ids, gives the label column its width and the kept column the rest", () => {
    const table = (columnView(vitamins, 1)?.doc as DocJSON).content[0] as PMNode;
    expect(table.attrs).toEqual({ grid: [60, 360], cellMarginPt: 0 });
    expect((table.content ?? [])[0]?.attrs).toEqual({ id: "r1", kind: "content" });
    // Cell widths follow the new grid rather than the original column's.
    expect((table.content ?? [])[0]?.content?.[1]?.attrs).toMatchObject({ colspan: 1, rowspan: 1, colwidth: null, fill: null });
  });

  it("places merged cells on the grid: a label spanning rows stays once, a row-wide cell spans both kept columns", () => {
    const doc = tableOf([60, 100, 100], [
      ["h", "Vitamin", "B1", "B2"],
      ["a", { text: "Sources", rowspan: 2 }, "Pork", "Milk"],
      ["b", "Grains", "Eggs"],
      ["c", { text: "Note: all water-soluble", colspan: 3 }],
    ]);
    expect(shape(columnView(doc, 2)?.doc as DocJSON)).toEqual([
      ["a", "Sources|r2", "Milk"],
      ["b", "Eggs"],
      ["c", "Note: all water-soluble|c2"],
    ]);
  });

  it("starts a cell that spans down from the header row on the second row, covering only the rows it reaches there", () => {
    const doc = tableOf([60, 100, 100], [
      ["h", { text: "Vitamin", rowspan: 2 }, "B1", "B2"],
      ["a", "x1", "x2"],
      ["b", "Toxicity", "None", "Rare"],
    ]);
    expect(shape(columnView(doc, 1)?.doc as DocJSON)).toEqual([["a", "Vitamin", "x1"], ["b", "Toxicity", "None"]]);
  });

  it("shows grid column `label` beside the chosen column instead of the first, giving it its own width", () => {
    // Pairs of name and notes columns: label 2 names the condition whose notes are column 3.
    const pairs = tableOf([50, 80, 60, 90], [
      ["h", "Disease", "Tx", "Disease", "Tx"],
      ["a", "Labyrinthitis", "Steroids", "Ramsay-Hunt", "Valacyclovir"],
      ["b", { text: "All: rest", colspan: 4 }],
    ]);
    const view = columnView(pairs, 3, 2);
    expect(view?.title).toBe("Tx");
    expect(shape(view?.doc as DocJSON)).toEqual([["a", "Ramsay-Hunt", "Valacyclovir"], ["b", "All: rest|c2"]]);
    expect(((view?.doc as DocJSON).content[0] as PMNode).attrs?.grid).toEqual([60, 220]);
  });

  it("is null for a label column not left of the chosen one", () => {
    expect(columnView(vitamins, 2, 2)).toBeNull();
    expect(columnView(vitamins, 1, 2)).toBeNull();
    expect(columnView(vitamins, 2, -1)).toBeNull();
  });

  it("is null for a doc that is not one table, or a column the table does not have", () => {
    expect(columnView(vitamins, 0)).toBeNull();
    expect(columnView(vitamins, 4)).toBeNull();
    expect(columnView(vitamins, 1.5)).toBeNull();
    expect(columnView({ type: "doc", content: [{ type: "paragraph" }] }, 1)).toBeNull();
    expect(columnView({ type: "doc", content: [...vitamins.content, { type: "paragraph" }] }, 1)).toBeNull();
  });
});

describe("rowsView: a table's header row and the chosen rows", () => {
  const screens = tableOf([60, 100], [
    ["h", "Screening", "Who"],
    ["t", "Tobacco", "Adults"],
    ["d", "Depression", "12 and older"],
    ["u", "Drug use", "18 and older"],
  ]);

  it("keeps the first row and the listed rows in table order, whatever order they are listed in", () => {
    expect(shape(rowsView(screens, ["u", "t"]) as DocJSON)).toEqual([["h", "Screening", "Who"], ["t", "Tobacco", "Adults"], ["u", "Drug use", "18 and older"]]);
  });

  it("keeps the table's attributes, grid and row attributes unchanged", () => {
    const table = (rowsView(screens, ["d"]) as DocJSON).content[0] as PMNode;
    expect(table.attrs).toEqual({ grid: [60, 100], cellMarginPt: 0 });
    expect((table.content ?? [])[1]?.attrs).toEqual({ id: "d", kind: "content" });
    expect((table.content ?? [])[1]?.content?.[0]?.attrs).toEqual({ colspan: 1, rowspan: 1, colwidth: [60], fill: null });
  });

  it("lists the header once when it is also listed, and only the header for no matching rows", () => {
    expect(shape(rowsView(screens, ["h", "d"]) as DocJSON)).toEqual([["h", "Screening", "Who"], ["d", "Depression", "12 and older"]]);
    expect(shape(rowsView(screens, ["zz"]) as DocJSON)).toEqual([["h", "Screening", "Who"]]);
  });

  it("places merged cells on the grid: a span is cut to the kept rows it covers, and starts on the first kept one", () => {
    const doc = tableOf([60, 100, 100], [
      ["h", "Topic", "Grade", "Who"],
      ["a", { text: "Cancer", rowspan: 3 }, "A", "Cervical"],
      ["b", "B", "Breast"],
      ["c", "B", "Lung"],
      ["n", { text: "Note: grades as of 2026", colspan: 3 }],
    ]);
    // The label spans a, b, c; with b and c kept it starts on b, spanning two rows.
    expect(shape(rowsView(doc, ["b", "c"]) as DocJSON)).toEqual([["h", "Topic", "Grade", "Who"], ["b", "Cancer|r2", "B", "Breast"], ["c", "B", "Lung"]]);
    // With a and c kept, the label covers both (b is left out) and stays on a.
    expect(shape(rowsView(doc, ["c", "a"]) as DocJSON)).toEqual([["h", "Topic", "Grade", "Who"], ["a", "Cancer|r2", "A", "Cervical"], ["c", "B", "Lung"]]);
    expect(shape(rowsView(doc, ["n"]) as DocJSON)).toEqual([["h", "Topic", "Grade", "Who"], ["n", "Note: grades as of 2026|c3"]]);
  });

  it("is null for a doc that is not one table", () => {
    expect(rowsView({ type: "doc", content: [{ type: "paragraph" }] }, ["t"])).toBeNull();
    expect(rowsView({ type: "doc", content: [...screens.content, { type: "paragraph" }] }, ["t"])).toBeNull();
  });

  it("without firstRow keeps only the listed rows, so a group under its own heading row leaves the table's first row out", () => {
    const groups = tableOf([60, 100], [
      ["h1", "1ST GEN", "MOA"],
      ["a", "Diphenhydramine", "H1 antagonist"],
      ["h2", "2ND GEN", "MOA"],
      ["b", "Loratadine", "H1 antagonist, less sedating"],
    ]);
    expect(shape(rowsView(groups, ["h2", "b"], { firstRow: false }) as DocJSON)).toEqual([["h2", "2ND GEN", "MOA"], ["b", "Loratadine", "H1 antagonist, less sedating"]]);
    expect(shape(rowsView(groups, ["h1", "a"], { firstRow: false }) as DocJSON)).toEqual([["h1", "1ST GEN", "MOA"], ["a", "Diphenhydramine", "H1 antagonist"]]);
    expect(rowsView(groups, ["zz"], { firstRow: false })).toBeNull();
  });
});

describe("noteView: a stored block's doc as a note shows it whole, cut to rows, or cut to one column", () => {
  const head = { firstRow: true };
  it("is the doc whole with no title when nothing cuts it", () => {
    expect(noteView(vitamins, {}, head)).toEqual({ title: null, doc: vitamins });
  });

  it("is rowsView, untitled, for rows, keeping the first row as asked; columnView for a column", () => {
    expect(noteView(vitamins, { rows: ["r2"] }, head)).toEqual({ title: null, doc: rowsView(vitamins, ["r2"]) });
    expect(noteView(vitamins, { rows: ["r2"] }, { firstRow: false })).toEqual({ title: null, doc: rowsView(vitamins, ["r2"], { firstRow: false }) });
    expect(noteView(vitamins, { column: 3 }, head)).toEqual(columnView(vitamins, 3));
  });

  it("cuts the rows and then that column of them for both, titled by the column's text in the first kept row", () => {
    const specific = tableOf([60, 100, 100], [
      ["h1", "", "Hemophilia A", "Hemophilia B"],
      ["a", "Tx", "Factor VIII", "Factor IX"],
      ["h2", "", "Acute ITP", "Chronic ITP"],
      ["b", "Tx", "Steroids, IVIG", "Splenectomy"],
    ]);
    const view = noteView(specific, { rows: ["h2", "b"], column: 2 }, { firstRow: false });
    expect(view?.title).toBe("Chronic ITP");
    expect(shape(view?.doc as DocJSON)).toEqual([["b", "Tx", "Splenectomy"]]);
    expect(shape(noteView(specific, { rows: ["h2", "b"], column: 2, label: 1 }, { firstRow: false })?.doc as DocJSON)).toEqual([["b", "Steroids, IVIG", "Splenectomy"]]);
    expect(noteView(specific, { rows: ["h2", "b"], column: 2, label: 2 }, { firstRow: false })).toBeNull();
    expect(noteView(specific, { rows: ["zz"], column: 2 }, { firstRow: false })).toBeNull();
  });

  it("is null when the cut does not apply to the doc", () => {
    const prose: DocJSON = { type: "doc", content: [{ type: "paragraph" }] };
    expect([noteView(prose, { rows: ["r1"] }, head), noteView(prose, { column: 1 }, head), noteView(vitamins, { column: 9 }, head)]).toEqual([null, null, null]);
  });
});
