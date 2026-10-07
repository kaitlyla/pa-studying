// Picture crops: the kept fraction and the one pixel rectangle every byte-level crop uses.
import { describe, expect, it } from "vitest";
import { cropOrNull, cropPixels, keptFraction } from "./crop.ts";

describe("picture crops", () => {
  it("keeps the fraction of each side the cuts leave; all of it when uncropped", () => {
    expect(keptFraction({ l: 0.25, t: 0.1, r: 0.125, b: 0.4 })).toEqual({ w: 0.625, h: 0.5 });
    expect(keptFraction(null)).toEqual({ w: 1, h: 1 });
    expect(keptFraction(undefined)).toEqual({ w: 1, h: 1 });
  });

  it("treats a crop that cuts nothing as no crop", () => {
    const c = { l: 0, t: 0, r: 0.2, b: 0 };
    expect(cropOrNull(c)).toBe(c);
    expect(cropOrNull({ l: 0, t: 0, r: 0, b: 0 })).toBeNull();
    expect(cropOrNull(null)).toBeNull();
    expect(cropOrNull(undefined)).toBeNull();
  });

  it("rounds each cut to whole pixels of the file", () => {
    // 200 × 100: left 50, right 25 → 125 wide; top 10 (0.1 × 100), bottom 40.
    expect(cropPixels(200, 100, { l: 0.25, t: 0.1, r: 0.125, b: 0.4 })).toEqual({ left: 50, top: 10, width: 125, height: 50 });
    // 3 px wide: a third rounds to 1 px each side.
    expect(cropPixels(3, 3, { l: 1 / 3, t: 0, r: 1 / 3, b: 0 })).toEqual({ left: 1, top: 0, width: 1, height: 3 });
  });

  it("keeps at least one pixel each way however much is cut", () => {
    expect(cropPixels(10, 10, { l: 0.96, t: 0.5, r: 0.03, b: 0.49 })).toEqual({ left: 9, top: 5, width: 1, height: 1 });
    expect(cropPixels(1, 1, { l: 0.9, t: 0.9, r: 0, b: 0 })).toEqual({ left: 0, top: 0, width: 1, height: 1 });
  });
});
