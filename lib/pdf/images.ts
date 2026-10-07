// Which image variants a PDF can embed as their stored bytes (pdfmake reads PNG and JPEG); every other
// variant is converted to PNG first, by sharp in tools/pdf and by a canvas in app/pdf.
import { cropOrNull } from "../crop.ts";
import type { ImageVariant } from "./types.ts";

/** MIME types of the stored formats pdfmake embeds directly, by lower-case file extension. */
export const EMBED_MIME: Readonly<Record<string, string>> = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg" };

/** The MIME type of an asset pdfmake can embed as stored, or null (GIF and anything else). */
export function storedMime(asset: string): string | null {
  return EMBED_MIME[asset.slice(asset.lastIndexOf(".") + 1).toLowerCase()] ?? null;
}

/** True when the variant's stored bytes embed as they are: PNG or JPEG, not cropped, turned or flipped. */
export function embedsAsStored(v: ImageVariant): boolean {
  return storedMime(v.asset) !== null && v.rot === 0 && !v.flipH && !v.flipV && cropOrNull(v.crop) === null;
}
