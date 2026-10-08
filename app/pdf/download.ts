// Browser PDF downloads (plan 70 §70.1–§70.2): the menu (OB6, app/reader) calls downloadPdf with the
// page data it has loaded, overlay included, so the file reflects her latest saved edits.
import { cropOrNull, cropPixels } from "../../lib/crop.ts";
import { FONTMAP_PATH, type FontMapJson } from "../../lib/derive/published.ts";
import {
  embedsAsStored,
  imageKey,
  imageRequests,
  pdfFileName,
  pdfFonts,
  renderPdf,
  storedMime,
  type DocDefinition,
  type ImageData,
  type ImageVariant,
  type PdfInput,
  type PdfScope,
} from "../../lib/pdf/index.ts";
import { DATA_BASE, loadData } from "../data/load.ts";
import { localAssetOf } from "../render/RichDoc.tsx";

export type { PdfInput, PdfScope } from "../../lib/pdf/index.ts";
export { pdfFileName, wholeGuideUrl } from "../../lib/pdf/index.ts";

/** The part of pdfmake's API the download uses (a document renders once, on its first getBuffer or download). */
export interface PdfMake {
  fonts: Record<string, Record<string, string>>;
  createPdf(def: DocDefinition): { getBuffer(): Promise<unknown>; download(fileName: string): Promise<unknown> };
}

/** What the download needs from the browser; tests substitute their own. */
export interface PdfEnvironment {
  pdfMake(): Promise<PdfMake>;
  fontmap(): Promise<FontMapJson>;
  /** Absolute URL of a vendored font file. */
  fontUrl(file: string): string;
  /** An image variant as a PNG or JPEG data URL. */
  image(v: ImageVariant): Promise<string>;
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Draws the part of an image its crop keeps (cut from the file upright, as the screen shows it:
 * createImageBitmap applies a photo's EXIF orientation by default), turned and flipped as
 * stored (flips first, then the rotation), and encodes PNG.
 */
export async function convertToPng(blob: Blob, v: ImageVariant): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const crop = cropOrNull(v.crop);
  const src = crop ? cropPixels(bitmap.width, bitmap.height, crop) : { left: 0, top: 0, width: bitmap.width, height: bitmap.height };
  const turned = v.rot % 180 !== 0;
  const canvas = new OffscreenCanvas(turned ? src.height : src.width, turned ? src.width : src.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("PDF: no 2D canvas for image conversion");
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((v.rot * Math.PI) / 180);
  ctx.scale(v.flipH ? -1 : 1, v.flipV ? -1 : 1);
  ctx.drawImage(bitmap, src.left, src.top, src.width, src.height, -src.width / 2, -src.height / 2, src.width, src.height);
  bitmap.close();
  return canvas.convertToBlob({ type: "image/png" });
}

async function siteAsset(asset: string): Promise<Blob> {
  const res = await fetch(`${DATA_BASE}assets/${asset}`);
  if (!res.ok) throw new Error(`PDF: image ${asset}: HTTP ${res.status}`);
  return res.blob();
}

export const browserEnvironment: PdfEnvironment = {
  async pdfMake() {
    const mod = (await import("pdfmake/build/pdfmake.js")) as unknown as { default?: PdfMake } & PdfMake;
    return mod.default ?? mod;
  },
  fontmap: () => loadData<FontMapJson>(FONTMAP_PATH),
  fontUrl: (file) => new URL(`${import.meta.env.BASE_URL}fonts/${file}`, window.location.href).href,
  async image(v) {
    const blob = localAssetOf(v.asset)?.blob ?? (await siteAsset(v.asset));
    if (embedsAsStored(v)) return `data:${storedMime(v.asset)};base64,${base64(new Uint8Array(await blob.arrayBuffer()))}`;
    const png = await convertToPng(blob, v);
    return `data:image/png;base64,${base64(new Uint8Array(await png.arrayBuffer()))}`;
  },
};

/**
 * Builds the scope's PDF in the browser and downloads it. Resolves with the file name once the
 * download has been handed to the browser (the menu then shows "Downloaded <file name>").
 */
export async function downloadPdf(scope: PdfScope, input: PdfInput, env: PdfEnvironment = browserEnvironment): Promise<string> {
  const [pdfMake, fontmap] = await Promise.all([env.pdfMake(), env.fontmap()]);
  const variants = imageRequests(scope, input);
  const loaded = await Promise.all(variants.map(async (v) => [imageKey(v), await env.image(v)] as const));
  const images: ImageData = Object.fromEntries(loaded);
  const name = pdfFileName(scope, input);
  pdfMake.fonts = pdfFonts(fontmap, env.fontUrl);
  const pdf = await renderPdf(scope, { ...input, images }, fontmap, (def) => pdfMake.createPdf(def));
  await pdf.download(name);
  return name;
}
