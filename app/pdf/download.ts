// Browser PDF downloads (plan 70 §70.1–§70.2): the menu (OB6, app/reader) calls downloadPdf with the
// page data it has loaded, overlay included, so the file reflects her latest saved edits.
import type { FontMapJson } from "../../lib/derive/published.ts";
import {
  buildDocDefinition,
  embedsAsStored,
  imageKey,
  imageRequests,
  pdfFileName,
  pdfFonts,
  storedMime,
  type DocDefinition,
  type ImageData,
  type ImageVariant,
  type PdfInput,
  type PdfScope,
} from "../../lib/pdf/index.ts";
import { DATA_BASE, loadData } from "../data/load.ts";

export type { PdfInput, PdfScope } from "../../lib/pdf/index.ts";
export { pdfFileName, wholeGuideUrl } from "../../lib/pdf/index.ts";

/** The part of pdfmake's API the download uses. */
export interface PdfMake {
  fonts: Record<string, Record<string, string>>;
  createPdf(def: DocDefinition): { download(fileName: string): Promise<unknown> };
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

/** Draws an image turned and flipped as stored (flips first, then the rotation) and encodes PNG. */
export async function convertToPng(blob: Blob, v: ImageVariant): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const turned = v.rot % 180 !== 0;
  const canvas = new OffscreenCanvas(turned ? bitmap.height : bitmap.width, turned ? bitmap.width : bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("PDF: no 2D canvas for image conversion");
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((v.rot * Math.PI) / 180);
  ctx.scale(v.flipH ? -1 : 1, v.flipV ? -1 : 1);
  ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  bitmap.close();
  return canvas.convertToBlob({ type: "image/png" });
}

export const browserEnvironment: PdfEnvironment = {
  async pdfMake() {
    const mod = (await import("pdfmake/build/pdfmake.js")) as unknown as { default?: PdfMake } & PdfMake;
    return mod.default ?? mod;
  },
  fontmap: () => loadData<FontMapJson>("fonts/fontmap.json"),
  fontUrl: (file) => new URL(`${import.meta.env.BASE_URL}fonts/${file}`, window.location.href).href,
  async image(v) {
    const res = await fetch(`${DATA_BASE}assets/${v.asset}`);
    if (!res.ok) throw new Error(`PDF: image ${v.asset}: HTTP ${res.status}`);
    const blob = await res.blob();
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
  const def = buildDocDefinition(scope, { ...input, images }, fontmap);
  const name = pdfFileName(scope, input);
  pdfMake.fonts = pdfFonts(fontmap, env.fontUrl);
  await pdfMake.createPdf(def).download(name);
  return name;
}
