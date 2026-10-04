import { describe, expect, it } from "vitest";
import { borderVisible, cellSide, edgeBorder, placeCells, underlineKind } from "./wordFormat.ts";

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
