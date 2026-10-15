// The compare route (40 §40.3 guide-reader/compare): one slot per quadrant, as many as she adds, an empty
// slot kept so an old address still opens, and the old `t/a,b` link reading as a comparison (the stacked
// page is gone). Parser and builder are the one grammar the app and the build share.
import { describe, expect, it } from "vitest";
import { addToCompare, guideViewHash, parseHash } from "./routes.ts";

const R1 = "r_AAAAAAAAA1";
const R2 = "r_AAAAAAAAB1";
const R3 = "r_AAAAAAAAC1";
const R4 = "r_AAAAAAAAD1";
const R5 = "r_AAAAAAAAE1";
const R6 = "r_AAAAAAAAF1";

const view = (hash: string): unknown => {
  const parsed = parseHash(hash);
  return parsed.kind === "guide" ? parsed.view : parsed.kind;
};

describe("compare routes", () => {
  it("builds one slot per quadrant, an empty quadrant as an empty slot", () => {
    expect(guideViewHash("fm", { kind: "compare", ids: [R1] })).toBe(`#/eor/fm/compare/${R1}`);
    expect(guideViewHash("fm", { kind: "compare", ids: [R1, "", R2] })).toBe(`#/eor/fm/compare/${R1},,${R2}`);
  });

  it("parses the slots, keeping empty ones", () => {
    expect(view(`#/eor/fm/compare/${R1}`)).toEqual({ kind: "compare", ids: [R1] });
    expect(view(`#/eor/fm/compare/,${R1},`)).toEqual({ kind: "compare", ids: ["", R1, ""] });
    expect(view(`#/eor/fm/compare/${R1},${R2},${R1},${R2}`)).toEqual({ kind: "compare", ids: [R1, R2, R1, R2] });
    // No limit: a comparison holds as many quadrants as the address names.
    expect(view(`#/eor/fm/compare/${R1},${R2},${R3},${R4},${R5},${R6}`)).toEqual({ kind: "compare", ids: [R1, R2, R3, R4, R5, R6] });
  });

  it("refuses a bare `compare` and a segment after the slots", () => {
    expect(view("#/eor/fm/compare")).toBe("notfound");
    expect(view("#/eor/fm/compare/")).toBe("notfound");
    expect(view(`#/eor/fm/compare/${R1}/x`)).toBe("notfound");
  });

  it("round-trips every built compare route", () => {
    for (const ids of [[R1], [R1, ""], ["", R2, R1], [R1, R2, "", ""]]) {
      const hash = guideViewHash("fm", { kind: "compare", ids });
      const parsed = parseHash(hash);
      expect(parsed.kind).toBe("guide");
      if (parsed.kind === "guide" && parsed.view.kind === "compare") expect(guideViewHash(parsed.guide, parsed.view)).toBe(hash);
    }
  });
});

describe("the old multi-topic link", () => {
  it("reads as a comparison; one topic is still the diagnosis page", () => {
    expect(view(`#/eor/fm/t/${R1},${R2}`)).toEqual({ kind: "compare", ids: [R1, R2] });
    expect(view(`#/eor/fm/t/${R1}`)).toEqual({ kind: "topics", ids: [R1] });
    // Empty segments were never topics: `t/a,,` is the one diagnosis.
    expect(view(`#/eor/fm/t/${R1},,`)).toEqual({ kind: "topics", ids: [R1] });
  });

  it("keeps every diagnosis it names, and has no page for none", () => {
    expect(view(`#/eor/fm/t/${R1},${R2},${R3},${R4},${R5},${R6}`)).toEqual({ kind: "compare", ids: [R1, R2, R3, R4, R5, R6] });
    expect(view("#/eor/fm/t/")).toBe("notfound");
  });
});

describe("addToCompare", () => {
  it("fills the first empty quadrant, else appends — a fifth and a sixth go on too", () => {
    expect(addToCompare([], R1)).toEqual([R1]);
    expect(addToCompare([R1], R2)).toEqual([R1, R2]);
    expect(addToCompare([R1, "", R2], R3)).toEqual([R1, R3, R2]);
    expect(addToCompare([R1, R2, R3], R4)).toEqual([R1, R2, R3, R4]);
    expect(addToCompare([R1, R2, R3, R4], R5)).toEqual([R1, R2, R3, R4, R5]);
    expect(addToCompare([R1, R2, R3, R4, R5], R6)).toEqual([R1, R2, R3, R4, R5, R6]);
  });
});
