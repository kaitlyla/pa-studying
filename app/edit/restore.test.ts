// Versions and Restore (plan 50 §50.6, 99 §99.1 restore.test) over a history committed to the GitHub fake:
// which commits are versions of a page and which is the Original, and what a restore writes.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { commitMessage, parseTrailers, serializeFile, type BlockFile, type DocJSON, type StructureFile, type SystemFile, type Trailers } from "../../lib/content/index.ts";
import { fileHash, guideViewHash, otherHash, refHash } from "../../lib/derive/routes.ts";
import { B, D, G, R, S } from "../../tools/build/test-fixture.ts";
import { DEVICE_KEY } from "../auth/config.ts";
import { versionTime } from "./format.ts";
import type { CommitInfo } from "./github.ts";
import { Snapshot } from "./snapshot.ts";
import { loadFixture, startWorld, type Fixture, type World } from "./testkit.ts";
import { buildRestore, buildSave, loadUnit, type EditUnit, type Part, type SaveBuild } from "./units.ts";
import {
  ORIGINAL_FROM_WORD, ORIGINAL_PUBLISHED, PER_PAGE, VersionHistory, pageHash, pageVersions, restoreVersion, type Version,
} from "./versions.ts";

const CV = "content/guides/fm/cardiovascular";
const CV_SYSTEM = `${CV}/system.json`;
const CV_STRUCTURE = `${CV}/structure.json`;
const blockPath = (n: number): string => `${CV}/blocks/${B(n)}.json`;
const MY_DEVICE = "0123456789";
const OTHER_DEVICE = "ABCDEFGHJK";
const AUTHOR = { name: "kaitlyla", email: "337482200+kaitlyla@users.noreply.github.com" };
const TODAY = "2026-10-04";

type Node = { type: string; attrs?: Record<string, unknown>; content?: Node[]; text?: string };

let fx: Fixture;
let w: World;

beforeAll(async () => {
  fx = await loadFixture();
}, 60_000);

beforeEach(() => {
  w = startWorld(fx);
  localStorage.setItem(DEVICE_KEY, MY_DEVICE);
});

afterEach(() => {
  w.stop();
});

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const unitAt = async (key: string, sha?: string): Promise<EditUnit> => loadUnit(key, await Snapshot.at(w.git, sha));
const read = <T>(path: string, at?: string): T => JSON.parse(w.fake.readFile(path, at) ?? "null") as T;

function only<K extends Part["kind"]>(unit: EditUnit, kind: K): Extract<Part, { kind: K }> {
  const p = unit.parts.find((x): x is Extract<Part, { kind: K }> => x.kind === kind);
  if (!p) throw new Error(`no ${kind} part in ${unit.key}`);
  return p;
}

/** Commit `files` (serialized canonically; null deletes) with these trailers, at `date`. */
function land(files: Record<string, unknown>, subject: string, trailers: Trailers, date: string): string {
  const out: Record<string, string | null> = {};
  for (const [path, value] of Object.entries(files)) out[path] = value === null ? null : typeof value === "string" ? value : serializeFile(path, value);
  return w.fake.commitFiles(out, { message: commitMessage(subject, trailers), date });
}

/** A built save's files, for land(). */
const filesOf = (build: SaveBuild): Record<string, unknown> =>
  Object.fromEntries(build.changes.map((c) => [c.path, "content" in c ? c.content : null]));

const edit = (page: string, changed: string[], device = MY_DEVICE): Trailers => ({ kind: "edit", page, changed, device });

// ---- table rows ---------------------------------------------------------------------------------

const rowsOfDoc = (doc: DocJSON): Node[] => ((doc.content[0] as Node).content ?? []);
const rowIds = (doc: DocJSON): string[] => rowsOfDoc(doc).map((r) => String(r.attrs?.id));
const cellText = (doc: DocJSON, row: string, col: number): string =>
  (rowsOfDoc(doc).find((r) => r.attrs?.id === row)?.content?.[col]?.content ?? []).flatMap((p) => p.content ?? []).map((t) => t.text ?? "").join("");
const cell = (text: string): Node => ({ type: "table_cell", content: [text === "" ? { type: "paragraph" } : { type: "paragraph", content: [{ type: "text", text }] }] });

function setCell(doc: DocJSON, row: string, col: number, text: string): DocJSON {
  const out = clone(doc);
  const r = rowsOfDoc(out).find((x) => x.attrs?.id === row);
  if (!r?.content) throw new Error(`row ${row} not in doc`);
  r.content[col] = cell(text);
  return out;
}

function addRow(doc: DocJSON, after: string, id: string, texts: string[]): DocJSON {
  const out = clone(doc);
  const rows = rowsOfDoc(out);
  rows.splice(rows.findIndex((x) => x.attrs?.id === after) + 1, 0, { type: "table_row", attrs: { id, kind: "content" }, content: texts.map(cell) });
  return out;
}

function dropRows(doc: DocJSON, ...ids: string[]): DocJSON {
  const out = clone(doc);
  const table = out.content[0] as Node;
  table.content = (table.content ?? []).filter((r) => !ids.includes(String(r.attrs?.id)));
  return out;
}

/** Save `edit` of the rows on page `key` (built against main's head) as a commit. */
async function saveRows(key: string, change: (doc: DocJSON) => DocJSON, trailers: Trailers, date: string): Promise<string> {
  const unit = await unitAt(key);
  const part = only(unit, "rows");
  return land(filesOf(buildSave(unit, new Map([[part.slot.id, change(part.slot.doc)]]), TODAY)), `Edit: ${key}`, trailers, date);
}

/** Save `change` of table `block`'s rows on page `key` as the editor does: Changed is the build's own list. */
async function saveTable(key: string, block: string, change: (doc: DocJSON) => DocJSON, date: string): Promise<{ sha: string; changed: string[] }> {
  const unit = await unitAt(key);
  const part = unit.parts.find((p): p is Extract<Part, { kind: "rows" }> => p.kind === "rows" && p.block.id === block);
  if (!part) throw new Error(`no rows of ${block} on ${key}`);
  const build = buildSave(unit, new Map([[part.slot.id, change(part.slot.doc)]]), TODAY);
  return { sha: land(filesOf(build), `Edit: ${key}`, edit(key, build.changed), date), changed: build.changed };
}

// ---- prose blocks -------------------------------------------------------------------------------

/** A prose block file with one paragraph per text, shaped like the fixture's B11. */
function prose(id: string, ...texts: string[]): BlockFile {
  const base = read<BlockFile>(blockPath(11));
  const para = base.doc.content[0] as Node;
  const text = (para.content ?? [])[0] as Node;
  return { ...base, id, doc: { type: "doc", content: texts.map((t) => ({ ...para, content: [{ ...text, text: t }] })) } as DocJSON };
}
const proseText = (path: string, at?: string): string[] =>
  (read<BlockFile>(path, at).doc.content as Node[]).map((p) => (p.content ?? []).map((t) => t.text ?? "").join(""));

const without = (record: Record<string, string>, key: string): Record<string, string> => Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));

async function versionsOf(key: string): Promise<{ history: VersionHistory; versions: Version[] }> {
  const history = await VersionHistory.open(w.git, key);
  return { history, versions: history.versions() };
}

const headTrailers = (): Trailers | null => parseTrailers(w.fake.commit(w.fake.head())?.message ?? "");

describe("restore: Original on a curated system", () => {
  it("labels the curation commit Original and restores only P2's curated content", async () => {
    const key = "system:fm:cardiovascular";
    land({ [blockPath(11)]: prose(B(11), "Murmurs and heart sounds", "Systolic murmurs: AS, MR") }, "Import her source files", { kind: "import" }, "2026-10-02T09:00:00Z");
    const sys = read<SystemFile>(CV_SYSTEM);
    const structure = read<StructureFile>(CV_STRUCTURE);
    const curation = land({
      [blockPath(11)]: prose(B(11), "Murmurs and heart sounds"),
      [blockPath(15)]: prose(B(15), "Systolic murmurs: AS, MR"),
      [CV_SYSTEM]: { ...sys, blocks: sys.blocks.toSpliced(sys.blocks.indexOf(B(11)) + 1, 0, B(15)) },
      [CV_STRUCTURE]: { ...structure, members: { ...structure.members, [B(15)]: "other" } },
    }, "Curate the Cardiovascular system", { kind: "curation" }, "2026-10-03T09:00:00Z");
    const editSha = land({ [blockPath(15)]: prose(B(15), "Systolic murmurs: AS, MR, HCM") }, "Edit: Cardiovascular", edit(key, [B(15)]), "2026-10-04T09:00:00Z");

    const { versions } = await versionsOf(key);
    expect(versions.map((v) => [v.sha, v.label, v.current, v.original])).toEqual([
      [editSha, "Your edit", true, false],
      [curation, ORIGINAL_FROM_WORD, false, true],
    ]);

    const before = { p1: w.fake.readFile(blockPath(11)), sys: w.fake.readFile(CV_SYSTEM), structure: w.fake.readFile(CV_STRUCTURE) };
    const original = versions[1] as Version;
    const result = await restoreVersion({ git: w.git, author: AUTHOR, key, title: "Cardiovascular", version: original });

    expect(result.kind).toBe("saved");
    expect(w.fake.head()).not.toBe(editSha);
    expect(proseText(blockPath(15))).toEqual(["Systolic murmurs: AS, MR"]);
    expect(w.fake.readFile(blockPath(15))).toBe(w.fake.readFile(blockPath(15), curation));
    expect(w.fake.readFile(blockPath(11))).toBe(before.p1);
    expect(w.fake.readFile(CV_SYSTEM)).toBe(before.sys);
    expect(w.fake.readFile(CV_STRUCTURE)).toBe(before.structure);
    // The raw import's single block P never comes back.
    expect(proseText(blockPath(11))).toEqual(["Murmurs and heart sounds"]);
    expect([...result.files.keys()]).toEqual([blockPath(15)]);
    expect(headTrailers()).toEqual({
      kind: "restore", page: key, changed: [B(15)], device: MY_DEVICE, restoredFrom: "2026-10-03T09:00:00.000Z",
    });
  });
});

describe("restore: one topic after a sibling edit", () => {
  const A = `topic:fm:${R(101)}`;
  const BKEY = `topic:fm:${R(104)}`;

  it("restoring topic A to the Original writes a1's original content and leaves topic B's edit, its new row and its members entry", async () => {
    const curation = await saveRows(A, (d) => setCell(d, R(102), 1, "more AF text, curated"), { kind: "curation" }, "2026-10-02T09:00:00Z");
    await saveRows(A, (d) => setCell(d, R(101), 1, "irregularly irregular; no P waves"), edit(A, [R(101)]), "2026-10-03T09:00:00Z");
    await saveRows(BKEY, (d) => addRow(setCell(d, R(104), 1, "exertional chest pain"), R(104), R(105), ["", "relieved by rest", ""]), edit(BKEY, [R(104), R(105)]), "2026-10-04T09:00:00Z");
    const membersB3 = read<StructureFile>(CV_STRUCTURE).members[R(105)];
    expect(membersB3).toBeDefined();

    const { versions } = await versionsOf(A);
    // Topic B's edit names none of topic A's rows, so it is not a version of A.
    expect(versions.map((v) => v.label)).toEqual(["Your edit", ORIGINAL_FROM_WORD]);
    expect(versions[1]?.sha).toBe(curation);

    const result = await restoreVersion({ git: w.git, author: AUTHOR, key: A, title: "Atrial fibrillation", version: versions[1] as Version });
    expect(result.kind).toBe("saved");

    const table = read<BlockFile>(blockPath(10)).doc;
    expect(cellText(table, R(101), 1)).toBe("irregularly irregular");
    expect(cellText(table, R(102), 1)).toBe("more AF text, curated");
    expect(cellText(table, R(104), 1)).toBe("exertional chest pain");
    expect(rowIds(table)).toEqual([R(100), R(101), R(102), R(103), R(104), R(105)]);
    expect(read<StructureFile>(CV_STRUCTURE).members[R(105)]).toBe(membersB3);
    expect(headTrailers()?.changed).toEqual([R(101)]);
  });

  it("re-inserts rows deleted since the version where they stood, with their old members entries", async () => {
    // Version V: a row recorded above a1 (members[r] = a1), then a1 (edited), a2.
    const v = await saveRows(A, (d) => addRow(setCell(d, R(101), 1, "irregular"), R(100), R(105), ["", "before AF", ""]), edit(A, [R(101), R(105)]), "2026-10-02T09:00:00Z");
    expect(read<StructureFile>(CV_STRUCTURE).members[R(105)]).toBe(R(101));
    await saveRows(A, (d) => dropRows(d, R(105), R(102)), edit(A, [R(105), R(102)]), "2026-10-03T09:00:00Z");
    expect(rowIds(read<BlockFile>(blockPath(10)).doc)).toEqual([R(100), R(101), R(103), R(104)]);
    expect(read<StructureFile>(CV_STRUCTURE).members[R(105)]).toBeUndefined();

    const { versions } = await versionsOf(A);
    const version = versions.find((x) => x.sha === v);
    // No commit before V has trailers, so V, the oldest version, is the Original.
    expect(version).toMatchObject({ original: true, label: ORIGINAL_FROM_WORD });
    const result = await restoreVersion({ git: w.git, author: AUTHOR, key: A, title: "Atrial fibrillation", version: version as Version });
    expect(result.kind).toBe("saved");

    expect(rowIds(read<BlockFile>(blockPath(10)).doc)).toEqual([R(100), R(105), R(101), R(102), R(103), R(104)]);
    const structure = read<StructureFile>(CV_STRUCTURE);
    expect(structure.members[R(105)]).toBe(R(101));
    expect(structure.members[R(102)]).toBeUndefined();
    expect(w.fake.readFile(blockPath(10))).toBe(w.fake.readFile(blockPath(10), v));
    expect(w.fake.readFile(CV_STRUCTURE)).toBe(w.fake.readFile(CV_STRUCTURE, v));
  });

  it("a column-width save is a version of the topic, and restoring the version before it brings the old widths back", async () => {
    const v = await saveRows(A, (d) => setCell(d, R(101), 1, "irregular"), edit(A, [R(101)]), "2026-10-02T09:00:00Z");
    const oldGrid = ((read<BlockFile>(blockPath(10)).doc.content[0] as Node).attrs?.grid) as number[];
    const widened = await saveTable(A, B(10), (d) => {
      const out = clone(d);
      const t = out.content[0] as Node;
      t.attrs = { ...t.attrs, grid: oldGrid.map((g, i) => (i === 0 ? g - 9 : i === 1 ? g + 9 : g)), ownWidths: true };
      return out;
    }, "2026-10-03T09:00:00Z");
    expect(widened.changed).toContain(R(101));
    // Her widths are marked hers; the version before them, saved with no such mark, still opens.
    expect((read<BlockFile>(blockPath(10)).doc.content[0] as Node).attrs?.ownWidths).toBe(true);
    expect(w.fake.readFile(blockPath(10), v)).not.toContain("ownWidths");
    const before = only(await unitAt(A, v), "rows");
    expect(((before.slot.doc.content[0] as Node).attrs)?.grid).toEqual(oldGrid);

    const { versions } = await versionsOf(A);
    expect(versions.map((x) => x.sha)).toEqual([widened.sha, v]);
    const result = await restoreVersion({ git: w.git, author: AUTHOR, key: A, title: "Atrial fibrillation", version: versions[1] as Version });
    expect(result.kind).toBe("saved");
    // The widths and the mark come back together: the restored table is drawn from her Word widths again.
    expect((read<BlockFile>(blockPath(10)).doc.content[0] as Node).attrs?.grid).toEqual(oldGrid);
    expect((read<BlockFile>(blockPath(10)).doc.content[0] as Node).attrs?.ownWidths).toBeUndefined();
    expect(w.fake.readFile(blockPath(10))).toBe(w.fake.readFile(blockPath(10), v));
  });
});

describe("restore: a document across a change of kind", () => {
  it("re-points docs/<d>/ to the Word version's blobs and deletes files/<d>/, uploading nothing", async () => {
    const d = D(5);
    const key = `doc:${d}`;
    const docDir = `content/docs/${d}/`;
    const fileDir = `content/files/${d}/`;
    const inbox = land({ [`${docDir}blocks/${B(60)}.json`]: prose(B(60), "TSH first, then free T4") }, "Add Thyroid notes", { kind: "inbox", changed: [d] }, "2026-10-02T09:00:00Z");
    const wordEntries = [...w.fake.listFiles(inbox).keys()].filter((p) => p.startsWith(docDir)).sort();
    expect(wordEntries.length).toBeGreaterThan(1);

    const pdf = { ...read<Record<string, unknown>>(`content/files/${D(1)}/file.json`), id: d, name: "Thyroid notes", original: "thyroid.pdf", view: "thyroid.pdf", pages: 1 };
    const replace = land({
      ...Object.fromEntries(wordEntries.map((p) => [p, null])),
      [`${fileDir}file.json`]: pdf,
      [`${fileDir}text.json`]: { pages: ["TSH"] },
      [`${fileDir}thyroid.pdf`]: "%PDF-thyroid",
    }, "Replace Thyroid notes with thyroid.pdf", { kind: "doc-replace", changed: [d], file: "thyroid.pdf" }, "2026-10-03T09:00:00Z");

    const { versions } = await versionsOf(key);
    expect(versions.map((v) => [v.sha, v.label, v.original])).toEqual([
      [replace, "Replaced with “thyroid.pdf”", false],
      [inbox, ORIGINAL_PUBLISHED, true],
    ]);

    const writesBefore = w.fake.writes().length;
    const result = await restoreVersion({ git: w.git, author: AUTHOR, key, title: "Thyroid notes", version: versions[1] as Version });
    expect(result.kind).toBe("saved");

    const head = w.fake.listFiles();
    for (const p of wordEntries) expect(head.get(p)).toBe(w.fake.fileSha(p, inbox));
    expect([...head.keys()].filter((p) => p.startsWith(fileDir))).toEqual([]);
    const restoreWrites = w.fake.writes().slice(writesBefore);
    expect(restoreWrites.length).toBeGreaterThan(0);
    expect(restoreWrites.filter((r) => new URL(r.url).pathname.endsWith("/git/blobs"))).toEqual([]);
    expect(headTrailers()).toMatchObject({ kind: "restore", page: key, changed: [d] });
    // The overlay gets the restored page's JSON.
    expect([...result.files.keys()].sort()).toEqual(wordEntries.filter((p) => p.endsWith(".json")));
  });

  it("a version whose content is already current writes nothing", async () => {
    const d = D(5);
    const head = w.fake.head();
    const result = await restoreVersion({
      git: w.git, author: AUTHOR, key: `doc:${d}`, title: "Thyroid notes",
      version: { sha: head, date: "2026-10-01T00:00:00Z", time: "", label: "", current: true, original: true },
    });
    expect(result).toEqual({ kind: "saved", commit: head, files: new Map() });
    expect(w.fake.head()).toBe(head);
  });
});

describe("buildRestore", () => {
  it("re-creates a block deleted since the version in its owner list, next to its old neighbour, with its structure entries", async () => {
    const key = "system:fm:cardiovascular";
    const version = await unitAt(key);
    const sys = read<SystemFile>(CV_SYSTEM);
    const structure = read<StructureFile>(CV_STRUCTURE);
    land({
      [blockPath(11)]: null,
      [CV_SYSTEM]: { ...sys, blocks: sys.blocks.filter((b) => b !== B(11)) },
      [CV_STRUCTURE]: { ...structure, members: without(structure.members, B(11)), listed: without(structure.listed, B(11)) },
    }, "Curate: drop Murmurs", { kind: "curation" }, "2026-10-02T09:00:00Z");

    const unit = await unitAt(key);
    const build = await buildRestore(unit, version, TODAY);
    const written = new Map(build.changes.map((c) => [c.path, "content" in c ? c.content : null]));
    expect([...written.keys()].sort()).toEqual([blockPath(11), CV_STRUCTURE, CV_SYSTEM].sort());
    expect(JSON.parse(written.get(CV_SYSTEM) ?? "null")).toEqual(sys);
    const restored = JSON.parse(written.get(CV_STRUCTURE) ?? "null") as StructureFile;
    expect(restored.members[B(11)]).toBe("other");
    expect(restored.listed[B(11)]).toBe("Murmurs");
    expect(written.get(blockPath(11))).toBe(serializeFile(blockPath(11), read<BlockFile>(blockPath(11), version.snapshot.commit)));
    expect(build.changed).toContain(B(11));
  });

  it("re-creates a deleted table of a system with its rows' structure entries, through the system owner", async () => {
    const key = "system:fm:cardiovascular";
    const version = await unitAt(key);
    const sys = read<SystemFile>(CV_SYSTEM);
    const structure = read<StructureFile>(CV_STRUCTURE);
    land({
      [blockPath(13)]: null,
      [CV_SYSTEM]: { ...sys, blocks: sys.blocks.filter((b) => b !== B(13)) },
      [CV_STRUCTURE]: { ...structure, members: without(structure.members, R(131)) },
    }, "Curate: drop the heart failure table", { kind: "curation" }, "2026-10-02T09:00:00Z");

    const unit = await unitAt(key);
    const build = await buildRestore(unit, version, TODAY);
    const written = new Map(build.changes.map((c) => [c.path, "content" in c ? c.content : null]));
    expect([...written.keys()].sort()).toEqual([blockPath(13), CV_STRUCTURE, CV_SYSTEM].sort());
    expect((JSON.parse(written.get(CV_SYSTEM) ?? "null") as SystemFile).blocks).toEqual(sys.blocks);
    expect((JSON.parse(written.get(CV_STRUCTURE) ?? "null") as StructureFile).members[R(131)]).toBe("other");
    expect(build.changed).toEqual(expect.arrayContaining([B(13), R(130), R(131)]));
  });

  it("with nothing lost, is the restore-mode save", async () => {
    const key = `topic:fm:${R(101)}`;
    const version = await unitAt(key);
    await saveRows(key, (d) => setCell(d, R(102), 1, "changed"), edit(key, [R(102)]), "2026-10-02T09:00:00Z");
    const unit = await unitAt(key);
    const build = await buildRestore(unit, version, TODAY);
    expect(build.changes.map((c) => c.path)).toEqual([blockPath(10)]);
    expect(build.changed).toEqual([R(102)]);
  });
});

// ---- the version list ---------------------------------------------------------------------------

describe("pageVersions", () => {
  const ids = [R(101), R(102)];
  let n = 0;
  const c = (date: string, trailers: Trailers | null): CommitInfo => ({
    sha: `sha${String(n++)}`, date, message: trailers ? commitMessage("Subject", trailers) : "Import", parents: [],
  });
  const opts = { fromWord: true, device: MY_DEVICE, complete: true, idsBefore: new Map<string, readonly string[]>() };

  it("labels each kind of version; the newest is Current", () => {
    const commits = [
      c("2026-10-02T00:00:00Z", { kind: "import" }),
      c("2026-10-03T00:00:00Z", edit("k", [R(101)])),
      c("2026-10-04T00:00:00Z", edit("k", [R(102)], OTHER_DEVICE)),
      c("2026-10-05T00:00:00Z", { kind: "restore", page: "k", changed: [R(101)], restoredFrom: "2026-10-03T00:00:00Z" }),
      c("2026-10-06T00:00:00Z", { kind: "doc-replace", changed: [D(5), R(101)], file: "new.pdf" }),
      c("2026-10-07T00:00:00Z", { kind: "doc-restore", changed: [D(5), R(102)] }),
      c("2026-10-08T00:00:00Z", edit("k", [R(999)])),
      c("2026-10-09T00:00:00Z", { kind: "guidelines" }),
    ];
    const versions = pageVersions([...commits].reverse(), ids, opts);
    expect(versions.map((v) => v.label)).toEqual([
      "Restored", "Replaced with “new.pdf”", `Restored from ${versionTime("2026-10-03T00:00:00Z")}`,
      "Saved from another device", "Your edit", ORIGINAL_FROM_WORD,
    ]);
    expect(versions.map((v) => v.current)).toEqual([true, false, false, false, false, false]);
    expect(versions.map((v) => v.original)).toEqual([false, false, false, false, false, true]);
    expect(versions[0]?.time).toBe(versionTime("2026-10-07T00:00:00Z"));
  });

  it("the Original is the newest origin commit older than every version, not a later one", () => {
    const old = c("2026-10-01T00:00:00Z", { kind: "import" });
    const curated = c("2026-10-02T00:00:00Z", { kind: "curation" });
    const later = c("2026-10-05T00:00:00Z", { kind: "inbox", changed: [D(5)] });
    const v = c("2026-10-03T00:00:00Z", edit("k", [R(101)]));
    const versions = pageVersions([later, v, curated, old], ids, { ...opts, fromWord: false });
    expect(versions.map((x) => [x.sha, x.label])).toEqual([[v.sha, "Your edit"], [curated.sha, ORIGINAL_PUBLISHED]]);
  });

  it("a page converted from her Word guides gets the Word Original label; a slide gets the published one", async () => {
    const origin = c("2026-10-02T00:00:00Z", { kind: "import" });
    const labelOf = async (key: string): Promise<string | undefined> => {
      const unit = await unitAt(key);
      return pageVersions([origin], unit.ids, { ...opts, fromWord: unit.fromWord })[0]?.label;
    };
    expect(await labelOf(`topic:fm:${R(101)}`)).toBe(ORIGINAL_FROM_WORD);
    expect(await labelOf(`listed:fm:${B(11)}`)).toBe(ORIGINAL_FROM_WORD);
    expect(await labelOf(`slide:fm:${S(2)}`)).toBe(ORIGINAL_PUBLISHED);
    expect(ORIGINAL_FROM_WORD).not.toBe(ORIGINAL_PUBLISHED);
  });

  it("with no versions, the newest origin commit is the Original and Current", () => {
    const old = c("2026-10-01T00:00:00Z", { kind: "import" });
    const curated = c("2026-10-02T00:00:00Z", { kind: "curation" });
    expect(pageVersions([old, curated], ids, opts)).toEqual([
      { sha: curated.sha, date: curated.date, time: versionTime(curated.date), label: ORIGINAL_FROM_WORD, current: true, original: true },
    ]);
  });

  it("with no origin commit, the oldest version is the Original", () => {
    const first = c("2026-10-02T00:00:00Z", edit("k", [R(101)]));
    const second = c("2026-10-03T00:00:00Z", edit("k", [R(101)]));
    const versions = pageVersions([second, first, c("2026-10-01T00:00:00Z", null)], ids, opts);
    expect(versions.map((v) => [v.sha, v.label, v.original])).toEqual([[second.sha, "Your edit", false], [first.sha, ORIGINAL_FROM_WORD, true]]);
  });

  it("a commit naming only ids the page had at its parent is a version; one naming ids it never had is not", () => {
    const deleted = c("2026-10-03T00:00:00Z", edit("k", [R(105)]));
    const elsewhere = c("2026-10-04T00:00:00Z", edit("k", [R(106)]));
    const idsBefore = new Map<string, readonly string[]>([[deleted.sha, [...ids, R(105)]], [elsewhere.sha, ids]]);
    const versions = pageVersions([elsewhere, deleted], ids, { ...opts, idsBefore });
    expect(versions.map((v) => [v.sha, v.current])).toEqual([[deleted.sha, true]]);
  });

  // A doc-marker commit (a replace's `replacing`, Dismiss) is not a version and not an Original
  // (Orchestrator ruling 2026-10-05 00:55Z, amending 50 §50.4 and §50.6).
  it("a doc-marker commit naming the page's document is neither a version nor the Original", () => {
    const docIds = [D(5), ...ids];
    const origin = c("2026-10-01T00:00:00Z", { kind: "import" });
    const replacing = c("2026-10-02T00:00:00Z", { kind: "doc-marker", changed: [D(5)] });
    const replaced = c("2026-10-03T00:00:00Z", { kind: "doc-replace", changed: [D(5)], file: "new.pdf" });
    const dismissed = c("2026-10-04T00:00:00Z", { kind: "doc-marker", changed: [D(5)] });
    const versions = pageVersions([dismissed, replaced, replacing, origin], docIds, { ...opts, fromWord: false });
    expect(versions.map((v) => [v.sha, v.label, v.current, v.original])).toEqual([
      [replaced.sha, "Replaced with “new.pdf”", true, false],
      [origin.sha, ORIGINAL_PUBLISHED, false, true],
    ]);
    expect(versions.filter((v) => v.label.startsWith("Replaced with"))).toHaveLength(1);
  });

  it("a doc-marker commit alone never becomes the Original, with or without an origin commit", () => {
    const docIds = [D(5), ...ids];
    const origin = c("2026-10-01T00:00:00Z", { kind: "import" });
    const marker = c("2026-10-02T00:00:00Z", { kind: "doc-marker", changed: [D(5)] });
    expect(pageVersions([marker, origin], docIds, opts).map((v) => [v.sha, v.current, v.original])).toEqual([[origin.sha, true, true]]);
    expect(pageVersions([marker], docIds, opts)).toEqual([]);
  });

  it("an incomplete history settles no Original", () => {
    const versions = pageVersions([c("2026-10-01T00:00:00Z", { kind: "import" }), c("2026-10-02T00:00:00Z", edit("k", [R(101)]))], ids, { ...opts, complete: false });
    expect(versions.map((v) => [v.label, v.original])).toEqual([["Your edit", false]]);
  });
});

// A commit is a version of a page when its Changed list names the page's ids at head or at the commit's
// parent (Orchestrator ruling 2026-10-04 20:57Z, amending 50 §50.6).
describe("versions of saves that delete rows", () => {
  const A = `topic:fm:${R(101)}`;
  const SYSTEM = "system:fm:cardiovascular";

  /** Current is the page as it stands at main's head. */
  function expectCurrentIsHead(v: Version | undefined): void {
    expect(v?.current).toBe(true);
    for (const path of [blockPath(10), CV_STRUCTURE]) expect(w.fake.readFile(path, v?.sha)).toBe(w.fake.readFile(path));
  }

  it("a delete-only save from the topic page is a version of it, and Current", async () => {
    const e1 = await saveTable(A, B(10), (d) => setCell(d, R(101), 1, "irregular"), "2026-10-02T09:00:00Z");
    const e2 = await saveTable(A, B(10), (d) => dropRows(d, R(102)), "2026-10-03T09:00:00Z");
    expect(e2.changed).toEqual([R(102)]);

    const { history, versions } = await versionsOf(A);
    expect(history.unit.ids).not.toContain(R(102));
    expect(versions.map((v) => v.sha)).toEqual([e2.sha, e1.sha]);
    expectCurrentIsHead(versions[0]);
  });

  it("a delete-only save from the system page is a version of the system page and of the topic page that lost the row", async () => {
    const e1 = await saveTable(A, B(10), (d) => setCell(d, R(101), 1, "irregular"), "2026-10-02T09:00:00Z");
    const e2 = await saveTable(SYSTEM, B(10), (d) => dropRows(d, R(102)), "2026-10-03T09:00:00Z");
    expect(e2.changed).toEqual([R(102)]);

    const topic = await versionsOf(A);
    expect(topic.versions.map((v) => v.sha)).toEqual([e2.sha, e1.sha]);
    expectCurrentIsHead(topic.versions[0]);

    const system = await versionsOf(SYSTEM);
    expect(system.versions.map((v) => v.sha)).toEqual([e2.sha, e1.sha]);
    expectCurrentIsHead(system.versions[0]);
  });

  it("after a row is added and then deleted, Current is the delete", async () => {
    const e1 = await saveTable(A, B(10), (d) => addRow(setCell(d, R(101), 1, "irregular"), R(102), R(105), ["", "AF follow-up", ""]), "2026-10-02T09:00:00Z");
    expect(e1.changed).toEqual(expect.arrayContaining([R(101), R(105)]));
    const e2 = await saveTable(A, B(10), (d) => dropRows(d, R(105)), "2026-10-03T09:00:00Z");
    expect(e2.changed).toEqual([R(105)]);

    const { versions } = await versionsOf(A);
    expect(versions.map((v) => v.sha)).toEqual([e2.sha, e1.sha]);
    expectCurrentIsHead(versions[0]);
    // Edit 1 still holds the added row, so it is not the page at head.
    expect(rowIds(read<BlockFile>(blockPath(10), e1.sha).doc)).toContain(R(105));
  });

  it("reads the page at a version's parent with the head's blob reads shared, each blob once", async () => {
    const e1 = await saveTable(A, B(10), (d) => setCell(d, R(101), 1, "irregular"), "2026-10-02T09:00:00Z");
    await saveTable(A, B(10), (d) => dropRows(d, R(102)), "2026-10-03T09:00:00Z");

    const from = w.fake.requests.length;
    await versionsOf(A);
    const paths = w.fake.requests.slice(from).filter((r) => r.method === "GET").map((r) => new URL(r.url).pathname);
    expect(paths.some((p) => p.endsWith(`/git/trees/${e1.sha}`))).toBe(true);
    const blobs = paths.filter((p) => p.includes("/git/blobs/"));
    expect(blobs.length).toBeGreaterThan(0);
    expect(new Set(blobs).size).toBe(blobs.length);
  });
});

describe("VersionHistory paging", () => {
  it("reads the next page when a path's page was full, and only then settles the Original", async () => {
    const key = "general:fm:labs";
    const path = `content/gapfill/${G(1)}.json`;
    const text = w.fake.readFile(path) ?? "";
    // PER_PAGE edits after the import: the first page holds only edits.
    for (let i = 1; i <= PER_PAGE; i++) {
      const date = new Date(Date.UTC(2026, 9, 2, 0, i)).toISOString().replace(".000", "");
      land({ [path]: i === PER_PAGE ? text : `${text} ${String(i)}` }, "Edit: Labs", edit(key, [G(1)]), date);
    }
    const { history, versions } = await versionsOf(key);
    expect(history.complete).toBe(false);
    expect(versions).toHaveLength(PER_PAGE);
    expect(versions.some((v) => v.original)).toBe(false);

    const requests = w.fake.requests.length;
    await history.more();
    const pages = w.fake.requests.slice(requests).map((r) => new URL(r.url).searchParams.get("page"));
    expect(pages).toEqual(["2"]);
    expect(history.complete).toBe(true);
    const all = history.versions();
    // The import has no trailers, so the oldest version is the Original.
    expect(all).toHaveLength(PER_PAGE);
    expect(all.at(-1)).toMatchObject({ original: true, label: ORIGINAL_PUBLISHED, date: "2026-10-02T00:01:00Z" });
  });
});

describe("pageHash", () => {
  it("routes each page key back to its page", () => {
    expect(pageHash(`topic:fm:${R(101)}`)).toBe(guideViewHash("fm", { kind: "topics", ids: [R(101)] }));
    expect(pageHash("section:fm:cardiovascular:cad")).toBe(guideViewHash("fm", { kind: "section", system: "cardiovascular", section: "cad" }));
    expect(pageHash("system:fm:cardiovascular")).toBe(guideViewHash("fm", { kind: "system", system: "cardiovascular" }));
    expect(pageHash(`listed:fm:${B(11)}`)).toBe(guideViewHash("fm", { kind: "block", id: B(11) }));
    expect(pageHash("pharm:fm:cardiovascular:antianginals")).toBe(guideViewHash("fm", { kind: "pharm", system: "cardiovascular", section: "antianginals", target: null }));
    expect(pageHash("general:fm:labs")).toBe(guideViewHash("fm", { kind: "general", key: "labs" }));
    expect(pageHash("workup:fm:ams")).toBe(guideViewHash("fm", { kind: "workup", item: "ams" }));
    expect(pageHash("visit:fm:2-months")).toBe("#/eor/fm/visits/2-months");
    expect(pageHash("ref:labs:cbc")).toBe(refHash("labs", "cbc"));
    expect(pageHash("other:vaccines")).toBe(otherHash("vaccines"));
    expect(pageHash(`doc:${D(5)}`)).toBe(fileHash(D(5), null));
    expect(pageHash("nonsense")).toBeNull();
  });
});
