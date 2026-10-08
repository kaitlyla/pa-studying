// Floating pictures in the PDF, laid out by pdfmake's real engine: drawn over the text at their offset
// from their anchor, kept within their table or column, taking no room, and on their anchor's page.
import { join, resolve, sep } from "node:path";
import pdfMake from "pdfmake";
import { beforeAll, describe, expect, it } from "vitest";
import type { DocJSON } from "../content/types.ts";
import { schema } from "../schema.ts";
import { floatLifts, imageKey, pdfFonts, renderPdf, type DocDefinition, type LaidNode } from "./index.ts";
import { block, doc, FONTS_DIR, fontmapFor, para, row, table, wordDoc } from "./testing.ts";

const ASCII = Array.from({ length: 95 }, (_, i) => String.fromCharCode(0x20 + i)).join("");
const fontmap = fontmapFor([ASCII]);
const IMG = "0123456789abcdef0123456789abcdef.png";
/** A 1 × 1 PNG, drawn at the size the definition gives it. */
const PNG_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const images = { [imageKey({ asset: IMG, rot: 0, flipH: false, flipV: false })]: PNG_URL };
/** The Word page fixture: 612 × 792 pt with 72 pt margins, so the column is 72–540 and the page's inner area ends at 720. */
const LEFT = 72;
const INNER_BOTTOM = 720;

beforeAll(() => {
  const root = resolve(FONTS_DIR) + sep;
  pdfMake.setUrlAccessPolicy(() => false);
  pdfMake.setLocalAccessPolicy((path) => resolve(path).startsWith(root));
  pdfMake.fonts = pdfFonts(fontmap, (file) => join(root, file));
});

const floating = (dxPt: number, dyPt: number, widthPt = 100, heightPt = 40) => ({
  type: "anchored",
  attrs: { offsetPt: 0, float: { dxPt, dyPt } },
  content: [{ type: "image_block", attrs: { asset: IMG, widthPt, heightPt, rot: 0, flipH: false, flipV: false } }],
});
const cellOf = (...content: unknown[]) => ({ type: "table_cell", attrs: {}, content });

interface Made {
  /** Each laid-out node of each PDF made, in order. */
  layouts: LaidNode[][];
  final: LaidNode[];
}

/** Makes a Word page's PDF as the download does, recording where pdfmake laid out every node. */
async function make(d: DocJSON, kind: "prose" | "table" = "prose"): Promise<Made> {
  expect(() => schema.nodeFromJSON(d).check()).not.toThrow();
  const w = wordDoc();
  w.blocks = [block("b_AAAAAAAAW1", kind, d)];
  const layouts: LaidNode[][] = [];
  const pdf = await renderPdf({ kind: "doc" }, { doc: w, images }, fontmap, (def: DocDefinition) => {
    const laid: LaidNode[] = [];
    layouts.push(laid);
    const inner = def.pageBreakBefore;
    def.pageBreakBefore = (node) => {
      laid.push(node);
      return inner?.(node) ?? false;
    };
    return pdfMake.createPdf(def);
  });
  await pdf.getBuffer();
  return { layouts, final: layouts.at(-1) ?? [] };
}

const picture = (laid: LaidNode[], n = 0): LaidNode => {
  const pics = laid.filter((x) => x.id?.startsWith("float-"));
  const p = pics[n];
  if (!p) throw new Error(`no floating picture ${n} of ${pics.length}`);
  return p;
};
/** The first line of the text node holding `words`. */
const textAt = (laid: LaidNode[], words: string): LaidNode => {
  const t = laid.find((x) => JSON.stringify((x as { text?: unknown }).text ?? null).includes(words));
  if (!t) throw new Error(`no text "${words}"`);
  return t;
};
const page = (n: LaidNode): number => n.startPosition.pageNumber;
const left = (n: LaidNode): number => (n.startPosition as unknown as { left: number }).left;

describe("a floating picture in body text", () => {
  it("is drawn dx right of the column and dy below the top of the paragraph after it, taking no room", async () => {
    const { final, layouts } = await make(doc(para("above"), floating(50, 10) as never, para("anchor words"), para("after")));
    const { final: without } = await make(doc(para("above"), para("anchor words"), para("after")));
    const pic = picture(final);
    const anchor = textAt(final, "anchor words");
    expect(page(pic)).toBe(page(anchor));
    expect(left(pic)).toBeCloseTo(LEFT + 50, 6);
    expect(pic.startPosition.top).toBeCloseTo(anchor.startPosition.top + 10, 6);
    // The text is where it is without the picture.
    for (const words of ["anchor words", "after"]) expect(textAt(final, words).startPosition.top).toBeCloseTo(textAt(without, words).startPosition.top, 6);
    // It fits its page: made once.
    expect(layouts).toHaveLength(1);
  });

  it("measures dy from the paragraph's text, below its space before", async () => {
    const { final } = await make(doc(para("above"), floating(0, 4) as never, para("spaced", { spaceBefore: 12 })));
    expect(picture(final).startPosition.top).toBeCloseTo(textAt(final, "spaced").startPosition.top + 4, 6);
  });

  it("keeps within the column", async () => {
    const { final } = await make(doc(floating(1000, 0) as never, para("x"), floating(-30, 0) as never, para("y")));
    expect(left(picture(final, 0))).toBeCloseTo(540 - 100, 6);
    expect(left(picture(final, 1))).toBeCloseTo(LEFT, 6);
  });
});

describe("a floating picture in a table cell", () => {
  // A 100 + 300 pt table at the column's left (72–472), no borders, Word's 5.4 pt cell margins.
  const tableWith = (dxPt: number, dyPt: number, heightPt = 40) =>
    doc(table([100, 300], [
      row("r_AAAAAAAAR1", "content", ["left text", cellOf(floating(dxPt, dyPt, 100, heightPt), para("cell anchor")) as never]),
      row("r_AAAAAAAAR2", "content", ["row two", "more"]),
    ]) as never, para("after table"));

  it("is drawn from its cell's text, dx right and dy down, over the table, taking no room in its cell", async () => {
    const { final } = await make(tableWith(20, 6, 120), "table");
    const { final: without } = await make(doc(table([100, 300], [
      row("r_AAAAAAAAR1", "content", ["left text", "cell anchor"]),
      row("r_AAAAAAAAR2", "content", ["row two", "more"]),
    ]) as never, para("after table")), "table");
    const pic = picture(final);
    const anchor = textAt(final, "cell anchor");
    expect(left(pic)).toBeCloseTo(left(anchor) + 20, 6);
    expect(pic.startPosition.top).toBeCloseTo(anchor.startPosition.top + 6, 6);
    // 120 pt tall, it reaches over the next row and below the table; neither moves.
    for (const words of ["cell anchor", "row two", "after table"]) expect(textAt(final, words).startPosition.top).toBeCloseTo(textAt(without, words).startPosition.top, 6);
  });

  it("keeps within the whole table, reaching into the other column", async () => {
    expect(left(picture((await make(tableWith(1000, 0), "table")).final))).toBeCloseTo(LEFT + 400 - 100, 6);
    expect(left(picture((await make(tableWith(-1000, 0), "table")).final))).toBeCloseTo(LEFT, 6);
  });
});

describe("a floating picture near the page's end", () => {
  // Enough lines to bring the anchor near the bottom of the first page.
  const filler = Array.from({ length: 44 }, (_, i) => para(`line ${i}`));

  it("stays on its anchor's page, lifted to end within the page instead of moving to the next", async () => {
    const { layouts, final } = await make(doc(...filler, floating(0, 0, 100, 200) as never, para("anchor near bottom"), para("next")));
    const anchor = textAt(final, "anchor near bottom");
    expect(page(anchor)).toBe(1);
    const pic = picture(final);
    expect(page(pic)).toBe(1);
    expect(pic.startPosition.top + 200).toBeCloseTo(INNER_BOTTOM, 6);
    // Unlifted, it would have run past the page's end: laid out once to find that, then made again.
    expect(layouts).toHaveLength(2);
    expect(picture(layouts[0] ?? []).startPosition.top + 200).toBeGreaterThan(INNER_BOTTOM);
    expect(picture(layouts[0] ?? []).startPosition.top).toBeCloseTo(anchor.startPosition.top, 6);
    // Lifting it moves no text.
    expect(textAt(layouts[0] ?? [], "next").startPosition).toEqual(textAt(final, "next").startPosition);
  });
});

describe("floatLifts", () => {
  const at = (top: number, height: number) => ({ height, startPosition: { pageNumber: 1, top, pageInnerHeight: 648, verticalRatio: (top - 72) / 648 } });

  it("lifts a picture by as much as it runs past its page's inner area, never above its top", () => {
    const lifts = floatLifts(new Map([["float-0", at(700, 100)], ["float-1", at(100, 50)], ["float-2", at(200, 900)]]));
    expect([...lifts]).toEqual([["float-0", 80], ["float-2", 128]]);
  });
});
