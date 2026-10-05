// The one-time import (30 §30.1) end to end over a temporary project root: her inventory and guide
// config are written into the root, the source files are built here (Word with fflate, PDF with
// pdf-lib, PowerPoint with fflate), and the result is read back through lib/content.
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { strToU8, zipSync } from "fflate";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GUIDE_IDS } from "../../lib/content/index.ts";
import type {
  AsIsFile, BlockFile, DeckFile, GuideFile, GuideId, OtherFile, PharmFile, RefTabsFile, StructureFile, SystemFile, VocabFile, WordDocFile,
} from "../../lib/content/index.ts";
import { readContent, readContentIfExists, readStoredFile } from "../../lib/content/fs.ts";
import { PSYCH_REMOVED_LINE, slideTexts } from "./pptx.ts";
import { runImport } from "./run.ts";

// ---- Word ----
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const esc = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const wp = (text: string): string => `<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
const wtbl = (rows: string[][]): string =>
  `<w:tbl><w:tblGrid>${rows[0]!.map(() => '<w:gridCol w:w="2000"/>').join("")}</w:tblGrid>${rows.map((row) => `<w:tr>${row.map((c) => `<w:tc>${wp(c)}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
const docx = (body: string[]): Uint8Array =>
  zipSync({ "word/document.xml": strToU8(`<w:document ${W}><w:body>${body.join("")}<w:sectPr/></w:body></w:document>`) });

// ---- PowerPoint ----
const P_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const ap = (text: string, lvl = 0): string => `<a:p><a:pPr lvl="${lvl}"/><a:r><a:rPr lang="en-US"/><a:t>${esc(text)}</a:t></a:r></a:p>`;
const sp = (...paras: string[]): string => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="x"/></p:nvSpPr><p:txBody><a:bodyPr/>${paras.join("")}</p:txBody></p:sp>`;
function pptx(slides: string[]): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "ppt/presentation.xml": strToU8(`<p:presentation ${P_NS}><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("")}</p:sldIdLst></p:presentation>`),
    "ppt/_rels/presentation.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, i) => `<Relationship Id="rId${i + 2}" Type="slide" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>`),
  };
  slides.forEach((s, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<p:sld ${P_NS}><p:cSld><p:spTree>${s}</p:spTree></p:cSld></p:sld>`);
  });
  return zipSync(files);
}

async function pdf(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([400, 400]).drawText(text, { x: 40, y: 300, size: 14, font });
  return doc.save();
}

/** Two systems per guide: Cardiovascular (CV) and a second one with no pharm category. */
const SYSTEMS: Record<GuideId, { title: string; pct: string; category: string | null; match?: string; heading: string }[]> = Object.fromEntries(
  GUIDE_IDS.map((g) => [g, [
    { title: "Cardiovascular", pct: "20%", category: "CV", heading: "Cardiovascular (20%)" },
    g === "pance"
      ? { title: "Renal System & GU System", pct: "5%", category: null, match: "Renal System (5%) & GU", heading: "Renal System (5%) & GU System (3%)" }
      : { title: "Pulmonary", pct: "10%", category: null, heading: "Pulmonary (10%)" },
  ]]),
) as never;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
const FLOWERS = pptx([sp(ap("Penicillins"))]);
const PSYCH = pptx([
  sp(ap("EOC Review")),
  sp(ap("High-Yield Psychopharmacology")) + sp(ap("SSRIs"), ap("First line", 1), ap(PSYCH_REMOVED_LINE, 1), ap("Risk causing mania", 2)),
]);
const LABS = docx([wp("CBC reference ranges")]);

interface Row { path: string; kind: string; name: string; placement: unknown }

/** Paths of the inventory used by most tests, in inventory order. */
const SOURCES: Row[] = [
  ...GUIDE_IDS.map((g) => ({ path: `guides/${g}.docx`, kind: "guide", name: g, placement: { guide: g } })),
  { path: "w/Labs.docx", kind: "word", name: "Labs", placement: { reftabs: "labs" } },
  { path: "w/Cardiac drugs.docx", kind: "word", name: "Cardiac drugs", placement: { pharm: ["CV"] } },
  { path: "f/Bugs.png", kind: "image", name: "Bugs", placement: { pharm: ["CV", "ID"] } },
  { path: "f/Flowers.pptx", kind: "slides", name: "Flower charts", placement: { pharm: ["CV"] } },
  { path: "f/Receptor.pdf", kind: "pdf", name: "Receptor chart", placement: { sidebarEnd: "pance" } },
  { path: "f/Emergency.pdf", kind: "pdf", name: "ACLS", placement: { other: "emergency" } },
  { path: "p/Pharm_Cardio.docx", kind: "pharm", name: "Pharm cardio", placement: null },
  { path: "s/Psych review.pptx", kind: "deck", name: "Psych review", placement: { deck: "psy" } },
  { path: "v/Vocab.docx", kind: "vocab", name: "Vocabulary", placement: null },
  { path: "w/Labs (1).docx", kind: "duplicate", name: "Labs copy", placement: { duplicateOf: "w/Labs.docx" } },
];

let root: string;
const at = (path: string): string => join(root, ...path.split("/"));
async function put(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(at(path)), { recursive: true });
  await writeFile(at(path), data);
}

async function writeProject(sources: Row[] = SOURCES): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const g of GUIDE_IDS) {
    files.set(`guides/${g}.docx`, docx([
      wp(`Preamble of ${g}`),
      ...SYSTEMS[g].flatMap((s) => [wp(s.heading), wp(`${s.title} notes of ${g}`)]),
    ]));
  }
  files.set("w/Labs.docx", LABS);
  files.set("w/Labs (1).docx", LABS);
  files.set("w/Cardiac drugs.docx", docx([wp("Beta blockers")]));
  files.set("f/Bugs.png", PNG);
  files.set("f/Flowers.pptx", FLOWERS);
  files.set("f/Receptor.pdf", await pdf("Receptor pharmacology"));
  files.set("f/Emergency.pdf", await pdf("ACLS algorithm"));
  files.set("p/Pharm_Cardio.docx", docx([wp("Digoxin"), wp("Narrow window")]));
  files.set("s/Psych review.pptx", PSYCH);
  files.set("v/Vocab.docx", docx([
    wp("Vocabulary"),
    wtbl([["Abbreviation", "Meaning", "Notes"], ["BP", "blood pressure", ""], ["", "orphan meaning", ""], ["HR / P", "heart rate / pulse", "x"]]),
  ]));
  for (const [path, bytes] of files) if (sources.some((s) => s.path === path)) await put(path, bytes);
  await put("tools/import/sources.json", JSON.stringify({ v: 1, sources }));
  await put("tools/import/guides.json", JSON.stringify({
    v: 1,
    guides: Object.fromEntries(GUIDE_IDS.map((g) => [g, { systems: SYSTEMS[g].map((s) => ({ title: s.title, pct: s.pct, category: s.category, ...(s.match ? { match: s.match } : {}) })) }])),
  }));
  return files;
}

/** Plain text of a block's doc (text nodes concatenated, blocks separated by "|"). */
function textOf(n: { type: string; text?: string; content?: unknown[] }): string {
  if (n.type === "text") return n.text ?? "";
  const kids = (n.content ?? []) as { type: string }[];
  return kids.map((k) => textOf(k)).join(kids.some((k) => k.type !== "text") ? "|" : "");
}
const blockTexts = async (dir: string, ids: readonly string[]): Promise<string[]> =>
  Promise.all(ids.map(async (id) => textOf((await readContent<BlockFile>(root, `${dir}/${id}.json`)).doc as never)));

const stagingDirs = async (): Promise<string[]> => (await readdir(root)).filter((n) => n.startsWith(".import-staging-"));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pa-import-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("runImport", () => {
  it("converts every source kind into content/ and never changes a source file", async () => {
    const files = await writeProject();
    const log: string[] = [];
    const { docIds } = await runImport(root, (line) => log.push(line));

    const id = (path: string): string => docIds.get(path) as string;
    expect([...docIds.keys()]).toEqual([
      "w/Labs.docx", "w/Cardiac drugs.docx", "f/Bugs.png", "f/Flowers.pptx", "f/Receptor.pdf", "f/Emergency.pdf", "s/Psych review.pptx",
    ]);
    expect(new Set(docIds.values()).size).toBe(7);
    for (const d of docIds.values()) expect(d).toMatch(/^d_/);

    // Sources untouched.
    for (const [path, bytes] of files) expect(new Uint8Array(await readFile(at(path)))).toEqual(bytes);

    // Guides: preamble, systems in config order, pharm files by category, PANCE sidebar end.
    for (const g of GUIDE_IDS) {
      const base = `content/guides/${g}`;
      const guide = await readContent<GuideFile>(root, `${base}/guide.json`);
      expect(guide.source).toBe(`${g}.docx`);
      expect(guide.systems.map((s) => [s.title, s.pct])).toEqual(SYSTEMS[g].map((s) => [s.title, s.pct]));
      expect(await blockTexts(`${base}/_preamble/blocks`, guide.preamble)).toEqual([`Preamble of ${g}`]);
      for (const [i, sys] of guide.systems.entries()) {
        const system = await readContent<SystemFile>(root, `${base}/${sys.id}/system.json`);
        expect(system.id).toBe(sys.id);
        const want = SYSTEMS[g][i]!;
        expect(await blockTexts(`${base}/${sys.id}/blocks`, system.blocks)).toEqual([`${want.heading}|${want.title} notes of ${g}`]);
        const structure = await readContent<StructureFile>(root, `${base}/${sys.id}/structure.json`);
        expect(structure.pharmFiles).toEqual(want.category === "CV" ? [id("w/Cardiac drugs.docx"), id("f/Bugs.png"), id("f/Flowers.pptx")] : []);
        expect(structure.sections).toEqual([]);
      }
      expect(guide.sidebarEnd).toBe(g === "pance" ? id("f/Receptor.pdf") : undefined);
      const general = await readContentIfExists(root, `${base}/general.json`);
      expect(general).toEqual(g === "pance" ? null : { v: 1, topics: [], workup: [] });
    }
    expect((await readContent<GuideFile>(root, "content/guides/pance/guide.json")).systems[1]!.id).toBe("renal-system-gu-system");

    // A Word page.
    const labs = await readContent<WordDocFile>(root, `content/docs/${id("w/Labs.docx")}/doc.json`);
    expect(labs).toMatchObject({ id: id("w/Labs.docx"), name: "Labs", kind: "word", source: "Labs.docx", removed: null });
    expect(await blockTexts(`content/docs/${id("w/Labs.docx")}/blocks`, labs.blocks)).toEqual(["CBC reference ranges"]);

    // A pharm notes file: one untitled overview part over every block.
    const pharm = await readContent<PharmFile>(root, "content/pharm/pharm-cardio/pharmfile.json");
    expect(pharm.fileName).toBe("Pharm_Cardio");
    expect(await blockTexts("content/pharm/pharm-cardio/blocks", pharm.blocks)).toEqual(["Digoxin|Narrow window"]);
    expect(pharm.parts).toEqual([{ id: expect.stringMatching(/^p_/), role: "overview", title: "", card: null, blocks: pharm.blocks }]);

    // PDFs: stored, page text, page count.
    const receptor = id("f/Receptor.pdf");
    expect(await readContent<AsIsFile>(root, `content/files/${receptor}/file.json`)).toEqual({
      v: 1, id: receptor, name: "Receptor chart", kind: "pdf", original: "Receptor.pdf", view: "Receptor.pdf", pages: 1, text: "text.json", removed: null,
    });
    expect(await readStoredFile(root, receptor, "Receptor.pdf")).toEqual(files.get("f/Receptor.pdf"));
    const text = JSON.parse(await readFile(at(`content/files/${receptor}/text.json`), "utf8")) as { pages: string[] };
    expect(text.pages).toEqual(["Receptor pharmacology"]);

    // An image, stored as-is.
    const bugs = id("f/Bugs.png");
    expect(await readContent<AsIsFile>(root, `content/files/${bugs}/file.json`)).toEqual({
      v: 1, id: bugs, name: "Bugs", kind: "image", original: "Bugs.png", view: "Bugs.png", removed: null,
    });
    expect(await readStoredFile(root, bugs, "Bugs.png")).toEqual(PNG);

    // A PowerPoint shown as-is waits for the inbox job: processing, and no stored file yet.
    const flowers = id("f/Flowers.pptx");
    expect(await readContent<AsIsFile>(root, `content/files/${flowers}/file.json`)).toEqual({
      v: 1, id: flowers, name: "Flower charts", kind: "slides", original: "Flowers.pptx", view: null, pages: null, text: null, removed: null, state: "processing",
    });
    expect(await readdir(at(`content/files/${flowers}`))).toEqual(["file.json"]);

    // Her psych deck: her approved edit on the site and in the stored original.
    const psych = id("s/Psych review.pptx");
    const deck = await readContent<DeckFile>(root, "content/slides/psy/deck.json");
    expect(deck).toMatchObject({ guide: "psy", kind: "own", title: "Psych review", file: psych });
    const slideText = await blockTexts("content/slides/psy/blocks", deck.slides);
    expect(slideText).toHaveLength(2);
    expect(slideText[1]).toContain("Risk causing mania");
    expect(slideText.join()).not.toContain(PSYCH_REMOVED_LINE);
    const stored = await readStoredFile(root, psych, "Psych review.pptx");
    expect(slideTexts(stored)[1]).toBe("High-Yield Psychopharmacology\nSSRIs\nFirst line\nRisk causing mania");
    expect(await readContent<AsIsFile>(root, `content/files/${psych}/file.json`)).toMatchObject({ kind: "slides", original: "Psych review.pptx", pages: 2 });
    expect(log.some((l) => l.includes(`removed "${PSYCH_REMOVED_LINE}"`))).toBe(true);

    // Vocabulary: rows with an empty abbreviation or meaning are skipped and counted.
    expect(await readContent<VocabFile>(root, "content/vocab/abbreviations.json")).toEqual({
      v: 1, entries: [{ abbr: ["BP"], meanings: ["blood pressure"] }, { abbr: ["HR", "P"], meanings: ["heart rate", "pulse"] }],
    });
    expect(log).toContain("  v/Vocab.docx: 1 vocabulary tables, 2 entries, 1 rows skipped (empty abbreviation or meaning)");

    // Places and the pre-curation files.
    const reftabs = await readContent<RefTabsFile>(root, "content/places/reftabs.json");
    expect(reftabs.labs.files).toEqual([id("w/Labs.docx")]);
    expect([reftabs.imaging.files, reftabs.ekg.files, reftabs.anatomy.files]).toEqual([[], [], []]);
    const other = await readContent<OtherFile>(root, "content/places/other.json");
    expect(other.sections.find((s) => s.id === "emergency")?.files).toEqual([id("f/Emergency.pdf")]);
    expect(other.sections.filter((s) => s.id !== "emergency").flatMap((s) => s.files)).toEqual([]);
    expect(await readContent(root, "content/pharm/cards.json")).toEqual({ v: 1, cards: [] });
    expect(await readContent(root, "content/pharm/trims.json")).toEqual({ v: 1, rows: {}, lines: [] });
    expect(await readContent(root, "content/pharm/uses.json")).toEqual({ v: 1, lines: [], conditions: [] });
    expect(await readContent(root, "content/updates/flags.json")).toEqual({ v: 1, flags: [] });
    expect(await readContent(root, "content/updates/concepts.json")).toEqual({ v: 1, concepts: [] });
    expect(await readContent(root, "content/updates/checks.json")).toEqual({ v: 1, lastRun: null, nextRun: null, sources: [], seen: {}, seenUrl: {} });
    expect(await readContent(root, "content/site.json")).toBeTruthy();

    // The duplicate is proven and not imported.
    expect(log).toContain("duplicate w/Labs (1).docx: same paragraph texts and pictures as w/Labs.docx; not imported");
    expect((await readdir(at("content/docs"))).sort()).toEqual([id("w/Labs.docx"), id("w/Cardiac drugs.docx")].sort());
  });

  it("refuses to run again once content/guides/ exists, writing nothing", async () => {
    await writeProject();
    await put("content/guides/keep.txt", "x");
    await expect(runImport(root, () => {})).rejects.toThrow(/content\/guides\/ already exists/);
    expect(await readdir(at("content"))).toEqual(["guides"]);
  });

  it("names every missing source and writes nothing", async () => {
    await writeProject();
    await rm(at("f/Bugs.png"));
    await rm(at("v/Vocab.docx"));
    await expect(runImport(root, () => {})).rejects.toThrow("Source files missing:\n  f/Bugs.png\n  v/Vocab.docx");
    await expect(readdir(at("content"))).rejects.toThrow(/ENOENT/);
  });

  it("fails before writing anything when a listed duplicate is not an exact duplicate", async () => {
    await writeProject();
    await put("w/Labs (1).docx", docx([wp("CBC reference ranges, revised")]));
    await expect(runImport(root, () => {})).rejects.toThrow("w/Labs (1).docx is not a duplicate of w/Labs.docx: their paragraph texts differ");
    await expect(readdir(at("content"))).rejects.toThrow(/ENOENT/);
  });

  it("leaves no partial content/ and no staging directory when a source fails to convert mid-run", async () => {
    const guidesOnly = SOURCES.filter((s) => s.kind === "guide");
    await writeProject(guidesOnly);
    // Surgery's guide lacks its second system heading; earlier guides have already been converted.
    await put("guides/surg.docx", docx([wp("Preamble"), wp("Cardiovascular (20%)"), wp("notes")]));
    await expect(runImport(root, () => {})).rejects.toThrow("system heading not found: Pulmonary");
    await expect(readdir(at("content"))).rejects.toThrow(/ENOENT/);
    expect(await stagingDirs()).toEqual([]);
  });

  it("moves into an existing content/ without guides/, keeping what is there", async () => {
    await writeProject(SOURCES.filter((s) => s.kind === "guide"));
    await put("content/README.md", "kept");
    await runImport(root, () => {});
    expect(await readFile(at("content/README.md"), "utf8")).toBe("kept");
    expect((await readdir(at("content"))).sort()).toEqual(["README.md", "guides", "pharm", "places", "site.json", "updates"]);
    expect(await stagingDirs()).toEqual([]);
  });

  it("moves nothing into an existing content/ when any imported entry is already there", async () => {
    await writeProject(SOURCES.filter((s) => s.kind === "guide"));
    await put("content/site.json", "hers");
    await expect(runImport(root, () => {})).rejects.toThrow("content/site.json already exists");
    expect(await readdir(at("content"))).toEqual(["site.json"]);
    expect(await readFile(at("content/site.json"), "utf8")).toBe("hers");
    expect(await stagingDirs()).toEqual([]);
  });
});
