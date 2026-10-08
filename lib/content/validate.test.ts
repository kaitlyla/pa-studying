// Validation of every stored record (plan 20): each file kind accepts its contract and refuses the
// violations 20 names.
import { describe, expect, it } from "vitest";
import { ContentError } from "./check.ts";
import { BLOCK_FILE_RE, inboxItemDir, inboxUploadPath, isContentJSON, partName, serializeFile, UPLOAD_NAME, validateFile } from "./files.ts";
import { checkTrackSeries, isCdcOrg } from "./validate.ts";
import type { GapFile } from "./types.ts";

const id = (p: string, n: number): string => `${p}_${String(n).padStart(10, "0")}`;
const B1 = id("b", 1);
const D1 = id("d", 1);
const G1 = id("g", 1);
const G2 = id("g", 2);

const para = (text: string, attrs: Record<string, unknown> = {}) => ({ type: "paragraph", attrs, content: [{ type: "text", text }] });
const doc = (...content: unknown[]) => ({ type: "doc", content });
const borders6 = { top: null, right: null, bottom: null, left: null, insideH: null, insideV: null };
const table = (...rowIds: string[]) => ({
  type: "table",
  attrs: { grid: [100, 200], borders: borders6, cellMarginPt: { top: 0, right: 5.4, bottom: 0, left: 5.4 } },
  content: rowIds.map((rid) => ({
    type: "table_row", attrs: { id: rid },
    content: [{ type: "table_cell", content: [para("x")] }, { type: "table_cell", content: [para("y")] }],
  })),
});

/** Validate after normalization (serializeFile), returning the thrown message or "ok". */
function verdict(path: string, value: unknown): string {
  try {
    serializeFile(path, value);
    return "ok";
  } catch (e) {
    if (!(e instanceof ContentError)) throw e;
    return e.message;
  }
}

const blockPath = `content/guides/fm/cardiovascular/blocks/${B1}.json`;
const block = (kind: string, d: unknown, extra: Record<string, unknown> = {}) => ({ v: 1, id: B1, kind, doc: d, meta: {}, ...extra });

describe("rich-text schema (20 §20.13)", () => {
  it("accepts a prose block and a table block", () => {
    expect(verdict(blockPath, block("prose", doc(para("Angina"), { type: "rule", attrs: { color: "A0A0A0", widthPt: 1 } })))).toBe("ok");
    expect(verdict(blockPath, block("table", doc(table(id("r", 1), id("r", 2)))))).toBe("ok");
  });

  it("fills attribute defaults on write so the stored doc round-trips unchanged", () => {
    const text = serializeFile(blockPath, block("prose", doc({ type: "paragraph", content: [{ type: "text", text: "a" }] })));
    const stored = JSON.parse(text);
    expect(stored.doc.content[0].attrs).toEqual({
      indLeft: 0, indRight: 0, indFirst: 0, spaceBefore: 0, spaceAfter: 0, line: null, align: "left", shade: null, borders: null, marker: null,
    });
    expect(() => validateFile(blockPath, stored)).not.toThrow();
  });

  it("refuses a stored doc that does not round-trip (missing defaults are not repaired on read)", () => {
    const raw = block("prose", doc({ type: "paragraph", content: [{ type: "text", text: "a" }] }));
    expect(() => validateFile(blockPath, raw)).toThrow(/round-trip/);
  });

  it.each([
    ["javascript: link", [{ type: "link", attrs: { href: "javascript:alert(1)" } }], /link href/],
    ["lowercase color", [{ type: "color", attrs: { hex: "1f3864" } }], /color/],
    ["bad vertAlign", [{ type: "vertAlign", attrs: { value: "super" } }], /one of/],
    ["zero size", [{ type: "size", attrs: { pt: 0 } }], /size/],
    ["unknown mark", [{ type: "glow" }], /glow/],
  ])("refuses a %s", (_name, marks, message) => {
    const v = block("prose", doc({ type: "paragraph", content: [{ type: "text", marks, text: "a" }] }));
    expect(verdict(blockPath, v)).toMatch(message);
  });

  it("refuses unknown node keys, node types and marks instead of dropping them on write", () => {
    expect(verdict(blockPath, block("prose", doc({ type: "paragraph", attr: { indLeft: 9 }, content: [] })))).toMatch(/unknown key attr on paragraph/);
    expect(verdict(blockPath, block("prose", doc({ type: "heading", content: [] })))).toMatch(/unknown node type "heading"/);
    expect(verdict(blockPath, block("prose", doc({ type: "paragraph", content: [{ type: "text", marks: [{ type: "bold", attrs: { weight: 700 } }], text: "a" }] })))).toMatch(/Unsupported attribute weight for bold/);
    expect(verdict(blockPath, block("prose", doc({ type: "paragraph", attrs: 3, content: [] })))).toMatch(/attrs of paragraph must be an object/);
    expect(verdict(blockPath, block("prose", doc("text")))).toMatch(/a node must be an object/);
    expect(verdict(blockPath, block("prose", doc({ type: "paragraph", content: [{ type: "text", marks: [{ type: "toString" }], text: "a" }] })))).toMatch(/unknown mark "toString"/);
    expect(verdict(blockPath, block("prose", doc({ type: "constructor" })))).toMatch(/unknown node type "constructor"/);
  });

  it("refuses inherited Object property names as keys (toString, constructor, __proto__)", () => {
    const bordersWith = (k: string) => JSON.parse(`{"top":null,"right":null,"bottom":null,"left":null,"${k}":null}`) as Record<string, unknown>;
    for (const k of ["toString", "constructor", "__proto__"]) {
      expect(verdict(blockPath, block("prose", doc(para("a", { borders: bordersWith(k) }))))).toMatch(new RegExp(`unknown key ${k}`));
      const site = JSON.parse(`{"v":1,"${k}":1}`) as Record<string, unknown>;
      expect(verdict("content/site.json", site)).toMatch(new RegExp(`\\.${k}: expected no such key`));
    }
    // A required key is not satisfied by an inherited property.
    expect(verdict("content/files/d_0000000001/text.json", {})).toMatch(/\.pages: expected a value/);
  });

  it("accepts http(s), mailto and internal #/ links", () => {
    for (const href of ["https://example.org/x", "http://a.b", "mailto:x@y.z", "#/fm/cardiovascular"]) {
      const v = block("prose", doc({ type: "paragraph", content: [{ type: "text", marks: [{ type: "link", attrs: { href } }], text: "a" }] }));
      expect(verdict(blockPath, v)).toBe("ok");
    }
  });

  it.each([
    ["paragraph line rule", para("a", { line: { rule: "double", value: 1 } }), /line rule/],
    ["paragraph line shape", para("a", { line: { rule: "auto" } }), /line/],
    ["paragraph alignment", para("a", { align: "middle" }), /one of/],
    ["paragraph borders", para("a", { borders: { top: { style: "single", widthPt: 1, color: "000000" } } }), /missing right/],
    ["marker without tabPt", para("a", { marker: { text: "•", font: null, marks: [] } }), /missing tabPt/],
    ["marker with an invalid mark", para("a", { marker: { text: "•", font: null, marks: [{ type: "size", attrs: { pt: -1 } }], tabPt: 9 } }), /size/],
    ["marker marks not a list", para("a", { marker: { text: "•", font: null, marks: {}, tabPt: 9 } }), /mark list/],
    ["image asset path", { type: "paragraph", content: [{ type: "image", attrs: { asset: "../x.png", widthPt: 10, heightPt: 10 } }] }, /asset/],
    ["image rotation", { type: "paragraph", content: [{ type: "image", attrs: { asset: `${"a".repeat(32)}.png`, widthPt: 10, heightPt: 10, rot: 45 } }] }, /one of/],
    ["text box border", { type: "textbox", attrs: { widthPt: 100, border: { style: "single", widthPt: 1 } }, content: [para("a")] }, /missing color/],
    ["drawing shape", { type: "drawing", attrs: { widthPt: 10, heightPt: 10, shapes: [{ geom: "rect" }] }, content: [] }, /missing x/],
    ["drawing shapes not a list", { type: "drawing", attrs: { widthPt: 10, heightPt: 10, shapes: {} }, content: [] }, /shapes/],
    ["anchored with two children", { type: "anchored", content: [{ type: "image_block", attrs: { asset: `${"a".repeat(32)}.gif`, widthPt: 1, heightPt: 1 } }, { type: "image_block", attrs: { asset: `${"a".repeat(32)}.gif`, widthPt: 1, heightPt: 1 } }] }, /invalid rich text/],
    ["unknown attribute", para("a", { color: "000000" }), /Unsupported attribute/],
  ])("refuses an invalid %s", (_name, node, message) => {
    expect(verdict(blockPath, block("prose", doc(node)))).toMatch(message);
  });

  it("accepts pictures, anchored content, text boxes, drawings and breaks", () => {
    const asset = `${"0123456789abcdef".repeat(2)}.jpeg`;
    const shape = { geom: "rect", x: 0, y: 0, w: 10, h: 10, rot: 0, flipH: false, flipV: true, stroke: { color: "000000", widthPt: 1, dash: null }, fill: "FFFFFF", head: null, tail: "arrow", asset: null };
    const v = block("prose", doc(
      { type: "paragraph", content: [{ type: "text", text: "a" }, { type: "hard_break" }, { type: "page_break" }, { type: "image", attrs: { asset, widthPt: 20, heightPt: 10, rot: 90, flipH: true } }] },
      { type: "anchored", attrs: { offsetPt: 10 }, content: [{ type: "image_block", attrs: { asset, widthPt: 20, heightPt: 10 } }] },
      { type: "textbox", attrs: { widthPt: 100, fill: "FFFF00", border: { style: "single", widthPt: 0.5, color: "000000" }, inline: true }, content: [para("box")] },
      { type: "drawing", attrs: { widthPt: 50, heightPt: 50, shapes: [shape] }, content: [{ type: "drawing_text", attrs: { x: 1, y: 1, w: 10, h: 10 }, content: [para("t")] }] },
      para("p", { line: { rule: "exact", value: 12 }, shade: "D9D9D9", borders: { top: null, right: null, bottom: { style: "single", widthPt: 1, color: "000000" }, left: null } }),
    ));
    expect(verdict(blockPath, v)).toBe("ok");
  });

  it("refuses an invalid table, row or cell attribute", () => {
    const t = table(id("r", 1));
    const withRow = (attrs: Record<string, unknown>) => ({ ...t, content: [{ ...t.content[0], attrs: { id: id("r", 1), ...attrs } }] });
    expect(verdict(blockPath, block("table", doc({ ...t, content: [{ ...t.content[0], attrs: { id: "row1" } }] })))).toMatch(/row id/);
    expect(verdict(blockPath, block("table", doc(withRow({ kind: "body" }))))).toMatch(/one of/);
    expect(verdict(blockPath, block("table", doc(withRow({ minHeightPt: "1" }))))).toMatch(/number or null/);
    const cell = (attrs: Record<string, unknown>) => ({ ...t, content: [{ ...t.content[0], content: [{ type: "table_cell", attrs, content: [para("x")] }] }] });
    expect(verdict(blockPath, block("table", doc(cell({ colwidth: [100] }))))).toMatch(/null/);
    expect(verdict(blockPath, block("table", doc(cell({ rowspan: 0 }))))).toMatch(/positive integer/);
    expect(verdict(blockPath, block("table", doc(cell({ borders: { diagonal: null } }))))).toMatch(/unknown side/);
    expect(verdict(blockPath, block("table", doc(cell({ borders: "none" }))))).toMatch(/cell borders/);
    expect(verdict(blockPath, block("table", doc(cell({ borders: { top: null, left: { style: "single", widthPt: 1, color: "000000" } }, vAlign: "center", fill: "FF0000" }))))).toBe("ok");
    expect(verdict(blockPath, block("table", doc({ ...t, attrs: { ...t.attrs, grid: ["1"] } })))).toMatch(/grid/);
  });

  describe("a row's own widths", () => {
    const t = table(id("r", 1), id("r", 2));
    const rowsWith = (first: Record<string, unknown>, second: Record<string, unknown> = {}, firstCell: Record<string, unknown> = {}) => ({
      ...t,
      content: [
        { ...t.content[0], attrs: { id: id("r", 1), ...first }, content: [{ type: "table_cell", attrs: firstCell, content: [para("x")] }, { type: "table_cell", content: [para("y")] }] },
        { ...t.content[1], attrs: { id: id("r", 2), ...second }, content: firstCell.rowspan ? [{ type: "table_cell", content: [para("y")] }] : t.content[1]?.content },
      ],
    });

    it("are stored only when set, and round-trip", () => {
      const text = serializeFile(blockPath, block("table", doc(rowsWith({ widths: [150, 150] }))));
      const stored = JSON.parse(text);
      expect(stored.doc.content[0].content[0].attrs.widths).toEqual([150, 150]);
      expect("widths" in stored.doc.content[0].content[1].attrs).toBe(false);
      expect(() => validateFile(blockPath, stored)).not.toThrow();
    });

    it("must number the grid's columns, each positive", () => {
      expect(verdict(blockPath, block("table", doc(rowsWith({ widths: [100, 100, 100] }))))).toMatch(/has widths for 3 columns; its table has 2/);
      expect(verdict(blockPath, block("table", doc(rowsWith({ widths: [100, 0] }))))).toMatch(/widths/);
      expect(verdict(blockPath, block("table", doc(rowsWith({ widths: "wide" }))))).toMatch(/widths/);
    });

    it("are the same in rows a merged cell joins", () => {
      expect(verdict(blockPath, block("table", doc(rowsWith({ widths: [150, 150] }, {}, { rowspan: 2 }))))).toMatch(/share a merged cell but not their widths/);
      expect(verdict(blockPath, block("table", doc(rowsWith({ widths: [150, 150] }, { widths: [150, 150] }, { rowspan: 2 }))))).toBe("ok");
    });
  });
});

describe("block envelopes (20 §20.4, §20.10)", () => {
  it("holds exactly one table node in a table block, and no table in a prose block", () => {
    expect(verdict(blockPath, block("table", doc(table(id("r", 1)), para("after"))))).toMatch(/exactly one table/);
    expect(verdict(blockPath, block("prose", doc(table(id("r", 1)))))).toMatch(/non-table/);
    expect(verdict(blockPath, block("prose", doc({ type: "heading_line", content: [] })))).toMatch(/non-table/);
  });

  it("requires meta {} on guide blocks and the id of the file name", () => {
    expect(verdict(blockPath, block("prose", doc(para("a")), { meta: { x: 1 } }))).toMatch(/\{\}/);
    expect(verdict(blockPath, { ...block("prose", doc(para("a"))), id: id("b", 2) })).toMatch(/from the file's path/);
    expect(verdict(blockPath, { ...block("prose", doc(para("a"))), extra: true })).toMatch(/no such key/);
    expect(verdict(blockPath, { ...block("prose", doc(para("a"))), v: 2 })).toMatch(/\.v: expected 1/);
  });

  it("accepts guide, preamble, pharm and Word-page blocks at their paths", () => {
    const v = block("prose", doc(para("a")));
    for (const p of [
      `content/guides/fm/_preamble/blocks/${B1}.json`,
      `content/pharm/cardio-med-list-1-1/blocks/${B1}.json`,
      `content/docs/${D1}/blocks/${B1}.json`,
    ]) expect(verdict(p, v)).toBe("ok");
  });

  it("validates slides: a title line, then lead paragraphs and cards", () => {
    const S1 = id("s", 1);
    const path = `content/slides/fm/blocks/${S1}.json`;
    const slide = (d: unknown, meta: Record<string, unknown> = {}) => ({ v: 1, id: S1, kind: "slide", doc: d, meta });
    const title = { type: "heading_line", content: [{ type: "text", text: "Cardiology" }] };
    const card = { type: "slide_card", content: [para("Heading"), para("Body")] };
    expect(verdict(path, slide(doc(title, para("lead"), card), {
      summarizes: [id("r", 1)], evidence: [{ item: "x", row: id("r", 1), quote: "x" }],
      verification: { verifier: "ana-1", at: "2026-10-06", result: "pass", notes: [] }, ownerEdits: ["2026-10-07"],
    }))).toBe("ok");
    expect(verdict(path, slide(doc(para("no title"))))).toMatch(/heading_line followed/);
    expect(verdict(path, slide(doc(title, table(id("r", 1)))))).toMatch(/heading_line followed/);
    expect(verdict(path, slide(doc(title), { summary: [] }))).toMatch(/no such key/);
    expect(verdict(path, { ...slide(doc(title)), id: id("s", 2) })).toMatch(/from the file's path/);
  });
});

describe("her own meds panel for a topic", () => {
  const R1 = id("r", 1);
  const C1 = id("c", 1);
  const C2 = id("c", 2);
  const P1 = id("p", 1);
  const path = `content/guides/fm/cardiovascular/meds/${R1}.json`;
  const rows = { kind: "rows", basePt: 10, title: null, file: null, doc: doc(table(id("r", 5))) };
  const notes = { kind: "notes", basePt: 8, title: "Beta blockers", file: "Cardio med list", doc: doc(para("Metoprolol")) };
  const meds = (extra: Record<string, unknown> = {}) => ({ v: 1, add: [], remove: [], own: [], ...extra });

  it("is routed by its topic's path, beside the topic's below file", () => {
    expect(isContentJSON(path)).toBe(true);
    expect(isContentJSON(`content/guides/fm/cardiovascular/meds/${C1}.json`)).toBe(false);
    expect(BLOCK_FILE_RE.test(path)).toBe(false);
  });

  it("accepts added cards, removed entries of any target kind, and her versions of rows and notes", () => {
    expect(verdict(path, meds({ add: [C1] }))).toBe("ok");
    expect(verdict(path, meds({ remove: [C1, R1, P1] }))).toBe("ok");
    expect(verdict(path, meds({ own: [{ target: C2, pieces: [rows, notes] }, { target: P1, pieces: [] }] }))).toBe("ok");
  });

  it("refuses an empty file: with nothing added, removed or edited there is no file", () => {
    expect(verdict(path, meds())).toMatch(/an added, removed or edited entry/);
  });

  it("refuses a card both added and removed, or listed twice, or two versions of one entry", () => {
    expect(verdict(path, meds({ add: [C1], remove: [C1] }))).toMatch(/\.add\[0\].*a card not also removed/);
    expect(verdict(path, meds({ add: [C1, C1] }))).not.toBe("ok");
    expect(verdict(path, meds({ remove: [R1, R1] }))).not.toBe("ok");
    expect(verdict(path, meds({ own: [{ target: C1, pieces: [notes] }, { target: C1, pieces: [notes] }] }))).toMatch(/\.own\[\]\.target/);
  });

  it("refuses an added row or part (only cards can be added) and a target that is no entry id", () => {
    expect(verdict(path, meds({ add: [R1] }))).toMatch(/\.add\[0\]/);
    expect(verdict(path, meds({ remove: [B1] }))).toMatch(/\.remove\[0\]/);
    expect(verdict(path, meds({ own: [{ target: D1, pieces: [notes] }] }))).toMatch(/\.own\[0\]\.target/);
  });

  it("refuses pieces of the wrong shape: rows that are not one table, a file on rows, a size of 0 (notes may hold a table, as her pharm notes do)", () => {
    const own = (p: Record<string, unknown>) => meds({ own: [{ target: C1, pieces: [p] }] });
    expect(verdict(path, own({ ...rows, doc: doc(para("not a table")) }))).toMatch(/\.own\[0\]\.pieces\[0\]\.doc/);
    expect(verdict(path, own({ ...rows, doc: doc(table(id("r", 5)), para("after")) }))).toMatch(/\.own\[0\]\.pieces\[0\]\.doc/);
    expect(verdict(path, own({ ...notes, doc: doc(table(id("r", 5)), para("Metoprolol")) }))).toBe("ok");
    expect(verdict(path, own({ ...rows, file: "Cardio med list" }))).toMatch(/null on guide rows/);
    expect(verdict(path, own({ ...notes, basePt: 0 }))).toMatch(/a size above 0/);
    expect(verdict(path, own({ ...notes, kind: "card" }))).toMatch(/\.kind/);
    expect(verdict(path, own({ ...notes, extra: 1 }))).toMatch(/no such key/);
  });

  it("normalizes each piece's rich text when written", () => {
    const loose = { ...notes, doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Metoprolol" }] }] } };
    const out = JSON.parse(serializeFile(path, meds({ own: [{ target: C1, pieces: [loose] }] }))) as { own: { pieces: { doc: { content: { attrs?: unknown }[] } }[] }[] };
    expect(out.own[0]?.pieces[0]?.doc.content[0]?.attrs).toBeDefined();
  });
});

describe("documents (20 §20.5)", () => {
  const filePath = `content/files/${D1}/file.json`;
  const pdf = { v: 1, id: D1, name: "ACLS algorithms", kind: "pdf", original: "ACLS.pdf", view: "ACLS.pdf", pages: 20, text: "text.json", removed: null };

  it("accepts imported pdf, image and slides files", () => {
    expect(verdict(filePath, pdf)).toBe("ok");
    expect(verdict(filePath, { v: 1, id: D1, name: "Chart", kind: "image", original: "c.png", view: "c.png", removed: null })).toBe("ok");
    expect(verdict(filePath, { v: 1, id: D1, name: "Deck", kind: "slides", original: "d.pptx", view: "d.pdf", pages: 12, text: "text.json", removed: null })).toBe("ok");
    expect(verdict(filePath, { v: 1, id: D1, name: "Psych deck", kind: "slides", original: "d.pptx", view: null, pages: 40, text: null, removed: null })).toBe("ok");
  });

  it("checks the kind rules of a ready file", () => {
    expect(verdict(filePath, { ...pdf, view: "other.pdf" })).toMatch(/view is the original/);
    expect(verdict(filePath, { ...pdf, kind: "word" })).toMatch(/ready file/);
    expect(verdict(filePath, { v: 1, id: D1, name: "Chart", kind: "image", original: "c.png", view: "c.png", pages: 1, removed: null })).toMatch(/no pages or text/);
    expect(verdict(filePath, { v: 1, id: D1, name: "Deck", kind: "slides", original: "d.pptx", view: "d.pdf", removed: null })).toMatch(/slide count/);
  });

  it("accepts a processing entry only with view, pages and text null, and a failed entry", () => {
    const processing = { v: 1, id: D1, name: "Lipids", kind: "word", original: "Lipids.docx", view: null, pages: null, text: null, removed: null, state: "processing" };
    expect(verdict(filePath, processing)).toBe("ok");
    expect(verdict(filePath, { ...processing, pages: 3 })).toMatch(/all null while processing/);
    expect(verdict(filePath, { ...processing, state: "failed" })).toBe("ok");
    expect(verdict(filePath, { ...processing, state: "done" })).toMatch(/one of/);
  });

  it("refuses a removed object lacking a field, with a non-UTC time or a short sha", () => {
    const from = "0123456789abcdef0123456789abcdef01234567";
    expect(verdict(filePath, { ...pdf, removed: { at: "2026-10-04T02:31:00Z", from } })).toBe("ok");
    expect(verdict(filePath, { ...pdf, removed: { at: "2026-10-04T02:31:00.123Z", from } })).toBe("ok");
    expect(verdict(filePath, { ...pdf, removed: { at: "2026-10-04T02:31:00Z" } })).toMatch(/from: expected a value/);
    expect(verdict(filePath, { ...pdf, removed: { from } })).toMatch(/at: expected a value/);
    expect(verdict(filePath, { ...pdf, removed: { at: "2026-10-04T02:31:00+02:00", from } })).toMatch(/ISO-8601 UTC/);
    expect(verdict(filePath, { ...pdf, removed: { at: "2026-10-04", from } })).toMatch(/ISO-8601 UTC/);
    expect(verdict(filePath, { ...pdf, removed: { at: "2026-02-31T10:00:00Z", from } })).toMatch(/ISO-8601 UTC/);
    expect(verdict(filePath, { ...pdf, removed: { at: "2025-02-29T00:00:00Z", from } })).toMatch(/ISO-8601 UTC/);
    expect(verdict(filePath, { ...pdf, removed: { at: "2024-02-29T00:00:00Z", from } })).toBe("ok");
    expect(verdict(filePath, { ...pdf, removed: { at: "2026-10-04T02:31:00Z", from: from.slice(0, 39) } })).toMatch(/40-hex/);
    expect(verdict(filePath, { ...pdf, removed: { at: "2026-10-04T02:31:00Z", from: from.toUpperCase() } })).toMatch(/40-hex/);
  });

  it("validates a replacing marker, the Word page record and the text record", () => {
    expect(verdict(filePath, { ...pdf, replacing: { fileName: "ACLS 2025.pdf", at: "2026-10-05T10:00:00Z" } })).toBe("ok");
    expect(verdict(filePath, { ...pdf, replacing: { fileName: "ACLS 2025.pdf" } })).toMatch(/at: expected a value/);
    const page = { widthPt: 612, heightPt: 792, margins: { top: 72, right: 72, bottom: 72, left: 72 } };
    const word = { v: 1, id: D1, name: "Vaccine notes", kind: "word", source: "vaccine_notes.docx", page, basePt: 11, blocks: [B1], removed: null };
    expect(verdict(`content/docs/${D1}/doc.json`, word)).toBe("ok");
    expect(verdict(`content/docs/${D1}/doc.json`, { ...word, id: id("d", 2) })).toMatch(/from the file's path/);
    expect(verdict(`content/docs/${D1}/doc.json`, { ...word, blocks: [B1, B1] })).toMatch(/no duplicate/);
    expect(verdict(`content/files/${D1}/text.json`, { pages: ["page 1", "page 2"] })).toBe("ok");
    expect(verdict(`content/files/${D1}/text.json`, { pages: [1] })).toMatch(/a string/);
  });

  it("validates a failed-replacement marker on as-is and Word records", () => {
    const marker = { fileName: "chart2.png", at: "2026-10-04T20:00:00Z" };
    expect(verdict(filePath, { ...pdf, replaceFailed: marker })).toBe("ok");
    expect(verdict(filePath, { ...pdf, replaceFailed: { fileName: "chart2.png" } })).toMatch(/at: expected a value/);
    expect(verdict(filePath, { ...pdf, replaceFailed: { ...marker, fileName: "" } })).toMatch(/fileName/);
    expect(verdict(filePath, { ...pdf, replaceFailed: { ...marker, at: "Oct 4" } })).toMatch(/ISO-8601 UTC/);
    expect(verdict(filePath, { ...pdf, replaceFailed: { ...marker, extra: 1 } })).toMatch(/extra/);
    const page = { widthPt: 612, heightPt: 792, margins: { top: 72, right: 72, bottom: 72, left: 72 } };
    const word = { v: 1, id: D1, name: "Vaccine notes", kind: "word", source: "vaccine_notes.docx", page, basePt: 11, blocks: [B1], removed: null };
    expect(verdict(`content/docs/${D1}/doc.json`, { ...word, replaceFailed: marker })).toBe("ok");
    expect(verdict(`content/docs/${D1}/doc.json`, { ...word, replaceFailed: { at: marker.at } })).toMatch(/fileName: expected a value/);
  });

  it("validates the inbox upload record", () => {
    const up = { v: 1, id: D1, fileName: "Lipids.docx", ext: "docx", size: 1024, sha256: "a".repeat(64), parts: 1, replaces: null };
    expect(verdict(`inbox/${D1}/upload.json`, up)).toBe("ok");
    expect(verdict(`inbox/${D1}/upload.json`, { ...up, replaces: true })).toBe("ok");
    expect(verdict(`inbox/${D1}/upload.json`, { ...up, replaces: false })).toMatch(/null or true/);
    expect(verdict(`inbox/${D1}/upload.json`, { ...up, ext: "txt" })).toMatch(/one of/);
    expect(verdict(`inbox/${D1}/upload.json`, { ...up, id: id("d", 2) })).toMatch(/expected d_0000000001/);
  });
});

describe("gap-fill (20 §20.9)", () => {
  const path = `content/gapfill/${G1}.json`;
  const track = { series: "idsa-cap", label: "IDSA/ATS community-acquired pneumonia guideline", org: "IDSA/ATS", edition: 2019, method: "pubmed", term: "community acquired pneumonia", title: "(\\d{4}) .*Pneumonia" };
  const source = (over: Record<string, unknown> = {}) => ({ name: "CAP guideline", org: "IDSA/ATS", year: "2019", url: "https://example.org", type: "guideline", track, ...over });
  const gap = (sources: unknown[], over: Record<string, unknown> = {}): GapFile => ({
    v: 1, id: G1, kind: "gap", doc: doc(para("Draw lithium 12 h post-dose.")) as GapFile["doc"],
    meta: { title: "Lithium level", relevantTo: "Bipolar I disorder", written: "2026-10", differs: null, sources: sources as GapFile["meta"]["sources"], ownerEdits: [], ...over },
  });

  it("accepts a tracked guideline, an untracked CDC guideline and a reference", () => {
    expect(verdict(path, gap([
      source(),
      source({ org: "CDC", track: null }),
      source({ org: "Advisory Committee on Immunization Practices (ACIP)", track: null }),
      source({ org: "Centers for Disease Control and Prevention", track: null }),
      source({ type: "reference", org: "UpToDate", track: null, url: null }),
      source({ type: "course", org: "EMU", track: null }),
    ], { differs: { doc: doc(para("Your notes say 8 h.")) }, ownerEdits: ["2026-10-07"] }))).toBe("ok");
  });

  it("refuses a non-CDC guideline source with track null, and a tracked CDC or non-guideline source", () => {
    expect(verdict(path, gap([source({ track: null })]))).toMatch(/a track for a non-CDC guideline source/);
    expect(verdict(path, gap([source({ org: "CDC" })]))).toMatch(/only non-CDC guideline sources are tracked/);
    expect(verdict(path, gap([source({ type: "reference" })]))).toMatch(/only non-CDC guideline sources are tracked/);
  });

  it("validates each track method's fields", () => {
    const base = { series: "gold", label: "GOLD report", org: "GOLD", edition: 2025 };
    expect(verdict(path, gap([source({ track: { ...base, method: "fixed", source: "gold" } })]))).toBe("ok");
    expect(verdict(path, gap([source({ track: { ...base, method: "fixed", source: "nice" } })]))).toMatch(/one of/);
    expect(verdict(path, gap([source({ track: { ...base, method: "page", url: "https://goldcopd.org", pattern: "(\\d{4}) GOLD Report" } })]))).toBe("ok");
    expect(verdict(path, gap([source({ track: { ...base, method: "page", url: "https://goldcopd.org", pattern: "(\\d{4}) (\\d{4})" } })]))).toMatch(/exactly one/);
    expect(verdict(path, gap([source({ track: { ...base, method: "page", url: "https://goldcopd.org", pattern: "(\\d{4}" } })]))).toMatch(/valid regular expression/);
    expect(verdict(path, gap([source({ track: { ...base, method: "pubmed", term: "x", title: "(\\d+)" } })]))).toMatch(/exactly one/);
    expect(verdict(path, gap([source({ track: { ...base, method: "none" } })]))).toBe("ok");
    expect(verdict(path, gap([source({ track: { ...base, method: "none", url: "https://x" } })]))).toMatch(/no such key/);
    expect(verdict(path, gap([source({ track: { ...base, method: "rss" } })]))).toMatch(/method/);
    expect(verdict(path, gap([source({ track: "gold" })]))).toMatch(/track object/);
  });

  it("refuses two tracks of one series that differ in anything but the edition", () => {
    const other = { ...track, edition: 2007 };
    expect(verdict(path, gap([source(), source({ track: other })]))).toBe("ok");
    expect(verdict(path, gap([source(), source({ track: { ...track, method: "page", url: "https://x.org", pattern: "(\\d{4})", term: undefined, title: undefined } })]))).toMatch(/no such key|differs/);
    const a = gap([source()]);
    const bGap = { ...gap([source({ track: { ...track, term: "pneumonia" } })]), id: G2 };
    expect(() => checkTrackSeries([a, bGap])).toThrow(/differs from the one in g_0000000001/);
    expect(() => checkTrackSeries([a, { ...bGap, meta: { ...bGap.meta, sources: [source({ track: { ...track, edition: 2026 } })] } } as GapFile])).not.toThrow();
  });

  it("checks the gap envelope, dates and the differs doc", () => {
    expect(verdict(path, gap([], { written: "2026-13" }))).toMatch(/month/);
    expect(verdict(path, gap([], { ownerEdits: ["10/07/2026"] }))).toMatch(/ISO date/);
    expect(verdict(path, gap([], { ownerEdits: ["2026-02-31"] }))).toMatch(/ISO date/);
    expect(verdict(path, gap([], { ownerEdits: ["2026-04-31"] }))).toMatch(/ISO date/);
    expect(verdict(path, gap([], { ownerEdits: ["2026-02-28"] }))).toBe("ok");
    expect(verdict(path, gap([], { differs: { doc: doc({ type: "heading_line", content: [] }) } }))).toMatch(/only block nodes/);
    expect(verdict(path, gap([], { differs: { doc: doc({ type: "paragraph", attrs: { align: "middle" } }) } }))).toMatch(/^content\/gapfill\/g_0000000001\.json: \.meta\.differs\.doc: invalid rich text/);
    expect(verdict(path, gap([], { differs: { doc: doc({ type: "glow" }) } }))).toMatch(/\.meta\.differs\.doc\.content\[0\]: invalid rich text: unknown node type/);
    expect(verdict(path, { ...gap([]), doc: doc({ type: "paragraph", attrs: { align: "middle" } }) })).toMatch(/: \.doc: invalid rich text/);
    expect(verdict(path, { ...gap([]), doc: doc({ type: "slide_card", content: [para("x")] }) })).toMatch(/only block nodes/);
    expect(verdict(path, { ...gap([]), id: G2 })).toMatch(/from the file's path/);
  });

  it("accepts example images with their credit and evidence, and refuses malformed ones", () => {
    const fig = (over: Record<string, unknown> = {}, credit: Record<string, unknown> = {}) => ({
      asset: `${"0f".repeat(16)}.jpg`, width: 1200, height: 400, caption: "Atrial fibrillation",
      credit: { author: "Jane Roe", license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/", page: "https://commons.wikimedia.org/wiki/File:AF.jpg", changes: null, ...credit },
      evidence: { quote: "ECG showing atrial fibrillation", accessed: "2026-10-05" },
      ...over,
    });
    expect(verdict(path, gap([], { figures: [fig(), fig({}, { license: "Public domain", licenseUrl: null, changes: "Cropped" })] }))).toBe("ok");
    expect(verdict(path, gap([], { figures: [] }))).toBe("ok");
    expect(verdict(path, gap([], { figures: [fig({ asset: "assets/x.png" })] }))).toMatch(/\.meta\.figures\[0\]\.asset: expected a stored asset name/);
    expect(verdict(path, gap([], { figures: [fig({ asset: `${"0f".repeat(16)}.svg` })] }))).toMatch(/stored asset name/);
    expect(verdict(path, gap([], { figures: [fig({ width: 0 })] }))).toMatch(/\.width: expected a positive integer/);
    expect(verdict(path, gap([], { figures: [fig({ caption: " " })] }))).toMatch(/\.caption: expected a non-empty string/);
    expect(verdict(path, gap([], { figures: [fig({}, { page: "http://commons.wikimedia.org/wiki/File:AF.jpg" })] }))).toMatch(/\.credit\.page: expected an https URL/);
    expect(verdict(path, gap([], { figures: [fig({}, { changes: "" })] }))).toMatch(/\.credit\.changes: expected a non-empty string/);
    expect(verdict(path, gap([], { figures: [fig({ evidence: { quote: "x", accessed: "2026-10" } })] }))).toMatch(/\.evidence\.accessed: expected an ISO date/);
    expect(verdict(path, gap([], { figures: [fig({ alt: "x" })] }))).toMatch(/no such key/);
  });

  it("accepts an image's shown width up to the box's text width, and refuses others", () => {
    const fig = (widthPt: unknown) => ({
      asset: `${"0f".repeat(16)}.jpg`, width: 1200, height: 400, caption: "Atrial fibrillation",
      credit: { author: "Jane Roe", license: "Public domain", licenseUrl: null, page: "https://commons.wikimedia.org/wiki/File:AF.jpg", changes: null },
      evidence: { quote: "ECG showing atrial fibrillation", accessed: "2026-10-05" },
      widthPt,
    });
    expect(verdict(path, gap([], { figures: [fig(300)] }))).toBe("ok");
    // Wider than a printed page: gap blocks are not printed, so up to what the widest screen frame shows.
    expect(verdict(path, gap([], { figures: [fig(1062)] }))).toBe("ok");
    expect(verdict(path, gap([], { figures: [fig(1100)] }))).toBe("ok");
    for (const w of [0, -5, 1101, "300", null]) {
      expect(verdict(path, gap([], { figures: [fig(w)] })), String(w)).toMatch(/\.meta\.figures\[0\]\.widthPt: expected a width in pt above 0 and at most 1100/);
    }
  });

  it("accepts a squished or stretched image's height up to 2000 pt, only with a width", () => {
    const fig = (size: Record<string, unknown>) => ({
      asset: `${"0f".repeat(16)}.jpg`, width: 1200, height: 400, caption: "Atrial fibrillation",
      credit: { author: "Jane Roe", license: "Public domain", licenseUrl: null, page: "https://commons.wikimedia.org/wiki/File:AF.jpg", changes: null },
      evidence: { quote: "ECG showing atrial fibrillation", accessed: "2026-10-05" },
      ...size,
    });
    expect(verdict(path, gap([], { figures: [fig({ widthPt: 300, heightPt: 400 })] }))).toBe("ok");
    // Taller than a printed page: her tallest figures already show about 1740 pt tall.
    expect(verdict(path, gap([], { figures: [fig({ widthPt: 300, heightPt: 1740 })] }))).toBe("ok");
    expect(verdict(path, gap([], { figures: [fig({ widthPt: 300, heightPt: 2000 })] }))).toBe("ok");
    for (const h of [0, -5, 2001, "300", null]) {
      expect(verdict(path, gap([], { figures: [fig({ widthPt: 300, heightPt: h })] })), String(h)).toMatch(/\.meta\.figures\[0\]\.heightPt: expected a height in pt above 0 and at most 2000/);
    }
    expect(verdict(path, gap([], { figures: [fig({ heightPt: 300 })] }))).toMatch(/\.meta\.figures\[0\]\.heightPt: expected a height only together with a widthPt/);
  });

  it("accepts asNotes only as true (absent means the box stays labeled)", () => {
    expect(verdict(path, gap([], { asNotes: true }))).toBe("ok");
    expect(verdict(path, gap([], { asNotes: false }))).toMatch(/\.meta\.asNotes/);
    expect(verdict(path, gap([], { asNotes: "yes" }))).toMatch(/\.meta\.asNotes/);
  });

  it("names CDC/ACIP organizations", () => {
    expect(isCdcOrg("CDC")).toBe(true);
    expect(isCdcOrg("ACIP")).toBe(true);
    expect(isCdcOrg("Centers for Disease Control and Prevention")).toBe(true);
    expect(isCdcOrg("American Diabetes Association")).toBe(false);
  });

  it("validates the evidence record", () => {
    const ev = {
      v: 1, block: G1, author: "ana-1",
      claims: [{ text: "Draw 12 h post-dose.", source: 0, quote: "12 hours", locator: "section 2.2", accessed: "2026-10-05" }],
      verification: { verifier: "bo-2", at: "2026-10-06", result: "pass", notes: [{ claim: 0, issue: "i", resolution: "r" }] },
    };
    expect(verdict(`content/gapfill/${G1}.evidence.json`, ev)).toBe("ok");
    expect(verdict(`content/gapfill/${G1}.evidence.json`, { ...ev, block: G2 })).toMatch(/from the file's path/);
    expect(verdict(`content/gapfill/${G1}.evidence.json`, { ...ev, verification: { ...ev.verification, result: "ok" } })).toMatch(/one of/);
  });
});

describe("site, guides and systems (20 §20.3, §20.4)", () => {
  const site = {
    v: 1, name: "PA Studying",
    owner: { login: "kaitlyla", id: 337482200, commitName: "kaitlyla", commitEmail: "337482200+kaitlyla@users.noreply.github.com" },
    repo: "kaitlyla/pa-studying", tabs: ["eor", "pance", "labs", "imaging", "ekg", "anatomy", "other"],
    eors: ["em", "fm", "im", "ob", "peds", "psy", "surg"],
    guideNames: { em: "Emergency Medicine", fm: "Family Medicine", im: "Internal Medicine", ob: "OBGYN", peds: "Pediatrics", psy: "Psychiatry", surg: "Surgery", pance: "PANCE / EOC" },
  };
  const page = { widthPt: 792, heightPt: 612, margins: { top: 36, right: 36, bottom: 36, left: 36 } };
  const guide = { v: 1, id: "fm", source: "Family Medicine EOR.docx", page, basePt: 10, preamble: [], systems: [{ id: "cardiovascular", title: "Cardiovascular", pct: "15%" }] };

  it("accepts the planned site.json and refuses an unknown guide", () => {
    expect(verdict("content/site.json", site)).toBe("ok");
    expect(verdict("content/site.json", { ...site, eors: ["fm", "derm"] })).toMatch(/one of/);
    expect(verdict("content/site.json", { ...site, guideNames: { ...site.guideNames, derm: "Derm" } })).toMatch(/one of/);
  });

  it("validates guide.json: id of its directory, unique systems, sidebarEnd only on PANCE", () => {
    expect(verdict("content/guides/fm/guide.json", guide)).toBe("ok");
    expect(verdict("content/guides/im/guide.json", guide)).toMatch(/\.id: expected im \(from the file's path\)/);
    expect(verdict("content/guides/fm/guide.json", { ...guide, systems: [...guide.systems, ...guide.systems] })).toMatch(/no duplicate/);
    expect(verdict("content/guides/fm/guide.json", { ...guide, sidebarEnd: D1 })).toMatch(/PANCE/);
    expect(verdict("content/guides/pance/guide.json", { ...guide, id: "pance", sidebarEnd: D1 })).toBe("ok");
  });

  it("validates system.json against its directory", () => {
    expect(verdict("content/guides/fm/cardiovascular/system.json", { v: 1, id: "cardiovascular", blocks: [B1] })).toBe("ok");
    expect(verdict("content/guides/fm/cardiovascular/system.json", { v: 1, id: "renal", blocks: [B1] })).toMatch(/\.id: expected cardiovascular \(from the file's path\)/);
    expect(verdict("content/guides/fm/cardiovascular/system.json", { v: 1, id: "cardiovascular", blocks: ["b1"] })).toMatch(/b_ id/);
  });
});

describe("pharm (20 §20.6, §20.7)", () => {
  const [b1, b2, b3] = [id("b", 1), id("b", 2), id("b", 3)];
  const C1 = id("c", 1);
  const path = "content/pharm/cardio-med-list-1-1/pharmfile.json";
  const pf = (parts: unknown[], blocks = [b1, b2, b3]) => ({ v: 1, id: "cardio-med-list-1-1", fileName: "cardio med list 1 (1)", basePt: 11, blocks, parts });
  const part = (n: number, role: string, blocks: string[], card: string | null = null) => ({ id: id("p", n), role, title: "T", card, blocks });

  it("accepts parts that slice the blocks contiguously, in order, exactly once", () => {
    expect(verdict(path, pf([part(1, "overview", [b1]), part(2, "card", [b2], C1), part(3, "lo", [b3])]))).toBe("ok");
  });

  it.each([
    ["a gap", [part(1, "overview", [b1]), part(2, "card", [b3], C1)], /next block/],
    ["an uncovered tail", [part(1, "overview", [b1]), part(2, "card", [b2], C1)], /every block exactly once/],
    ["out of order", [part(1, "card", [b2], C1), part(2, "lo", [b1, b3])], /next block/],
    ["a card part without a card", [part(1, "card", [b1, b2, b3])], /card id exactly/],
    ["an lo part with a card", [part(1, "lo", [b1, b2, b3], C1)], /card id exactly/],
    ["an overview after the start", [part(1, "lo", [b1]), part(2, "overview", [b2, b3])], /overview only as the first/],
    ["an empty part", [part(1, "lo", []), part(2, "lo", [b1, b2, b3])], /non-empty slice/],
    ["a repeated part id", [part(1, "lo", [b1]), part(1, "lo", [b2, b3])], /no duplicate/],
  ])("refuses parts with %s", (_name, parts, message) => {
    expect(verdict(path, pf(parts))).toMatch(message);
  });

  it("requires the file slug as id", () => {
    expect(verdict(path, { ...pf([part(1, "lo", [b1, b2, b3])]), id: "cardio" })).toMatch(/\.id: expected cardio-med-list-1-1 \(from the file's path\)/);
  });

  describe("parts that cut one block (rows or a column)", () => {
    const [r1, r2, r3] = [id("r", 1), id("r", 2), id("r", 3)];
    const C2 = id("c", 2);
    const rowsPart = (n: number, card: string, rows: string[], block = b2) => ({ ...part(n, "card", [block], card), rows });
    const colPart = (n: number, card: string, column: number, block = b2) => ({ ...part(n, "card", [block], card), column });

    it("accepts a block cut by consecutive parts taking disjoint rows, or disjoint columns, between whole parts", () => {
      expect(verdict(path, pf([part(1, "overview", [b1]), rowsPart(2, C1, [r1, r2]), rowsPart(3, C2, [r3]), part(4, "lo", [b3])]))).toBe("ok");
      expect(verdict(path, pf([part(1, "overview", [b1]), colPart(2, C1, 1), colPart(3, C2, 2), part(4, "lo", [b3])]))).toBe("ok");
    });

    it("accepts row parts of one group sharing its heading rows, listed first in each", () => {
      const [h0, h1] = [id("r", 10), id("r", 11)];
      expect(verdict(path, pf([part(1, "overview", [b1]), rowsPart(2, C1, [h1, r1]), rowsPart(3, C2, [h1, r2, r3]), part(4, "lo", [b3])]))).toBe("ok");
      expect(verdict(path, pf([part(1, "overview", [b1]), rowsPart(2, C1, [h0, h1, r1]), rowsPart(3, C2, [h0, h1, r2]), part(4, "lo", [b3])]))).toBe("ok");
    });

    it("accepts the page a doc-backed file is made from", () => {
      expect(verdict(path, { ...pf([part(1, "overview", [b1, b2, b3])]), page: id("d", 1) })).toBe("ok");
      expect(verdict(path, { ...pf([part(1, "overview", [b1, b2, b3])]), page: "pharm review" })).toMatch(/\.page: expected a d_ id/);
    });

    it.each([
      ["overlapping rows", [part(1, "overview", [b1]), rowsPart(2, C1, [r1, r2]), rowsPart(3, C2, [r2]), part(4, "lo", [b3])], /\.parts\[1\]: expected rows shared with another part on b_\w+ listed before the part's own rows/],
      ["a part listing only rows other parts list", [part(1, "overview", [b1]), rowsPart(2, C1, [r1, r2]), rowsPart(3, C2, [r1]), part(4, "lo", [b3])], /\.parts\[2\]: expected rows of the part's own besides those shared/],
      ["a shared row after a part's own", [part(1, "overview", [b1]), rowsPart(2, C1, [r1, r3]), rowsPart(3, C2, [r3, r2]), part(4, "lo", [b3])], /\.parts\[1\]: expected rows shared with another part/],
      ["the same column twice", [part(1, "overview", [b1]), colPart(2, C1, 1), colPart(3, C2, 1), part(4, "lo", [b3])], /\.parts\[1\]: expected a column no other part on b_\w+ takes/],
      ["rows and a column on one block", [part(1, "overview", [b1]), rowsPart(2, C1, [r1]), colPart(3, C2, 2), part(4, "lo", [b3])], /\.parts\[2\]: expected rows like the parts before it/],
      ["a cut part of two blocks", [part(1, "overview", [b1]), { ...rowsPart(2, C1, [r1]), blocks: [b2, b3] }], /\.parts\[1\]\.blocks: expected one block when the part has a column or rows/],
      ["both rows and a column", [part(1, "overview", [b1]), { ...rowsPart(2, C1, [r1]), column: 1 }, part(3, "lo", [b3])], /\.parts\[1\]: expected column or rows, not both/],
      ["no rows", [part(1, "overview", [b1]), rowsPart(2, C1, []), part(3, "lo", [b3])], /\.parts\[1\]\.rows: expected at least one row id/],
      ["a column 0", [part(1, "overview", [b1]), colPart(2, C1, 0), part(3, "lo", [b3])], /\.parts\[1\]\.column: expected a column number/],
      ["a cut of a block that is not next", [part(1, "overview", [b1]), rowsPart(2, C1, [r1], b3)], /\.parts\[1\]\.blocks\[0\]: expected the next block of the file/],
      ["a cut block taken again whole", [part(1, "overview", [b1]), rowsPart(2, C1, [r1]), part(3, "lo", [b2, b3])], /\.parts\[2\]\.blocks\[0\]: expected the next block of the file/],
    ])("refuses %s", (_name, parts, message) => {
      expect(verdict(path, pf(parts))).toMatch(message);
    });

    describe("topic parts (shown on the meds panels of named guide topics)", () => {
      const [h, T1] = [id("r", 10), id("r", 20)];
      const topicPart = (n: number, cut: { rows?: string[]; column?: number; label?: number }, topics: unknown = [T1]) =>
        ({ ...part(n, "topic", [b2]), ...cut, topics });
      const around = (...cuts: unknown[]) => pf([part(1, "overview", [b1]), ...cuts, part(9, "lo", [b3])]);

      it("accepts a topic part whole, by rows sharing a card's heading row, or by rows and one column of them", () => {
        expect(verdict(path, pf([part(1, "overview", [b1]), { ...part(2, "topic", [b2, b3]), topics: [T1] }]))).toBe("ok");
        expect(verdict(path, around(rowsPart(2, C1, [h, r1]), topicPart(3, { rows: [h, r2] })))).toBe("ok");
        expect(verdict(path, around(topicPart(2, { rows: [h, r1], column: 1 }), topicPart(3, { rows: [h, r1], column: 2 }), topicPart(4, { rows: [h, r2], column: 3, label: 2 })))).toBe("ok");
        // A card part showing the whole heading row shares it with a topic part cutting a column of it.
        expect(verdict(path, around(rowsPart(2, C1, [h, r1]), topicPart(3, { rows: [h, r2], column: 1 })))).toBe("ok");
      });

      it("accepts a card part written for some conditions (`diseases`)", () => {
        expect(verdict(path, around({ ...rowsPart(2, C1, [r1]), diseases: ["Tourette syndrome", "tic disorder"] }))).toBe("ok");
      });

      it.each([
        ["topics on a card part", [{ ...rowsPart(2, C1, [r1]), topics: [T1] }], /\.parts\[1\]\.topics: expected topics exactly when role is topic/],
        ["a topic part without topics", [{ ...part(2, "topic", [b2]), rows: [r1] }], /\.parts\[1\]\.topics: expected topics exactly when role is topic/],
        ["a topic part with no topic", [topicPart(2, { rows: [r1] }, [])], /\.parts\[1\]\.topics: expected at least one topic id/],
        ["a topic id that is not a row id", [topicPart(2, { rows: [r1] }, ["Myasthenia"])], /\.parts\[1\]\.topics\[0\]: expected an? r_/],
        ["a topic part with a card", [{ ...topicPart(2, { rows: [r1] }), card: C1 }], /\.parts\[1\]\.card: expected a card id exactly when role is card/],
        ["a label on a card part", [{ ...colPart(2, C1, 2), label: 1 }], /\.parts\[1\]\.label: expected a column left of `column`, only on a topic part/],
        ["a label on a topic part with no column", [topicPart(2, { rows: [r1], label: 0 })], /\.parts\[1\]\.label: expected a column left of `column`/],
        ["a label not left of the column", [topicPart(2, { rows: [r1], column: 2, label: 2 })], /\.parts\[1\]\.label: expected a column left of `column`/],
        ["two topic parts showing the same column of the same rows", [topicPart(2, { rows: [h, r1], column: 1 }), topicPart(3, { rows: [h, r1], column: 1 })], /\.parts\[1\]: expected rows of the part's own besides those shared/],
        ["a whole row part covering a topic part's cell", [rowsPart(2, C1, [h, r1]), topicPart(3, { rows: [h, r1], column: 1 })], /\.parts\[1\]: expected rows of the part's own besides those shared/],
        ["a topic part's column after a column run", [colPart(2, C1, 1), topicPart(3, { rows: [r1], column: 2 })], /\.parts\[2\]: expected column like the parts before it/],
        ["diseases on a part that is not a card part", [{ ...topicPart(2, { rows: [r1] }), diseases: ["Tourette syndrome"] }], /\.parts\[1\]\.diseases: expected diseases only on a card part/],
        ["an empty disease on a card part", [{ ...rowsPart(2, C1, [r1]), diseases: [" "] }], /\.parts\[1\]\.diseases\[0\]/],
      ])("refuses %s", (_name, cuts, message) => {
        expect(verdict(path, around(...cuts))).toMatch(message);
      });
    });

    describe("card and lo parts cutting rows to a range of columns (classes set side by side)", () => {
      const h = id("r", 10);
      const rangePart = (n: number, card: string | null, rows: string[], column: number, columns: number) =>
        ({ ...part(n, card === null ? "lo" : "card", [b2], card), rows, column, columns });
      const around = (...cuts: unknown[]) => pf([part(1, "overview", [b1]), ...cuts, part(9, "lo", [b3])]);

      it("accepts parts sharing a heading row and a list row in disjoint column ranges, from column 0, beside whole-row parts", () => {
        expect(verdict(path, around(rangePart(2, C1, [h, r1], 0, 2), rangePart(3, C2, [h, r1], 2, 2)))).toBe("ok");
        expect(verdict(path, around(rangePart(2, C1, [h, r1], 0, 1), rangePart(3, null, [h, r1], 1, 1), rowsPart(4, C2, [r2])))).toBe("ok");
      });

      it.each([
        ["overlapping column ranges of the same rows", [rangePart(2, C1, [h, r1], 0, 2), rangePart(3, C2, [h, r1], 1, 2)], /\.parts\[1\]: expected rows of the part's own besides those shared/],
        ["a range on a topic part", [{ ...rangePart(2, null, [h, r1], 0, 2), role: "topic", topics: [id("r", 20)] }], /\.parts\[1\]\.columns: expected a column count with `column` and `rows`, only on a card or lo part/],
        ["a range without rows", [{ ...colPart(2, C1, 1), columns: 2 }], /\.parts\[1\]\.columns: expected a column count with `column` and `rows`/],
        ["a range without a column", [{ ...rowsPart(2, C1, [r1]), columns: 2 }], /\.parts\[1\]\.columns: expected a column count with `column` and `rows`/],
        ["a range of no columns", [rangePart(2, C1, [h, r1], 0, 0)], /\.parts\[1\]\.columns: expected a column number \(1 or more\)/],
        ["a topic part's column 0", [{ ...part(2, "topic", [b2]), rows: [r1], column: 0, topics: [id("r", 20)] }], /\.parts\[1\]\.column: expected a column number \(1 or more\)/],
      ])("refuses %s", (_name, cuts, message) => {
        expect(verdict(path, around(...cuts))).toMatch(message);
      });
    });
  });

  it("validates cards.json", () => {
    const cards = { v: 1, cards: [{ id: C1, file: "cardio-med-list-1-1", aliases: ["CCB", "amlodipine"], home: { fm: "cardiovascular", pance: "cardiovascular" } }] };
    expect(verdict("content/pharm/cards.json", cards)).toBe("ok");
    expect(verdict("content/pharm/cards.json", { v: 1, cards: [...cards.cards, ...cards.cards] })).toMatch(/no duplicate/);
    expect(verdict("content/pharm/cards.json", { v: 1, cards: [{ ...cards.cards[0], home: { xx: "a" } }] })).toMatch(/one of/);
  });

  it("accepts a card's class words and refuses an empty one", () => {
    const card = { id: C1, file: "cardio-med-list-1-1", aliases: ["Loop Diuretics"], home: {} };
    expect(verdict("content/pharm/cards.json", { v: 1, cards: [{ ...card, classWords: ["diuretics", "diuretic"] }] })).toBe("ok");
    expect(verdict("content/pharm/cards.json", { v: 1, cards: [{ ...card, classWords: [""] }] })).toMatch(/classWords\[0\]/);
  });

  it("accepts a card's diseases and refuses an empty one", () => {
    const card = { id: C1, file: "neuro-med-list-1", aliases: ["DMTs"], home: {} };
    expect(verdict("content/pharm/cards.json", { v: 1, cards: [{ ...card, diseases: ["multiple sclerosis"] }] })).toBe("ok");
    expect(verdict("content/pharm/cards.json", { v: 1, cards: [{ ...card, diseases: ["multiple sclerosis", " "] }] })).toMatch(/diseases\[1\]/);
  });

  it("accepts a class card's notDiseases, refusing an empty one and one on a card shown inside another", () => {
    const card = { id: C1, file: "cardio-med-list-1-1", aliases: ["Potassium Sparing Diuretics"], home: {} };
    const member = { id: id("c", 2), file: "pharm-review", aliases: [], home: {}, in: C1 };
    expect(verdict("content/pharm/cards.json", { v: 1, cards: [{ ...card, notDiseases: ["acne", "PCOS"] }, member] })).toBe("ok");
    expect(verdict("content/pharm/cards.json", { v: 1, cards: [{ ...card, notDiseases: [""] }] })).toMatch(/notDiseases\[0\]/);
    expect(verdict("content/pharm/cards.json", { v: 1, cards: [card, { ...member, notDiseases: ["acne"] }] })).toMatch(/\.cards\[1\]\.notDiseases: expected notDiseases only on a class card/);
  });

  describe("a card shown inside another card's class (in)", () => {
    const [C2, C3] = [id("c", 2), id("c", 3)];
    const card = (cid: string, inId?: string) => ({ id: cid, file: "cardio-med-list-1-1", aliases: [], home: {}, ...(inId ? { in: inId } : {}) });
    const v = (...cs: unknown[]) => verdict("content/pharm/cards.json", { v: 1, cards: cs });

    it("accepts members naming a class card", () => {
      expect(v(card(C1), card(C2, C1), card(C3, C1))).toBe("ok");
    });

    it.each([
      ["an unknown card", [card(C1), card(C2, C3)]],
      ["itself", [card(C1, C1)]],
      ["a card that is itself in another", [card(C1), card(C2, C1), card(C3, C2)]],
    ])("refuses in naming %s", (_name, cs) => {
      expect(v(...cs)).toMatch(/\.in: expected another card that is itself in no card/);
    });

    it("refuses an in that is not a card id", () => {
      expect(v(card(C1), { ...card(C2), in: "x" })).not.toBe("ok");
    });

    it("accepts a card's `for`: pharm sections, at least one, none twice", () => {
      expect(v(card(C1), { ...card(C2, C1), for: ["antiarrhythmics"] })).toBe("ok");
      expect(v({ ...card(C1), for: [] })).toMatch(/\.cards\[0\]\.for: expected at least one pharm section/);
      expect(v({ ...card(C1), for: ["antianginals", "antianginals"] })).toMatch(/\.cards\[0\]\.for/);
      expect(v({ ...card(C1), for: ["Not A Slug"] })).not.toBe("ok");
    });
  });

  describe("uses.json", () => {
    const path = "content/pharm/uses.json";
    const line = { block: b1, text: "Effort induced angina", for: ["antianginals"] };
    const cond = { guide: "fm", system: "cardiovascular", section: "coronary-artery-disease", for: ["antianginals", "hyperlipidemia"] };
    const uses = { v: 1, lines: [line], conditions: [cond, { guide: "psy", system: "anxiety-disorders", section: null, for: [] }] };

    it("accepts line uses and condition sections, a system without sections under null, and a section no pharm section treats", () => {
      expect(verdict(path, uses)).toBe("ok");
      expect(verdict(path, { v: 1, lines: [], conditions: [] })).toBe("ok");
    });

    it("refuses a line judged twice, or written for no section", () => {
      expect(verdict(path, { ...uses, lines: [line, line] })).toMatch(/one judgment per block line/);
      expect(verdict(path, { ...uses, lines: [{ ...line, for: [] }] })).toMatch(/\.lines\[0\]\.for: expected at least one pharm section/);
    });

    it("refuses a condition section listed twice or naming a pharm section twice", () => {
      expect(verdict(path, { ...uses, conditions: [cond, cond] })).toMatch(/one entry per condition section/);
      expect(verdict(path, { ...uses, conditions: [{ ...cond, for: ["antianginals", "antianginals"] }] })).toMatch(/\.conditions\[0\]\.for/);
      expect(verdict(path, { ...uses, conditions: [{ ...cond, guide: "xx" }] })).not.toBe("ok");
    });
  });

  it("validates trims.json", () => {
    const path = "content/pharm/trims.json";
    const r = id("r", 1);
    const covered = { block: b1, text: "Brady, hypotension", label: false, rows: [r] };
    const label = { block: b1, text: "Adverse Effects:", label: true, rows: [] };
    const trims = { v: 1, rows: { [r]: "Beta Blockers | ADRs: ↓ HR/BP" }, lines: [covered, label] };
    expect(verdict(path, trims)).toBe("ok");
    expect(verdict(path, { ...trims, lines: [{ ...covered, rows: [] }] })).toMatch(/no rows exactly when the line is a label/);
    expect(verdict(path, { ...trims, lines: [{ ...label, rows: [r] }] })).toMatch(/no rows exactly when the line is a label/);
    expect(verdict(path, { ...trims, lines: [{ ...covered, rows: [id("r", 2)] }] })).toMatch(/rows recorded in \.rows/);
    expect(verdict(path, { ...trims, lines: [covered, covered] })).toMatch(/one judgment per block line/);
  });

  const R1 = id("r", 1);
  const structure = {
    v: 1,
    sections: [{ id: "coronary-artery-disease", title: "Coronary artery disease" }, { id: "other", title: "Cardiovascular — other" }],
    members: { [R1]: "coronary-artery-disease", [b1]: "other" },
    listed: { [b1]: "Murmurs" },
    drugTables: [{ block: b2, pharmSection: "antianginals", conditionRows: [id("r", 2)] }],
    pharmSections: [{ id: "antianginals", title: "Antianginals", tables: [b2], overview: id("p", 1), lo: null, also: [C1] }],
    pharmFiles: [D1],
  };
  const sPath = "content/guides/fm/cardiovascular/structure.json";

  it("accepts a curated structure.json and the pre-curation empty form", () => {
    expect(verdict(sPath, structure)).toBe("ok");
    expect(verdict(sPath, { v: 1, sections: [], members: {}, listed: {}, drugTables: [], pharmSections: [], pharmFiles: [] })).toBe("ok");
  });

  it("accepts a row recorded under a topic (ruling 04:44Z), with or without sections", () => {
    const R3 = id("r", 3);
    expect(verdict(sPath, { ...structure, members: { ...structure.members, [R3]: R1 } })).toBe("ok");
    expect(verdict(sPath, { ...structure, sections: [], members: { [R3]: R1 } })).toBe("ok");
  });

  it("accepts a block recorded under a listed block (a run listed as one entry), with or without sections", () => {
    const b3 = id("b", 3);
    expect(verdict(sPath, { ...structure, members: { ...structure.members, [b3]: b1 } })).toBe("ok");
    expect(verdict(sPath, { ...structure, sections: [], members: { [b3]: b1 } })).toBe("ok");
  });

  it("accepts titled rows naming a heading cell (rulings 21:02Z/22:01Z), and the field's absence", () => {
    expect(verdict(sPath, { ...structure, titled: { [R1]: 0, [id("r", 3)]: 1 } })).toBe("ok");
    expect(verdict(sPath, { ...structure, titled: {} })).toBe("ok");
  });

  it("accepts a titled row given its title as text (ruling 2026-10-06)", () => {
    expect(verdict(sPath, { ...structure, titled: { [R1]: "Contraceptive Methods – Hormonal", [id("r", 3)]: 1 } })).toBe("ok");
  });

  it("accepts unlisted rows (ruling 2026-10-06)", () => {
    expect(verdict(sPath, { ...structure, unlisted: [R1, id("r", 3)] })).toBe("ok");
    expect(verdict(sPath, { ...structure, unlisted: [] })).toBe("ok");
  });

  it("accepts a drug table written only for some conditions (`onlyFor`)", () => {
    expect(verdict(sPath, { ...structure, drugTables: [{ ...structure.drugTables[0], onlyFor: ["gout"] }] })).toBe("ok");
  });

  it.each([
    ["an empty onlyFor condition", { drugTables: [{ ...structure.drugTables[0], onlyFor: [""] }] }, /onlyFor\[0\]/],
    ["an onlyFor condition listed twice", { drugTables: [{ ...structure.drugTables[0], onlyFor: ["gout", "gout"] }] }, /onlyFor.*no duplicate/],
    ["onlyFor given as text", { drugTables: [{ ...structure.drugTables[0], onlyFor: "gout" }] }, /onlyFor/],
    ["other not last", { sections: [...structure.sections].reverse() }, /"other" last/],
    ["section members without sections", { sections: [] }, /a topic id \(sections is \[\]\)/],
    ["a block recorded under a topic", { members: { ...structure.members, [b1]: R1 } }, /a topic id only on another row/],
    ["a row recorded under itself", { members: { [R1]: R1 } }, /a topic id only on another row/],
    ["a row recorded under a listed block", { members: { ...structure.members, [R1]: b1 } }, /\.members\.r_\w+: expected a listed block id only on another, unlisted block/],
    ["a block recorded under an unlisted block", { members: { ...structure.members, [id("b", 3)]: b2 } }, /\.members\.b_\w+: expected a listed block id only on another, unlisted block/],
    ["a listed block recorded under another listed block", { listed: { [b1]: "Murmurs", [b2]: "Angina" }, members: { ...structure.members, [b2]: b1 } }, /\.members\.b_\w+: expected a listed block id only on another, unlisted block/],
    ["a member in an unknown section", { members: { [R1]: "valvular" } }, /section id of this system/],
    ["a member key that is not a row or block", { members: { [D1]: "other" } }, /a r_ or b_ id/],
    ["a drug table in an unknown pharm section", { drugTables: [{ block: b2, pharmSection: "diuretics", conditionRows: [] }] }, /pharm section id/],
    ["a drug table listed twice", { drugTables: [structure.drugTables[0], structure.drugTables[0]] }, /no duplicate/],
    ["duplicate section ids", { sections: [structure.sections[0], structure.sections[0]] }, /no duplicate/],
    ["duplicate pharm section ids", { pharmSections: [structure.pharmSections[0], structure.pharmSections[0]] }, /no duplicate/],
    ["a titled block", { titled: { [b1]: 0 } }, /\.titled\{b_.*a r_ id/],
    ["a negative titled cell", { titled: { [R1]: -1 } }, /\.titled\.r_.*a heading cell index or a non-empty title/],
    ["a fractional titled cell", { titled: { [R1]: 1.5 } }, /a heading cell index or a non-empty title/],
    ["an empty titled title", { titled: { [R1]: "" } }, /a heading cell index or a non-empty title/],
    ["a blank titled title", { titled: { [R1]: "  " } }, /a heading cell index or a non-empty title/],
    ["titled as a list", { titled: [R1] }, /\.titled.*an object/],
    ["an unlisted block", { unlisted: [b1] }, /\.unlisted.*a r_ id/],
    ["an unlisted row listed twice", { unlisted: [R1, R1] }, /no duplicate/],
    ["unlisted as a record", { unlisted: { [R1]: true } }, /\.unlisted.*an array/],
    ["a row both titled and unlisted", { titled: { [R1]: 0 }, unlisted: [R1] }, /\.unlisted.*rows that are not also titled/],
  ])("refuses %s", (_name, over, message) => {
    expect(verdict(sPath, { ...structure, ...over })).toMatch(message);
  });
});

describe("places (20 §20.8)", () => {
  const otherSections = ["emergency", "vaccines", "guidelines", "screenings", "legal", "pa", "vitamins", "pe", "notes"]
    .map((sid) => ({ id: sid, title: sid, lead: null as string | null, files: [] as string[], links: [] as unknown[] }));
  const other = (f: (s: (typeof otherSections)[number]) => Record<string, unknown> = (s) => s) => ({ v: 1, sections: otherSections.map(f) });

  it("accepts gaps on screenings, legal, PA professional, physical exam and documentation and a lead on vaccines", () => {
    expect(verdict("content/places/other.json", other((s) => (
      s.id === "legal" || s.id === "screenings" || s.id === "pa" || s.id === "pe" || s.id === "notes" ? { ...s, gaps: [G1] } : s.id === "vaccines" ? { ...s, lead: G2 } : s
    )))).toBe("ok");
  });

  it("refuses a gaps key on any other section", () => {
    expect(verdict("content/places/other.json", other((s) => (s.id === "vaccines" ? { ...s, gaps: [] } : s)))).toMatch(/no gaps key outside screenings, legal, pa, pe, notes/);
  });

  it("refuses a lead outside vaccines, and sections out of the signed order", () => {
    expect(verdict("content/places/other.json", other((s) => (s.id === "legal" ? { ...s, lead: G1 } : s)))).toMatch(/null outside vaccines/);
    expect(verdict("content/places/other.json", { v: 1, sections: [...otherSections].reverse() })).toMatch(/9 sections in order/);
  });

  const general = {
    v: 1,
    topics: [
      { key: "labs", howto: "labs", links: [{ target: id("r", 1), covers: "Lithium level — Bipolar I disorder" }], files: [D1], gaps: [G1] },
      { key: "workup", howto: null, links: [], files: [], gaps: [] },
    ],
    workup: [
      { id: "ams", title: "Altered mental status (AMS)", conds: "Delirium", gap: G1 },
      { id: "si", title: "suicidal ideation", conds: "MDD", gap: G2 },
    ],
  };

  it("validates general.json: key order, alphabetical workup, EOR guides only", () => {
    expect(verdict("content/guides/psy/general.json", general)).toBe("ok");
    expect(verdict("content/guides/psy/general.json", { ...general, topics: [...general.topics].reverse() })).toMatch(/in the order/);
    expect(verdict("content/guides/psy/general.json", { ...general, topics: [general.topics[0], general.topics[0]] })).toMatch(/in the order/);
    expect(verdict("content/guides/psy/general.json", { ...general, workup: [...general.workup].reverse() })).toMatch(/alphabetical/);
    expect(verdict("content/guides/psy/general.json", { ...general, topics: [{ ...general.topics[0], links: [{ target: D1, covers: "x" }] }] })).toMatch(/a r_ or b_ id/);
    expect(verdict("content/guides/pance/general.json", general)).toMatch(/no general\.json/);
  });

  it("validates well-child visits: a visits topic exactly when there are visits, unique ids, row/block links", () => {
    const visitsTopic = { key: "visits", howto: null, links: [], files: [], gaps: [] };
    const visit = (vid: string) => ({ id: vid, title: "2 months", links: [{ target: id("r", 1), covers: "Vaccine: DTaP" }], gaps: [G1, G2] });
    const withVisits = { ...general, topics: [...general.topics, visitsTopic], visits: [visit("newborn"), visit("2-months")] };
    const at = "content/guides/psy/general.json";
    expect(verdict(at, withVisits)).toBe("ok");
    expect(verdict(at, { ...withVisits, visits: [] })).toMatch(/a visits topic exactly when visits is non-empty/);
    expect(verdict(at, { ...general, visits: [visit("newborn")] })).toMatch(/a visits topic exactly when visits is non-empty/);
    expect(verdict(at, { ...withVisits, visits: [visit("newborn"), visit("newborn")] })).toMatch(/visits\[\]\.id/);
    expect(verdict(at, { ...withVisits, visits: [{ ...visit("newborn"), gaps: [G1, G1] }] })).toMatch(/visits\[0\]\.gaps/);
    expect(verdict(at, { ...withVisits, visits: [{ ...visit("newborn"), links: [{ target: D1, covers: "x" }] }] })).toMatch(/a r_ or b_ id/);
    expect(verdict(at, { ...withVisits, visits: [{ ...visit("Newborn") }] })).toMatch(/visits\[0\]\.id/);
    // Initial workup follows the same rule: its topic exactly when it has items.
    expect(verdict(at, { ...general, topics: [general.topics[0]] })).toMatch(/a workup topic exactly when workup is non-empty/);
    expect(verdict(at, { ...general, workup: [] })).toMatch(/a workup topic exactly when workup is non-empty/);
    expect(verdict(at, { ...general, topics: [general.topics[0]], workup: [] })).toBe("ok");
    // The visits topic sits last, after screenings.
    expect(verdict(at, { ...withVisits, topics: [visitsTopic, ...general.topics] })).toMatch(/in the order/);
  });

  it("validates reftabs.json", () => {
    const tab = { subs: [{ id: "cbc", title: "CBC", links: [], gaps: [G1] }], files: [D1] };
    expect(verdict("content/places/reftabs.json", { v: 1, labs: tab, imaging: tab, ekg: tab, anatomy: tab })).toBe("ok");
    expect(verdict("content/places/reftabs.json", { v: 1, labs: tab, imaging: tab, ekg: tab })).toMatch(/anatomy/);
  });

  it("validates a reftab link's section: `gap` must be one of its own sub's gaps", () => {
    const withLink = (gap: string) => ({ subs: [{ id: "cbc", title: "CBC", links: [{ target: id("r", 1), covers: "x", gap }], gaps: [G1] }], files: [] });
    const empty = { subs: [], files: [] };
    expect(verdict("content/places/reftabs.json", { v: 1, labs: withLink(G1), imaging: empty, ekg: empty, anatomy: empty })).toBe("ok");
    expect(verdict("content/places/reftabs.json", { v: 1, labs: withLink(id("g", 2)), imaging: empty, ekg: empty, anatomy: empty })).toMatch(/links\[0\]\.gap: expected one of this sub's gaps/);
    expect(verdict("content/places/reftabs.json", { v: 1, labs: withLink(D1), imaging: empty, ekg: empty, anatomy: empty })).toMatch(/a g_ id/);
  });

  it("validates a reftab sub's group and intro: intro ids are its own gaps, a group's subs are consecutive", () => {
    const G2 = id("g", 2);
    const sub = (sid: string, extra: Record<string, unknown>) => ({ id: sid, title: sid, links: [], gaps: [G1, G2], ...extra });
    const empty = { subs: [], files: [] };
    const imaging = (...subs: unknown[]) => verdict("content/places/reftabs.json", { v: 1, labs: empty, imaging: { subs, files: [] }, ekg: empty, anatomy: empty });
    expect(imaging(sub("pick", { intro: [] }), sub("chest", { group: "X-ray", intro: [G1] }), sub("abd", { group: "X-ray" }), sub("head", { group: "CT", intro: [G2, G1] }))).toBe("ok");
    expect(imaging(sub("chest", { intro: [id("g", 3)] }))).toMatch(/subs\[0\]\.intro\[0\]: expected one of this sub's gaps/);
    expect(imaging(sub("chest", { intro: [G1, G1] }))).toMatch(/intro/);
    expect(imaging(sub("chest", { group: "" }))).toMatch(/group/);
    expect(imaging(sub("chest", { group: "X-ray" }), sub("head", { group: "CT" }), sub("abd", { group: "X-ray" }))).toMatch(/subs\[2\]\.group: expected a group's subs next to each other/);
    expect(imaging(sub("chest", { group: "X-ray" }), sub("pick", {}), sub("abd", { group: "X-ray" }))).toMatch(/subs\[2\]\.group/);
  });

  it("validates a place's notes: headings, and her Word-page blocks with an optional column of 1 or more", () => {
    const withNotes = (notes: unknown) => ({ subs: [{ id: "cbc", title: "CBC", notes, links: [], gaps: [] }], files: [] });
    const empty = { subs: [], files: [] };
    const reftabs = (notes: unknown) => verdict("content/places/reftabs.json", { v: 1, labs: withNotes(notes), imaging: empty, ekg: empty, anatomy: empty });
    expect(reftabs([{ heading: "Fat-soluble" }, { block: id("b", 1) }, { block: id("b", 1), column: 3 }])).toBe("ok");
    for (const bad of [[{ heading: "" }], [{ block: G1 }], [{ block: id("b", 1), column: 0 }], [{ block: id("b", 1), column: 1.5 }], [{ heading: "x", block: id("b", 1) }], [{}]]) {
      expect(reftabs(bad), JSON.stringify(bad)).toMatch(/notes\[0\]: expected a note: \{ heading \} or \{ block, column\? \| rows\? \}/);
    }
    expect(verdict("content/places/other.json", other((s) => (s.id === "vitamins" ? { ...s, notes: [{ block: id("b", 1), column: 2 }] } : s)))).toBe("ok");
    expect(verdict("content/places/other.json", other((s) => (s.id === "vitamins" ? { ...s, notes: [{ block: D1 }] } : s)))).toMatch(/notes\[0\]/);
  });

  it("validates a block note's rows: one or more distinct row ids, and never together with a column", () => {
    const vit = (notes: unknown) => verdict("content/places/other.json", other((s) => (s.id === "vitamins" ? { ...s, notes } : s)));
    const B = id("b", 1);
    expect(vit([{ block: B, rows: [id("r", 1)] }, { block: B, rows: [id("r", 2), id("r", 1)] }])).toBe("ok");
    for (const bad of [{ block: B, rows: [] }, { block: B, rows: [id("r", 1), id("r", 1)] }, { block: B, rows: [id("b", 2)] }, { block: B, rows: id("r", 1) }, { block: B, column: 1, rows: [id("r", 1)] }]) {
      expect(vit([bad]), JSON.stringify(bad)).toMatch(/notes\[0\]: expected an outline item/);
    }
    const empty = { subs: [], files: [] };
    const labs = { subs: [{ id: "cbc", title: "CBC", notes: [{ block: B, rows: [id("r", 1)] }], links: [], gaps: [] }], files: [] };
    expect(verdict("content/places/reftabs.json", { v: 1, labs, imaging: empty, ekg: empty, anatomy: empty })).toBe("ok");
  });

  describe("an Other section's outline", () => {
    const L1 = id("r", 1);
    const pe = (notes: unknown[]) => verdict("content/places/other.json", other((s) => (
      s.id === "pe" ? { ...s, files: [D1], gaps: [G1], links: [{ target: L1, covers: "Murmurs" }], notes } : s
    )));

    it("accepts top and sub headings with her blocks, docs, gaps and links from the section's own lists", () => {
      expect(pe([
        { block: id("b", 1) },
        { heading: "Cardiac" },
        { doc: D1 },
        { heading: "Murmurs", sub: true },
        { link: L1 },
        { gap: G1 },
      ])).toBe("ok");
    });

    it("accepts an original item naming one of the section's files", () => {
      expect(pe([{ heading: "HEENT" }, { block: id("b", 1) }, { original: D1 }])).toBe("ok");
    });

    it("accepts the same doc, gap or link once in each part", () => {
      expect(pe([{ heading: "Psych EOR" }, { gap: G1 }, { link: L1 }, { heading: "Capacity", sub: true }, { gap: G1 }, { link: L1 }, { heading: "PANCE" }, { gap: G1 }, { doc: D1 }])).toBe("ok");
    });

    it.each([
      ["a doc not in the section's files", [{ doc: id("d", 2) }], /notes\[0\]: expected an entry of this section's own list/],
      ["an original not in the section's files", [{ original: id("d", 2) }], /notes\[0\]: expected an entry of this section's own list/],
      ["the same original twice in one part", [{ heading: "A" }, { original: D1 }, { original: D1 }], /notes\[2\]: expected each item once per part/],
      ["an original given as a block id", [{ original: id("b", 1) }], /notes\[0\]: expected an outline item/],
      ["a gap not in the section's gaps", [{ gap: G2 }], /notes\[0\]: expected an entry of this section's own list/],
      ["a link that is not one of the section's targets", [{ link: id("b", 9) }], /notes\[0\]: expected an entry of this section's own list/],
      ["the same gap twice in one part", [{ heading: "A" }, { gap: G1 }, { gap: G1 }], /notes\[2\]: expected each item once per part/],
      ["the same doc twice across a heading-less intro", [{ doc: D1 }, { doc: D1 }], /notes\[1\]: expected each item once per part/],
      ["a sub heading before any top heading", [{ heading: "Murmurs", sub: true }], /notes\[0\]: expected a sub heading after a top heading/],
      ["sub: false", [{ heading: "A", sub: false }], /notes\[0\]: expected an outline item/],
      ["a doc item with a column", [{ doc: D1, column: 1 }], /notes\[0\]: expected an outline item/],
      ["a gap given as a doc id", [{ gap: D1 }], /notes\[0\]: expected an outline item/],
    ])("refuses %s", (_name, notes, message) => {
      expect(pe(notes)).toMatch(message);
    });
  });
});

describe("slides, vocabulary and updates (20 §20.10–§20.12)", () => {
  it("validates deck.json: own decks name their document, generated decks do not", () => {
    expect(verdict("content/slides/psy/deck.json", { v: 1, guide: "psy", kind: "own", title: "Psych review slides", file: D1, slides: [id("s", 1)] })).toBe("ok");
    expect(verdict("content/slides/fm/deck.json", { v: 1, guide: "fm", kind: "generated", title: "High-yield review slides", file: null, slides: [] })).toBe("ok");
    expect(verdict("content/slides/fm/deck.json", { v: 1, guide: "fm", kind: "generated", title: "x", file: D1, slides: [] })).toMatch(/exactly for an own deck/);
    expect(verdict("content/slides/fm/deck.json", { v: 1, guide: "psy", kind: "own", title: "x", file: D1, slides: [] })).toMatch(/\.guide: expected fm \(from the file's path\)/);
  });

  it("validates the abbreviation vocabulary", () => {
    expect(verdict("content/vocab/abbreviations.json", { v: 1, entries: [{ abbr: ["MI"], meanings: ["myocardial infarction"] }] })).toBe("ok");
    expect(verdict("content/vocab/abbreviations.json", { v: 1, entries: [{ abbr: [""], meanings: [] }] })).toMatch(/non-empty/);
  });

  const flag = {
    id: id("u", 1), kind: "rec", source: "uspstf", by: "check", key: "Breast Cancer: Screening#1", subject: "Breast Cancer: Screening",
    guideline: "Breast Cancer: Screening", org: "USPSTF", published: "2024-04", quote: "Biennial mammography", grade: "B",
    url: "https://www.uspreventiveservicestaskforce.org/", flagged: "2026-10-01", supersededBy: null,
  };

  it("validates flags: sources, agent fields and unique ids", () => {
    expect(verdict("content/updates/flags.json", { v: 1, flags: [flag] })).toBe("ok");
    expect(verdict("content/updates/flags.json", { v: 1, flags: [{ ...flag, id: id("u", 2), source: "cite:idsa-cap", kind: "edition" }] })).toBe("ok");
    expect(verdict("content/updates/flags.json", { v: 1, flags: [{ ...flag, source: "nice" }] })).toMatch(/cite:<series>/);
    const agent = { ...flag, by: "agent", locator: "p. 3", verification: { verifier: "bo-2", at: "2026-10-06", result: "pass" } };
    expect(verdict("content/updates/flags.json", { v: 1, flags: [agent] })).toBe("ok");
    expect(verdict("content/updates/flags.json", { v: 1, flags: [{ ...flag, by: "agent" }] })).toMatch(/locator/);
    expect(verdict("content/updates/flags.json", { v: 1, flags: [{ ...flag, locator: "p. 3" }] })).toMatch(/no such key/);
    expect(verdict("content/updates/flags.json", { v: 1, flags: [flag, flag] })).toMatch(/no duplicate/);
  });

  it("accepts a retired date on check and agent flags, and refuses one that is not an ISO date", () => {
    const agent = { ...flag, by: "agent", locator: "p. 3", verification: { verifier: "bo-2", at: "2026-10-06", result: "pass" } };
    expect(verdict("content/updates/flags.json", { v: 1, flags: [{ ...flag, retired: "2026-11-01" }] })).toBe("ok");
    expect(verdict("content/updates/flags.json", { v: 1, flags: [{ ...agent, retired: "2026-11-01" }] })).toBe("ok");
    expect(verdict("content/updates/flags.json", { v: 1, flags: [{ ...flag, retired: "2026-11" }] })).toMatch(/\.retired: expected an ISO date/);
    expect(verdict("content/updates/flags.json", { v: 1, flags: [{ ...agent, retired: null }] })).toMatch(/\.retired: expected an ISO date/);
  });

  it("validates concepts and checks", () => {
    expect(verdict("content/updates/concepts.json", { v: 1, concepts: [{ id: "breast-cancer-screening", title: "Breast cancer screening", sourceKeys: { uspstf: ["k"] }, targets: [id("r", 1), G1, D1] }] })).toBe("ok");
    expect(verdict("content/updates/concepts.json", { v: 1, concepts: [{ id: "x", title: "X", sourceKeys: {}, targets: [id("u", 1)] }] })).toMatch(/a r_ or b_ or g_ or d_ id/);
    const checks = {
      v: 1, lastRun: "2026-11-01", nextRun: "2026-12-01",
      sources: [{ id: "uspstf", lastSuccess: null, lastAttempt: "2026-11-01", status: "fail" }],
      seen: { uspstf: { k: "2024-04" }, gold: 2026, "cite:idsa-cap": 2019 }, seenUrl: { k: "https://x" },
    };
    expect(verdict("content/updates/checks.json", checks)).toBe("ok");
    expect(verdict("content/updates/checks.json", { ...checks, seen: { gold: "2026" } })).toMatch(/a year/);
    expect(verdict("content/updates/checks.json", { ...checks, lastRun: "Nov 1" })).toMatch(/ISO date/);
  });
});

describe("paths (20 §20.2)", () => {
  it("knows the content JSON files and refuses anything else", () => {
    expect(isContentJSON("content/site.json")).toBe(true);
    expect(isContentJSON(`content/guides/fm/cardiovascular/blocks/${B1}.json`)).toBe(true);
    expect(isContentJSON("content/guides/derm/guide.json")).toBe(false);
    expect(isContentJSON(`content/assets/${"a".repeat(32)}.png`)).toBe(false);
    expect(() => validateFile("content/notes.json", {})).toThrow(/not a content JSON file/);
  });

  it("names the inbox item layout: the upload record the validator routes, and zero-padded parts", () => {
    expect(inboxItemDir(D1)).toBe(`inbox/${D1}`);
    expect(inboxUploadPath(D1)).toBe(`${inboxItemDir(D1)}/${UPLOAD_NAME}`);
    expect(isContentJSON(inboxUploadPath(D1))).toBe(true);
    expect(isContentJSON(`${inboxItemDir(D1)}/${partName(0)}`)).toBe(false);
    expect(isContentJSON(inboxUploadPath(B1))).toBe(false);
    expect(() => validateFile(inboxUploadPath(D1), {})).toThrow(ContentError);
    expect([0, 1, 12, 999].map(partName)).toEqual(["part-000", "part-001", "part-012", "part-999"]);
  });

  it("BLOCK_FILE_RE matches exactly the block routes: each location with its own id prefix", () => {
    const S1 = id("s", 1);
    const blocks: [string, string][] = [
      [`content/guides/fm/_preamble/blocks/${B1}.json`, B1],
      [`content/guides/fm/cardiovascular/blocks/${B1}.json`, B1],
      [`content/pharm/cardio-med-list/blocks/${B1}.json`, B1],
      [`content/docs/${D1}/blocks/${B1}.json`, B1],
      [`content/slides/fm/blocks/${S1}.json`, S1],
    ];
    for (const [path, block] of blocks) {
      expect(BLOCK_FILE_RE.exec(path)?.groups?.id, path).toBe(block);
      expect(isContentJSON(path), path).toBe(true);
    }
    const wrongPrefix = [
      `content/guides/fm/_preamble/blocks/${S1}.json`,
      `content/guides/fm/cardiovascular/blocks/${S1}.json`,
      `content/pharm/cardio-med-list/blocks/${S1}.json`,
      `content/docs/${D1}/blocks/${S1}.json`,
      `content/slides/fm/blocks/${B1}.json`,
    ];
    for (const path of wrongPrefix) {
      expect(BLOCK_FILE_RE.test(path), path).toBe(false);
      expect(isContentJSON(path), path).toBe(false);
    }
    for (const path of ["content/guides/fm/cardiovascular/structure.json", "content/slides/fm/deck.json", `content/gapfill/${G1}.json`, `content/docs/${D1}/doc.json`]) {
      expect(isContentJSON(path), path).toBe(true);
      expect(BLOCK_FILE_RE.test(path), path).toBe(false);
    }
  });
});
