// tools/pdf (plan 70 §70.5): whole-guide PDFs rendered with the real pdfmake and vendored fonts, image
// conversion, the release decision, and the CLI.
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PDFDocument } from "@cantoo/pdf-lib";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DocJSON } from "../../lib/content/types.ts";
import type { HomeJson, NavJson, SystemJson } from "../../lib/derive/published.ts";
import { FONTS, isVariationSelector } from "../../lib/fonts.ts";
import { schema } from "../../lib/schema.ts";
import { block, cardioSystem, cell, doc, fmHome, fmNav, FONTS_DIR, fontmapFor, FORBIDDEN, para, pulmSystem, row, table, txt, wordDoc } from "../../lib/pdf/testing.ts";
import type { PdfInput, PdfScope } from "../../lib/pdf/index.ts";
import { buildGuidePdf, consumedFiles, imageDataUrl, loadFontmap, mergePdfs, nodeRenderer, type PdfRenderer } from "./build.ts";
import { main, runAll } from "./index.ts";
import { decide, guideDigest, headCommit, outsideBuild, publish, releaseRecord, type Run, type RunResult } from "./release.ts";

const PNG = `${"a".repeat(32)}.png`;
const GIF = `${"b".repeat(32)}.gif`;
const HEAD = "1".repeat(40);
const OLD = "2".repeat(40);

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pdf-test-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// ---- fixtures -----------------------------------------------------------------------------------

/** A 4 × 2 px picture: left half red, right half blue. */
async function picture(): Promise<ReturnType<typeof sharp>> {
  const red = { r: 255, g: 0, b: 0 };
  const half = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toBuffer();
  return sharp({ create: { width: 4, height: 2, channels: 3, background: red } }).composite([{ input: half, left: 2, top: 0 }]);
}

const imageNode = (asset: string, attrs: Record<string, unknown> = {}) => ({ type: "image", attrs: { asset, widthPt: 40, heightPt: 20, rot: 0, flipH: false, flipV: false, ...attrs } });

/** Pulmonary with a stored PNG and a turned, mirrored GIF in its prose. */
function pulmWithPictures(): SystemJson {
  const s = pulmSystem();
  s.blocks = [block("b_AAAAAAAPU1", "prose", doc(para([txt("Asthma notes"), imageNode(PNG), imageNode(GIF, { rot: 90, flipH: true })])))];
  return s;
}

const TEXTS = ["Preamble title page", "Intro ⊕ → ➀ ▪️ item", "CARDIO LABEL About Dx Angina chest pain ECG radiates troponin Myocarditis: viral/other viral MRI", "ANTIANGINAL Use Nitrates angina CCB HTN", "Murmurs note", "HF PHARM Use Loop diuretics edema", "Asthma notes", "GAPBLOCK text SLIDETEXT", " "];

/** dist/data for the Family Medicine guide (and an empty PANCE), as tools/build writes it. */
async function writeData(dataDir: string, home: HomeJson = fmHome()): Promise<void> {
  const put = async (path: string, value: unknown): Promise<void> => {
    await mkdir(join(dataDir, path, ".."), { recursive: true });
    await writeFile(join(dataDir, path), JSON.stringify(value));
  };
  await put("site.json", { eors: [{ id: "fm", name: "Family Medicine" }], pance: { id: "pance", name: "PANCE" }, guideNames: { fm: "Family Medicine", pance: "PANCE" } });
  await put("g/fm/nav.json", fmNav());
  await put("g/fm/home.json", home);
  await put("g/fm/s/cardiovascular.json", cardioSystem());
  await put("g/fm/s/pulmonary.json", pulmWithPictures());
  const pance: NavJson = { ...fmNav(), guide: "pance", title: "PANCE", source: "PANCE.docx", systems: [] };
  await put("g/pance/nav.json", pance);
  await put("g/pance/home.json", { ...fmHome(), guide: "pance", title: "PANCE", preamble: [] });
  await put("fonts/fontmap.json", fontmapFor(TEXTS));
  await mkdir(join(dataDir, "assets"), { recursive: true });
  await (await picture()).png().toFile(join(dataDir, "assets", PNG));
  await (await picture()).gif().toFile(join(dataDir, "assets", GIF));
}

/** Each page's extracted text (items joined with spaces) and its count of painted images. */
async function readPdf(bytes: Uint8Array): Promise<{ text: string; images: number }[]> {
  const task = getDocument({ data: bytes.slice(), useSystemFonts: false });
  const pdf = await task.promise;
  const pages: { text: string; images: number }[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((it) => ("str" in it ? it.str : "")).join(" ").replace(/\s+/g, " ");
    const ops = await page.getOperatorList();
    pages.push({ text, images: ops.fnArray.filter((f) => f === OPS.paintImageXObject).length });
  }
  await task.destroy();
  return pages;
}

async function onePagePdf(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  d.addPage([100, 100]);
  return d.save();
}

/** Records every scope it is asked for; each render is a one-page PDF. */
function recordingRenderer(): PdfRenderer & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async render(scope: PdfScope, input: PdfInput) {
      calls.push("system" in input ? `${scope.kind}:${input.system.id}` : scope.kind);
      return onePagePdf();
    },
  };
}

// ---- whole guide --------------------------------------------------------------------------------

describe("buildGuidePdf with pdfmake and the vendored fonts", () => {
  it("puts the preamble first, then every system in guide order with its drug tables in place and no excluded blocks", async () => {
    const dataDir = join(tmp, "data");
    await writeData(dataDir);
    const fontmap = fontmapFor(TEXTS);
    const pages = await readPdf(await buildGuidePdf(dataDir, "fm", nodeRenderer(dataDir, FONTS_DIR, fontmap)));

    expect(pages[0]?.text).toContain("Preamble title page");
    expect(pages[0]?.text).not.toContain("Intro");
    const all = pages.map((p) => p.text).join(" ");
    const order = ["Preamble title page", "Intro", "⊕", "CARDIO LABEL", "Angina", "Myocarditis", "ANTIANGINAL", "Nitrates", "Murmurs note", "HF PHARM", "Loop diuretics", "Asthma notes"];
    const at = order.map((s) => all.indexOf(s));
    expect(at.every((i) => i >= 0), `missing: ${order.filter((_, i) => at[i] === -1).join(", ")}`).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    for (const s of FORBIDDEN) expect(all).not.toContain(s);
    // The variation selector after ▪ is stripped, never drawn as a missing glyph.
    expect([...all].some((ch) => isVariationSelector(ch.codePointAt(0) ?? 0))).toBe(false);
    expect(all.includes("\u0000")).toBe(false);
    // Pulmonary's two pictures are embedded on its page.
    expect(pages.at(-1)?.text).toContain("Asthma notes");
    expect(pages.at(-1)?.images).toBe(2);
  }, 60_000);

  it("starts with the first system when the guide has no preamble", async () => {
    const dataDir = join(tmp, "data");
    await writeData(dataDir, { ...fmHome(), preamble: [] });
    const r = recordingRenderer();
    const merged = await PDFDocument.load(await buildGuidePdf(dataDir, "fm", r));
    expect(r.calls).toEqual(["system:cardiovascular", "system:pulmonary"]);
    expect(merged.getPageCount()).toBe(2);
  });

  it("renders the preamble scope from home.json before the systems", async () => {
    const dataDir = join(tmp, "data");
    await writeData(dataDir);
    const r = recordingRenderer();
    const merged = await PDFDocument.load(await buildGuidePdf(dataDir, "fm", r));
    expect(r.calls).toEqual(["preamble", "system:cardiovascular", "system:pulmonary"]);
    expect(merged.getPageCount()).toBe(3);
  });
});

describe("mergePdfs", () => {
  it("concatenates every page of every part in order", async () => {
    const part = async (sizes: number[]): Promise<Uint8Array> => {
      const d = await PDFDocument.create();
      for (const w of sizes) d.addPage([w, 100]);
      return d.save();
    };
    const merged = await PDFDocument.load(await mergePdfs([await part([101, 102]), await part([103])]));
    expect(merged.getPages().map((p) => p.getWidth())).toEqual([101, 102, 103]);
  });
});

describe("every stored node kind through pdfmake", () => {
  it("renders a Word page using every block, inline and mark kind without error, keeping its text", async () => {
    const dataDir = join(tmp, "data");
    await writeData(dataDir);
    const border = { style: "single", widthPt: 1, color: "70AD47" };
    const geoms = ["line", "straightConnector1", "arc", "mathPlus", "rightBrace", "ellipse", "roundRect", "rect", "picture"];
    const shapes = geoms.map((geom, i) => ({
      geom, x: i * 30, y: 5, w: 25, h: 20, rot: i === 2 ? 90 : 0, flipH: i === 1, flipV: i === 3,
      stroke: { color: "000000", widthPt: 1, dash: i % 2 ? "dash" : null }, fill: geom === "picture" ? null : "FFFFFF",
      head: geom === "line" ? "triangle" : null, tail: geom === "straightConnector1" ? "arrow" : null, asset: geom === "picture" ? GIF : null,
    }));
    const d: DocJSON = doc(
      para([
        txt("Marked "),
        txt("bold", [{ type: "bold" }]),
        txt(" italic", [{ type: "italic" }]),
        txt(" under", [{ type: "underline", attrs: { style: "dotted" } }]),
        txt(" struck", [{ type: "strike", attrs: { double: true } }]),
        txt("2", [{ type: "vertAlign", attrs: { value: "sup" } }]),
        txt(" caps", [{ type: "caps" }]),
        txt(" Small Caps", [{ type: "smallCaps" }]),
        txt(" big", [{ type: "size", attrs: { pt: 14 } }]),
        txt(" red", [{ type: "color", attrs: { hex: "FF0000" } }]),
        txt(" lit", [{ type: "highlight", attrs: { hex: "FFFF00" } }, { type: "shade", attrs: { hex: "DDDDDD" } }]),
        txt(" link", [{ type: "link", attrs: { href: "#/eor/fm" } }]),
        txt(" ⊕", [{ type: "font", attrs: { family: "Cambria Math" } }]),
        { type: "hard_break" },
        txt("after\tbreak"),
      ], { marker: { text: "•", font: null, marks: [{ type: "bold" }], tabPt: 18 }, indLeft: 36, indFirst: -18, line: { rule: "exact", value: 14 }, spaceAfter: 6 }),
      para("Boxed paragraph", { shade: "E2EFDA", borders: { top: border, right: border, bottom: border, left: border }, align: "center" }),
      para([txt("Before picture"), imageNode(PNG), imageNode(GIF, { rot: 270, flipV: true }), { type: "page_break" }]),
      para("After page break", { indFirst: 24, line: { rule: "atLeast", value: 20 } }),
      table([100, 100, 100], [
        row("r_AAAAAAAAX1", "heading", ["Head A", "Head B", "Head C"], { repeatHeader: true, cantSplit: true }),
        row("r_AAAAAAAAX2", "content", [cell("Spans two", { colspan: 2, fill: "FFF2CC", vAlign: "center" }), cell("Tall", { rowspan: 2, vAlign: "bottom", borders: { left: null, right: border } })], { minHeightPt: 30, cantSplit: true }),
        row("r_AAAAAAAAX3", "content", ["Cell 1", "Cell 2"], { cantSplit: true }),
      ], { indentPt: 12 }),
      { type: "anchored", attrs: { offsetPt: 50 }, content: [{ type: "image_block", attrs: { asset: PNG, widthPt: 60, heightPt: 30, rot: 180, flipH: false, flipV: false } }] },
      { type: "anchored", attrs: { offsetPt: 0 }, content: [{ type: "textbox", attrs: { widthPt: 200, fill: null, border: null, inline: false }, content: [para("Anchored box")] }] },
      { type: "textbox", attrs: { widthPt: 200, fill: "E2EFDA", border, inline: true }, content: [para("Text box words")] },
      { type: "drawing", attrs: { widthPt: 300, heightPt: 40, shapes }, content: [{ type: "drawing_text", attrs: { x: 10, y: 10, w: 100, h: 20, fill: "FFFFFF", border }, content: [para("Drawing label")] }] },
      { type: "rule", attrs: { color: "808080", widthPt: 1.5 } },
      { type: "slide_card", content: [para("Slide card text")] },
      { type: "heading_line", content: [txt("Heading line")] },
    );
    expect(() => schema.nodeFromJSON(d).check()).not.toThrow();
    const w = wordDoc();
    w.blocks = [block("b_AAAAAAAAW1", "prose", d)];
    const fontmap = fontmapFor([...TEXTS, "Marked bold italic under struck2 caps Small Caps big red lit link ⊕ after break • Boxed paragraph Before picture After page break Head A B C Spans two Tall Cell 1 2 Anchored box Text box words Drawing label Slide card text Heading line"]);
    const pages = await readPdf(await nodeRenderer(dataDir, FONTS_DIR, fontmap).render({ kind: "doc" }, { doc: w }));

    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(pages[0]?.text).toContain("Before picture");
    expect(pages[0]?.text).not.toContain("After page break");
    const all = pages.map((p) => p.text).join(" ");
    // Small caps are drawn as capitals at 80 % size, so "Small" becomes "S" + "MALL".
    for (const s of ["Marked", "bold", "CAPS", "MALL", "APS", "link", "⊕", "after", "Boxed paragraph", "After page break", "Head A", "Spans two", "Tall", "Cell 2", "Anchored box", "Text box words", "Drawing label", "Slide card text", "Heading line"]) {
      expect(all, s).toContain(s);
    }
    expect(all).not.toContain("\u0000");
    // Two inline pictures, the anchored picture, and the drawing's picture.
    expect(pages.reduce((n, p) => n + p.images, 0)).toBe(4);
  }, 60_000);
});

// ---- images -------------------------------------------------------------------------------------

describe("imageDataUrl", () => {
  const decode = (url: string): Buffer => Buffer.from(url.slice(url.indexOf(",") + 1), "base64");

  it("embeds an unturned PNG as its stored bytes", async () => {
    const dir = join(tmp, "assets");
    await mkdir(dir);
    await (await picture()).png().toFile(join(dir, PNG));
    const url = await imageDataUrl(dir, { asset: PNG, rot: 0, flipH: false, flipV: false });
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    expect(decode(url).equals(await readFile(join(dir, PNG)))).toBe(true);
  });

  it("converts a GIF to PNG with its turn baked in", async () => {
    const dir = join(tmp, "assets");
    await mkdir(dir);
    await (await picture()).gif().toFile(join(dir, GIF));
    const url = await imageDataUrl(dir, { asset: GIF, rot: 90, flipH: false, flipV: false });
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    const png = sharp(decode(url));
    expect(await png.metadata()).toMatchObject({ format: "png", width: 2, height: 4 });
    // Turned 90° clockwise, the red left half is on top.
    const { data } = await png.removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([data[0], data[2]]).toEqual([255, 0]);
    expect([data[data.length - 3], data[data.length - 1]]).toEqual([0, 255]);
  });

  it("mirrors a PNG horizontally, so its blue half comes first", async () => {
    const dir = join(tmp, "assets");
    await mkdir(dir);
    await (await picture()).png().toFile(join(dir, PNG));
    const url = await imageDataUrl(dir, { asset: PNG, rot: 0, flipH: true, flipV: false });
    const { data, info } = await sharp(decode(url)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([4, 2]);
    expect([data[0], data[2]]).toEqual([0, 255]);
  });
});

// ---- releases -----------------------------------------------------------------------------------

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string, code = 1): RunResult => ({ code, stdout: "", stderr });

/** A fake `gh`/`git`: the first rule whose pattern matches the command line answers; otherwise success. */
function fakeRun(rules: [RegExp, RunResult][] = []): Run & { calls: string[] } {
  const calls: string[] = [];
  const run = ((cmd: string, args: readonly string[]) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    return rules.find(([re]) => re.test(line))?.[1] ?? ok();
  }) as Run & { calls: string[] };
  run.calls = calls;
  return run;
}

const DIGEST = "d".repeat(64);
const body = (commit: string, digest: string): string => JSON.stringify({ body: `commit: ${commit}\ndigest: ${digest}\n` });

describe("releaseRecord", () => {
  it("reports a missing release", () => {
    expect(releaseRecord(fakeRun([[/^gh release view pdf-fm --json body$/, fail("release not found")]]), "fm")).toEqual({ exists: false, commit: null, digest: null });
  });

  it("reads the commit and digest from the release body", () => {
    expect(releaseRecord(fakeRun([[/^gh release view/, ok(body(OLD, DIGEST))]]), "fm")).toEqual({ exists: true, commit: OLD, digest: DIGEST });
  });

  it("reports what the body does not name as null", () => {
    expect(releaseRecord(fakeRun([[/^gh release view/, ok(JSON.stringify({ body: `commit: ${OLD}` }))]]), "fm")).toEqual({ exists: true, commit: OLD, digest: null });
    expect(releaseRecord(fakeRun([[/^gh release view/, ok(JSON.stringify({ body: "built by hand" }))]]), "fm")).toEqual({ exists: true, commit: null, digest: null });
  });

  it("fails on any other gh error", () => {
    expect(() => releaseRecord(fakeRun([[/^gh release view/, fail("HTTP 401: Bad credentials")]]), "fm")).toThrow(/Bad credentials/);
  });
});

describe("consumedFiles", () => {
  it("lists exactly the data files buildGuidePdf and loadFontmap read", async () => {
    const dataDir = join(tmp, "data");
    await writeData(dataDir);
    const files = await consumedFiles(dataDir, "fm");
    expect(files).toContain("g/fm/s/pulmonary.json");

    // With only the listed files (and the content-addressed assets) present, the build still works.
    const only = join(tmp, "only");
    for (const f of files) {
      await mkdir(dirname(join(only, f)), { recursive: true });
      await copyFile(join(dataDir, f), join(only, f));
    }
    const build = async (dir: string): Promise<number> => {
      await loadFontmap(dir);
      return (await PDFDocument.load(await buildGuidePdf(dir, "fm", recordingRenderer()))).getPageCount();
    };
    expect(await build(only)).toBe(3);

    // And each listed file is read: without it the build fails.
    for (const f of files) {
      const bytes = await readFile(join(only, f));
      await rm(join(only, f));
      await expect(build(only), f).rejects.toThrow(/ENOENT/);
      await writeFile(join(only, f), bytes);
    }
  });
});

describe("guideDigest", () => {
  it("changes when any file the guide's PDF reads changes, and only then", async () => {
    const dataDir = join(tmp, "data");
    await writeData(dataDir);
    const base = await guideDigest(dataDir, "fm");
    expect(base).toMatch(/^[0-9a-f]{64}$/);

    // Another guide's data, the site index and build.json (with its timestamp) are not read.
    await writeFile(join(dataDir, "g", "pance", "home.json"), JSON.stringify({ ...fmHome(), guide: "pance", preamble: [block("b_AAAAAAAPR2", "prose", doc(para("PANCE preamble")))] }));
    await writeFile(join(dataDir, "site.json"), "{}");
    await writeFile(join(dataDir, "build.json"), JSON.stringify({ builtAt: "2026-10-04T04:41:00Z" }));
    expect(await guideDigest(dataDir, "fm")).toBe(base);

    const changed: string[] = [];
    for (const path of await consumedFiles(dataDir, "fm")) {
      const original = await readFile(join(dataDir, path), "utf8");
      await writeFile(join(dataDir, path), `${original} `);
      changed.push(await guideDigest(dataDir, "fm"));
      await writeFile(join(dataDir, path), original);
    }
    expect(new Set([base, ...changed]).size).toBe(6);
    expect(await guideDigest(dataDir, "fm")).toBe(base);
  });
});

describe("decide", () => {
  const released = { exists: true, commit: OLD, digest: DIGEST };

  it("regenerates without a release, or when its body lacks the commit or digest", () => {
    const run = fakeRun();
    expect(decide(run, { exists: false, commit: null, digest: null }, DIGEST)).toEqual({ regenerate: true, reason: "no release" });
    expect(decide(run, { exists: true, commit: null, digest: DIGEST }, DIGEST)).toMatchObject({ regenerate: true });
    expect(decide(run, { exists: true, commit: OLD, digest: null }, DIGEST)).toMatchObject({ regenerate: true });
    expect(run.calls).toEqual([]);
  });

  it("regenerates when the guide's built data no longer matches the recorded digest", () => {
    const run = fakeRun();
    expect(decide(run, released, "e".repeat(64))).toEqual({ regenerate: true, reason: "the guide's built data changed" });
    expect(run.calls).toEqual([]);
  });

  it("regenerates when the recorded commit is not in the clone", () => {
    const run = fakeRun([[/^git cat-file/, fail("fatal: Not a valid object name", 128)]]);
    expect(decide(run, released, DIGEST)).toMatchObject({ regenerate: true });
    expect(run.calls).toEqual([`git cat-file -e ${OLD}^{commit}`]);
  });

  it.each([["lib/fonts.ts"], ["package-lock.json"], ["package.json"], ["tools/build/fonts.ts"], ["lib/wordFormat.ts"], ["lib/content/load.ts"], ["app/public/fonts/Carlito-Regular.ttf"]])("regenerates when %s changed", (path) => {
    const run = fakeRun([[/^git diff/, ok(`${path}\n`)]]);
    expect(decide(run, released, DIGEST)).toEqual({ regenerate: true, reason: `code changed since ${OLD}: 1 file(s)` });
    expect(run.calls[1]).toBe(`git diff --name-only ${OLD} HEAD`);
  });

  it("keeps the release when only content, CI config or docs changed and the data digest matches", () => {
    const run = fakeRun([[/^git diff/, ok("content/guides/pance/s/x.json\ncontent/site.json\n.github/workflows/publish.yml\ndocs/notes.txt\nREADME.md\n")]]);
    expect(decide(run, released, DIGEST)).toEqual({ regenerate: false });
  });

  it("fails when git diff fails", () => {
    expect(() => decide(fakeRun([[/^git diff/, fail("fatal: bad revision")]]), released, DIGEST)).toThrow(/git diff failed.*bad revision/);
  });
});

describe("outsideBuild", () => {
  it.each([
    ["content/guides/fm/s/a.json", true],
    [".github/workflows/ci.yml", true],
    ["docs/x.txt", true],
    ["lib/README.md", true],
    ["lib/fonts.ts", false],
    ["package-lock.json", false],
    ["worker/index.ts", false],
    ["contents.ts", false],
  ])("%s → %s", (path, expected) => {
    expect(outsideBuild(path)).toBe(expected);
  });
});

describe("publish", () => {
  it("creates a missing release, uploads the PDF and records the commit and digest", () => {
    const run = fakeRun();
    publish(run, "fm", "Family Medicine", false, "dist/pdf/Family-Medicine-EOR.pdf", HEAD, DIGEST);
    expect(run.calls).toEqual([
      "gh release create pdf-fm --title Family Medicine PDF --notes ",
      "gh release upload pdf-fm dist/pdf/Family-Medicine-EOR.pdf --clobber",
      `gh release edit pdf-fm --notes commit: ${HEAD}\ndigest: ${DIGEST}`,
    ]);
  });

  it("records a body that releaseRecord reads back", () => {
    let notes = "";
    const run = fakeRun();
    publish(((cmd, args) => {
      if (args[1] === "edit") notes = String(args[4]);
      return run(cmd, args);
    }) as Run, "fm", "Family Medicine", true, "f.pdf", HEAD, DIGEST);
    expect(releaseRecord(fakeRun([[/^gh release view/, ok(JSON.stringify({ body: notes }))]]), "fm")).toEqual({ exists: true, commit: HEAD, digest: DIGEST });
  });

  it("replaces the asset of an existing release without creating one", () => {
    const run = fakeRun();
    publish(run, "fm", "Family Medicine", true, "f.pdf", HEAD, DIGEST);
    expect(run.calls).toEqual(["gh release upload pdf-fm f.pdf --clobber", `gh release edit pdf-fm --notes commit: ${HEAD}\ndigest: ${DIGEST}`]);
  });

  it("stops before recording the commit when the upload fails", () => {
    const run = fakeRun([[/^gh release upload/, fail("upload error")]]);
    expect(() => publish(run, "fm", "Family Medicine", true, "f.pdf", HEAD, DIGEST)).toThrow(/upload error/);
    expect(run.calls.some((c) => c.startsWith("gh release edit"))).toBe(false);
  });
});

describe("headCommit", () => {
  it("returns HEAD's sha, and fails when git does", () => {
    expect(headCommit(fakeRun([[/^git rev-parse HEAD$/, ok(`${HEAD}\n`)]]))).toBe(HEAD);
    expect(() => headCommit(fakeRun([[/^git rev-parse/, fail("not a git repository", 128)]]))).toThrow(/not a git repository/);
  });
});

// ---- the CLI --------------------------------------------------------------------------------------

describe("runAll", () => {
  /** gh/git answering for HEAD, with each guide's release recorded at OLD with the given digest (or missing). */
  function releases(recorded: Record<string, string | null>, diff = ""): Run & { calls: string[] } {
    return fakeRun([
      [/^git rev-parse HEAD$/, ok(`${HEAD}\n`)],
      ...Object.entries(recorded).map(([g, d]): [RegExp, RunResult] => [new RegExp(`^gh release view pdf-${g} `), d === null ? fail("release not found") : ok(body(OLD, d))]),
      [/^git diff /, ok(diff)],
    ]);
  }
  const published = (run: { calls: string[] }): string[] => run.calls.filter((c) => /^gh release (create|upload|edit)/.test(c));

  it("builds and publishes a guide without a release, recording HEAD and its digest", async () => {
    const dataDir = join(tmp, "data");
    const outDir = join(tmp, "out");
    await writeData(dataDir);
    const run = releases({ fm: null, pance: await guideDigest(dataDir, "pance") });
    const log: string[] = [];
    const rebuilt = await runAll({ dataDir, fontsDir: FONTS_DIR, outDir, run, log: (l) => log.push(l), renderer: recordingRenderer() });

    expect(rebuilt).toEqual(["fm"]);
    expect(log).toEqual(["fm: regenerating (no release)", "pance: up to date"]);
    const file = join(outDir, "Family-Medicine-EOR.pdf");
    expect((await PDFDocument.load(await readFile(file))).getPageCount()).toBe(3);
    expect(published(run)).toEqual([
      "gh release create pdf-fm --title Family Medicine PDF --notes ",
      `gh release upload pdf-fm ${file} --clobber`,
      `gh release edit pdf-fm --notes commit: ${HEAD}\ndigest: ${await guideDigest(dataDir, "fm")}`,
    ]);
  });

  it("rebuilds the guide whose consumed content changed, and not a guide whose content did not", async () => {
    const dataDir = join(tmp, "data");
    await writeData(dataDir);
    const recorded = { fm: await guideDigest(dataDir, "fm"), pance: await guideDigest(dataDir, "pance") };
    // A content edit to PANCE alone: its built home changes; git sees only content/.
    await writeFile(join(dataDir, "g", "pance", "home.json"), JSON.stringify({ ...fmHome(), guide: "pance", preamble: [block("b_AAAAAAAPR2", "prose", doc(para("PANCE preamble")))] }));
    const run = releases(recorded, "content/guides/pance/home.json\n");
    const log: string[] = [];
    expect(await runAll({ dataDir, fontsDir: FONTS_DIR, outDir: join(tmp, "out"), run, log: (l) => log.push(l), renderer: recordingRenderer() })).toEqual(["pance"]);
    expect(log).toEqual(["fm: up to date", "pance: regenerating (the guide's built data changed)"]);
    expect(published(run).every((c) => c.includes("pdf-pance"))).toBe(true);
  });

  it("rebuilds a guide when another content file it consumes changes, though no code changed", async () => {
    const dataDir = join(tmp, "data");
    await writeData(dataDir);
    const recorded = { fm: await guideDigest(dataDir, "fm"), pance: await guideDigest(dataDir, "pance") };
    const pulm = pulmWithPictures();
    pulm.blocks = [block("b_AAAAAAAPU1", "prose", doc(para("Asthma notes, revised")))];
    await writeFile(join(dataDir, "g", "fm", "s", "pulmonary.json"), JSON.stringify(pulm));
    const run = releases(recorded, "content/guides/fm/pulmonary.json\n");
    expect(await runAll({ dataDir, fontsDir: FONTS_DIR, outDir: join(tmp, "out"), run, log: () => {}, renderer: recordingRenderer() })).toEqual(["fm"]);
  });

  it("rebuilds every guide when lib/fonts.ts or the lockfile changed", async () => {
    const dataDir = join(tmp, "data");
    await writeData(dataDir);
    const recorded = { fm: await guideDigest(dataDir, "fm"), pance: await guideDigest(dataDir, "pance") };
    for (const diff of ["lib/fonts.ts\n", "package-lock.json\n"]) {
      const log: string[] = [];
      expect(await runAll({ dataDir, fontsDir: FONTS_DIR, outDir: join(tmp, "out"), run: releases(recorded, diff), log: (l) => log.push(l), renderer: recordingRenderer() })).toEqual(["fm", "pance"]);
      expect(log).toEqual([`fm: regenerating (code changed since ${OLD}: 1 file(s))`, `pance: regenerating (code changed since ${OLD}: 1 file(s))`]);
    }
  });
});

describe("main", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = process.cwd();
  });
  afterEach(() => {
    process.chdir(cwd);
  });

  it.each([[[]], [["--guide", "fm"]], [["--all", "--guide", "fm"]], [["--build"]]])("prints usage and exits 2 for %j", async (argv) => {
    const log: string[] = [];
    expect(await main(argv, fakeRun(), (l) => log.push(l))).toBe(2);
    expect(log).toEqual(["usage: node tools/pdf/index.ts --all | --guide <g> --out <file>"]);
  });

  it("--all makes no release changes when every guide is up to date", async () => {
    const dataDir = join(tmp, "dist", "data");
    await writeData(dataDir);
    process.chdir(tmp);
    const run = fakeRun([
      [/^git rev-parse HEAD$/, ok(HEAD)],
      [/^gh release view pdf-fm /, ok(body(OLD, await guideDigest(dataDir, "fm")))],
      [/^gh release view pdf-pance /, ok(body(OLD, await guideDigest(dataDir, "pance")))],
      [/^git diff /, ok("")],
    ]);
    const log: string[] = [];
    expect(await main(["--all"], run, (l) => log.push(l))).toBe(0);
    expect(log).toEqual(["fm: up to date", "pance: up to date"]);
    expect(run.calls.filter((c) => /^gh release (create|upload|edit)/.test(c))).toEqual([]);
  });

  it("--guide builds one guide's whole PDF locally from dist/data and the vendored fonts, with no release calls", async () => {
    await writeData(join(tmp, "dist", "data"));
    await mkdir(join(tmp, "app", "public", "fonts"), { recursive: true });
    for (const f of [...FONTS.map((x) => x.file), "Carlito-Bold.ttf", "Carlito-Italic.ttf", "Carlito-BoldItalic.ttf"]) await copyFile(join(FONTS_DIR, f), join(tmp, "app", "public", "fonts", f));
    process.chdir(tmp);
    const run = fakeRun();
    const log: string[] = [];
    expect(await main(["--guide", "fm", "--out", join("out", "fm.pdf")], run, (l) => log.push(l))).toBe(0);
    expect(run.calls).toEqual([]);
    expect(log).toEqual([`wrote ${join("out", "fm.pdf")}`]);
    const pages = await readPdf(new Uint8Array(await readFile(join(tmp, "out", "fm.pdf"))));
    expect(pages[0]?.text).toContain("Preamble title page");
    expect(pages.at(-1)?.text).toContain("Asthma notes");
  }, 60_000);
});
