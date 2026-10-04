// app/pdf/download.ts: what the download takes from the browser — asset fetches, canvas conversion,
// the font map, font URLs and pdfmake's browser build.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fontmapFor } from "../../lib/pdf/testing.ts";
import { DATA_BASE } from "../data/load.ts";
import { browserEnvironment, convertToPng } from "./download.ts";

const PNG = `${"a".repeat(32)}.png`;
const GIF = `${"b".repeat(32)}.gif`;
/** A 1 × 1 PNG. */
const PNG_BYTES = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const PNG_URL = `data:image/png;base64,${btoa(String.fromCharCode(...PNG_BYTES))}`;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** createImageBitmap and OffscreenCanvas stand-ins recording the drawing calls. */
function stubCanvas(): { calls: unknown[][]; canvases: { width: number; height: number }[] } {
  const calls: unknown[][] = [];
  const canvases: { width: number; height: number }[] = [];
  vi.stubGlobal("createImageBitmap", async () => ({ width: 4, height: 2, close: () => calls.push(["close"]) }));
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
        canvases.push(this);
      }
      getContext() {
        return {
          translate: (...a: number[]) => calls.push(["translate", ...a]),
          rotate: (a: number) => calls.push(["rotate", a]),
          scale: (...a: number[]) => calls.push(["scale", ...a]),
          drawImage: (_b: unknown, ...a: number[]) => calls.push(["drawImage", ...a]),
        };
      }
      async convertToBlob(o: { type: string }) {
        calls.push(["convertToBlob", o.type]);
        return { type: o.type, arrayBuffer: async () => PNG_BYTES.slice().buffer };
      }
    },
  );
  return { calls, canvases };
}

describe("convertToPng", () => {
  it("draws a turned picture on a canvas with swapped sides, mirrored before it is turned", async () => {
    const { calls, canvases } = stubCanvas();
    const out = await convertToPng(new Blob([PNG_BYTES]), { asset: GIF, rot: 90, flipH: true, flipV: false });
    expect(canvases.map((c) => [c.width, c.height])).toEqual([[2, 4]]);
    // The context applies the last transform first: scale (mirror), then rotate, then centre.
    expect(calls).toEqual([["translate", 1, 2], ["rotate", Math.PI / 2], ["scale", -1, 1], ["drawImage", -2, -1], ["close"], ["convertToBlob", "image/png"]]);
    expect(out.type).toBe("image/png");
  });

  it("keeps the sides of a picture turned 180° and mirrors it vertically", async () => {
    const { calls, canvases } = stubCanvas();
    await convertToPng(new Blob([PNG_BYTES]), { asset: GIF, rot: 180, flipH: false, flipV: true });
    expect(canvases.map((c) => [c.width, c.height])).toEqual([[4, 2]]);
    expect(calls.slice(0, 3)).toEqual([["translate", 2, 1], ["rotate", Math.PI], ["scale", 1, -1]]);
  });
});

describe("browserEnvironment", () => {
  const respond = (body: BodyInit | null, status = 200): Response => new Response(body, { status });

  it("embeds a stored PNG's bytes as they are", async () => {
    const fetch = vi.fn(async () => respond(PNG_BYTES));
    vi.stubGlobal("fetch", fetch);
    expect(await browserEnvironment.image({ asset: PNG, rot: 0, flipH: false, flipV: false })).toBe(PNG_URL);
    expect(fetch).toHaveBeenCalledWith(`${DATA_BASE}assets/${PNG}`);
  });

  it("converts a GIF to PNG through the canvas", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(PNG_BYTES)));
    const { calls } = stubCanvas();
    expect(await browserEnvironment.image({ asset: GIF, rot: 0, flipH: false, flipV: false })).toBe(PNG_URL);
    expect(calls.at(-1)).toEqual(["convertToBlob", "image/png"]);
  });

  it("fails on an HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(null, 404)));
    await expect(browserEnvironment.image({ asset: PNG, rot: 0, flipH: false, flipV: false })).rejects.toThrow(`PDF: image ${PNG}: HTTP 404`);
  });

  it("loads the font map from the published data", async () => {
    const fontmap = fontmapFor(["a"]);
    const fetch = vi.fn(async () => respond(JSON.stringify(fontmap)));
    vi.stubGlobal("fetch", fetch);
    expect(await browserEnvironment.fontmap()).toEqual(fontmap);
    expect(fetch).toHaveBeenCalledWith(`${DATA_BASE}fonts/fontmap.json`, { cache: "no-cache" });
  });

  it("resolves font files under the site's /fonts/", () => {
    expect(browserEnvironment.fontUrl("Carlito-Regular.ttf")).toBe(new URL(`${import.meta.env.BASE_URL}fonts/Carlito-Regular.ttf`, window.location.href).href);
  });

  it("loads pdfmake's browser build", async () => {
    const pdfMake = await browserEnvironment.pdfMake();
    expect(typeof pdfMake.createPdf).toBe("function");
  });
});
