// The processing job (50 §50.9) over temporary content roots, and its CLI over a temporary git repo.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newId, parseTrailers, serializeFile } from "../../lib/content/index.ts";
import type { AsIsFile, BlockFile, DeckFile, FileText, UploadExt, UploadFile, WordDocFile } from "../../lib/content/index.ts";
import { readContent, readContentIfExists, readStoredFile, writeContent } from "../../lib/content/fs.ts";
import { buildDocx, para, png, run } from "../../lib/docx/fixtures.ts";
import { convertDeck } from "../import/pptx.ts";
import { verifyWordDoc } from "../verify/index.ts";
import type { SourceReport } from "../verify/index.ts";
import { main } from "./index.ts";
import { processItem, sofficeConvert } from "./process.ts";
import type { ProcessDeps, Soffice } from "./process.ts";

// When set, the copy of the staged result into the content tree stops partway with EIO.
const copy = vi.hoisted(() => ({ fails: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    cp: async (...args: Parameters<typeof fs.cp>): Promise<void> => {
      if (!copy.fails) return fs.cp(...args);
      const [from, to, options] = args;
      await fs.cp(from, to, { ...options, filter: (src) => !src.endsWith("file.json") });
      throw Object.assign(new Error("EIO: i/o error, copyfile"), { code: "EIO" });
    },
  };
});
afterEach(() => { copy.fails = false; });

const WIN_SOFFICE = "C:\\Program Files\\LibreOffice\\program\\soffice.exe";
const HAS_SOFFICE = process.env.PA_SOFFICE !== undefined || existsSync(WIN_SOFFICE) || existsSync("/usr/bin/soffice");

const clean = (): SourceReport => ({ source: "x", counts: {}, discrepancies: [], info: [] });

interface Logged {
  deps: ProcessDeps;
  errors: string[];
  sofficeCalls: string[];
}

/** Deps whose LibreOffice is `soffice` (a stub by default) and whose comparison reports `report`. */
function fakeDeps(report: () => SourceReport = clean, soffice?: Soffice): Logged {
  const errors: string[] = [];
  const sofficeCalls: string[] = [];
  const deps: ProcessDeps = {
    soffice: soffice ?? (async (_bytes, from, to) => {
      sofficeCalls.push(`${from}->${to}`);
      return makePdf([["converted"]]);
    }),
    verifyWordDoc: async () => report(),
    log: () => undefined,
    error: (line) => { errors.push(line); },
  };
  return { deps, errors, sofficeCalls };
}

async function makePdf(pages: string[][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([400, 400]);
    lines.forEach((line, i) => page.drawText(line, { x: 40, y: 340 - i * 40, size: 14, font }));
  }
  return doc.save();
}

const PNS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

/** A minimal PowerPoint package with one text box per slide. */
function pptx(slides: string[]): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    "ppt/presentation.xml": strToU8(`<p:presentation ${PNS}><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("")}</p:sldIdLst></p:presentation>`),
    "ppt/_rels/presentation.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, i) => `<Relationship Id="rId${i + 2}" Type="slide" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>`),
  };
  slides.forEach((text, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${PNS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/></p:nvGrpSpPr>` +
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="x"/></p:nvSpPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>` +
      "</p:spTree></p:cSld></p:sld>",
    );
  });
  return zipSync(files);
}

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function uploadOf(id: string, fileName: string, bytes: Uint8Array, replaces: null | true = null, parts = 1): UploadFile {
  const ext = fileName.slice(fileName.lastIndexOf(".") + 1) as UploadExt;
  return { v: 1, id, fileName, ext, size: bytes.length, sha256: sha(bytes), parts, replaces };
}

/** The text of a stored doc, its text nodes joined. */
function textOf(node: unknown): string {
  if (typeof node !== "object" || node === null) return "";
  const n = node as { text?: string; content?: unknown[] };
  return (n.text ?? "") + (n.content ?? []).map(textOf).join("");
}

const filePath = (id: string): string => `content/files/${id}/file.json`;
const docPath = (id: string): string => `content/docs/${id}/doc.json`;

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "pa-inbox-test-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** An added document as the upload's step 8 leaves it on main. */
async function pendingAdd(name: string, original: string, kind: AsIsFile["kind"]): Promise<string> {
  const id = newId("d");
  await writeContent(root, filePath(id), { v: 1, id, name, kind, original, view: null, pages: null, text: null, removed: null, state: "processing" } satisfies AsIsFile);
  return id;
}

async function wordPages(id: string): Promise<string[]> {
  const doc = await readContent<WordDocFile>(root, docPath(id));
  const texts: string[] = [];
  for (const b of doc.blocks) texts.push(textOf((await readContent<BlockFile>(root, `content/docs/${id}/blocks/${b}.json`)).doc));
  return texts;
}

describe("processItem: adds", () => {
  it.skipIf(!HAS_SOFFICE)("converts a .doc that is really RTF through LibreOffice into a Word page reading Hello", async () => {
    const id = await pendingAdd("Notes", "notes.doc", "word");
    const bytes = strToU8("{\\rtf1\\ansi Hello}");
    const errors: string[] = [];
    const result = await processItem(root, uploadOf(id, "notes.doc", bytes), bytes, {
      soffice: sofficeConvert, verifyWordDoc, log: () => undefined, error: (l) => { errors.push(l); },
    });
    expect(errors).toEqual([]);
    expect(result?.ok).toBe(true);
    expect(parseTrailers(result?.message ?? "")).toMatchObject({ kind: "inbox", changed: [id] });
    const doc = await readContent<WordDocFile>(root, docPath(id));
    expect(doc).toMatchObject({ name: "Notes", kind: "word", source: "notes.doc", removed: null });
    expect((await wordPages(id)).join("")).toBe("Hello");
    // The pending as-is record is gone: the document moved to docs/.
    expect(existsSync(join(root, "content", "files", id))).toBe(false);
  }, 120_000);

  it("ends a .docx whose comparison finds a discrepancy as failed, with her original stored and no page written", async () => {
    const id = await pendingAdd("Cardio", "cardio.docx", "word");
    const bytes = buildDocx({ body: para(run("Chest pain")) });
    const discrepancy = { kind: "text", story: "body", index: 0, expected: "Chest pain", actual: "Chest" };
    const { deps, errors } = fakeDeps(() => ({ ...clean(), discrepancies: [discrepancy] }));
    const result = await processItem(root, uploadOf(id, "cardio.docx", bytes), bytes, deps);
    expect(result?.ok).toBe(false);
    expect(parseTrailers(result?.message ?? "")).toMatchObject({ kind: "inbox", changed: [id] });
    expect((await readContent<AsIsFile>(root, filePath(id))).state).toBe("failed");
    expect(await readStoredFile(root, id, "cardio.docx")).toEqual(bytes);
    expect(existsSync(join(root, "content", "docs", id))).toBe(false);
    expect(errors.join("\n")).toContain("differs from the Word file in 1 place");
  });

  it("converts a .docx whose comparison is clean into a Word page", async () => {
    const id = await pendingAdd("Cardio", "cardio.docx", "word");
    const bytes = buildDocx({ body: para(run("Chest pain")) + para(run("Dyspnea")) });
    const { deps } = fakeDeps();
    const result = await processItem(root, uploadOf(id, "cardio.docx", bytes), bytes, deps);
    expect(result?.ok).toBe(true);
    // Consecutive paragraphs share one prose block.
    expect(await wordPages(id)).toEqual(["Chest painDyspnea"]);
    expect((await readContent<WordDocFile>(root, docPath(id))).source).toBe("cardio.docx");
  });

  it("fails an item whose parts don't match upload.json, storing nothing as her original", async () => {
    const id = await pendingAdd("Chart", "chart.pdf", "pdf");
    const bytes = await makePdf([["one"]]);
    const upload = { ...uploadOf(id, "chart.pdf", bytes), sha256: "0".repeat(64) };
    const { deps, errors } = fakeDeps();
    const result = await processItem(root, upload, bytes, deps);
    expect(result?.ok).toBe(false);
    expect((await readContent<AsIsFile>(root, filePath(id))).state).toBe("failed");
    expect(existsSync(join(root, "content", "files", id, "chart.pdf"))).toBe(false);
    expect(errors.join("\n")).toContain("upload.json says");
  });

  it("stores a pdf as-is with its page count and search text", async () => {
    const id = await pendingAdd("Antibiotic Flower Charts", "flowers.pdf", "pdf");
    const bytes = await makePdf([["Penicillins"], ["Cephalosporins"]]);
    const { deps } = fakeDeps();
    const result = await processItem(root, uploadOf(id, "flowers.pdf", bytes), bytes, deps);
    expect(result?.ok).toBe(true);
    expect(result?.message.split("\n")[0]).toBe("Inbox: flowers.pdf");
    expect(await readContent<AsIsFile>(root, filePath(id))).toEqual({
      v: 1, id, name: "Antibiotic Flower Charts", kind: "pdf", original: "flowers.pdf", view: "flowers.pdf", pages: 2, text: "text.json", removed: null, state: "ready",
    });
    expect((await readContent<FileText>(root, `content/files/${id}/text.json`)).pages).toEqual(["Penicillins", "Cephalosporins"]);
    expect(await readStoredFile(root, id, "flowers.pdf")).toEqual(bytes);
  });

  it("stores an image as-is", async () => {
    const id = await pendingAdd("ECG", "ecg.png", "image");
    const bytes = await png(4, 4);
    const result = await processItem(root, uploadOf(id, "ecg.png", bytes), bytes, fakeDeps().deps);
    expect(result?.ok).toBe(true);
    expect(await readContent<AsIsFile>(root, filePath(id))).toMatchObject({ kind: "image", view: "ecg.png", state: "ready" });
    expect(await readStoredFile(root, id, "ecg.png")).toEqual(bytes);
  });

  it("stores a slideshow with LibreOffice's PDF view and the slides' text", async () => {
    const id = await pendingAdd("Lecture", "lecture.pptx", "slides");
    const bytes = pptx(["Murmurs", "Valves"]);
    const { deps, sofficeCalls } = fakeDeps();
    const result = await processItem(root, uploadOf(id, "lecture.pptx", bytes), bytes, deps);
    expect(result?.ok).toBe(true);
    expect(sofficeCalls).toEqual(["pptx->pdf"]);
    expect(await readContent<AsIsFile>(root, filePath(id))).toMatchObject({ kind: "slides", original: "lecture.pptx", view: "lecture.pdf", pages: 2, text: "text.json", state: "ready" });
    expect((await readContent<FileText>(root, `content/files/${id}/text.json`)).pages).toEqual(["Murmurs", "Valves"]);
    expect(await readStoredFile(root, id, "lecture.pptx")).toEqual(bytes);
    expect((await readStoredFile(root, id, "lecture.pdf")).length).toBeGreaterThan(0);
  });

  it("does nothing for an item that is no longer processing, or whose document is gone", async () => {
    const id = await pendingAdd("ECG", "ecg.png", "image");
    const bytes = await png(4, 4);
    const ready = { ...(await readContent<AsIsFile>(root, filePath(id))), view: "ecg.png", state: "ready" as const };
    await writeContent(root, filePath(id), ready);
    expect(await processItem(root, uploadOf(id, "ecg.png", bytes), bytes, fakeDeps().deps)).toBeNull();
    expect(await processItem(root, uploadOf(newId("d"), "ecg.png", bytes), bytes, fakeDeps().deps)).toBeNull();
    expect(await readContent<AsIsFile>(root, filePath(id))).toEqual(ready);
  });
});

describe("processItem: replaces", () => {
  const replacing = { fileName: "new.pdf", at: "2026-10-04T20:00:00Z" };

  it("moves a Word document to files/ when it is replaced with a pdf, keeping its name", async () => {
    const id = await pendingAdd("Cardio", "cardio.docx", "word");
    const docx = buildDocx({ body: para(run("Chest pain")) });
    await processItem(root, uploadOf(id, "cardio.docx", docx), docx, fakeDeps().deps);
    await writeContent(root, docPath(id), { ...(await readContent<WordDocFile>(root, docPath(id))), name: "Cardio notes", replacing });

    const bytes = await makePdf([["Chest pain"]]);
    const result = await processItem(root, uploadOf(id, "new.pdf", bytes, true), bytes, fakeDeps().deps);
    expect(result?.ok).toBe(true);
    expect(result?.message.split("\n")[0]).toBe("Replace Cardio notes with new.pdf");
    expect(parseTrailers(result?.message ?? "")).toMatchObject({ kind: "doc-replace", changed: [id], file: "new.pdf" });
    expect(existsSync(join(root, "content", "docs", id))).toBe(false);
    const file = await readContent<AsIsFile>(root, filePath(id));
    expect(file).toMatchObject({ name: "Cardio notes", kind: "pdf", original: "new.pdf", removed: null, state: "ready" });
    expect(file.replacing).toBeUndefined();
  });

  it("moves an as-is document to docs/ when it is replaced with a Word file, removing its old stored files", async () => {
    const id = await pendingAdd("Chart", "chart.png", "image");
    const img = await png(4, 4);
    await processItem(root, uploadOf(id, "chart.png", img), img, fakeDeps().deps);
    await writeContent(root, filePath(id), { ...(await readContent<AsIsFile>(root, filePath(id))), replacing: { fileName: "chart.docx", at: replacing.at } });

    const docx = buildDocx({ body: para(run("Murmur grades")) });
    const result = await processItem(root, uploadOf(id, "chart.docx", docx, true), docx, fakeDeps().deps);
    expect(result?.ok).toBe(true);
    expect(existsSync(join(root, "content", "files", id))).toBe(false);
    expect(await readContent<WordDocFile>(root, docPath(id))).toMatchObject({ name: "Chart", source: "chart.docx" });
    expect((await readContent<WordDocFile>(root, docPath(id))).replacing).toBeUndefined();
  });

  it("leaves the current document untouched and clears replacing when the replacement fails", async () => {
    const id = await pendingAdd("Chart", "chart.png", "image");
    const img = await png(4, 4);
    await processItem(root, uploadOf(id, "chart.png", img), img, fakeDeps().deps);
    const shown = await readContent<AsIsFile>(root, filePath(id));
    await writeContent(root, filePath(id), { ...shown, replacing });

    const bytes = await makePdf([["x"]]);
    const { deps, errors } = fakeDeps();
    const result = await processItem(root, { ...uploadOf(id, "new.pdf", bytes, true), size: 1 }, bytes, deps);
    expect(result?.ok).toBe(false);
    expect(parseTrailers(result?.message ?? "")).toMatchObject({ kind: "inbox", changed: [id] });
    expect(await readContent<AsIsFile>(root, filePath(id))).toEqual(shown);
    expect(await readStoredFile(root, id, "chart.png")).toEqual(img);
    expect(existsSync(join(root, "content", "files", id, "new.pdf"))).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it("does nothing for a replace with no replacement in progress", async () => {
    const id = await pendingAdd("Chart", "chart.png", "image");
    const img = await png(4, 4);
    await processItem(root, uploadOf(id, "chart.png", img), img, fakeDeps().deps);
    const bytes = await makePdf([["x"]]);
    expect(await processItem(root, uploadOf(id, "new.pdf", bytes, true), bytes, fakeDeps().deps)).toBeNull();
  });

  it("rebuilds the psych deck's slides when its document is replaced", async () => {
    const id = newId("d");
    const old = newId("s");
    const oldDoc = convertDeck(pptx(["Old slide"])).at(0);
    if (!oldDoc) throw new Error("the one-slide deck converted to no slides");
    await writeContent(root, `content/slides/psy/blocks/${old}.json`, { v: 1, id: old, kind: "slide", doc: oldDoc, meta: {} } satisfies BlockFile);
    await writeContent(root, "content/slides/psy/deck.json", { v: 1, guide: "psy", kind: "own", title: "Psych review", file: id, slides: [old] } satisfies DeckFile);
    await writeContent(root, filePath(id), { v: 1, id, name: "Psych review", kind: "slides", original: "psych.pptx", view: null, pages: 1, text: null, removed: null, replacing: { fileName: "psych2.pptx", at: replacing.at } } satisfies AsIsFile);

    const bytes = pptx(["Lithium", "Clozapine"]);
    const { deps, sofficeCalls } = fakeDeps();
    const result = await processItem(root, uploadOf(id, "psych2.pptx", bytes, true), bytes, deps);
    expect(result?.ok).toBe(true);
    expect(sofficeCalls).toEqual([]);
    const deck = await readContent<DeckFile>(root, "content/slides/psy/deck.json");
    expect(deck.slides).toHaveLength(2);
    expect(deck.slides).not.toContain(old);
    expect((await readdir(join(root, "content", "slides", "psy", "blocks"))).sort()).toEqual(deck.slides.map((s) => `${s}.json`).sort());
    const texts = await Promise.all(deck.slides.map(async (s) => textOf((await readContent<BlockFile>(root, `content/slides/psy/blocks/${s}.json`)).doc)));
    expect(texts).toEqual(["Lithium", "Clozapine"]);
    expect(await readContent<AsIsFile>(root, filePath(id))).toMatchObject({ original: "psych2.pptx", view: null, pages: 2, text: null, state: "ready" });
    expect(await readContentIfExists(root, `content/files/${id}/text.json`)).toBeNull();
  });
});

describe("tools/inbox CLI", () => {
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });

  it("processes the item read from its inbox branch and commits the result on the checked-out branch", async () => {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "test");
    git("config", "user.email", "test@example.invalid");
    git("config", "core.autocrlf", "false");
    const id = await pendingAdd("ECG", "ecg.png", "image");
    git("add", "-A");
    git("commit", "-q", "-m", "Add ECG");

    // The upload's branch: upload.json plus the file cut into two parts.
    const bytes = await png(6, 6);
    const half = Math.floor(bytes.length / 2);
    git("checkout", "-q", "-b", "upload");
    await mkdir(join(root, "inbox", id), { recursive: true });
    await writeFile(join(root, "inbox", id, "upload.json"), serializeFile(`inbox/${id}/upload.json`, uploadOf(id, "ecg.png", bytes, null, 2)));
    await writeFile(join(root, "inbox", id, "part-000"), bytes.subarray(0, half));
    await writeFile(join(root, "inbox", id, "part-001"), bytes.subarray(half));
    git("add", "-A");
    git("commit", "-q", "-m", "Inbox: ecg.png");
    git("update-ref", `refs/remotes/origin/inbox/${id}`, "HEAD");
    git("checkout", "-q", "main");

    expect(await main(["--item", id], { root, deps: fakeDeps().deps })).toBe(0);
    expect(git("log", "-1", "--format=%s")).toBe("Inbox: ecg.png\n");
    expect(parseTrailers(git("log", "-1", "--format=%B"))).toMatchObject({ kind: "inbox", changed: [id] });
    expect(JSON.parse(git("show", `HEAD:content/files/${id}/file.json`))).toMatchObject({ state: "ready", view: "ecg.png" });
    expect(new Uint8Array(execFileSync("git", ["show", `HEAD:content/files/${id}/ecg.png`], { cwd: root }))).toEqual(bytes);
    expect(git("status", "--porcelain")).toBe("");

    // A re-dispatched run finds the item ready and commits nothing.
    const head = git("rev-parse", "HEAD");
    expect(await main(["--item", id], { root, deps: fakeDeps().deps })).toBe(0);
    expect(git("rev-parse", "HEAD")).toBe(head);
  });

  it("fails the job without a commit when moving the result into the tree throws partway, and a re-run from a fresh checkout succeeds", async () => {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "test");
    git("config", "user.email", "test@example.invalid");
    git("config", "core.autocrlf", "false");
    const id = await pendingAdd("Chart", "chart.png", "image");
    const img = await png(4, 4);
    await processItem(root, uploadOf(id, "chart.png", img), img, fakeDeps().deps);
    const shown = await readContent<AsIsFile>(root, filePath(id));
    await writeContent(root, filePath(id), { ...shown, replacing: { fileName: "chart2.png", at: "2026-10-04T20:00:00Z" } });
    git("add", "-A");
    git("commit", "-q", "-m", "Replace chart.png");

    const bytes = await png(8, 8);
    git("checkout", "-q", "-b", "upload");
    await mkdir(join(root, "inbox", id), { recursive: true });
    await writeFile(join(root, "inbox", id, "upload.json"), serializeFile(`inbox/${id}/upload.json`, uploadOf(id, "chart2.png", bytes, true)));
    await writeFile(join(root, "inbox", id, "part-000"), bytes);
    git("add", "-A");
    git("commit", "-q", "-m", "Inbox: chart2.png");
    const branch = git("rev-parse", "HEAD");
    git("update-ref", `refs/remotes/origin/inbox/${id}`, "HEAD");
    git("checkout", "-q", "main");
    const head = git("rev-parse", "HEAD");

    copy.fails = true;
    await expect(main(["--item", id], { root, deps: fakeDeps().deps })).rejects.toThrow("EIO");
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("rev-parse", `refs/remotes/origin/inbox/${id}`)).toBe(branch);

    // The re-run starts from a fresh checkout of main.
    copy.fails = false;
    git("checkout", "-q", "--", ".");
    git("clean", "-fdq");
    expect(await main(["--item", id], { root, deps: fakeDeps().deps })).toBe(0);
    expect(git("log", "-1", "--format=%s")).toBe("Replace Chart with chart2.png\n");
    expect(JSON.parse(git("show", `HEAD:content/files/${id}/file.json`))).toMatchObject({ original: "chart2.png", state: "ready" });
    expect(new Uint8Array(execFileSync("git", ["show", `HEAD:content/files/${id}/chart2.png`], { cwd: root }))).toEqual(bytes);
    expect(git("status", "--porcelain")).toBe("");
  });

  it("refuses an argument that isn't a d_ id", async () => {
    const { deps, errors } = fakeDeps();
    expect(await main(["--item", "../etc"], { root, deps })).toBe(2);
    expect(await main([], { root, deps })).toBe(2);
    expect(errors).toEqual(["usage: node tools/inbox/index.ts --item <d_id>", "usage: node tools/inbox/index.ts --item <d_id>"]);
  });
});
