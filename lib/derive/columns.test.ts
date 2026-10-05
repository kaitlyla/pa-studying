import { describe, expect, it } from "vitest";
import type { DocJSON } from "../content/types.ts";
import { columnView } from "./columns.ts";
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

  it("is null for a doc that is not one table, or a column the table does not have", () => {
    expect(columnView(vitamins, 0)).toBeNull();
    expect(columnView(vitamins, 4)).toBeNull();
    expect(columnView(vitamins, 1.5)).toBeNull();
    expect(columnView({ type: "doc", content: [{ type: "paragraph" }] }, 1)).toBeNull();
    expect(columnView({ type: "doc", content: [...vitamins.content, { type: "paragraph" }] }, 1)).toBeNull();
  });
});
