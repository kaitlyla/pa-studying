import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { assetName } from "../content/ids.ts";
import { FIXTURES, buildDocx, para, run } from "./fixtures.ts";
import type { TopElement } from "./index.ts";
import { convertDocx, isSymbolFont, mapSymbol, segmentGuide, toBlocks } from "./index.ts";

/** Stored node JSON as these tests walk it, field by field. */
type J = Record<string, unknown>;

async function convert(key: keyof typeof FIXTURES) {
  const bytes = await FIXTURES[key]!.build();
  const stored: { name: string; bytes: Uint8Array }[] = [];
  const conv = await convertDocx(bytes, {
    storeAsset: async (b, ext) => {
      const name = await assetName(b, ext);
      stored.push({ name, bytes: b });
      return name;
    },
  });
  return { bytes, conv, stored, nodes: conv.body.flatMap((e) => e.nodes) };
}

/** Every node of a type, depth first, in document order. */
function all(nodes: J[], type: string): J[] {
  const out: J[] = [];
  const walk = (ns: J[]): void => {
    for (const n of ns) {
      if (n.type === type) out.push(n);
      walk((n.content ?? []) as J[]);
    }
  };
  walk(nodes);
  return out;
}

const textOf = (p: J): string =>
  ((p.content ?? []) as J[]).map((c) => (c.type === "text" ? (c.text as string) : c.type === "hard_break" ? "\n" : "")).join("");
const markers = (nodes: J[]): (string | null)[] =>
  all(nodes, "paragraph").map((p) => ((p.attrs as J).marker as J | null)?.text as string | null);
const marksOf = (n: J): J[] => (n.marks ?? []) as J[];
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

describe("convertDocx — 99 §99.1 scenarios", () => {
  it("maps a Wingdings F0E0 symbol to →", async () => {
    const { nodes, conv } = await convert("symbolMap");
    expect(textOf(all(nodes, "paragraph")[0]!)).toBe("→");
    expect(conv.report).toEqual([]);
  });

  it("keeps an unmapped symbol with its font mark and reports it", async () => {
    const { nodes, conv } = await convert("unmappedSymbol");
    const text = (all(nodes, "paragraph")[0]!.content as J[])[0]!;
    expect(text.text).toBe("");
    expect(marksOf(text)).toContainEqual({ type: "font", attrs: { family: "Wingdings" } });
    expect(conv.report).toEqual([{ kind: "unmappedSymbol", font: "Wingdings", code: "F0FC" }]);
  });

  it("converts tab, line break, page break and drops the soft hyphen", async () => {
    const { nodes } = await convert("breaks");
    expect(all(nodes, "paragraph")[0]!.content).toEqual([
      { type: "text", text: "a\tb" },
      { type: "hard_break" },
      { type: "text", text: "c" },
      { type: "page_break" },
      { type: "text", text: "de" },
    ]);
  });

  it("numbers two levels: 1. a) b) 2. 3.", async () => {
    const { nodes } = await convert("numbering");
    expect(markers(nodes)).toEqual(["1.", "a)", "b)", "2.", "3."]);
  });

  it("restarts a level-1 run at its w:start after a new level-0 paragraph", async () => {
    const { nodes } = await convert("restart");
    expect(markers(nodes)).toEqual(["1.", "c)", "d)", "2.", "c)"]);
  });

  it("keeps a Courier New bullet's font on the marker", async () => {
    const { nodes } = await convert("bulletFont");
    const marker = (all(nodes, "paragraph")[0]!.attrs as J).marker as J;
    expect(marker.text).toBe("o");
    expect(marker.font).toBe("Courier New");
  });

  it("merges vertical cells into rowspan 3 and appends continuation content", async () => {
    const { nodes } = await convert("vMerge");
    const rows = all(nodes, "table_row");
    expect(rows.map((r) => (r.content as J[]).length)).toEqual([2, 1, 1]);
    const merged = (rows[0]!.content as J[])[0]!;
    expect((merged.attrs as J).rowspan).toBe(3);
    expect((merged.content as J[]).map(textOf)).toEqual(["top", "x"]);
  });

  it("reads tblHeader with no val as true and val=0 as false", async () => {
    const { nodes } = await convert("tblHeader");
    expect(all(nodes, "table_row").map((r) => (r.attrs as J).repeatHeader)).toEqual([true, false]);
  });

  it("places a text box anchored in a cell paragraph after that paragraph, in the same cell", async () => {
    const { nodes } = await convert("textboxInCell");
    const cell = all(nodes, "table_cell")[0]!;
    const content = cell.content as J[];
    expect(content.map((n) => n.type)).toEqual(["paragraph", "anchored"]);
    expect(textOf(content[0]!)).toBe("anchor");
    const box = (content[1]!.content as J[])[0]!;
    expect(box.type).toBe("textbox");
    expect((box.content as J[]).map(textOf)).toEqual(["boxed"]);
  });

  it("reads mc:Choice once and never the Fallback", async () => {
    const { nodes } = await convert("choiceFallback");
    const boxes = all(nodes, "textbox");
    expect(boxes).toHaveLength(1);
    expect(all(boxes, "paragraph").map(textOf)).toEqual(["from choice"]);
    expect(JSON.stringify(nodes)).not.toContain("from fallback");
  });

  it("crops a 200×100 PNG with l=r=25% to a 100×100 PNG", async () => {
    const { stored, nodes } = await convert("crop");
    expect(stored).toHaveLength(1);
    const meta = await sharp(stored[0]!.bytes).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 100, 100]);
    expect((all(nodes, "image")[0]!.attrs as J).asset).toBe(stored[0]!.name);
  });

  it("stores an uncropped picture byte-for-byte", async () => {
    const { stored, bytes } = await convert("uncropped");
    const { unzipSync } = await import("fflate");
    const original = unzipSync(bytes)["word/media/plain.png"]!;
    expect(stored).toHaveLength(1);
    expect(sha(stored[0]!.bytes)).toBe(sha(original));
  });

  it("places a column-anchored picture after its paragraph with offsetPt 10", async () => {
    const { nodes } = await convert("anchoredPicture");
    expect(nodes.map((n) => n.type)).toEqual(["paragraph", "anchored"]);
    expect(nodes[1]!.attrs).toEqual({ offsetPt: 10 });
    expect((nodes[1]!.content as J[])[0]!.type).toBe("image_block");
  });

  it("keeps a theme color's resolved value and drops auto", async () => {
    const { nodes } = await convert("themeColor");
    const [themed, auto] = all(nodes, "paragraph")[0]!.content as J[];
    expect(themed!.text).toBe("themed");
    expect(marksOf(themed!)).toContainEqual({ type: "color", attrs: { hex: "1F3864" } });
    expect(auto!.text).toBe("auto");
    expect(marksOf(auto!).some((m) => m.type === "color")).toBe(false);
  });

  it("turns a VML horizontal rule into a rule node with its color", async () => {
    const { nodes } = await convert("rule");
    const rule = all(nodes, "rule")[0]!;
    expect((rule.attrs as J).color).toBe("A0A0A0");
  });

  it("numbers a footnote reference as superscript 1 and ends with the note paragraph", async () => {
    const { nodes } = await convert("footnote");
    const paras = all(nodes, "paragraph");
    const ref = (paras[0]!.content as J[]).at(-1)!;
    expect(ref.text).toBe("1");
    expect(marksOf(ref)).toContainEqual({ type: "vertAlign", attrs: { value: "sup" } });
    expect(textOf(paras.at(-1)!)).toBe("1 Note text");
  });

  it("places endnotes after the footnotes", async () => {
    const { nodes } = await convert("endnote");
    expect(all(nodes, "paragraph").map(textOf)).toEqual(["Body1 more1", "1 Foot text", "1 End text"]);
  });

  it("numbers endnotes in lowerRoman when no endnotePr sets a format", async () => {
    const { nodes } = await convert("endnoteDefault");
    expect(all(nodes, "paragraph").map(textOf)).toEqual(["Bodyi", "i End text"]);
  });

  it("puts the default header first and the default footer last", async () => {
    const { nodes } = await convert("headerFooter");
    expect(all(nodes, "paragraph").map(textOf)).toEqual(["H", "middle", "F"]);
  });

  it("keeps an https link and drops a javascript: link but keeps its text", async () => {
    const { nodes } = await convert("hyperlink");
    const content = all(nodes, "paragraph")[0]!.content as J[];
    expect(content[0]).toEqual({ type: "text", text: "safe", marks: [{ type: "link", attrs: { href: "https://example.org/x" } }] });
    expect(content[1]).toEqual({ type: "text", text: " and unsafe" });
  });

  it("applies a table style's firstRow bold to the first row only", async () => {
    const { nodes } = await convert("tblStylePr");
    const rows = all(nodes, "table_row");
    const bold = (r: J): boolean[] => all([r], "text").map((t) => marksOf(t).some((m) => m.type === "bold"));
    expect(bold(rows[0]!)).toEqual([true, true]);
    expect(bold(rows[1]!)).toEqual([false, false]);
  });

  it("starts at a lvlOverride startOverride: 5. 6. 7.", async () => {
    const { nodes } = await convert("startOverride");
    expect(markers(nodes)).toEqual(["5.", "6.", "7."]);
  });

  it("continues a level with lvlRestart 0 across level-0 paragraphs", async () => {
    const { nodes } = await convert("lvlRestart");
    expect(markers(nodes)).toEqual(["1.", "a)", "2.", "b)"]);
  });

  it("merges legacy hMerge cells into colspan 2", async () => {
    const { nodes } = await convert("hMerge");
    const first = all(nodes, "table_row")[0]!.content as J[];
    expect(first).toHaveLength(1);
    expect((first[0]!.attrs as J).colspan).toBe(2);
    expect((first[0]!.content as J[]).map(textOf)).toEqual(["wide"]);
  });

  it("restarts at the startOverride value, not the level's w:start, after a restart", async () => {
    const { nodes } = await convert("restartAfterOverride");
    expect(markers(nodes)).toEqual(["1.", "e)", "f)", "2.", "e)"]);
  });

  it("keeps an explicit nil left border as no border instead of inheriting the style's", async () => {
    const { nodes } = await convert("nilLeftBorder");
    const table = all(nodes, "table")[0]!;
    expect(((table.attrs as J).borders as J).left).toBeNull();
    expect(((table.attrs as J).borders as J).top).toEqual({ style: "single", widthPt: 1, color: "FF0000" });
    const [nil, styled] = all(nodes, "table_cell");
    expect(((nil!.attrs as J).borders as J).left).toBeNull();
    expect(((styled!.attrs as J).borders as J).left).toEqual({ style: "single", widthPt: 1, color: "00FF00" });
  });
});

describe("convertDocx — shapes (30 §30.9)", () => {
  it("stores Word's outline explicitly: no a:ln takes the lnRef theme line, a:noFill has none", async () => {
    const { nodes, conv } = await convert("shapeStrokes");
    const shapes = all(nodes, "drawing").map((d) => ((d.attrs as J).shapes as J[])[0]!);
    expect(shapes.map((s) => s.geom)).toEqual(["line", "ellipse", "rect", "rect"]);
    expect(shapes[0]!.stroke).toEqual({ color: "4472C4", widthPt: 0.75, dash: "solid" });
    expect(shapes[0]!.fill).toBeNull();
    expect(shapes[1]!.stroke).toBeNull();
    expect(shapes[2]!.stroke).toEqual({ color: "00AA00", widthPt: 2, dash: "sysDot" });
    expect(shapes[3]!.stroke).toBeNull();
    expect(conv.report).toEqual([{ kind: "approxGeometry", geom: "cloud" }]);
  });

  it("gives an empty text box one empty paragraph", async () => {
    const { nodes } = await convert("emptyTextbox");
    const box = all(nodes, "textbox")[0]!;
    expect(box.content).toEqual([{ type: "paragraph", attrs: expect.objectContaining({ indLeft: 0, marker: null }) }]);
  });

  it("places group members through the group's frame and nested child spaces", async () => {
    const { nodes, stored } = await convert("group");
    const drawing = all(nodes, "drawing")[0]!;
    const attrs = drawing.attrs as J;
    expect([attrs.widthPt, attrs.heightPt]).toEqual([100, 50]);
    const box = (s: J): number[] => [s.x, s.y, s.w, s.h] as number[];
    const [rect, picture, ellipse] = attrs.shapes as J[];
    expect(rect!.geom).toBe("rect");
    expect(box(rect!)).toEqual([10, 5, 20, 10]);
    expect(rect!.stroke).toEqual({ color: "FF0000", widthPt: 1, dash: "solid" });
    expect(picture).toMatchObject({ geom: "picture", x: 0, y: 25, w: 10, h: 10, rot: 90, flipH: true, flipV: false, asset: stored[0]!.name });
    expect(ellipse).toMatchObject({ geom: "ellipse", x: 55, y: 30, w: 10, h: 10, stroke: null, fill: null });
    const [text] = drawing.content as J[];
    expect(text!.type).toBe("drawing_text");
    expect(text!.attrs).toEqual({ x: 50, y: 0, w: 50, h: 25, fill: null, border: null });
    expect(textOf(all([text!], "paragraph")[0]!)).toBe("in group");
  });

  it("converts VML rules, text boxes and image data", async () => {
    const { conv, stored } = await convert("vml");
    const [ruleEl, boxEl, picEl] = conv.body;
    expect(ruleEl!.nodes[1]).toEqual({ type: "rule", attrs: { color: "FF0000", widthPt: 2 } });

    const [anchored, plain] = boxEl!.nodes.slice(1);
    expect(anchored!.type).toBe("anchored");
    expect(anchored!.attrs).toEqual({ offsetPt: 10 });
    const box = (anchored!.content as J[])[0]!;
    expect(box.attrs).toEqual({ widthPt: 100, fill: "00FF00", border: { style: "solid", widthPt: 2, color: "0000FF" }, inline: false });
    expect(textOf(all([box], "paragraph")[0]!)).toBe("vml box");
    expect(plain!.type).toBe("textbox");
    expect(plain!.attrs).toEqual({ widthPt: 80, fill: null, border: null, inline: true });

    const image = all(picEl!.nodes as J[], "image")[0]!;
    expect(image.attrs).toEqual({ asset: stored[0]!.name, widthPt: 50, heightPt: 20, rot: 90, flipH: true, flipV: false });
  });
});

describe("convertDocx — document-level behavior", () => {
  it("takes basePt from the most frequent size and strips only that size mark", async () => {
    const bytes = buildDocx({ body: para(run("bigger text here", '<w:sz w:val="28"/>') + run("small")) });
    const conv = await convertDocx(bytes, { storeAsset: async () => "unused.png" });
    expect(conv.basePt).toBe(14);
    const [big, small] = conv.body[0]!.nodes[0]!.content as J[];
    expect(marksOf(big!).some((m) => m.type === "size")).toBe(false);
    expect(marksOf(small!)).toContainEqual({ type: "size", attrs: { pt: 10 } });
  });

  it("reads the page size and margins from the final sectPr", async () => {
    const bytes = buildDocx({ body: para(run("x")), sectPr: '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="1080" w:bottom="720" w:left="1080"/>' });
    const conv = await convertDocx(bytes, { storeAsset: async () => "unused.png" });
    expect(conv.page).toEqual({ widthPt: 595.3, heightPt: 841.9, margins: { top: 36, right: 54, bottom: 36, left: 54 } });
  });

  it("rejects a package without a document body", async () => {
    const { zipSync, strToU8 } = await import("fflate");
    const bytes = zipSync({ "word/document.xml": strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>') });
    await expect(convertDocx(bytes, { storeAsset: async () => "x.png" })).rejects.toThrow(/w:body is missing/);
  });
});

describe("toBlocks and segmentGuide (30 §30.8)", () => {
  const p = (text: string): TopElement => ({ table: false, text, nodes: [{ type: "paragraph", content: [{ type: "text", text }] }] });
  const t: TopElement = { table: true, text: "", nodes: [{ type: "table" }] };

  it("makes one table block per table and one prose block per run of other elements", () => {
    const blocks = toBlocks([p("a"), p("b"), t, p("c")]);
    expect(blocks.map((b) => b.kind)).toEqual(["prose", "table", "prose"]);
    expect(blocks[0]!.doc.content).toHaveLength(2);
  });

  it("splits a guide into its preamble and systems by heading text", () => {
    const els = [p("Intro"), p("CARDIOLOGY overview"), p("x"), t, p("Pulmonary"), p("y")];
    const seg = segmentGuide(els, [{ title: "Cardiology" }, { title: "Lungs", match: "pulmonary" }]);
    expect(seg.preamble.map((e) => e.text)).toEqual(["Intro"]);
    expect(seg.systems.map((s) => s.length)).toEqual([3, 2]);
  });

  it("throws when a system heading is missing", () => {
    expect(() => segmentGuide([p("Intro")], [{ title: "Renal" }])).toThrow("system heading not found: Renal");
  });
});

describe("symbols (30 §30.5)", () => {
  it("maps both the PUA and the low form of a symbol code", () => {
    expect(mapSymbol("Wingdings", "")).toBe("▪");
    expect(mapSymbol("wingdings", "§")).toBe("▪");
    expect(mapSymbol("Symbol", "")).toBe("•");
    expect(mapSymbol("Wingdings", "")).toBeNull();
    expect(mapSymbol("Arial", "")).toBeNull();
  });

  it("maps symbol-font run text per character, keeping real Unicode and reporting unmapped codes", async () => {
    const ch = (cp: number): string => String.fromCodePoint(cp);
    const wd = '<w:rFonts w:ascii="Wingdings" w:hAnsi="Wingdings"/>';
    const split = '<w:rFonts w:ascii="Wingdings" w:hAnsi="Arial"/>';
    const bytes = buildDocx({
      body: para(run(`${ch(0xe0)} ${ch(0x1f86a)}${ch(0xa7)}`, wd)) + para(run(ch(0xfc), wd)) + para(run(`n${ch(0xe0)}`, split)),
    });
    const conv = await convertDocx(bytes, { storeAsset: async () => "unused.png" });
    const [mapped, unmapped, perChar] = conv.body.map((e) => e.nodes[0]!);
    expect(textOf(mapped!)).toBe(`→ ${ch(0x1f86a)}▪`);
    expect(textOf(unmapped!)).toBe(ch(0xfc));
    expect(marksOf((unmapped!.content as J[])[0]!)).toContainEqual({ type: "font", attrs: { family: "Wingdings" } });
    expect(conv.report).toEqual([{ kind: "unmappedSymbol", font: "Wingdings", code: "F0FC" }]);
    // w:ascii covers characters below U+0080 and w:hAnsi the rest (Word's per-character font rule).
    expect(textOf(perChar!)).toBe(`■${ch(0xe0)}`);
  });

  it("recognises symbol fonts case-insensitively", () => {
    expect(isSymbolFont(" Wingdings 3 ")).toBe(true);
    expect(isSymbolFont("Courier New")).toBe(false);
    expect(isSymbolFont(undefined)).toBe(false);
  });
});
