// Whole-guide PDFs (plan 70 §70.5): the preamble and every system built with lib/pdf, exactly as the
// browser builds "This system", then merged in guide order with @cantoo/pdf-lib.
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { PDFDocument } from "@cantoo/pdf-lib";
import pdfMake from "pdfmake";
import sharp from "sharp";
import type { FontMapJson, HomeJson, NavJson, SystemJson } from "../../lib/derive/published.ts";
import { buildDocDefinition, imageKey, imageRequests, pdfFonts, type ImageData, type ImageVariant, type PdfInput, type PdfScope } from "../../lib/pdf/index.ts";

const MIME: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg" };

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

/** An image variant as a data URL: PNG/JPEG bytes as stored; GIF and turned/flipped pictures as PNG via sharp. */
export async function imageDataUrl(assetsDir: string, v: ImageVariant): Promise<string> {
  const bytes = await readFile(join(assetsDir, v.asset));
  const ext = v.asset.slice(v.asset.lastIndexOf(".") + 1).toLowerCase();
  const mime = MIME[ext];
  if (mime && v.rot === 0 && !v.flipH && !v.flipV) return `data:${mime};base64,${bytes.toString("base64")}`;
  // sharp mirrors (flip, flop) before it rotates, matching the stored transform's order.
  const png = await sharp(bytes).flip(v.flipV).flop(v.flipH).rotate(v.rot).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

export interface PdfRenderer {
  render(scope: PdfScope, input: PdfInput): Promise<Uint8Array>;
}

/** Renders scopes with pdfmake in Node from `dist/data/` and the vendored fonts. */
export function nodeRenderer(dataDir: string, fontsDir: string, fontmap: FontMapJson): PdfRenderer {
  const fontsRoot = resolve(fontsDir) + sep;
  pdfMake.setUrlAccessPolicy(() => false);
  pdfMake.setLocalAccessPolicy((path) => resolve(path).startsWith(fontsRoot));
  pdfMake.fonts = pdfFonts(fontmap, (file) => join(fontsRoot, file));
  const assetsDir = join(dataDir, "assets");
  return {
    async render(scope, input) {
      const variants = imageRequests(scope, input);
      const images: ImageData = {};
      for (const v of variants) images[imageKey(v)] = await imageDataUrl(assetsDir, v);
      const def = buildDocDefinition(scope, { ...input, images }, fontmap);
      return new Uint8Array(await pdfMake.createPdf(def).getBuffer());
    },
  };
}

/** Concatenates PDFs page by page, in order. */
export async function mergePdfs(parts: readonly Uint8Array[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const part of parts) {
    const src = await PDFDocument.load(part);
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const page of pages) out.addPage(page);
  }
  return out.save();
}

/** The guide's whole PDF: its preamble (when it has one), then every system in guide order. */
export async function buildGuidePdf(dataDir: string, guide: string, renderer: PdfRenderer): Promise<Uint8Array> {
  const dir = join(dataDir, "g", guide);
  const nav = await readJson<NavJson>(join(dir, "nav.json"));
  const home = await readJson<HomeJson>(join(dir, "home.json"));
  const parts: Uint8Array[] = [];
  if (home.preamble.length > 0) parts.push(await renderer.render({ kind: "preamble" }, { nav, home }));
  for (const s of nav.systems) {
    const system = await readJson<SystemJson>(join(dir, "s", `${s.id}.json`));
    parts.push(await renderer.render({ kind: "system" }, { nav, system }));
  }
  return mergePdfs(parts);
}

export async function loadFontmap(dataDir: string): Promise<FontMapJson> {
  return readJson<FontMapJson>(join(dataDir, "fonts", "fontmap.json"));
}
