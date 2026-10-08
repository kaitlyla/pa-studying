// Floating pictures' geometry: where each is drawn and the room it takes from the text under it.
import { describe, expect, it } from "vitest";
import { docHasFloat, exclusionFloats, layoutFloats, sameFloatLayout, type Box, type FloatLayout, type FloatPic, type Frame, type TextBlock } from "./floats.ts";

const pic = (p: Partial<FloatPic> & Pick<FloatPic, "left" | "top" | "width" | "height">): FloatPic => ({ frame: 0, ...p });
/** A block of text: unindented, no hanging indent, and no line height (the room starts at the picture's top) unless given. */
const blk = (b: Partial<TextBlock> & Pick<TextBlock, "top" | "bottom">): TextBlock => ({ indent: 0, hang: 0, lineTop: b.top, lineHeight: 0, ...b });

describe("layoutFloats", () => {
  // A two-cell table row, 300 px wide; cell A at 0–150, cell B at 150–300.
  const table: Frame[] = [{ left: 0, width: 300, bottom: 100 }];
  const cellA: Box = { left: 0, top: 0, width: 150, height: 100 };
  const cellB: Box = { left: 150, top: 0, width: 150, height: 100 };

  it("takes the part a picture covers from each cell, on the side with less room", () => {
    const out = layoutFloats(table, [cellA, cellB], [pic({ left: 100, top: 10, width: 100, height: 40 })], 20);
    expect(out.places).toEqual([{ left: 100, top: 10 }]);
    // Over A's right 50 px, so A's text runs on its left; over B's left 50 px, so B's runs on its right.
    expect(out.exclusions).toEqual([
      [{ side: "right", top: 10, width: 50, height: 40 }],
      [{ side: "left", top: 10, width: 50, height: 40 }],
    ]);
    expect(out.below).toEqual([0]);
  });

  it("measures each exclusion from the top of its region", () => {
    const lower: Box = { left: 0, top: 60, width: 150, height: 100 };
    const out = layoutFloats(table, [lower], [pic({ left: 0, top: 50, width: 40, height: 30 })], 20);
    expect(out.exclusions).toEqual([[{ side: "left", top: 0, width: 40, height: 20 }]]);
  });

  it("moves a picture past the frame's right edge back inside it, and one wider than the frame to its left", () => {
    const out = layoutFloats(table, [], [pic({ left: 280, top: 0, width: 100, height: 10 }), pic({ left: 50, top: 0, width: 400, height: 10 })], 20);
    expect(out.places).toEqual([{ left: 200, top: 0 }, { left: 0, top: 0 }]);
  });

  it("widens the room beside a block with a hanging indent by its hang, so its first line starts at the picture's edge", () => {
    // A bulleted block (first line 20 px left of the rest) from 30 to 60, beside a picture from 10 to 80.
    const cell = { ...cellB, blocks: [blk({ top: 30, bottom: 60, indent: 20, hang: 20 })] };
    const out = layoutFloats(table, [cell], [pic({ left: 150, top: 10, width: 50, height: 70 })], 20);
    expect(out.exclusions).toEqual([[
      { side: "left", top: 10, width: 50, height: 20 },
      { side: "left", top: 30, width: 70, height: 30 },
      { side: "left", top: 60, width: 50, height: 20 },
    ]]);
    // Text on the picture's left ends at the picture, which a hang does not move.
    const right = layoutFloats(table, [{ ...cellA, blocks: [blk({ top: 0, bottom: 100, indent: 20, hang: 20 })] }], [pic({ left: 100, top: 10, width: 50, height: 20 })], 20);
    expect(right.exclusions).toEqual([[{ side: "right", top: 10, width: 50, height: 20 }]]);
  });

  it("keeps no more room for a hanging indent whose bullet already starts clear of the picture", () => {
    const region = { left: 0, top: 0, width: 300, height: 100, blocks: [blk({ top: 0, bottom: 100, indent: 100, hang: 30 })] };
    const out = layoutFloats(table, [region], [pic({ left: 0, top: 0, width: 50, height: 20 })], 20);
    expect(out.exclusions).toEqual([[{ side: "left", top: 0, width: 50, height: 20 }]]);
  });

  it("sends a block below the picture when its own text has no room beside it, though the region has", () => {
    // 100 px right of the picture, but the second block's text starts 135 px in: 15 px is left for it.
    const cell = { ...cellB, blocks: [blk({ top: 10, bottom: 30 }), blk({ top: 30, bottom: 60, indent: 135 })] };
    const out = layoutFloats(table, [cell], [pic({ left: 150, top: 10, width: 50, height: 70 })], 20);
    expect(out.exclusions).toEqual([[
      { side: "left", top: 10, width: 50, height: 20 },
      { side: "left", top: 30, width: 150, height: 50 },
    ]]);
  });

  it("sends a bulleted block below, bullet and all, when the text after its bullet would not fit beside the picture", () => {
    // 50 px right of the picture, but after the 30 px bullet only 20: the bullet would sit there alone.
    const region = { left: 0, top: 0, width: 200, height: 100, blocks: [blk({ top: 0, bottom: 100, indent: 30, hang: 30 })] };
    const out = layoutFloats(table, [region], [pic({ left: 0, top: 10, width: 150, height: 40 })], 30);
    expect(out.exclusions).toEqual([[{ side: "left", top: 10, width: 200, height: 40 }]]);
  });

  it("measures the room left of a picture from where a block's text starts", () => {
    const cell = { ...cellA, blocks: [blk({ top: 0, bottom: 100, indent: 90 })] };
    const out = layoutFloats(table, [cell], [pic({ left: 100, top: 10, width: 50, height: 20 })], 20);
    expect(out.exclusions).toEqual([[{ side: "left", top: 10, width: 150, height: 20 }]]);
  });

  it("starts the room at the top of the line the picture's top cuts into, so that line moves aside too", () => {
    // Lines 15 px apart from 4: the picture's top at 25 is inside the line from 19 to 34.
    const cell = { ...cellB, blocks: [blk({ top: 2, bottom: 80, lineTop: 4, lineHeight: 15 })] };
    const out = layoutFloats(table, [cell], [pic({ left: 150, top: 25, width: 50, height: 30 })], 20);
    expect(out.exclusions).toEqual([[{ side: "left", top: 19, width: 50, height: 36 }]]);
    // On a line's top, the line above it keeps its room.
    const onLine = layoutFloats(table, [cell], [pic({ left: 150, top: 34, width: 50, height: 30 })], 20);
    expect(onLine.exclusions).toEqual([[{ side: "left", top: 34, width: 50, height: 30 }]]);
  });

  it("sends the text below the picture when neither side has the minimum room", () => {
    const out = layoutFloats(table, [cellA], [pic({ left: 40, top: 10, width: 70, height: 20 })], 50);
    // 40 px left and 40 px right of it, both under 50: the whole cell width is kept clear.
    expect(out.exclusions).toEqual([[{ side: "left", top: 10, width: 150, height: 20 }]]);
  });

  it("keeps pictures over the same lines of a region clear together", () => {
    const out = layoutFloats(table, [cellA], [pic({ left: 0, top: 30, width: 30, height: 20 }), pic({ left: 10, top: 10, width: 40, height: 30 })], 20);
    expect(out.exclusions).toEqual([[{ side: "left", top: 10, width: 50, height: 40 }]]);
  });

  it("keeps pictures over separate lines apart, top first", () => {
    const out = layoutFloats(table, [cellA], [pic({ left: 0, top: 60, width: 30, height: 10 }), pic({ left: 120, top: 10, width: 30, height: 20 })], 20);
    expect(out.exclusions).toEqual([[
      { side: "right", top: 10, width: 30, height: 20 },
      { side: "left", top: 60, width: 30, height: 10 },
    ]]);
  });

  it("adds room below only the frame whose picture reaches past its end", () => {
    const frames: Frame[] = [{ left: 0, width: 300, bottom: 500 }, { left: 0, width: 300, bottom: 100 }];
    const out = layoutFloats(frames, [], [pic({ frame: 1, left: 0, top: 80, width: 50, height: 50 })], 20);
    expect(out.below).toEqual([0, 30]);
  });

  describe("a body picture", () => {
    // The doc column, 300 px wide: body text 0–100, a two-cell table 100–200, body text 200–400.
    const column: Frame[] = [{ left: 0, width: 300, bottom: 400 }];
    const body1: Box = { left: 0, top: 0, width: 300, height: 100 };
    const a: Box = { left: 0, top: 100, width: 150, height: 100 };
    const b: Box = { left: 150, top: 100, width: 150, height: 100 };
    const body2: Box = { left: 0, top: 200, width: 300, height: 200 };

    it("takes from each body region only the part of it it covers", () => {
      const out = layoutFloats(column, [body1, body2], [pic({ left: 200, top: 80, width: 100, height: 140 })], 20);
      expect(out.exclusions).toEqual([
        [{ side: "right", top: 80, width: 100, height: 20 }],
        [{ side: "right", top: 0, width: 100, height: 20 }],
      ]);
    });

    it("moves the text of the table cells it reaches over aside too", () => {
      const out = layoutFloats(column, [body1, a, b, body2], [pic({ left: 0, top: 80, width: 100, height: 150 })], 20);
      expect(out.exclusions).toEqual([
        [{ side: "left", top: 80, width: 100, height: 20 }],
        [{ side: "left", top: 0, width: 100, height: 100 }],
        [],
        [{ side: "left", top: 0, width: 100, height: 30 }],
      ]);
      expect(out.below).toEqual([0]);
    });
  });
});

describe("exclusionFloats", () => {
  it("puts a zero-width spacer down to each exclusion's top, then the room", () => {
    expect(exclusionFloats([
      { side: "left", top: 10, width: 50, height: 20 },
      { side: "right", top: 40, width: 30, height: 10 },
    ])).toEqual([
      { float: "left", width: 0, height: 10 },
      { float: "left", width: 50, height: 20 },
      { float: "left", width: 0, height: 10 },
      { float: "right", width: 30, height: 10 },
    ]);
  });

  it("starts an exclusion at the region's top with no spacer height", () => {
    expect(exclusionFloats([{ side: "right", top: 0, width: 5, height: 5 }])).toEqual([
      { float: "left", width: 0, height: 0 },
      { float: "right", width: 5, height: 5 },
    ]);
  });

  it("lays every edge on the 1/64 px layout unit, never above the exclusion's top or bottom", () => {
    // Chrome lays floats out in 1/64 px: a 72.1869 px spacer would start the room 0.012 px higher, over
    // the line just above it, and that line would move aside too.
    const list = [
      { side: "left" as const, top: 72.1869, width: 50, height: 30.5 },
      { side: "right" as const, top: 120.01, width: 30, height: 10 },
    ];
    const out = exclusionFloats(list);
    expect(out).toEqual([
      { float: "left", width: 0, height: 72.1875 },
      { float: "left", width: 50, height: 30.5 },
      { float: "left", width: 0, height: 120.015625 - 102.6875 },
      { float: "right", width: 30, height: 130.015625 - 120.015625 },
    ]);
    let y = 0;
    list.forEach((e, i) => {
      const spacer = out[2 * i]?.height ?? NaN;
      const room = out[2 * i + 1]?.height ?? NaN;
      for (const h of [spacer, room]) expect(Number.isInteger(h * 64)).toBe(true);
      expect(y + spacer).toBeGreaterThanOrEqual(e.top);
      y += spacer + room;
      expect(y).toBeGreaterThanOrEqual(e.top + e.height);
    });
  });
});

describe("sameFloatLayout", () => {
  const layout: FloatLayout = {
    places: [{ left: 10, top: 20 }],
    exclusions: [[{ side: "left", top: 0, width: 40, height: 30 }], []],
    below: [0, 12],
  };
  const copy = (): FloatLayout => structuredClone(layout);

  it("holds layouts within half a px the same", () => {
    expect(sameFloatLayout(null, layout)).toBe(false);
    const near = copy();
    near.places[0] = { left: 10.4, top: 19.6 };
    expect(sameFloatLayout(layout, near)).toBe(true);
  });

  it("tells a moved picture, changed room or changed room below apart", () => {
    const moved = copy();
    moved.places[0] = { left: 11, top: 20 };
    const side = copy();
    side.exclusions[0] = [{ side: "right", top: 0, width: 40, height: 30 }];
    const more = copy();
    more.exclusions[1] = [{ side: "left", top: 0, width: 1, height: 1 }];
    const below = copy();
    below.below = [0, 13];
    for (const other of [moved, side, more, below]) expect(sameFloatLayout(layout, other)).toBe(false);
  });
});

describe("docHasFloat", () => {
  const floating = { type: "anchored", attrs: { float: { dxPt: 0, dyPt: 0 } }, content: [{ type: "image_block" }] };
  const inCell = (anchored: object) => ({
    type: "doc",
    content: [{ type: "table", content: [{ type: "table_row", content: [{ type: "table_cell", content: [anchored] }] }] }],
  });

  it("finds a floating picture anywhere in a doc", () => {
    expect(docHasFloat(inCell(floating))).toBe(true);
  });

  it("ignores pictures anchored in line", () => {
    expect(docHasFloat(inCell({ ...floating, attrs: { float: null } }))).toBe(false);
    expect(docHasFloat(inCell({ type: "anchored", attrs: {}, content: [] }))).toBe(false);
  });
});
