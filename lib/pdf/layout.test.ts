// PDF layout rules (plan 70 §70.3) and the Carlito metrics they rely on.
import { join } from "node:path";
import * as fontkit from "fontkit";
import { describe, expect, it } from "vitest";
import type { DocJSON } from "../content/types.ts";
import { schema } from "../schema.ts";
import { buildDocDefinition, imageKey, imageRequests, keepRows, type Content, type ImageData } from "./index.ts";
import { CARLITO_ASCENT, CARLITO_ASCII_WIDTHS, CARLITO_DESCENT, CARLITO_LINE_FACTOR, CARLITO_UNITS_PER_EM, type Face } from "./metrics.ts";
import { SITE_URL } from "./rich.ts";
import { ALL_BORDERS, block, cell, doc, FONTS_DIR, fontmapFor, inlines, lines, para, row, table, txt, wordDoc } from "./testing.ts";

const ASCII = Array.from({ length: 95 }, (_, i) => String.fromCharCode(0x20 + i)).join("");
const fontmap = fontmapFor([ASCII, "⊕→➀•"]);
/** Word page fixture: 612 × 792 pt, 72 pt margins, so 468 pt of content width; base size 11 pt. */
const WIDTH = 468;

const IMG = "0123456789abcdef0123456789abcdef.png";
const GIF = "fedcba9876543210fedcba9876543210.gif";
const images: ImageData = {
  [imageKey({ asset: IMG, rot: 0, flipH: false, flipV: false })]: "data:image/png;base64,AAAA",
  [imageKey({ asset: IMG, rot: 90, flipH: true, flipV: false })]: "data:image/png;base64,BBBB",
  [imageKey({ asset: GIF, rot: 0, flipH: false, flipV: false })]: "data:image/png;base64,CCCC",
};

function build(d: DocJSON, kind: "prose" | "table" = "prose"): Content[] {
  expect(() => schema.nodeFromJSON(d).check()).not.toThrow();
  const w = wordDoc();
  w.blocks = [block("b_AAAAAAAAW1", kind, d)];
  return buildDocDefinition({ kind: "doc" }, { doc: w, images }, fontmap).content;
}

const first = (c: Content[]): Content => c[0] as Content;
const tableOf = (c: Content): { widths: number[]; body: Content[][]; headerRows?: number; dontBreakRows?: boolean; heights?: (i: number) => unknown } => c.table as never;
const layoutOf = (c: Content): Record<string, (i: number) => number> => c.layout as never;

describe("Carlito metrics", () => {
  it.each(["Regular", "Bold", "Italic", "BoldItalic"] as Face[])("match the vendored Carlito-%s.ttf", (face) => {
    const font = fontkit.openSync(join(FONTS_DIR, `Carlito-${face}.ttf`)) as unknown as {
      unitsPerEm: number;
      ascent: number;
      descent: number;
      glyphForCodePoint(cp: number): { advanceWidth: number };
    };
    expect([font.unitsPerEm, font.ascent, font.descent]).toEqual([CARLITO_UNITS_PER_EM, CARLITO_ASCENT, CARLITO_DESCENT]);
    expect(CARLITO_ASCII_WIDTHS[face]).toEqual(Array.from({ length: 95 }, (_, i) => font.glyphForCodePoint(0x20 + i).advanceWidth));
  });
});

describe("paragraphs", () => {
  it("uses margins for indents and spacing, and leadingIndent for a first-line or hanging indent", () => {
    const [p1, p2] = build(doc(para("first", { indLeft: 36, indRight: 9, indFirst: 18, spaceBefore: 6, spaceAfter: 4 }), para("hanging", { indLeft: 36, indFirst: -18 })));
    expect(p1).toMatchObject({ margin: [36, 6, 9, 4], leadingIndent: 18, preserveLeadingSpaces: true, alignment: "left" });
    expect(p2).toMatchObject({ margin: [36, 0, 0, 0], leadingIndent: -18 });
  });

  it("renders a marker paragraph as two columns, the marker tabPt wide, at indLeft + indFirst", () => {
    const marker = { text: "•", font: null, marks: [{ type: "bold" }], tabPt: 18 };
    const p = first(build(doc(para("item text", { indLeft: 36, indFirst: -18, marker }))));
    expect(p.margin).toEqual([18, 0, 0, 0]);
    const [m, t] = p.columns as Content[];
    expect(m).toMatchObject({ width: 18 });
    expect(inlines(m)).toMatchObject([{ text: "•", bold: true }]);
    expect(t).toMatchObject({ width: "*" });
    expect(lines(t)).toEqual(["item text"]);
  });

  it("keeps an empty paragraph's line with one space at the base size", () => {
    expect(inlines(build(doc(para(""))))).toEqual([{ text: " ", font: "Carlito", bold: false, italics: false, fontSize: 11 }]);
  });

  it("maps line spacing: auto as a multiple, exact and at-least from pt", () => {
    const [a, e, l] = build(doc(para("a", { line: { rule: "auto", value: 1.5 } }), para("e", { line: { rule: "exact", value: 24 } }), para("l", { line: { rule: "atLeast", value: 6 } })));
    expect(a?.lineHeight).toBe(1.5);
    expect(e?.lineHeight).toBeCloseTo(24 / (11 * CARLITO_LINE_FACTOR), 10);
    expect(l?.lineHeight).toBe(1);
  });

  it("aligns and draws shading as a filled one-cell box", () => {
    const p = first(build(doc(para("shaded", { align: "center", shade: "FFF2CC", indLeft: 10 }))));
    expect(p.margin).toEqual([10, 0, 0, 0]);
    const t = tableOf(p);
    expect(t.widths).toEqual([WIDTH - 10]);
    expect(t.body[0]?.[0]).toMatchObject({ fillColor: "#FFF2CC", border: [false, false, false, false] });
    expect((t.body[0]?.[0]?.stack as Content[])[0]).toMatchObject({ alignment: "center" });
  });

  it("turns tabs into spaces to the next 36 pt stop", () => {
    // A leading tab at 11 pt: 36 pt / Carlito's space (463/2048 em = 2.487 pt) ≈ 14 spaces.
    expect(inlines(build(doc(para("\tx"))))[0]?.text).toBe(`${" ".repeat(14)}x`);
    // A first-line indent of 30 pt leaves 6 pt to the stop at 36: 2 spaces.
    expect(inlines(build(doc(para("\tx", { indFirst: 30 }))))[0]?.text).toBe("  x");
    // After a hard break the line starts again at the margin.
    const brk = para([txt("a"), { type: "hard_break" }, txt("\tb")]);
    expect(inlines(build(doc(brk))).map((i) => i.text).join("")).toBe(`a\n${" ".repeat(14)}b`);
  });
});

describe("marks", () => {
  const run = (marks: { type: string; attrs?: Record<string, unknown> }[], text = "Ab"): Content[] => inlines(build(doc(para([txt(text, marks)]))));

  it("maps bold and italic to font faces, and keeps symbol fonts at Regular", () => {
    expect(run([{ type: "bold" }, { type: "italic" }], "A⊕")).toEqual([
      { text: "A", font: "Carlito", bold: true, italics: true, fontSize: 11 },
      { text: "⊕", font: "Noto Sans Math", bold: false, italics: false, fontSize: 11 },
    ]);
  });

  it("maps underline style, strike, sup/sub, color and size", () => {
    expect(run([{ type: "underline", attrs: { style: "double" } }])[0]).toMatchObject({ decoration: "underline", decorationStyle: "double" });
    expect(run([{ type: "underline", attrs: { style: "dottedHeavy" } }, { type: "strike", attrs: { double: false } }])[0]).toMatchObject({ decoration: ["underline", "lineThrough"], decorationStyle: "dotted" });
    expect(run([{ type: "underline", attrs: { style: "single" } }])[0]?.decorationStyle).toBeUndefined();
    expect(run([{ type: "vertAlign", attrs: { value: "sup" } }])[0]).toMatchObject({ sup: true });
    expect(run([{ type: "vertAlign", attrs: { value: "sub" } }])[0]).toMatchObject({ sub: true });
    expect(run([{ type: "color", attrs: { hex: "C00000" } }, { type: "size", attrs: { pt: 14 } }])[0]).toMatchObject({ color: "#C00000", fontSize: 14 });
  });

  it("uses the highlight as background, else the shade", () => {
    expect(run([{ type: "highlight", attrs: { hex: "FFFF00" } }, { type: "shade", attrs: { hex: "D9D9D9" } }])[0]?.background).toBe("#FFFF00");
    expect(run([{ type: "shade", attrs: { hex: "D9D9D9" } }])[0]?.background).toBe("#D9D9D9");
  });

  it("upper-cases caps, and small caps as lowercase letters upper-cased at 80% size", () => {
    expect(run([{ type: "caps" }], "Abc")[0]?.text).toBe("ABC");
    expect(run([{ type: "smallCaps" }], "Abc D").map((i) => [i.text, i.fontSize])).toEqual([["A", 11], ["BC", 11 * 0.8], [" D", 11]]);
  });

  it("links externally as stored and internal routes to the published site", () => {
    expect(run([{ type: "link", attrs: { href: "https://example.org/x" } }])[0]?.link).toBe("https://example.org/x");
    expect(run([{ type: "link", attrs: { href: "#/eor/fm/t/r_AAAAAAAAA1" } }])[0]?.link).toBe(`${SITE_URL}#/eor/fm/t/r_AAAAAAAAA1`);
  });
});

describe("tables", () => {
  it("uses her grid in pt when it fits, minus cell padding and borders", () => {
    const t = tableOf(first(build(doc(table([100, 200], [row("r_AAAAAAAAA1", "content", ["a", "b"])])), "table")));
    expect(t.widths).toHaveLength(2);
    expect(t.widths[0]).toBeCloseTo(100 - 10.8 - 0.5, 10);
    expect(t.widths[1]).toBeCloseTo(200 - 10.8 - 0.5 - 0.5, 10);
  });

  it("draws a name column she set under the screen's first-column minimum at her width", () => {
    // 30 of 400 pt is 7.5%: the screen's 11% minimum applies only to Word widths; the PDF draws her grid either way.
    for (const attrs of [{}, { ownWidths: true }]) {
      const t = tableOf(first(build(doc(table([30, 370], [row("r_AAAAAAAAA1", "content", ["a", "b"])], attrs)), "table")));
      expect(t.widths[0]).toBeCloseTo(30 - 10.8 - 0.5, 10);
      expect(t.widths[1]).toBeCloseTo(370 - 10.8 - 0.5 - 0.5, 10);
    }
  });

  it("scales every column by one factor when the grid is wider than the page", () => {
    const grid = [100, 400, 400];
    const c = first(build(doc(table(grid, [row("r_AAAAAAAAA1", "content", ["a", "b", "c"])])), "table"));
    const t = tableOf(c);
    const lay = layoutOf(c);
    const outer = t.widths.map((w, i) => w + 10.8 + (lay.vLineWidth?.(i) ?? 0) + (i === 2 ? (lay.vLineWidth?.(3) ?? 0) : 0));
    expect(outer.reduce((a, b) => a + b, 0)).toBeCloseTo(WIDTH, 6);
    for (let i = 0; i < 3; i++) expect((outer[i] ?? 0) / (grid[i] ?? 1)).toBeCloseTo(WIDTH / 900, 6);
  });

  it("pads cells by cellMarginPt and keeps fills, vertical alignment, spans and per-cell borders", () => {
    const red = { style: "single", widthPt: 1.5, color: "FF0000" };
    const rows = [
      row("r_AAAAAAAAA1", "content", [cell("wide", { colspan: 2, fill: "DEEAF6" }), cell("tall", { rowspan: 2, vAlign: "center" })]),
      row("r_AAAAAAAAA2", "content", [cell("x", { borders: { left: red, bottom: null } }), cell("y", { vAlign: "bottom" })]),
    ];
    const c = first(build(doc(table([50, 50, 50], rows, { cellMarginPt: { top: 2, right: 4, bottom: 3, left: 6 } })), "table"));
    const t = tableOf(c);
    const lay = layoutOf(c);
    expect([lay.paddingLeft?.(0), lay.paddingRight?.(0), lay.paddingTop?.(0), lay.paddingBottom?.(0)]).toEqual([6, 4, 2, 3]);
    expect(t.body[0]?.[0]).toMatchObject({ colSpan: 2, fillColor: "#DEEAF6" });
    expect(t.body[0]?.[1]).toEqual({ text: "" });
    expect(t.body[0]?.[2]).toMatchObject({ rowSpan: 2, verticalAlignment: "middle" });
    expect(t.body[1]?.[0]).toMatchObject({ border: [true, true, true, false], borderColor: ["#FF0000", "#000000", "#000000", "#000000"] });
    expect(t.body[1]?.[1]).toMatchObject({ verticalAlignment: "bottom" });
    expect(t.body[1]?.[2]).toEqual({ text: "" });
    expect(lay.vLineWidth?.(0)).toBe(1.5);
  });

  it("repeats the leading repeatHeader rows and keeps rows whole only when every row is cantSplit", () => {
    const h = (id: string, extra: Record<string, unknown>) => row(id, "heading", ["H", "h"], extra);
    const c = (id: string, extra: Record<string, unknown> = {}) => row(id, "content", ["c", "d"], extra);
    const t1 = tableOf(first(build(doc(table([50, 50], [h("r_AAAAAAAAH1", { repeatHeader: true, cantSplit: true }), h("r_AAAAAAAAH2", { repeatHeader: true, cantSplit: true }), c("r_AAAAAAAAA1", { cantSplit: true }), c("r_AAAAAAAAA2", { repeatHeader: true, cantSplit: true })])), "table")));
    expect(t1.headerRows).toBe(2);
    expect(t1.dontBreakRows).toBe(true);
    const t2 = tableOf(first(build(doc(table([50, 50], [h("r_AAAAAAAAH1", { cantSplit: true }), c("r_AAAAAAAAA1")])), "table")));
    expect(t2.headerRows).toBeUndefined();
    expect(t2.dontBreakRows).toBeUndefined();
  });

  it("gives rows their minimum height", () => {
    const t = tableOf(first(build(doc(table([50], [row("r_AAAAAAAAA1", "content", ["a"], { minHeightPt: 30 }), row("r_AAAAAAAAA2", "content", ["b"])])), "table")));
    expect([t.heights?.(0), t.heights?.(1)]).toEqual([30, "auto"]);
  });

  it("indents the table by indentPt", () => {
    expect(first(build(doc(table([50], [row("r_AAAAAAAAA1", "content", ["a"])], { indentPt: 12 })), "table")).margin).toEqual([12, 0, 0, 0]);
  });
});

describe("keepRows (topic and section tables)", () => {
  const span = (text: string, rowspan: number) => cell(text, { rowspan, fill: "FFE699" });
  const d = doc(
    table([50, 50], [
      row("r_AAAAAAAAA1", "content", [span("A", 3), "a1"]),
      row("r_AAAAAAAAA2", "content", ["a2"]),
      row("r_AAAAAAAAA3", "content", ["a3"]),
      row("r_AAAAAAAAB1", "content", ["B", "b1"]),
    ]),
  );
  const rowsOf = (out: DocJSON) => ((out.content[0] as { content: { attrs: { id: string }; content: { attrs: { rowspan: number; fill: string | null }; content: unknown[] }[] }[] }).content);

  it("keeps only the given rows, in table order, clipping row spans", () => {
    const out = keepRows(d, new Set(["r_AAAAAAAAB1", "r_AAAAAAAAA1", "r_AAAAAAAAA3"]));
    expect(rowsOf(out).map((r) => r.attrs.id)).toEqual(["r_AAAAAAAAA1", "r_AAAAAAAAA3", "r_AAAAAAAAB1"]);
    expect(rowsOf(out)[0]?.content[0]?.attrs.rowspan).toBe(2);
    expect(() => schema.nodeFromJSON(out).check()).not.toThrow();
  });

  it("keeps a spanning cell's text, as the screen does, on the first kept row when its own row is dropped", () => {
    const out = keepRows(d, new Set(["r_AAAAAAAAA2", "r_AAAAAAAAA3"]));
    const [r2, r3] = rowsOf(out);
    expect(r2?.content.map((c) => [c.attrs.rowspan, c.attrs.fill ?? null])).toEqual([[2, "FFE699"], [1, null]]);
    expect(lines(build(out, "table"))).toEqual(["A", "a2", "a3"]);
    expect(r3?.content).toHaveLength(1);
    expect(() => schema.nodeFromJSON(out).check()).not.toThrow();
  });
});

describe("page breaks", () => {
  it("starts the content after a page_break on a new page", () => {
    const out = build(doc(para([txt("before"), { type: "page_break" }, txt("after")]), para("next")));
    expect(lines(out)).toEqual(["before", "after", "next"]);
    expect(out[1]?.pageBreak).toBe("before");
    expect(out[2]?.pageBreak).toBeUndefined();
  });

  it("carries a break at a paragraph's end to the next block", () => {
    const out = build(doc(para([txt("end"), { type: "page_break" }]), table([50], [row("r_AAAAAAAAA1", "content", ["t"])])));
    expect(out[1]?.pageBreak).toBe("before");
  });

  it("ignores a page_break inside a table cell", () => {
    const brk = { type: "table_cell", attrs: {}, content: [para([txt("x"), { type: "page_break" }])] };
    const out = build(doc(table([50], [row("r_AAAAAAAAA1", "content", [brk])]), para("after")), "table");
    expect(out[1]?.pageBreak).toBeUndefined();
  });
});

describe("images, anchored content, text boxes, drawings, rules", () => {
  const img = (attrs: Record<string, unknown>) => ({ type: "image", attrs: { asset: IMG, widthPt: 100, heightPt: 50, rot: 0, flipH: false, flipV: false, ...attrs } });

  it("embeds a picture at its stored extent, the box turned for 90°, under its variant's key", () => {
    const out = build(doc(para([txt("see"), img({ rot: 90, flipH: true })])));
    expect(out[1]).toMatchObject({ image: imageKey({ asset: IMG, rot: 90, flipH: true, flipV: false }), width: 50, height: 100 });
    expect(lines(out)).toEqual(["see"]);
  });

  it("scales a picture wider than the space down proportionally", () => {
    expect(first(build(doc(para([img({ widthPt: 936, heightPt: 100 })]))))).toMatchObject({ width: WIDTH, height: 50 });
  });

  it("embeds only the images used, and fails on missing image data", () => {
    const w = wordDoc();
    w.blocks = [block("b_AAAAAAAAW1", "prose", doc(para([img({})])))];
    const def = buildDocDefinition({ kind: "doc" }, { doc: w, images }, fontmap);
    expect(Object.keys(def.images)).toEqual([imageKey({ asset: IMG, rot: 0, flipH: false, flipV: false })]);
    expect(() => buildDocDefinition({ kind: "doc" }, { doc: w }, fontmap)).toThrow(new RegExp(IMG));
  });

  it("requests each picture variant once, and drawing pictures unturned", () => {
    const w = wordDoc();
    const pic = { geom: "picture", x: 0, y: 0, w: 10, h: 10, rot: 45, flipH: true, flipV: false, stroke: null, fill: null, head: null, tail: null, asset: GIF };
    w.blocks = [block("b_AAAAAAAAW1", "prose", doc(para([img({}), img({}), img({ rot: 90, flipH: true })]), { type: "drawing", attrs: { widthPt: 20, heightPt: 20, shapes: [pic] } }))];
    expect(imageRequests({ kind: "doc" }, { doc: w })).toEqual([
      { asset: IMG, rot: 0, flipH: false, flipV: false },
      { asset: IMG, rot: 90, flipH: true, flipV: false },
      { asset: GIF, rot: 0, flipH: false, flipV: false },
    ]);
  });

  it("places anchored content at min(offset, space − width)", () => {
    const anchored = (offsetPt: number) => ({ type: "anchored", attrs: { offsetPt }, content: [{ type: "image_block", attrs: { asset: IMG, widthPt: 100, heightPt: 50, rot: 0, flipH: false, flipV: false } }] });
    const [near, far] = build(doc(anchored(10) as never, anchored(1000) as never));
    expect(near?.margin).toEqual([10, 0, 0, 0]);
    expect(far?.margin).toEqual([WIDTH - 100, 0, 0, 0]);
  });

  it("draws a text box as a one-cell table of its width, fill and border", () => {
    const box = { type: "textbox", attrs: { widthPt: 200, fill: "E2EFDA", border: { style: "single", widthPt: 1, color: "70AD47" }, inline: false }, content: [para("boxed words")] };
    const c = first(build(doc(box as never)));
    expect(c.width).toBe(200);
    expect(tableOf(c).widths).toEqual([200 - 2 * 7.2 - 2]);
    expect(tableOf(c).body[0]?.[0]).toMatchObject({ fillColor: "#E2EFDA", border: [true, true, true, true], borderColor: Array(4).fill("#70AD47") });
    expect(lines(c)).toEqual(["boxed words"]);
  });

  it("draws a drawing as SVG scaled to the space, with its text boxes over it", () => {
    const shapes = [
      { geom: "ellipse", x: 0, y: 0, w: 100, h: 50, rot: 0, flipH: false, flipV: false, stroke: { color: "000000", widthPt: 1, dash: "dash" }, fill: "FFFFFF", head: null, tail: null, asset: null },
      { geom: "picture", x: 10, y: 10, w: 20, h: 20, rot: 0, flipH: false, flipV: false, stroke: null, fill: null, head: null, tail: null, asset: GIF },
    ];
    const dt = { type: "drawing_text", attrs: { x: 100, y: 40, w: 200, h: 30, fill: null, border: null }, content: [para("label in drawing")] };
    const c = first(build(doc({ type: "drawing", attrs: { widthPt: 936, heightPt: 200, shapes }, content: [dt] } as never)));
    const [svg, overlay] = c.stack as Content[];
    expect(svg).toMatchObject({ width: WIDTH, height: 100 });
    expect(String(svg?.svg)).toContain('<ellipse cx="50" cy="25" rx="50" ry="25" fill="#FFFFFF" stroke="#000000" stroke-width="1" stroke-dasharray="4 3"/>');
    expect(String(svg?.svg)).toContain('href="data:image/png;base64,CCCC"');
    expect(overlay?.relativePosition).toEqual({ x: 50, y: -80 });
    expect(lines(overlay)).toEqual(["label in drawing"]);
  });

  it("draws a rule as a line across the space", () => {
    expect(first(build(doc({ type: "rule", attrs: { color: "A0A0A0", widthPt: 1.5 } } as never))).canvas).toEqual([{ type: "line", x1: 0, y1: 0.75, x2: WIDTH, y2: 0.75, lineWidth: 1.5, lineColor: "#A0A0A0" }]);
  });
});

describe("table borders", () => {
  it("draws no line where the table and cell have none", () => {
    const none = { top: null, right: null, bottom: null, left: null, insideH: null, insideV: null };
    const c = first(build(doc(table([50, 50], [row("r_AAAAAAAAA1", "content", ["a", "b"])], { borders: none })), "table"));
    expect(tableOf(c).body[0]?.[0]?.border).toEqual([false, false, false, false]);
    expect(layoutOf(c).hLineWidth?.(0)).toBe(0);
  });

  it("draws no line for a nil or none border in any case, and the cell's own side wins over the table's", () => {
    const nil = { style: "NIL", widthPt: 4, color: "FF0000" };
    const thick = { style: "single", widthPt: 2, color: "0000FF" };
    const c = first(build(doc(table([50, 50], [row("r_AAAAAAAAA1", "content", [cell("a", { borders: { right: thick } }), "b"])], { borders: { ...ALL_BORDERS, top: nil, insideV: { ...nil, style: "None" } } })), "table"));
    const [a, b] = tableOf(c).body[0] as Content[];
    // left, top, right, bottom
    expect(a?.border).toEqual([true, false, true, true]);
    expect(b?.border).toEqual([false, false, true, true]);
    expect(layoutOf(c).hLineWidth?.(0)).toBe(0);
    expect(layoutOf(c).vLineWidth?.(1)).toBe(2);
  });

  it("draws a dotDash underline dashed, as the screen does", () => {
    const def = build(doc(para([txt("x", [{ type: "underline", attrs: { style: "dotDash" } }])])));
    expect(inlines(def)[0]).toMatchObject({ decoration: "underline", decorationStyle: "dashed" });
  });
});
