import { describe, expect, it } from "vitest";
import { openSidebarScale } from "./pageScale.ts";

describe("openSidebarScale", () => {
  it("lays the content out at its sidebar-hidden width and draws it smaller to fit", () => {
    // 1280px window: the frame is 980px beside the 300px sidebar and 1240px beside the 40px rail;
    // 48px of it is padding.
    expect(openSidebarScale(980, 48, 300, 40, 1400)).toEqual({ width: 1192, scale: 932 / 1192 });
  });

  it("stops at the frame's maximum width", () => {
    expect(openSidebarScale(1200, 48, 300, 40, 1400)).toEqual({ width: 1352, scale: 1152 / 1352 });
  });

  it("leaves the content alone when hiding the sidebar would not widen it", () => {
    expect(openSidebarScale(1400, 48, 300, 40, 1400)).toBeNull();
    expect(openSidebarScale(1620, 48, 300, 40, 1400)).toBeNull();
  });

  it("leaves the content alone without a measured width or the frame's sizes", () => {
    expect(openSidebarScale(0, 48, 300, 40, 1400)).toBeNull();
    expect(openSidebarScale(40, 48, 300, 40, 1400)).toBeNull();
    expect(openSidebarScale(980, 48, Number.NaN, Number.NaN, Number.NaN)).toBeNull();
  });
});
