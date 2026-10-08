import { describe, expect, it } from "vitest";
import { borderVisible, cellSide, drawnGrid, edgeBorder, mergedRowGroups, ownRowWidths, placeCells, rowWidthsProblem, underlineKind } from "./wordFormat.ts";

describe("underlineKind", () => {
  it.each([
    ["single", "solid"],
    ["words", "solid"],
    ["thick", "solid"],
    ["double", "double"],
    ["Double", "double"],
    ["wave", "wavy"],
    ["wavyHeavy", "wavy"],
    ["wavyDouble", "wavy"],
    ["dash", "dashed"],
    ["dashLong", "dashed"],
    ["dotDash", "dashed"],
    ["dotDotDash", "dashed"],
    ["dashDotHeavy", "dashed"],
    ["dotted", "dotted"],
    ["dottedHeavy", "dotted"],
  ])("%s draws %s", (style, kind) => {
    expect(underlineKind(style)).toBe(kind);
  });
});

describe("borderVisible", () => {
  const b = (style: string, widthPt = 0.5) => ({ style, widthPt, color: "000000" });
  it("draws a styled border of positive width", () => {
    expect(borderVisible(b("single"))).toBe(true);
    expect(borderVisible(b("dashed"))).toBe(true);
  });
  it.each(["none", "nil", "NIL", "None"])("does not draw style %s", (style) => {
    expect(borderVisible(b(style))).toBe(false);
  });
  it("does not draw a missing or zero-width border", () => {
    expect(borderVisible(null)).toBe(false);
    expect(borderVisible(undefined)).toBe(false);
    expect(borderVisible(b("single", 0))).toBe(false);
  });
});

describe("edgeBorder and cellSide", () => {
  const table = { top: "T", right: "R", bottom: "B", left: "L", insideH: "H", insideV: "V" };
  it("uses the outer border on the table's edge and the inside border elsewhere", () => {
    expect([edgeBorder(table, "top", true), edgeBorder(table, "right", true), edgeBorder(table, "bottom", true), edgeBorder(table, "left", true)]).toEqual(["T", "R", "B", "L"]);
    expect([edgeBorder(table, "top", false), edgeBorder(table, "bottom", false), edgeBorder(table, "left", false), edgeBorder(table, "right", false)]).toEqual(["H", "H", "V", "V"]);
    expect(edgeBorder({}, "top", true)).toBeNull();
  });
  it("prefers the cell's own side, a stored null included", () => {
    expect(cellSide(table, { left: "own" }, "left", true)).toBe("own");
    expect(cellSide(table, { left: null }, "left", true)).toBeNull();
    expect(cellSide(table, { left: "own" }, "right", false)).toBe("V");
    expect(cellSide(table, null, "top", false)).toBe("H");
  });
});

describe("placeCells", () => {
  const c = (id: string, attrs: Record<string, unknown> = {}) => ({ id, attrs });
  const where = (rows: { content: ReturnType<typeof c>[] }[]) => placeCells(rows).cells.map((p) => `${p.node.id}@${p.row},${p.col} ${p.colspan}x${p.rowspan}`);

  it("skips columns covered by row spans from above", () => {
    const rows = [{ content: [c("a", { rowspan: 2 }), c("b"), c("c")] }, { content: [c("d"), c("e")] }];
    expect(where(rows)).toEqual(["a@0,0 1x2", "b@0,1 1x1", "c@0,2 1x1", "d@1,1 1x1", "e@1,2 1x1"]);
    expect(placeCells(rows).columns).toBe(3);
  });

  it("places column spans and clamps a row span past the last row", () => {
    const rows = [{ content: [c("a", { colspan: 2 }), c("b", { rowspan: 5 })] }, { content: [c("c"), c("d")] }];
    expect(where(rows)).toEqual(["a@0,0 2x1", "b@0,2 1x2", "c@1,0 1x1", "d@1,1 1x1"]);
  });

  it("counts covered positions in the grid width and treats invalid spans as 1", () => {
    const rows = [{ content: [c("a"), c("b", { rowspan: 2, colspan: 2 })] }, { content: [c("c", { colspan: 0, rowspan: 1.5 })] }];
    expect(where(rows)).toEqual(["a@0,0 1x1", "b@0,1 2x2", "c@1,0 1x1"]);
    expect(placeCells(rows).columns).toBe(3);
    expect(placeCells([])).toEqual({ cells: [], columns: 0 });
  });
});

describe("ownRowWidths", () => {
  it("takes one positive width per column and nothing else", () => {
    expect(ownRowWidths([1, 2, 3], 3)).toEqual([1, 2, 3]);
    expect(ownRowWidths([1, 2], 3)).toBeNull();
    expect(ownRowWidths([1, 0, 3], 3)).toBeNull();
    expect(ownRowWidths([1, "2", 3], 3)).toBeNull();
    expect(ownRowWidths(null, 3)).toBeNull();
  });
});

describe("drawnGrid", () => {
  const cell = (col: number, colspan = 1) => ({ col, colspan });
  const base = [10, 20, 30, 40];
  const plain = { widths: null, cells: [cell(0), cell(1), cell(2), cell(3)] };

  it("is the table's columns, with every cell where the grid places it, when no row has widths", () => {
    const rows = [plain, { widths: undefined, cells: [cell(0, 2), cell(2, 2)] }];
    expect(drawnGrid(rows, base)).toEqual({
      widths: [10, 20, 30, 40],
      spans: [[cell(0), cell(1), cell(2), cell(3)], [cell(0, 2), cell(2, 2)]],
    });
  });

  it("draws the union of the edges of rows with and without widths, each row's widths scaled to the table's width", () => {
    // Row 1: widths 4:1:2:3 of the 100 wide table = 40,10,20,30; its second cell spans columns 1-3.
    const rows = [plain, { widths: [4, 1, 2, 3], cells: [cell(0), cell(1, 3)] }];
    expect(drawnGrid(rows, base)).toEqual({
      widths: [10, 20, 10, 20, 40],
      spans: [[cell(0), cell(1), cell(2, 2), cell(4)], [cell(0, 3), cell(3, 2)]],
    });
  });

  it("draws rows sharing their widths on those columns alone", () => {
    const own = [40, 10, 20, 30];
    const rows = [{ widths: own, cells: [cell(0), cell(1, 2), cell(3)] }, { widths: own, cells: [cell(0), cell(1), cell(2), cell(3)] }];
    expect(drawnGrid(rows, base)).toEqual({ widths: [40, 10, 20, 30], spans: [[cell(0), cell(1, 2), cell(3)], [cell(0), cell(1), cell(2), cell(3)]] });
  });

  it("draws edges of different rows that meet within a twip as one edge, and edges further apart as two", () => {
    const grid = [117, 117, 117, 117];
    const plainRow = { widths: null, cells: [cell(0), cell(1), cell(2), cell(3)] };
    // A dx row's first border 0.04 pt (under a twip) right of the grid's: one edge.
    expect(drawnGrid([plainRow, { widths: [117.04, 116.96, 117, 117], cells: plainRow.cells }], grid)).toEqual({
      widths: grid,
      spans: [plainRow.cells, plainRow.cells],
    });
    // 0.1 pt right: a column of its own.
    const apart = drawnGrid([plainRow, { widths: [117.1, 116.9, 117, 117], cells: plainRow.cells }], grid);
    expect(apart.widths).toHaveLength(5);
    expect(apart.widths[1]).toBeCloseTo(0.1, 10);
  });

  it("ignores widths that do not fit the grid", () => {
    const rows = [{ widths: [50, 50], cells: [cell(0), cell(1), cell(2), cell(3)] }];
    expect(drawnGrid(rows, base).widths).toEqual(base);
  });
});

describe("mergedRowGroups", () => {
  const c = (attrs: Record<string, unknown> = {}) => ({ attrs });
  it("joins the rows a merged cell spans, transitively, and leaves other rows alone", () => {
    const rows = [
      { content: [c({ rowspan: 2 }), c()] },
      { content: [c()] },
      { content: [c()] },
      { content: [c(), c({ rowspan: 2 })] },
      { content: [c({ rowspan: 2 })] },
      { content: [c(), c()] },
    ];
    expect(mergedRowGroups(rows)).toEqual([[0, 1], [2], [3, 4, 5]]);
  });
});

describe("rowWidthsProblem", () => {
  const row = (id: string, widths?: number[], rowspan = 1) => ({ attrs: { id, ...(widths ? { widths } : {}) }, content: [{ attrs: { rowspan } }, { attrs: {} }] });
  const single = (id: string, widths?: number[]) => ({ attrs: { id, ...(widths ? { widths } : {}) }, content: [{ attrs: {} }] });
  const table = (...rows: { attrs: Record<string, unknown>; content: { attrs: Record<string, unknown> }[] }[]) => ({ attrs: { grid: [10, 20] }, content: rows });

  it("accepts rows without widths and merged rows sharing theirs", () => {
    expect(rowWidthsProblem(table(row("a"), row("b", [1, 2], 2), single("c", [1, 2])))).toBeNull();
  });

  it("names a row whose widths do not number the grid's columns", () => {
    expect(rowWidthsProblem(table(row("a", [1, 2, 3])))).toBe("row a has widths for 3 columns; its table has 2");
  });

  it("names merged rows whose widths differ", () => {
    expect(rowWidthsProblem(table(row("a", [1, 2], 2), single("b")))).toBe("rows a, b share a merged cell but not their widths");
  });
});
