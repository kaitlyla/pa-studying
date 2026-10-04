// Picture bytes (30 §30.9): supported extensions and cropping to a:srcRect with sharp.
import sharp from "sharp";

const EXTS: Record<string, string> = { png: ".png", jpeg: ".jpeg", jpg: ".jpg", gif: ".gif" };

/** The asset extension for a media part name, or null when it is not a stored image type. */
export function imageExt(partName: string): string | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(partName);
  return m ? (EXTS[m[1]!.toLowerCase()] ?? null) : null;
}

/** The pixel rectangle kept by a srcRect (l, t, r, b in 1/1000 % of each side; negatives count as 0). */
export function cropRect(width: number, height: number, ltrb: readonly number[]): { left: number; top: number; width: number; height: number } {
  const [l, t, r, b] = ltrb.map((v) => Math.max(0, v) / 100000);
  const left = Math.min(width - 1, Math.round(width * l!));
  const top = Math.min(height - 1, Math.round(height * t!));
  const right = Math.round(width * r!);
  const bottom = Math.round(height * b!);
  return { left, top, width: Math.max(1, width - left - right), height: Math.max(1, height - top - bottom) };
}

/** Crops a picture. PNG and JPEG become PNG (lossless for the kept pixels); GIF stays GIF. */
export async function cropImage(bytes: Uint8Array, ext: string, ltrb: readonly number[]): Promise<{ bytes: Uint8Array; ext: string }> {
  const meta = await sharp(bytes).metadata();
  const rect = cropRect(meta.width ?? 1, meta.height ?? 1, ltrb);
  const img = sharp(bytes).extract(rect);
  if (ext === ".gif") return { bytes: new Uint8Array(await img.gif().toBuffer()), ext: ".gif" };
  return { bytes: new Uint8Array(await img.png().toBuffer()), ext: ".png" };
}
