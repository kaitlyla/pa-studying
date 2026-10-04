// Edit units and the save builder (plan 50 §50.2, §50.4) against the synthetic content tree in the
// GitHub fake: what each page key edits, and exactly which files a save writes.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DocJSON, GapFile, StructureFile, BlockFile } from "../../lib/content/index.ts";
import type { SystemJson } from "../../lib/derive/published.ts";
import { checkMembers, deriveTopics } from "../../lib/derive/topics.ts";
import { B, D, G, R, S } from "../../tools/build/test-fixture.ts";
import { Snapshot } from "./snapshot.ts";
import { loadFixture, startWorld, type Fixture, type World } from "./testkit.ts";
import { buildSave, loadUnit, localDate, UnitError, type EditUnit, type Part } from "./units.ts";

const CV = "content/guides/fm/cardiovascular";
const CV_STRUCTURE = `${CV}/structure.json`;
const blockPath = (n: number): string => `${CV}/blocks/${B(n)}.json`;
const TODAY = "2026-10-04";

type Node = { type: string; attrs?: Record<string, unknown>; content?: Node[]; text?: string };

let fx: Fixture;
let w: World;

beforeAll(async () => {
  fx = await loadFixture();
}, 60_000);

beforeEach(() => {
  w = startWorld(fx);
});

afterEach(() => {
  w.stop();
});

const unitAt = async (key: string): Promise<EditUnit> => loadUnit(key, await Snapshot.at(w.git));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function only<K extends Part["kind"]>(unit: EditUnit, kind: K, i = 0): Extract<Part, { kind: K }> {
  const parts = unit.parts.filter((p): p is Extract<Part, { kind: K }> => p.kind === kind);
  const p = parts[i];
  if (!p) throw new Error(`no ${kind} part #${i} in ${unit.key}`);
  return p;
}

const rowsOfDoc = (doc: DocJSON): Node[] => ((doc.content[0] as Node).content ?? []);
const rowIds = (doc: DocJSON): string[] => rowsOfDoc(doc).map((r) => String(r.attrs?.id));
const cellText = (row: Node, col: number): string =>
  (row.content?.[col]?.content ?? []).flatMap((p) => p.content ?? []).map((t) => t.text ?? "").join("");

/** A paragraph cell holding `text` (empty paragraph for ""). */
const cell = (text: string): Node => ({ type: "table_cell", content: [text === "" ? { type: "paragraph" } : { type: "paragraph", content: [{ type: "text", text }] }] });

function setCell(doc: DocJSON, row: string, col: number, text: string): DocJSON {
  const out = clone(doc);
  const r = rowsOfDoc(out).find((x) => x.attrs?.id === row);
  if (!r?.content) throw new Error(`row ${row} not in doc`);
  r.content[col] = cell(text);
  return out;
}

/** The doc with a new content row (cells `texts`) inserted after row `after` (or first when null). */
function addRow(doc: DocJSON, after: string | null, id: string, texts: string[]): DocJSON {
  const out = clone(doc);
  const rows = rowsOfDoc(out);
  const at = after === null ? 0 : rows.findIndex((x) => x.attrs?.id === after) + 1;
  rows.splice(at, 0, { type: "table_row", attrs: { id, kind: "content" }, content: texts.map(cell) });
  return out;
}

function dropRow(doc: DocJSON, id: string): DocJSON {
  const out = clone(doc);
  const table = out.content[0] as Node;
  table.content = (table.content ?? []).filter((r) => r.attrs?.id !== id);
  return out;
}

const json = <T>(text: string | undefined): T => JSON.parse(text ?? "null") as T;
const changeOf = (build: ReturnType<typeof buildSave>, path: string): string | undefined => {
  const c = build.changes.find((x) => x.path === path);
  return c && "content" in c ? c.content : undefined;
};

describe("loading a page key", () => {
  it("topic: one rows editor with the topic's rows and its heading; the block and structure.json are its files", async () => {
    const unit = await unitAt(`topic:fm:${R(101)}`);
    const part = only(unit, "rows");
    expect(unit.parts).toHaveLength(1);
    expect(part.shown).toEqual([R(100), R(101), R(102)]);
    expect(rowIds(part.slot.doc)).toEqual([R(100), R(101), R(102)]);
    expect(part.slot.basePt).toBe(10);
    expect(part.slot.pageContentPt).toBe(792 - 36 - 36);
    expect(unit.scope).toEqual({ files: [blockPath(10), CV_STRUCTURE].sort(), dirs: [] });
    expect(unit.ids).toEqual([R(100), R(101), R(102)]);
    expect(unit.snapshot.commit).toBe(w.fake.head());
  });

  it("section: the same rows and blocks as the published section page", async () => {
    const unit = await unitAt("section:fm:cardiovascular:cad");
    const sys = fx.published.get("g/fm/s/cardiovascular.json") as SystemJson;
    const items = sys.sections.find((s) => s.id === "cad")?.items ?? [];
    expect(items.length).toBeGreaterThan(0);
    const fromParts = unit.parts.map((p) => (p.kind === "rows" ? { block: p.block.id, rows: p.shown } : p.kind === "block" ? { block: p.block.id, rows: null } : null));
    expect(fromParts).toEqual(items);
  });

  it("system: whole tables as rows editors, prose as blocks, and the drug table as its stub", async () => {
    const unit = await unitAt("system:fm:cardiovascular");
    expect(unit.parts.map((p) => [p.kind, p.kind === "stub" ? p.block : p.kind === "gap" ? p.gap.id : p.block.id])).toEqual([
      ["rows", B(10)], ["block", B(11)], ["stub", B(12)], ["rows", B(13)], ["block", B(14)],
    ]);
    const stub = only(unit, "stub");
    expect(stub.label).toBe("ANTIANGINALS");
    expect(only(unit, "rows").shown).toEqual([R(100), R(101), R(102), R(103), R(104)]);
  });

  it("listed: the one listed block", async () => {
    const unit = await unitAt(`listed:fm:${B(11)}`);
    expect(unit.parts.map((p) => p.kind)).toEqual(["block"]);
    expect(only(unit, "block").path).toBe(blockPath(11));
  });

  it("pharm: the overview, every row of the section's drug table, then its cards' blocks; structure.json is in scope", async () => {
    const unit = await unitAt("pharm:fm:cardiovascular:antianginals");
    const sys = fx.published.get("g/fm/s/cardiovascular.json") as SystemJson;
    const cards = sys.pharm?.sections.find((s) => s.id === "antianginals")?.cards ?? [];
    expect(cards.length).toBeGreaterThan(0);
    const blocksOfCard: Record<string, string> = { c_0000000001: B(71), c_0000000002: B(72), c_0000000003: B(73) };
    expect(unit.parts.map((p) => (p.kind === "rows" ? `rows ${p.block.id}` : p.kind === "block" ? p.block.id : p.kind))).toEqual([
      B(70), `rows ${B(12)}`, ...cards.map((c) => blocksOfCard[c]),
    ]);
    expect(only(unit, "block").slot.basePt).toBe(11);
    expect(unit.scope.files).toContain(CV_STRUCTURE);
    expect(unit.scope.files).toContain(`content/pharm/cardio-med-list/blocks/${B(70)}.json`);
  });

  it("general, workup, ref and other keys: their gap blocks, each with its own editor", async () => {
    const general = await unitAt("general:fm:labs");
    expect(general.parts.map((p) => (p.kind === "gap" ? p.gap.id : p.kind))).toEqual([G(1)]);
    expect(only(general, "gap").doc.basePt).toBe(11);
    expect(general.scope.files).toEqual([`content/gapfill/${G(1)}.json`]);
    expect((await unitAt("workup:fm:ams")).parts.map((p) => (p.kind === "gap" ? p.gap.id : p.kind))).toEqual([G(2)]);
    expect((await unitAt("ref:labs:cbc")).parts.map((p) => (p.kind === "gap" ? p.gap.id : p.kind))).toEqual([G(1)]);
    expect((await unitAt("other:vaccines")).parts.map((p) => (p.kind === "gap" ? p.gap.id : p.kind))).toEqual([G(3)]);
    expect((await unitAt("other:emergency")).parts).toEqual([]);
  });

  it("slide: the one slide", async () => {
    const unit = await unitAt(`slide:fm:${S(2)}`);
    expect(only(unit, "slide").path).toBe(`content/slides/fm/blocks/${S(2)}.json`);
  });

  it("doc (Word page): its blocks at the page's size; its directories are the scope; Original is the Word file", async () => {
    const unit = await unitAt(`doc:${D(5)}`);
    expect(unit.parts.map((p) => (p.kind === "block" ? p.block.id : p.kind))).toEqual([B(60), B(61)]);
    expect(only(unit, "block").slot.basePt).toBe(11);
    expect(unit.scope).toEqual({ files: [], dirs: [`content/docs/${D(5)}/`, `content/files/${D(5)}/`] });
    expect(unit.ids).toEqual([D(5), B(60), B(61)]);
    expect(unit.docId).toBe(D(5));
    expect(unit.fromWord).toBe(true);
  });

  it("doc (the psych deck's file): no editors; the deck's directory joins the scope", async () => {
    const unit = await unitAt(`doc:${D(4)}`);
    expect(unit.parts).toEqual([]);
    expect(unit.scope.dirs).toEqual([`content/docs/${D(4)}/`, `content/files/${D(4)}/`, "content/slides/psy/"]);
    expect(unit.fromWord).toBe(false);
  });

  it("refuses unknown, malformed and vanished keys", async () => {
    await expect(unitAt("nope:fm")).rejects.toBeInstanceOf(UnitError);
    await expect(unitAt("topic:fm")).rejects.toThrow("Malformed page key: topic:fm");
    await expect(unitAt(`topic:fm:${R(102)}`)).rejects.toThrow(`${R(102)} is not on fm's pages`);
    await expect(unitAt("pharm:fm:cardiovascular:nosuch")).rejects.toThrow("Pharm section nosuch is no longer in cardiovascular");
  });
});

describe("building a save", () => {
  it("writes nothing when no editor changed", async () => {
    const unit = await unitAt("system:fm:cardiovascular");
    const docs = new Map(unit.parts.flatMap((p) => (p.kind === "rows" || p.kind === "block" ? [[p.slot.id, clone(p.slot.doc)] as const] : [])));
    expect(buildSave(unit, docs, TODAY)).toEqual({ changes: [], files: new Map(), changed: [] });
  });

  it("an edited cell rewrites only its block, keeps the rows the page didn't show, and names the row", async () => {
    const unit = await unitAt(`topic:fm:${R(101)}`);
    const part = only(unit, "rows");
    const build = buildSave(unit, new Map([[part.slot.id, setCell(part.slot.doc, R(102), 1, "more AF text, revised")]]), TODAY);

    expect(build.changes.map((c) => c.path)).toEqual([blockPath(10)]);
    expect(build.changed).toEqual([R(102)]);
    const saved = json<BlockFile>(changeOf(build, blockPath(10)));
    expect(rowIds(saved.doc)).toEqual([R(100), R(101), R(102), R(103), R(104)]);
    expect(cellText(rowsOfDoc(saved.doc)[2] as Node, 1)).toBe("more AF text, revised");
    expect(cellText(rowsOfDoc(saved.doc)[4] as Node, 1)).toBe("chest pain on exertion");
    expect(build.files.get(blockPath(10))).toEqual(saved);
  });

  it("an added row goes after the topic's last row, before the hidden rows that follow, and joins the section above it", async () => {
    const unit = await unitAt(`topic:fm:${R(101)}`);
    const part = only(unit, "rows");
    const build = buildSave(unit, new Map([[part.slot.id, addRow(part.slot.doc, R(102), R(105), ["", "new line", ""])]]), TODAY);

    expect(build.changes.map((c) => c.path).sort()).toEqual([blockPath(10), CV_STRUCTURE].sort());
    expect(rowIds(json<BlockFile>(changeOf(build, blockPath(10))).doc)).toEqual([R(100), R(101), R(102), R(105), R(103), R(104)]);
    const structure = json<StructureFile>(changeOf(build, CV_STRUCTURE));
    expect(structure.members[R(105)]).toBe("other");
    expect(build.changed).toContain(R(105));
  });

  it("a blank row added above the topic's first row, on its topic page, is recorded as a member of that topic", async () => {
    const unit = await unitAt(`topic:fm:${R(101)}`);
    const part = only(unit, "rows");
    const build = buildSave(unit, new Map([[part.slot.id, addRow(part.slot.doc, R(100), R(105), ["", "before AF", ""])]]), TODAY);

    expect(rowIds(json<BlockFile>(changeOf(build, blockPath(10))).doc)).toEqual([R(100), R(105), R(101), R(102), R(103), R(104)]);
    expect(json<StructureFile>(changeOf(build, CV_STRUCTURE)).members[R(105)]).toBe(R(101));
  });

  it("deleting the topic's first row on its topic page saves, and reports where the topic's other rows went", async () => {
    const unit = await unitAt(`topic:fm:${R(101)}`);
    expect(unit.topic).toBe(R(101));
    const part = only(unit, "rows");
    // Deleting R101 and adding a row above the rest: the topic-run join would look R101 up in the row order.
    const edited = addRow(dropRow(part.slot.doc, R(101)), R(100), R(105), ["", "before the rest", ""]);
    const build = buildSave(unit, new Map([[part.slot.id, edited]]), TODAY);

    expect(rowIds(json<BlockFile>(changeOf(build, blockPath(10))).doc)).toEqual([R(100), R(105), R(102), R(103), R(104)]);
    const members = json<StructureFile>(changeOf(build, CV_STRUCTURE)).members;
    expect(members[R(101)]).toBeUndefined();
    expect(Object.values(members)).not.toContain(R(101));
    // R105 now opens the rows after the heading, and R102 (no title of its own) continues it.
    expect(build.topicMoved).toEqual({ guide: "fm", system: "cardiovascular", topic: R(105) });
  });

  it("deleting a topic's first row from the system page keeps the rows recorded above it with the rest of the topic, in a tree the build accepts", async () => {
    // Two blank rows added above R101 on its topic page are recorded under it (Orchestrator ruling 04:44Z).
    const topicUnit = await unitAt(`topic:fm:${R(101)}`);
    const tp = only(topicUnit, "rows");
    const above = addRow(addRow(tp.slot.doc, R(100), R(105), ["", "first above", ""]), R(105), R(106), ["", "second above", ""]);
    const first = buildSave(topicUnit, new Map([[tp.slot.id, above]]), TODAY);
    expect(json<StructureFile>(changeOf(first, CV_STRUCTURE)).members).toMatchObject({ [R(105)]: R(101), [R(106)]: R(101) });
    w.fake.commitFiles(Object.fromEntries(first.changes.map((c) => [c.path, changeOf(first, c.path) ?? null])));

    const unit = await unitAt("system:fm:cardiovascular");
    const part = only(unit, "rows");
    const section = part.sys.structure.members[R(101)];
    expect(section).toBe("other");
    const build = buildSave(unit, new Map([[part.slot.id, dropRow(part.slot.doc, R(101))]]), TODAY);

    const structure = json<StructureFile>(changeOf(build, CV_STRUCTURE));
    expect(structure.members[R(102)]).toBe(section);
    expect(structure.members[R(105)]).toBe(R(102));
    expect(structure.members[R(106)]).toBe(R(102));
    const saved = json<BlockFile>(changeOf(build, blockPath(10)));
    const blocks = part.sys.blocks.map((b) => (b.id === saved.id ? saved : b));
    const topics = deriveTopics(blocks, structure);
    expect(() => checkMembers("cardiovascular", topics, structure)).not.toThrow();
    expect(topics.topics.find((t) => t.rows.includes(R(102)))?.rows).toEqual([R(105), R(106), R(102)]);
  });

  it("clearing a topic's name on its page reports where its rows went, and the rows recorded under it keep its section", async () => {
    // A blank row added above R131 on its topic page is recorded under it (Orchestrator ruling 04:44Z).
    const first = await unitAt(`topic:fm:${R(131)}`);
    const fp = only(first, "rows");
    const above = buildSave(first, new Map([[fp.slot.id, addRow(fp.slot.doc, null, R(135), ["", "above heart failure"])]]), TODAY);
    expect(json<StructureFile>(changeOf(above, CV_STRUCTURE)).members[R(135)]).toBe(R(131));
    w.fake.commitFiles(Object.fromEntries(above.changes.map((c) => [c.path, changeOf(above, c.path) ?? null])));

    const unit = await unitAt(`topic:fm:${R(131)}`);
    const part = only(unit, "rows");
    const build = buildSave(unit, new Map([[part.slot.id, setCell(part.slot.doc, R(131), 0, "")]]), TODAY);

    // R131 has no heading above it, so it continues the topic before it: Stable angina (R104).
    expect(build.topicMoved).toEqual({ guide: "fm", system: "cardiovascular", topic: R(104) });
    const structure = json<StructureFile>(changeOf(build, CV_STRUCTURE));
    expect(structure.members[R(135)]).toBe("other");
    const saved = json<BlockFile>(changeOf(build, blockPath(13)));
    const blocks = part.sys.blocks.map((b) => (b.id === saved.id ? saved : b));
    const topics = deriveTopics(blocks, structure);
    expect(() => checkMembers("cardiovascular", topics, structure)).not.toThrow();
    expect(topics.topics.map((t) => t.id)).not.toContain(R(131));
    expect(topics.topics.find((t) => t.id === R(104))?.rows).toEqual(expect.arrayContaining([R(135), R(131)]));
  });

  it("refuses a save whose structure the build would reject, before anything is written", async () => {
    const unit = await unitAt(`topic:fm:${R(101)}`);
    const part = only(unit, "rows");
    // R102 recorded under R101, a topic row above it: the build can't place it.
    part.sys.structure = { ...part.sys.structure, members: { ...part.sys.structure.members, [R(102)]: R(101) } };
    expect(() => buildSave(unit, new Map([[part.slot.id, setCell(part.slot.doc, R(102), 1, "more AF text, revised")]]), TODAY))
      .toThrow(`members records it under ${R(101)}`);
  });

  it("a topic page save that keeps its first row reports no move", async () => {
    const unit = await unitAt(`topic:fm:${R(101)}`);
    const part = only(unit, "rows");
    const build = buildSave(unit, new Map([[part.slot.id, dropRow(part.slot.doc, R(102))]]), TODAY);
    expect(build.changed).toEqual([R(102)]);
    expect(build.topicMoved).toBeUndefined();
  });

  it("a row added to a drug table gets no section in structure.json (drug rows live only in Pharm)", async () => {
    const unit = await unitAt("pharm:fm:cardiovascular:antianginals");
    const part = only(unit, "rows");
    const build = buildSave(unit, new Map([[part.slot.id, addRow(part.slot.doc, R(124), R(125), ["Isosorbide", "venodilator", ""])]]), TODAY);

    expect(build.changes.map((c) => c.path)).toEqual([blockPath(12)]);
    expect(rowIds(json<BlockFile>(changeOf(build, blockPath(12))).doc)).toEqual([R(120), R(121), R(122), R(123), R(124), R(125)]);
    expect(build.changed).toEqual([R(125)]);
  });

  it("a deleted condition row leaves members and its drug table's conditionRows", async () => {
    const unit = await unitAt("pharm:fm:cardiovascular:antianginals");
    const part = only(unit, "rows");
    const build = buildSave(unit, new Map([[part.slot.id, dropRow(part.slot.doc, R(123))]]), TODAY);

    const structure = json<StructureFile>(changeOf(build, CV_STRUCTURE));
    expect(R(123) in structure.members).toBe(false);
    expect(structure.drugTables[0]?.conditionRows).toEqual([]);
    expect(structure.members[R(104)]).toBe("cad");
    expect(rowIds(json<BlockFile>(changeOf(build, blockPath(12))).doc)).not.toContain(R(123));
    expect(build.changed).toEqual([R(123)]);
  });

  it("an edited gap block is stamped with today's date in ownerEdits; an untouched one is not written", async () => {
    const unit = await unitAt("general:fm:labs");
    const gap = only(unit, "gap");
    const edited = clone(gap.doc.doc);
    ((edited.content[0] as Node).content as Node[])[0] = { type: "text", text: "Check TSH and free T4." };

    const build = buildSave(unit, new Map([[gap.doc.id, edited]]), TODAY);
    const path = `content/gapfill/${G(1)}.json`;
    expect(build.changes.map((c) => c.path)).toEqual([path]);
    const saved = json<GapFile>(changeOf(build, path));
    expect(saved.meta.ownerEdits).toEqual([TODAY]);
    expect(saved.meta.title).toBe("TSH in AF");
    expect(build.changed).toEqual([G(1)]);

    expect(buildSave(unit, new Map([[gap.doc.id, clone(gap.doc.doc)]]), TODAY).changes).toEqual([]);
  });

  it("an edited slide is stamped in ownerEdits", async () => {
    const unit = await unitAt(`slide:fm:${S(2)}`);
    const slide = only(unit, "slide");
    const edited = clone(slide.slot.doc);
    ((edited.content[0] as Node).content as Node[])[0] = { type: "text", text: "AF" };
    const build = buildSave(unit, new Map([[slide.slot.id, edited]]), TODAY);
    const saved = json<BlockFile<{ ownerEdits?: string[] }>>(changeOf(build, slide.path));
    expect(saved.meta.ownerEdits).toEqual([TODAY]);
    expect(build.changed).toEqual([S(2)]);
  });

  it("a Word page edit names the document as well as the block", async () => {
    const unit = await unitAt(`doc:${D(5)}`);
    const block = only(unit, "block");
    const edited = clone(block.slot.doc);
    ((edited.content[0] as Node).content as Node[]).splice(0, 1, { type: "text", text: "TSH second " });
    const build = buildSave(unit, new Map([[block.slot.id, edited]]), TODAY);
    expect(build.changes.map((c) => c.path)).toEqual([`content/docs/${D(5)}/blocks/${B(60)}.json`]);
    expect(build.changed).toEqual([B(60), D(5)]);
  });
});

describe("snapshot", () => {
  it("reads each blob once, lists a directory sorted, and refuses a path the commit lacks", async () => {
    const snap = await Snapshot.at(w.git);
    const blobReads = (): number => w.fake.requests.filter((r) => r.url.includes("/git/blobs/")).length;
    const before = blobReads();
    const [a, b] = await Promise.all([snap.text(CV_STRUCTURE), snap.text(CV_STRUCTURE)]);
    expect(a).toBe(b);
    expect(blobReads()).toBe(before + 1);
    expect(snap.under(`${CV}/blocks/`)).toEqual([10, 11, 12, 13, 14].map(blockPath));
    expect(snap.has(CV_STRUCTURE)).toBe(true);
    expect(await snap.jsonIfExists("content/nope.json")).toBeNull();
    await expect(snap.text("content/nope.json")).rejects.toThrow(`content/nope.json is not in ${snap.commit}`);
  });

  it("reads an older commit's files", async () => {
    const first = w.fake.head();
    w.fake.commitFiles({ [CV_STRUCTURE]: null });
    expect((await Snapshot.at(w.git)).has(CV_STRUCTURE)).toBe(false);
    expect((await Snapshot.at(w.git, first)).has(CV_STRUCTURE)).toBe(true);
  });
});

describe("localDate", () => {
  it("is the local calendar date, zero-padded", () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(localDate(new Date(2026, 11, 31, 0, 0))).toBe("2026-12-31");
  });
});
