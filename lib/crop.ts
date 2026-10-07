// Picture crops (lib/schemaTypes.ts Crop): what part of a file a picture keeps. Browser-safe and
// shared by the screen renderer, the editor, both PDF builders and the Word importer.
import type { Crop } from "./schemaTypes.ts";

/** The fraction of the file's width (`w`) and height (`h`) that `crop` keeps; 1 × 1 for none. */
export function keptFraction(crop: Crop | null | undefined): { w: number; h: number } {
  return crop ? { w: 1 - crop.l - crop.r, h: 1 - crop.t - crop.b } : { w: 1, h: 1 };
}

/** `crop`, or null when it cuts nothing (the stored form of an uncropped picture). */
export function cropOrNull(crop: Crop | null | undefined): Crop | null {
  return crop && (crop.l > 0 || crop.t > 0 || crop.r > 0 || crop.b > 0) ? crop : null;
}

/**
 * The pixel rectangle `crop` keeps of a `width` × `height` file: each cut rounded to whole pixels,
 * keeping at least one pixel each way. Every byte-level crop goes through this one rounding.
 */
export function cropPixels(width: number, height: number, crop: Crop): { left: number; top: number; width: number; height: number } {
  const left = Math.min(width - 1, Math.round(width * crop.l));
  const top = Math.min(height - 1, Math.round(height * crop.t));
  const right = Math.round(width * crop.r);
  const bottom = Math.round(height * crop.b);
  return { left, top, width: Math.max(1, width - left - right), height: Math.max(1, height - top - bottom) };
}
