// @vitest-environment node
// app/pdf/download.ts: downloadPdf run with pdfmake's real engine and the vendored fonts. Node, not
// jsdom: pdfkit does not recognise font bytes read under jsdom's globals.
import { join, resolve, sep } from "node:path";
import { PDFDocument } from "@cantoo/pdf-lib";
import serverPdfMake from "pdfmake";
import { describe, expect, it } from "vitest";
import { imageKey, imageRequests, type DocDefinition, type ImageVariant } from "../../lib/pdf/index.ts";
import { block, cardioSystem, doc, fmNav, FONTS_DIR, fontmapFor, para, txt, wordDoc } from "../../lib/pdf/testing.ts";
import { downloadPdf, embedsAsStored, pdfFileName, type PdfEnvironment, type PdfMake } from "./download.ts";

const PNG = `${"a".repeat(32)}.png`;
const GIF = `${"b".repeat(32)}.gif`;
/** A 1 × 1 PNG. */
const PNG_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

interface Download {
  name: string;
  pdf: Uint8Array;
  fonts: Record<string, Record<string, string>>;
}

/** pdfmake's Node engine behind the browser API: download() renders the PDF and records it. */
function testEnvironment(texts: string[], image: (v: ImageVariant) => Promise<string> = async () => PNG_URL): PdfEnvironment & { downloads: Download[]; images: ImageVariant[] } {
  const downloads: Download[] = [];
  const images: ImageVariant[] = [];
  const root = resolve(FONTS_DIR) + sep;
  serverPdfMake.setUrlAccessPolicy(() => false);
  serverPdfMake.setLocalAccessPolicy((path) => resolve(path).startsWith(root));
  const pdfMake: PdfMake = {
    fonts: {},
    createPdf(def: DocDefinition) {
      return {
        async download(name: string) {
          serverPdfMake.fonts = pdfMake.fonts;
          downloads.push({ name, pdf: new Uint8Array(await serverPdfMake.createPdf(def).getBuffer()), fonts: pdfMake.fonts });
        },
      };
    },
  };
  return {
    downloads,
    images,
    pdfMake: async () => pdfMake,
    fontmap: async () => fontmapFor(texts),
    fontUrl: (file) => join(FONTS_DIR, file),
    async image(v) {
      images.push(v);
      return image(v);
    },
  };
}

const imageNode = (asset: string, attrs: Record<string, unknown> = {}) => ({ type: "image", attrs: { asset, widthPt: 40, heightPt: 20, rot: 0, flipH: false, flipV: false, ...attrs } });

describe("downloadPdf", () => {
  it("downloads the scope's PDF under its file name, with the vendored fonts, and resolves with the name", async () => {
    const env = testEnvironment(["Intro ⊕ → ➀ ▪️ item CARDIO LABEL About Dx Angina chest pain ECG radiates troponin ANTIANGINAL Use Nitrates angina CCB HTN Murmurs note HF PHARM Loop diuretics edema Myocarditis: viral/other MRI"]);
    const input = { nav: fmNav(), system: cardioSystem() };
    const name = await downloadPdf({ kind: "system" }, input, env);

    expect(name).toBe("Family Medicine EOR - Cardiovascular.pdf");
    expect(name).toBe(pdfFileName({ kind: "system" }, input));
    expect(env.downloads.map((d) => d.name)).toEqual([name]);
    const [d] = env.downloads;
    expect(d?.fonts.Carlito).toEqual({
      normal: join(FONTS_DIR, "Carlito-Regular.ttf"),
      bold: join(FONTS_DIR, "Carlito-Bold.ttf"),
      italics: join(FONTS_DIR, "Carlito-Italic.ttf"),
      bolditalics: join(FONTS_DIR, "Carlito-BoldItalic.ttf"),
    });
    expect(d?.fonts["Noto Sans Math"]?.normal).toBe(join(FONTS_DIR, "NotoSansMath-Regular.ttf"));
    expect((await PDFDocument.load(d?.pdf ?? new Uint8Array())).getPageCount()).toBeGreaterThanOrEqual(1);
    expect(env.images).toEqual([]);
  });

  it("loads each image variant the scope needs once and embeds it", async () => {
    const w = wordDoc();
    w.blocks = [block("b_AAAAAAAAW1", "prose", doc(para([txt("pictures"), imageNode(PNG), imageNode(PNG), imageNode(GIF, { rot: 90, flipH: true })])))];
    const env = testEnvironment(["pictures Vaccine page text"]);
    const name = await downloadPdf({ kind: "doc" }, { doc: w }, env);

    expect(name).toBe(pdfFileName({ kind: "doc" }, { doc: w }));
    expect(env.images).toEqual(imageRequests({ kind: "doc" }, { doc: w }));
    expect(env.images.map(imageKey)).toEqual([imageKey({ asset: PNG, rot: 0, flipH: false, flipV: false }), imageKey({ asset: GIF, rot: 90, flipH: true, flipV: false })]);
    expect(env.downloads).toHaveLength(1);
  });

  it("rejects without downloading when an image cannot be loaded", async () => {
    const w = wordDoc();
    w.blocks = [block("b_AAAAAAAAW1", "prose", doc(para([imageNode(PNG)])))];
    const env = testEnvironment(["Vaccine"], async (v) => {
      throw new Error(`PDF: image ${v.asset}: HTTP 404`);
    });
    await expect(downloadPdf({ kind: "doc" }, { doc: w }, env)).rejects.toThrow(`PDF: image ${PNG}: HTTP 404`);
    expect(env.downloads).toEqual([]);
  });
});

describe("embedsAsStored", () => {
  it.each([
    [{ asset: PNG, rot: 0, flipH: false, flipV: false }, true],
    [{ asset: "c".repeat(32) + ".jpeg", rot: 0, flipH: false, flipV: false }, true],
    [{ asset: "c".repeat(32) + ".JPG", rot: 0, flipH: false, flipV: false }, true],
    [{ asset: GIF, rot: 0, flipH: false, flipV: false }, false],
    [{ asset: PNG, rot: 90, flipH: false, flipV: false }, false],
    [{ asset: PNG, rot: 0, flipH: true, flipV: false }, false],
    [{ asset: PNG, rot: 0, flipH: false, flipV: true }, false],
  ])("%j → %s", (v, expected) => {
    expect(embedsAsStored(v)).toBe(expected);
  });
});
