// Picture bytes (30 §30.9): supported extensions and cropping to a:srcRect with sharp.
import sharp from "sharp";
import { cropPixels } from "../crop.ts";
import type { Crop } from "../schemaTypes.ts";

const EXTS: Record<string, string> = { png: ".png", jpeg: ".jpeg", jpg: ".jpg", gif: ".gif" };

/** The asset extension for a media part name, or null when it is not a stored image type. */
export function imageExt(partName: string): string | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(partName);
  return m ? (EXTS[m[1]!.toLowerCase()] ?? null) : null;
}

/** A srcRect's l, t, r, b (1/1000 % of each side; negatives count as 0) as a crop. */
export function srcRectCrop(ltrb: readonly [number, number, number, number]): Crop {
  const [l, t, r, b] = ltrb.map((v) => Math.max(0, v) / 100000) as [number, number, number, number];
  return { l, t, r, b };
}

/** Crops a picture. PNG and JPEG become PNG (lossless for the kept pixels); GIF stays GIF. */
export async function cropImage(bytes: Uint8Array, ext: string, crop: Crop): Promise<{ bytes: Uint8Array; ext: string }> {
  const meta = await sharp(bytes).metadata();
  const rect = cropPixels(meta.width ?? 1, meta.height ?? 1, crop);
  const img = sharp(bytes).extract(rect);
  if (ext === ".gif") return { bytes: new Uint8Array(await img.gif().toBuffer()), ext: ".gif" };
  return { bytes: new Uint8Array(await img.png().toBuffer()), ext: ".png" };
}
