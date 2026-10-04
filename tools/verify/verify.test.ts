import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeAsset, writeContent, writeStoredFile } from "../../lib/content/fs.ts";
import { assetName, newId } from "../../lib/content/ids.ts";
import type { DocJSON } from "../../lib/content/types.ts";
import {
  FIXTURES, abstractNum, buildDocx, listPara, lvl, num, para, pictureDrawing, png, run, tbl, textboxDrawing,
} from "../../lib/docx/fixtures.ts";
import { convertDocx, toBlocks } from "../../lib/docx/index.ts";
import type { Discrepancy } from "./compare.ts";
import { align, compareDocx } from "./compare.ts";
import { REMOVED_LINE, deckParagraphs } from "./deck.ts";
import { extract } from "./extract.ts";
import { reportName, runVerify, verifySource, verifyWordDoc } from "./index.ts";
import { blockContent, textsInOrder } from "./rendered.ts";

/** Stored node JSON as these tests walk and mutate it. */
type J = Record<string, unknown>;

interface Converted {
  bytes: Uint8Array;
  docs: DocJSON[];
  basePt: number;
  assets: Map<string, Uint8Array>;
}

async function convertInMemory(bytes: Uint8Array): Promise<Converted> {
  const assets = new Map<string, Uint8Array>();
  const conv = await convertDocx(bytes, {
    storeAsset: async (b, ext) => {
      const name = await assetName(b, ext);
      assets.set(name, b);
      return name;
    },
  });
  return { bytes, docs: toBlocks(conv.body).map((b) => b.doc), basePt: conv.basePt, assets };
}

async function compare(c: Converted, docs: DocJSON[] = c.docs): Promise<Discrepancy[]> {
  const r = await compareDocx(await extract(c.bytes), docs, c.basePt, async (n) => c.assets.get(n) ?? null);
  return r.discrepancies;
}

const kinds = (ds: Discrepancy[]): string[] => [...new Set(ds.map((d) => d.kind))].sort();

/** Every node matching `pred`, with its parent's content array, in document order. */
function find(docs: DocJSON[], pred: (n: J) => boolean): { node: J; siblings: J[] }[] {
  const out: { node: J; siblings: J[] }[] = [];
  const walk = (ns: J[]): void => {
    for (const n of ns) {
      if (pred(n)) out.push({ node: n, siblings: ns });
      walk((n.content ?? []) as J[]);
    }
  };
  for (const d of docs) walk(d.content as J[]);
  return out;
}

const hasText = (text: string) => (n: J): boolean => n.type === "paragraph" && ((n.content ?? []) as J[]).some((c) => c.text === text);
const textNode = (text: string) => (n: J): boolean => n.type === "text" && n.text === text;
const clone = (docs: DocJSON[]): DocJSON[] => structuredClone(docs);
const dropMark = (n: J, type: string): void => {
  n.marks = ((n.marks ?? []) as J[]).filter((m) => m.type !== type);
};

/** A valid PDF of `pages` blank pages, with a correct xref table. */
function minimalPdf(pages: number): string {
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    ...Array.from({ length: pages }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>"),
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  return `${out}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

/** One package holding every element the mutation cases remove or alter. */
async function richDocx(): Promise<Uint8Array> {
  return buildDocx({
    styles: `<w:style w:type="paragraph" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>`,
    numbering: abstractNum(0,
      lvl(0, "decimal", "%1.", '<w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr>') +
      lvl(1, "lowerLetter", "%2)", '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>')) + num(1, 0),
    rels: [
      { id: "rIdImg", type: "image", target: "media/pic.png" },
      { id: "rIdLink", type: "hyperlink", target: "https://example.org/a", external: true },
    ],
    media: { "pic.png": await png(40, 20) },
    body: [
      para(run("Intro paragraph with ordinary words in it")),
      para(run("Second paragraph also ordinary")),
      para(run("Bold by style"), '<w:pStyle w:val="Strong"/>'),
      listPara("top item", 1, 0),
      listPara("sub item", 1, 1),
      para(run("CAPS", "<w:caps/>") + run(" ") + run("Small", "<w:smallCaps/>") + run(" ") + run("sup", '<w:vertAlign w:val="superscript"/>') + run(" ") + run("big", '<w:sz w:val="28"/>')),
      para(`<w:hyperlink r:id="rIdLink">${run("linked")}</w:hyperlink>`),
      para(run("picture here") + `<w:r>${pictureDrawing("rIdImg")}</w:r>`),
      para(run("box host") + `<w:r>${textboxDrawing(para(run("Box words")), true)}</w:r>`),
      tbl([{ cells: [{ tcPr: '<w:shd w:val="clear" w:color="auto" w:fill="D9D9D9"/>', content: para(run("shaded")) }, { content: para(run("plain")) }] }]),
      para(run("Has a note") + `<w:r><w:footnoteReference w:id="1"/></w:r>`),
    ].join(""),
    footnotes: `<w:footnote w:id="1">${para(`<w:r><w:footnoteRef/></w:r>${run(" Foot note")}`)}</w:footnote>`,
  });
}

describe("compareDocx: an unmutated conversion is complete", () => {
  it.each(Object.keys(FIXTURES))("%s fixture has zero discrepancies", async (key) => {
    const c = await convertInMemory(await FIXTURES[key]!.build());
    expect(await compare(c)).toEqual([]);
  });

  it("the mutation fixture has zero discrepancies", async () => {
    expect(await compare(await convertInMemory(await richDocx()))).toEqual([]);
  });
});

describe("compareDocx: each loss is caught (99 §99.1)", () => {
  let c: Converted;
  beforeEach(async () => {
    c = await convertInMemory(await richDocx());
  });

  it("removing the textbox node → story", async () => {
    const docs = clone(c.docs);
    const [hit] = find(docs, (n) => n.type === "anchored" && ((n.content ?? []) as J[]).some((k) => k.type === "textbox"));
    hit!.siblings.splice(hit!.siblings.indexOf(hit!.node), 1);
    const ds = await compare(c, docs);
    expect(kinds(ds)).toEqual(["story"]);
    expect(ds[0]!.expected).toBe("Box words");
  });

  it("deleting one paragraph from a body block → paragraph", async () => {
    const docs = clone(c.docs);
    const [hit] = find(docs, hasText("Second paragraph also ordinary"));
    hit!.siblings.splice(hit!.siblings.indexOf(hit!.node), 1);
    const ds = await compare(c, docs);
    expect(ds).toEqual([{ kind: "paragraph", story: "body", index: 1, expected: "Second paragraph also ordinary", actual: null }]);
  });

  it("dropping one picture → picture", async () => {
    const docs = clone(c.docs);
    const [hit] = find(docs, (n) => n.type === "image");
    hit!.siblings.splice(hit!.siblings.indexOf(hit!.node), 1);
    const ds = await compare(c, docs);
    expect(kinds(ds)).toEqual(["picture"]);
    expect(ds[0]!.expected).toBe("word/media/pic.png");
  });

  it("removing a bold mark inherited from the paragraph style → format", async () => {
    const docs = clone(c.docs);
    const [hit] = find(docs, textNode("Bold by style"));
    dropMark(hit!.node, "bold");
    const ds = await compare(c, docs);
    expect(kinds(ds)).toEqual(["format"]);
    expect(ds[0]!.expected).toMatchObject({ bold: true });
  });

  it("changing a level-1 list paragraph's indLeft from 36 to 18 → indent", async () => {
    const docs = clone(c.docs);
    const [hit] = find(docs, hasText("sub item"));
    const attrs = hit!.node.attrs as J;
    expect(attrs.indLeft).toBe(36);
    attrs.indLeft = 18;
    const ds = await compare(c, docs);
    expect(kinds(ds)).toEqual(["indent"]);
  });

  it.each([
    ["caps", "CAPS"],
    ["smallCaps", "Small"],
    ["vertAlign", "sup"],
  ])("removing %s from a run that has it → format", async (mark, text) => {
    const docs = clone(c.docs);
    const [hit] = find(docs, textNode(text));
    expect(((hit!.node.marks ?? []) as J[]).some((m) => m.type === mark)).toBe(true);
    dropMark(hit!.node, mark);
    const ds = await compare(c, docs);
    expect(kinds(ds)).toEqual(["format"]);
    expect(Object.keys(ds[0]!.actual as object)).toEqual([mark]);
  });

  it("changing a run's size mark from 14 to 12 → format", async () => {
    const docs = clone(c.docs);
    const [hit] = find(docs, textNode("big"));
    const size = ((hit!.node.marks ?? []) as J[]).find((m) => m.type === "size")!;
    expect(size.attrs).toEqual({ pt: 14 });
    size.attrs = { pt: 12 };
    const ds = await compare(c, docs);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ kind: "format", expected: { size: 14 }, actual: { size: 12 } });
  });

  it("clearing a shaded cell's fill → table", async () => {
    const docs = clone(c.docs);
    const [hit] = find(docs, (n) => n.type === "table_cell" && (n.attrs as J).fill === "D9D9D9");
    (hit!.node.attrs as J).fill = null;
    const ds = await compare(c, docs);
    expect(kinds(ds)).toEqual(["table"]);
  });

  it("removing a footnote's appended paragraph → paragraph in that footnote's story", async () => {
    const docs = clone(c.docs);
    const [hit] = find(docs, (n) => n.type === "paragraph" && ((n.content ?? []) as J[]).some((k) => k.text === " Foot note"));
    hit!.siblings.splice(hit!.siblings.indexOf(hit!.node), 1);
    const ds = await compare(c, docs);
    expect(ds).toEqual([{ kind: "paragraph", story: "footnote 1", index: 0, expected: "1 Foot note", actual: null }]);
  });

  it("removing a link mark → link", async () => {
    const docs = clone(c.docs);
    const [hit] = find(docs, textNode("linked"));
    dropMark(hit!.node, "link");
    const ds = await compare(c, docs);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ kind: "link", expected: { href: "https://example.org/a" }, actual: { href: null } });
  });

  it("a stored crop of the wrong size → picture", async () => {
    const cropped = await convertInMemory(await FIXTURES.crop!.build());
    const [name] = [...cropped.assets.keys()];
    cropped.assets.set(name!, await png(150, 100));
    expect(kinds(await compare(cropped))).toEqual(["picture"]);
  });
});

describe("align", () => {
  it("reports missing and extra items around a common sequence", () => {
    expect(align(["a", "b", "c", "d"], ["a", "c", "x", "d"])).toEqual({ pairs: [[0, 0], [2, 1], [3, 3]], missing: [1], extra: [2] });
  });
});

describe("deckParagraphs", () => {
  const P_NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const sp = (paras: string[]): string => `<p:sp><p:txBody>${paras.join("")}</p:txBody></p:sp>`;
  const ap = (runs: string): string => `<a:p>${runs}</a:p>`;
  const ar = (t: string, rPr = ""): string => `<a:r>${rPr}<a:t>${t}</a:t></a:r>`;
  const slide = (shapes: string): Uint8Array => strToU8(`<p:sld ${P_NS}><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`);

  it("lists each slide's title then its paragraphs, maps symbols and applies the slide-2 edit", () => {
    const pptx = zipSync({
      "ppt/presentation.xml": strToU8(`<p:presentation ${P_NS}><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>`),
      "ppt/_rels/presentation.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="slides/slide2.xml"/><Relationship Id="rId2" Target="slides/slide1.xml"/></Relationships>`),
      "ppt/slides/slide1.xml": slide(sp([ap(ar("Title")), ap(ar("line two"))]) + sp([ap(ar("QTc ") + ar("", '<a:rPr><a:sym typeface="Wingdings"/></a:rPr>') + ar(" TdP")), ap("")])),
      "ppt/slides/slide2.xml": slide(`<p:grpSp>${sp([ap(ar("Lithium"))])}</p:grpSp>` + sp([ap(ar(REMOVED_LINE)), ap(ar("kept"))])),
    });
    expect(deckParagraphs(pptx)).toEqual([
      ["Title\nline two", "QTc → TdP"],
      ["Lithium", "kept"],
    ]);
  });
});

describe("rendered-check helpers", () => {
  it("textsInOrder finds texts in order and names the first one missing or out of order", () => {
    expect(textsInOrder("Alpha  beta\ngamma delta", ["alpha beta", "gamma"]).missing).toBe(0);
    expect(textsInOrder("Alpha  beta\ngamma delta", ["Alpha beta", "", "gamma"]).missing).toBeNull();
    expect(textsInOrder("one two", ["two", "one"]).missing).toBe(1);
  });

  it("blockContent lists main, text box and group texts and every asset", () => {
    const doc: DocJSON = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "main" }, { type: "image", attrs: { asset: "a.png" } }] },
        { type: "textbox", content: [{ type: "paragraph", content: [{ type: "text", text: "boxed" }] }] },
        { type: "drawing", attrs: { shapes: [{ asset: "b.png" }] }, content: [{ type: "drawing_text", content: [{ type: "paragraph", content: [{ type: "text", text: "grouped" }] }] }] },
      ],
    } as DocJSON;
    expect(blockContent({ v: 1, id: "b_X", kind: "prose", doc, meta: {} })).toEqual({
      stories: [{ label: "main", texts: ["main"] }, { label: "text box 1", texts: ["boxed"] }, { label: "group text 1", texts: ["grouped"] }],
      assets: ["a.png", "b.png"],
    });
  });
});

describe("verifyWordDoc / verifySource / runVerify on a content root", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pa-verify-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Imports a .docx as a Word page through lib/content, as the importer and inbox job do. */
  async function importWord(bytes: Uint8Array, source: string): Promise<{ docId: string; blockIds: string[] }> {
    const conv = await convertDocx(bytes, { storeAsset: (b, e) => writeAsset(root, b, e) });
    const docId = newId("d");
    const blockIds: string[] = [];
    for (const b of toBlocks(conv.body)) {
      const id = newId("b");
      blockIds.push(id);
      await writeContent(root, `content/docs/${docId}/blocks/${id}.json`, { v: 1, id, kind: b.kind, doc: b.doc, meta: {} });
    }
    await writeContent(root, `content/docs/${docId}/doc.json`, {
      v: 1, id: docId, name: "Notes", kind: "word", source, page: conv.page, basePt: conv.basePt, blocks: blockIds, removed: null,
    });
    return { docId, blockIds };
  }

  async function writeSources(rows: unknown[]): Promise<void> {
    await mkdir(join(root, "tools", "import"), { recursive: true });
    await writeFile(join(root, "tools", "import", "sources.json"), JSON.stringify({ v: 1, sources: rows }));
  }

  it("verifies an imported Word page with its stored assets", async () => {
    const bytes = await richDocx();
    const { docId } = await importWord(bytes, "notes.docx");
    const report = await verifyWordDoc(root, docId, bytes);
    expect(report.discrepancies).toEqual([]);
    expect(report.source).toBe("notes.docx");
    expect(report.counts).toMatchObject({ pictures: 1, textboxes: 1, tables: 1 });
  });

  it("reports a missing stored asset and an unlisted block file", async () => {
    const bytes = await richDocx();
    const { docId } = await importWord(bytes, "notes.docx");
    const stored = await readdir(join(root, "content", "assets"));
    expect(stored).toHaveLength(1);
    await rm(join(root, "content", "assets", stored[0]!));
    const stray = newId("b");
    await writeContent(root, `content/docs/${docId}/blocks/${stray}.json`, { v: 1, id: stray, kind: "prose", doc: { type: "doc", content: [{ type: "paragraph" }] }, meta: {} });
    const report = await verifyWordDoc(root, docId, bytes);
    expect(kinds(report.discrepancies)).toEqual(["picture", "reachability"]);
  });

  it("runVerify writes a report per source and a summary, and exits 0 when complete", async () => {
    const bytes = await richDocx();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "notes.docx"), bytes);
    await importWord(bytes, "notes.docx");
    const png1 = await png(10, 10);
    await writeFile(join(root, "src", "chart.png"), png1);
    const fileId = newId("d");
    await writeStoredFile(root, fileId, "chart.png", png1);
    await writeContent(root, `content/files/${fileId}/file.json`, { v: 1, id: fileId, name: "Chart", kind: "image", original: "chart.png", view: "chart.png", removed: null });
    await writeSources([
      { path: "src/notes.docx", kind: "word", name: "Notes", placement: { other: "x" } },
      { path: "src/chart.png", kind: "image", name: "Chart", placement: { other: "x" } },
      { path: "src/dup.docx", kind: "duplicate", name: "Dup", placement: null },
    ]);
    const lines: string[] = [];
    expect(await runVerify(root, { log: (l) => lines.push(l) })).toBe(0);
    const dir = join(root, "tools", "import", "reports");
    const summary = JSON.parse(await readFile(join(dir, "summary.json"), "utf8")) as { sources: { source: string; discrepancies: number }[] };
    expect(summary.sources).toEqual([{ source: "notes.docx", discrepancies: 0 }, { source: "chart.png", discrepancies: 0 }]);
    const word = JSON.parse(await readFile(join(dir, reportName("notes.docx")), "utf8")) as { discrepancies: unknown[] };
    expect(word.discrepancies).toEqual([]);
    expect(lines.at(-1)).toBe("all 2 sources complete");
  });

  it("runVerify exits 1 when a source is missing from the content store or altered", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "lost.docx"), await richDocx());
    const fileId = newId("d");
    await writeStoredFile(root, fileId, "chart.png", await png(10, 10));
    await writeFile(join(root, "src", "chart.png"), await png(11, 10));
    await writeContent(root, `content/files/${fileId}/file.json`, { v: 1, id: fileId, name: "Chart", kind: "image", original: "chart.png", view: "chart.png", removed: null });
    await writeSources([
      { path: "src/lost.docx", kind: "word", name: "Lost", placement: { other: "x" } },
      { path: "src/chart.png", kind: "image", name: "Chart", placement: { other: "x" } },
    ]);
    const lines: string[] = [];
    expect(await runVerify(root, { log: (l) => lines.push(l) })).toBe(1);
    expect(lines.at(-1)).toBe("2 of 2 sources have discrepancies");
  });

  /** Converts a .docx and writes its blocks under `dir`, returning the block ids and basePt. */
  async function writeBlocks(bytes: Uint8Array, dir: string): Promise<{ ids: string[]; basePt: number; page: unknown }> {
    const conv = await convertDocx(bytes, { storeAsset: (b, e) => writeAsset(root, b, e) });
    const ids: string[] = [];
    for (const b of toBlocks(conv.body)) {
      const id = newId("b");
      ids.push(id);
      await writeContent(root, `${dir}/${id}.json`, { v: 1, id, kind: b.kind, doc: b.doc, meta: {} });
    }
    return { ids, basePt: conv.basePt, page: conv.page };
  }

  async function writeSource(rel: string, bytes: Uint8Array): Promise<void> {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", rel), bytes);
  }

  it("verifies a guide across its preamble and systems, and reports unreadable system content", async () => {
    const bytes = await richDocx();
    await writeSource("fm.docx", bytes);
    const base = "content/guides/fm";
    const { ids, basePt, page } = await writeBlocks(bytes, `${base}/cardio/blocks`);
    const pre = await writeBlocks(buildDocx({ body: "" }), `${base}/_preamble/blocks`);
    expect(pre.ids).toEqual([]);
    await writeContent(root, `${base}/cardio/system.json`, { v: 1, id: "cardio", blocks: ids });
    await writeContent(root, `${base}/guide.json`, { v: 1, id: "fm", source: "fm.docx", page, basePt, preamble: [], systems: [{ id: "cardio", title: "Cardio", pct: "10%" }] });
    const row = { path: "src/fm.docx", kind: "guide", name: "FM", placement: { guide: "fm" } };
    const ok = await verifySource(root, row);
    expect(ok!.discrepancies).toEqual([]);
    expect(ok!.counts).toMatchObject({ pictures: 1, textboxes: 1, tables: 1 });

    await writeFile(join(root, ...`${base}/cardio/system.json`.split("/")), JSON.stringify({ v: 1, id: "cardio", blocks: [...ids, ids[0]] }));
    // lib/content refuses a system listing a block twice, so the source is reported unreadable.
    const twice = await verifySource(root, row);
    expect(twice!.discrepancies).toEqual([expect.objectContaining({ kind: "file", story: "content", actual: expect.stringContaining("cardio/system.json") })]);
  });

  it("verifies pharm notes and their parts against pharm/cards.json", async () => {
    const bytes = await richDocx();
    await writeSource("CV Pharm.docx", bytes);
    const base = "content/pharm/cv-pharm";
    const { ids, basePt } = await writeBlocks(bytes, `${base}/blocks`);
    const half = Math.ceil(ids.length / 2);
    const parts = [
      { id: newId("p"), role: "overview", title: "Overview", card: null, blocks: ids.slice(0, half) },
      { id: newId("p"), role: "card", title: "Nitrates", card: newId("c"), blocks: ids.slice(half) },
    ];
    await writeContent(root, `${base}/pharmfile.json`, { v: 1, id: "cv-pharm", fileName: "CV Pharm.docx", basePt, blocks: ids, parts });
    await writeContent(root, "content/pharm/cards.json", { v: 1, cards: [{ id: parts[1]!.card, file: "cv-pharm", aliases: [], home: {} }] });
    const row = { path: "src/CV Pharm.docx", kind: "pharm", name: "CV Pharm", placement: null };
    expect((await verifySource(root, row))!.discrepancies).toEqual([]);

    const stray = newId("c");
    await writeContent(root, `${base}/pharmfile.json`, { v: 1, id: "cv-pharm", fileName: "CV Pharm.docx", basePt, blocks: ids, parts: [parts[0], { ...parts[1]!, card: stray }] });
    expect((await verifySource(root, row))!.discrepancies).toEqual([
      { kind: "pharm", story: "parts", index: 1, expected: "a card in pharm/cards.json", actual: stray },
    ]);
  });

  it("verifies a slide deck's paragraphs per slide and its slide count", async () => {
    const P_NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const slide = (title: string, body: string): Uint8Array => strToU8(`<p:sld ${P_NS}><p:cSld><p:spTree>` +
      `<p:sp><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp>` +
      "</p:spTree></p:cSld></p:sld>");
    const pptx = zipSync({
      "ppt/presentation.xml": strToU8(`<p:presentation ${P_NS}><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`),
      "ppt/_rels/presentation.xml.rels": strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>'),
      "ppt/slides/slide1.xml": slide("Mood", "SSRIs first"),
      "ppt/slides/slide2.xml": slide("Psychosis", "Antipsychotics"),
    });
    await writeSource("psych.pptx", pptx);
    const text = (t: string): J => ({ type: "text", text: t });
    const slideDoc = (title: string, body: string): DocJSON => ({
      type: "doc", content: [{ type: "heading_line", content: [text(title)] }, { type: "paragraph", content: [text(body)] }],
    }) as DocJSON;
    const ids = [newId("s"), newId("s")];
    await writeContent(root, `content/slides/psy/blocks/${ids[0]}.json`, { v: 1, id: ids[0], kind: "slide", doc: slideDoc("Mood", "SSRIs first"), meta: {} });
    await writeContent(root, `content/slides/psy/blocks/${ids[1]}.json`, { v: 1, id: ids[1], kind: "slide", doc: slideDoc("Psychosis", "Typicals"), meta: {} });
    const deck = { v: 1, guide: "psy", kind: "own", title: "Psych", file: newId("d"), slides: ids };
    await writeContent(root, "content/slides/psy/deck.json", deck);
    const row = { path: "src/psych.pptx", kind: "deck", name: "Psych", placement: { deck: "psy" } };
    const report = (await verifySource(root, row))!;
    expect(report.counts).toEqual({ stories: 2, paragraphs: 4 });
    expect(report.discrepancies).toEqual([{ kind: "deck", story: "slide 2", index: 1, expected: "Antipsychotics", actual: "Typicals" }]);

    await writeContent(root, "content/slides/psy/deck.json", { ...deck, slides: [ids[0]] });
    const short = (await verifySource(root, row))!.discrepancies;
    expect(short).toContainEqual({ kind: "deck", story: "slides", index: -1, expected: { slides: 2 }, actual: { slides: 1 } });
  });

  it("checks a PDF's stored copy and page text, and treats a processing file as info", async () => {
    const pdf = strToU8(minimalPdf(2));
    await writeSource("ref.pdf", pdf);
    const fileId = newId("d");
    await writeStoredFile(root, fileId, "ref.pdf", pdf);
    await writeContent(root, `content/files/${fileId}/text.json`, { pages: ["one", "two"] });
    const file = { v: 1, id: fileId, name: "Ref", kind: "pdf", original: "ref.pdf", view: "ref.pdf", pages: 2, text: "text.json", removed: null };
    await writeContent(root, `content/files/${fileId}/file.json`, file);
    const row = { path: "src/ref.pdf", kind: "pdf", name: "Ref", placement: { other: "x" } };
    const ok = (await verifySource(root, row))!;
    expect(ok.discrepancies).toEqual([]);
    expect(ok.counts).toEqual({ stories: 2 });

    await writeContent(root, `content/files/${fileId}/text.json`, { pages: ["one"] });
    expect((await verifySource(root, row))!.discrepancies).toEqual([
      { kind: "file", story: "text.json", index: -1, expected: { pages: 2 }, actual: { pages: 1 } },
    ]);

    await writeContent(root, `content/files/${fileId}/file.json`, { ...file, view: null, pages: null, text: null, state: "processing" });
    const processing = (await verifySource(root, row))!;
    expect(processing.discrepancies).toEqual([]);
    expect(processing.info).toEqual([{ kind: "processing", id: fileId }]);
  });

  it("reports a Word row with no stored page, and unreadable content, as file discrepancies", async () => {
    await writeSource("gone.docx", await richDocx());
    const missing = (await verifySource(root, { path: "src/gone.docx", kind: "word", name: "Gone", placement: { other: "x" } }))!;
    expect(missing.discrepancies).toEqual([{ kind: "file", story: "doc", index: -1, expected: "gone.docx", actual: null }]);
    const noGuide = (await verifySource(root, { path: "src/gone.docx", kind: "guide", name: "Gone", placement: { guide: "em" } }))!;
    expect(noGuide.discrepancies).toEqual([expect.objectContaining({ kind: "file", story: "content", expected: "readable content" })]);
  });

  it("verifySource skips duplicate and vocab rows", async () => {
    expect(await verifySource(root, { path: "x.docx", kind: "duplicate", name: "x", placement: null })).toBeNull();
    expect(await verifySource(root, { path: "v.docx", kind: "vocab", name: "v", placement: null })).toBeNull();
  });
});
