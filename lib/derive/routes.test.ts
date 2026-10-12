// The compare route (40 §40.3 guide-reader/compare): one to four slots, an empty slot kept so a
// favorite can fill it. Parser and builder are the one grammar the app and the build share.
import { describe, expect, it } from "vitest";
import { guideViewHash, parseHash } from "./routes.ts";

const R1 = "r_AAAAAAAAA1";
const R2 = "r_AAAAAAAAB1";

const view = (hash: string): unknown => {
  const parsed = parseHash(hash);
  return parsed.kind === "guide" ? parsed.view : parsed.kind;
};

describe("compare routes", () => {
  it("builds one slot per quadrant, an empty quadrant as an empty slot", () => {
    expect(guideViewHash("fm", { kind: "compare", ids: [R1] })).toBe(`#/eor/fm/compare/${R1}`);
    expect(guideViewHash("fm", { kind: "compare", ids: [R1, "", R2] })).toBe(`#/eor/fm/compare/${R1},,${R2}`);
  });

  it("parses one to four slots, keeping empty ones", () => {
    expect(view(`#/eor/fm/compare/${R1}`)).toEqual({ kind: "compare", ids: [R1] });
    expect(view(`#/eor/fm/compare/,${R1},`)).toEqual({ kind: "compare", ids: ["", R1, ""] });
    expect(view(`#/eor/fm/compare/${R1},${R2},${R1},${R2}`)).toEqual({ kind: "compare", ids: [R1, R2, R1, R2] });
  });

  it("refuses more than four slots, a bare `compare`, and a segment after the slots", () => {
    expect(view(`#/eor/fm/compare/${R1},${R2},${R1},${R2},${R1}`)).toBe("notfound");
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
