import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ASSET_EXTS } from "../content/ids.ts";
import { cropImage, imageExt } from "./images.ts";

describe("imageExt", () => {
  it.each([
    ["word/media/image1.png", ".png"],
    ["word/media/image2.JPEG", ".jpeg"],
    ["word/media/image3.jpg", ".jpg"],
    ["word/media/image4.gif", ".gif"],
    ["word/media/image5.webp", ".webp"],
    ["word/media/image6.emf", null],
    ["word/media/image7", null],
  ])("%s → %s", (part, ext) => {
    expect(imageExt(part)).toBe(ext);
  });

  it("accepts exactly the stored asset extensions", () => {
    for (const ext of ASSET_EXTS) expect(imageExt(`word/media/x${ext}`)).toBe(ext);
  });
});

describe("cropImage", () => {
  it("crops a WebP to a PNG holding exactly the kept pixels", async () => {
    // 4 × 2 px: left half red, right half blue.
    const blue = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toBuffer();
    const webp = await sharp({ create: { width: 4, height: 2, channels: 3, background: { r: 255, g: 0, b: 0 } } })
      .composite([{ input: blue, left: 2, top: 0 }])
      .webp({ lossless: true })
      .toBuffer();
    const out = await cropImage(new Uint8Array(webp), ".webp", { l: 0.5, t: 0, r: 0, b: 0 });
    expect(out.ext).toBe(".png");
    const { data, info } = await sharp(out.bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([2, 2]);
    expect([...data]).toEqual([0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255]);
  });
});
