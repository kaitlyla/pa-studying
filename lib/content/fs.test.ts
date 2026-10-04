// Node file-system store over a temporary content tree.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkBlockDir, listDir, listGapBlocks, readContent, readContentIfExists, readStoredFile, readSystem, removeContent,
  stagedTree, writeAsset, writeContent, writeStoredFile,
} from "./fs.ts";
import { serializeFile } from "./files.ts";
import type { BlockFile, SystemFile } from "./types.ts";

const id = (p: string, n: number): string => `${p}_${String(n).padStart(10, "0")}`;
const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const block = (n: number): BlockFile => ({ v: 1, id: id("b", n), kind: "prose", doc: { type: "doc", content: [para(`block ${n}`)] }, meta: {} });

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "pa-fs-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const sysBase = "content/guides/fm/cardiovascular";

async function writeSystem(blockIds: number[], listed = blockIds): Promise<void> {
  for (const n of blockIds) await writeContent(root, `${sysBase}/blocks/${id("b", n)}.json`, block(n));
  const sys: SystemFile = { v: 1, id: "cardiovascular", blocks: listed.map((n) => id("b", n)) };
  await writeContent(root, `${sysBase}/system.json`, sys);
}

describe("reading and writing", () => {
  it("reports a missing file, or null when asked", async () => {
    await expect(readContent(root, "content/site.json")).rejects.toThrow(/file not found/);
    expect(await readContentIfExists(root, "content/site.json")).toBeNull();
    expect(await listDir(root, "content/gapfill")).toEqual([]);
  });

  it("treats only a missing path as absent; other read errors propagate", async () => {
    // A directory where a file is expected: reading it fails with EISDIR, not ENOENT.
    await mkdir(join(root, "content", "site.json"), { recursive: true });
    await expect(readContentIfExists(root, "content/site.json")).rejects.toMatchObject({ code: "EISDIR" });
    await expect(readContent(root, "content/site.json")).rejects.toMatchObject({ code: "EISDIR" });
    // A file where a directory is expected: listing it fails with ENOTDIR.
    await writeFile(join(root, "content", "gapfill"), "not a directory");
    await expect(listDir(root, "content/gapfill")).rejects.toMatchObject({ code: "ENOTDIR" });
    await expect(listGapBlocks(root)).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(await readContentIfExists(root, "content/places/other.json")).toBeNull();
    expect(await listDir(root, "content/updates")).toEqual([]);
  });

  it("refuses to write an invalid record and leaves no file", async () => {
    await expect(writeContent(root, `${sysBase}/system.json`, { v: 1, id: "renal", blocks: [] })).rejects.toThrow(/\.id: expected cardiovascular \(from the file's path\)/);
    expect(await readContentIfExists(root, `${sysBase}/system.json`)).toBeNull();
  });

  it("reads back what it wrote, normalized", async () => {
    await writeContent(root, `${sysBase}/blocks/${id("b", 1)}.json`, block(1));
    const back = await readContentIfExists<BlockFile>(root, `${sysBase}/blocks/${id("b", 1)}.json`);
    expect(back?.doc.content[0]).toMatchObject({ type: "paragraph", attrs: { indLeft: 0, marker: null }, content: [{ type: "text", text: "block 1" }] });
  });

  it("removes files and directories", async () => {
    await writeSystem([1]);
    await removeContent(root, `${sysBase}/blocks`);
    expect(await listDir(root, `${sysBase}/blocks`)).toEqual([]);
    await removeContent(root, `${sysBase}/blocks`);
  });
});

describe("systems (20 §20.4)", () => {
  it("reads a system's blocks in list order", async () => {
    await writeSystem([2, 1]);
    const { system, blocks } = await readSystem(root, "fm", "cardiovascular");
    expect(system.blocks).toEqual([id("b", 2), id("b", 1)]);
    expect(blocks.map((b) => b.id)).toEqual([id("b", 2), id("b", 1)]);
  });

  it("refuses a block file the list does not name, and a listed block with no file", async () => {
    await writeSystem([1, 2], [1]);
    await expect(readSystem(root, "fm", "cardiovascular")).rejects.toThrow(/not listed by its owner/);
    await expect(checkBlockDir(root, `${sysBase}/blocks`, [id("b", 1), id("b", 2), id("b", 3)])).rejects.toThrow(/listed block file is missing/);
  });
});

describe("staged trees", () => {
  const blockPath = (n: number): string => `${sysBase}/blocks/${id("b", n)}.json`;
  const staged = (entries: [string, unknown][]) =>
    stagedTree(root, entries.map(([path, value]): [string, string | null] => [path, value === null ? null : serializeFile(path.replaceAll("\\", "/"), value)]));

  it("reads staged files over the disk, hides staged deletions and lists both, writing nothing", async () => {
    await writeSystem([1, 2]);
    const tree = staged([
      [blockPath(3), block(3)],
      [blockPath(2), null],
      [`${sysBase}/system.json`, { v: 1, id: "cardiovascular", blocks: [id("b", 1), id("b", 3)] }],
      ["content/guides/fm/renal/system.json", { v: 1, id: "renal", blocks: [] }],
    ]);

    const { blocks } = await readSystem(tree, "fm", "cardiovascular");
    expect(blocks.map((b) => b.id)).toEqual([id("b", 1), id("b", 3)]);
    expect(await listDir(tree, `${sysBase}/blocks`)).toEqual([`${id("b", 1)}.json`, `${id("b", 3)}.json`]);
    expect(await listDir(tree, "content/guides/fm")).toEqual(["cardiovascular", "renal"]);
    await expect(readContent(tree, blockPath(2))).rejects.toThrow(/file not found/);
    expect(await readContentIfExists(tree, blockPath(2))).toBeNull();

    expect(await listDir(root, `${sysBase}/blocks`)).toEqual([`${id("b", 1)}.json`, `${id("b", 2)}.json`]);
    expect(await listDir(root, "content/guides/fm")).toEqual(["cardiovascular"]);
    expect(await readContentIfExists(root, blockPath(3))).toBeNull();
  });

  it("checks a blocks directory as staged: an unlisted staged block and a deleted listed block are refused", async () => {
    await writeSystem([1]);
    await expect(readSystem(staged([[blockPath(2), block(2)]]), "fm", "cardiovascular")).rejects.toThrow(/not listed by its owner/);
    await expect(readSystem(staged([[blockPath(1), null]]), "fm", "cardiovascular")).rejects.toThrow(/listed block file is missing/);
  });

  it("takes backslash-separated staged paths as repository paths", async () => {
    await writeSystem([1]);
    const tree = staged([[`${sysBase}\\blocks\\${id("b", 1)}.json`, null]]);
    expect(await listDir(tree, `${sysBase}/blocks`)).toEqual([]);
  });
});

describe("gap-fill series check on write (20 §20.9)", () => {
  const track = (over: Record<string, unknown> = {}) => ({
    series: "idsa-cap", label: "IDSA/ATS CAP guideline", org: "IDSA/ATS", edition: 2019, method: "pubmed", term: "community acquired pneumonia", title: "(\\d{4}).*Pneumonia", ...over,
  });
  const gap = (n: number, t: unknown) => ({
    v: 1, id: id("g", n), kind: "gap", doc: { type: "doc", content: [para("text")] },
    meta: { title: "CAP", relevantTo: "Pneumonia", written: "2026-10", differs: null, sources: [{ name: "CAP", org: "IDSA/ATS", year: "2019", url: null, type: "guideline", track: t }], ownerEdits: [] },
  });

  it("compares a new gap block's tracks against every stored gap block", async () => {
    await writeContent(root, `content/gapfill/${id("g", 1)}.json`, gap(1, track()));
    await writeContent(root, `content/gapfill/${id("g", 1)}.evidence.json`, {
      v: 1, block: id("g", 1), author: "a", claims: [], verification: { verifier: "b", at: "2026-10-06", result: "pass", notes: [] },
    });
    expect(await writeContent(root, `content/gapfill/${id("g", 2)}.json`, gap(2, track({ edition: 2026 })))).toBe(true);
    await expect(writeContent(root, `content/gapfill/${id("g", 3)}.json`, gap(3, track({ term: "pneumonia" })))).rejects.toThrow(/differs from the one in g_0000000001/);
    expect(await readContentIfExists(root, `content/gapfill/${id("g", 3)}.json`)).toBeNull();
    expect((await listGapBlocks(root)).map((g) => g.id)).toEqual([id("g", 1), id("g", 2)]);
  });

  it("lets a block change its own series descriptor when no other block cites it", async () => {
    await writeContent(root, `content/gapfill/${id("g", 1)}.json`, gap(1, track()));
    expect(await writeContent(root, `content/gapfill/${id("g", 1)}.json`, gap(1, track({ term: "pneumonia" })))).toBe(true);
  });
});

describe("binary files", () => {
  it("stores an asset once under its content address", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const name = await writeAsset(root, bytes, ".png");
    expect(name).toMatch(/^[0-9a-f]{32}\.png$/);
    const disk = join(root, "content", "assets", name);
    expect(new Uint8Array(await readFile(disk))).toEqual(bytes);
    // An existing asset is never rewritten: a marker written over it survives a second store.
    await writeFile(disk, "marker");
    expect(await writeAsset(root, bytes, ".png")).toBe(name);
    expect(await readFile(disk, "utf8")).toBe("marker");
  });

  it("writes and reads stored files by plain name only", async () => {
    const d = id("d", 1);
    const bytes = new Uint8Array([1, 2, 3]);
    await writeStoredFile(root, d, "ACLS algorithms.pdf", bytes);
    expect(await readStoredFile(root, d, "ACLS algorithms.pdf")).toEqual(bytes);
    await expect(writeStoredFile(root, d, "../escape.pdf", bytes)).rejects.toThrow(/plain file name/);
    await expect(readStoredFile(root, d, "..")).rejects.toThrow(/plain file name/);
    await expect(writeStoredFile(root, d, "", bytes)).rejects.toThrow(/plain file name/);
    for (const bad of ["..", "d_1", "../content", "b_0000000001"]) {
      await expect(writeStoredFile(root, bad, "x.pdf", bytes)).rejects.toThrow(/not a document id/);
      await expect(readStoredFile(root, bad, "x.pdf")).rejects.toThrow(/not a document id/);
    }
  });
});
