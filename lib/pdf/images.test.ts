import { describe, expect, it } from "vitest";
import { embedsAsStored, storedMime } from "./images.ts";

const PNG = `${"a".repeat(32)}.png`;

describe("storedMime", () => {
  it.each([
    [PNG, "image/png"],
    [`${"c".repeat(32)}.jpeg`, "image/jpeg"],
    [`${"c".repeat(32)}.JPG`, "image/jpeg"],
    [`${"b".repeat(32)}.gif`, null],
    [`${"d".repeat(32)}.tiff`, null],
    ["noextension", null],
  ])("%s → %s", (asset, mime) => {
    expect(storedMime(asset)).toBe(mime);
  });
});

describe("embedsAsStored", () => {
  it.each([
    [{ asset: PNG, rot: 0, flipH: false, flipV: false }, true],
    [{ asset: `${"c".repeat(32)}.jpg`, rot: 0, flipH: false, flipV: false }, true],
    [{ asset: `${"b".repeat(32)}.gif`, rot: 0, flipH: false, flipV: false }, false],
    [{ asset: `${"d".repeat(32)}.tiff`, rot: 0, flipH: false, flipV: false }, false],
    [{ asset: PNG, rot: 90, flipH: false, flipV: false }, false],
    [{ asset: PNG, rot: 0, flipH: true, flipV: false }, false],
    [{ asset: PNG, rot: 0, flipH: false, flipV: true }, false],
    [{ asset: PNG, rot: 0, flipH: false, flipV: false, crop: null }, true],
    [{ asset: PNG, rot: 0, flipH: false, flipV: false, crop: { l: 0, t: 0, r: 0.5, b: 0 } }, false],
    [{ asset: `${"c".repeat(32)}.jpg`, rot: 0, flipH: false, flipV: false, crop: { l: 0.1, t: 0, r: 0, b: 0 } }, false],
  ])("%j → %s", (v, expected) => {
    expect(embedsAsStored(v)).toBe(expected);
  });
});
