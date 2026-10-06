// Edit units and the save builder (plan 50 §50.2, §50.4) against the synthetic content tree in the
// GitHub fake: what each page key edits, and exactly which files a save writes.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readContent, writeContent } from "../../lib/content/fs.ts";
import { serializeFile, type CardsFile, type DocJSON, type GapFile, type StructureFile, type BlockFile } from "../../lib/content/index.ts";
import type { SystemJson } from "../../lib/derive/published.ts";
import { checkMembers, deriveTopics } from "../../lib/derive/topics.ts";
import { B, C, D, G, PHARM_PAGE, R, S, writePharmReviewPage } from "../../tools/build/test-fixture.ts";
import { publishFixture } from "../testing.tsx";
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
  it("topic: one rows editor with the topic's rows and its heading, then its empty below area; the block and structure.json are its files", async () => {
    const unit = await unitAt(`topic:fm:${R(101)}`);
    const part = only(unit, "rows");
    expect(unit.parts.map((p) => p.kind)).toEqual(["rows", "below"]);
    const below = only(unit, "below");
    expect(below.block).toBeNull();
    expect(below.path).toBe(`${CV}/below/${R(101)}.json`);
    expect(part.shown).toEqual([R(100), R(101), R(102)]);
    expect(rowIds(part.slot.doc)).toEqual([R(100), R(101), R(102)]);
    expect(part.slot.basePt).toBe(10);
    expect(part.slot.pageContentPt).toBe(792 - 36 - 36);
    expect(unit.scope).toEqual({ files: [blockPath(10), CV_STRUCTURE, below.path].sort(), dirs: [] });
    expect(unit.ids).toEqual([R(100), R(101), R(102)]);
    expect(unit.snapshot.commit).toBe(w.fake.head());
  });

  it("topic continuing into the next table: one rows editor per table, and a save writes each table's rows into that table", async () => {
    const unit = await unitAt(`topic:fm:${R(104)}`);
    expect(unit.parts.map((p) => (p.kind === "rows" ? [p.block.id, p.shown] : p.kind))).toEqual([
      [B(10), [R(103), R(104)]],
      [B(13), [R(130)]],
      "below",
    ]);
    const cont = only(unit, "rows", 1);
    const build = buildSave(unit, new Map([[cont.slot.id, setCell(cont.slot.doc, R(130), 1, "angina, continued")]]), TODAY);
    expect(build.changes.map((c) => c.path)).toEqual([blockPath(13)]);
    expect(build.changed).toEqual([R(130)]);
    const saved = json<BlockFile>(changeOf(build, blockPath(13)));
    expect(rowIds(saved.doc)).toEqual([R(130), R(131)]);
    expect(cellText(rowsOfDoc(saved.doc)[0] as Node, 1)).toBe("angina, continued");
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
    expect(unit.parts.map((p) => [p.kind, p.kind === "stub" ? p.block : p.kind === "gap" ? p.gap.id : p.kind === "below" ? p.topic : p.block.id])).toEqual([
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

  it("ref and other keys: her Word-page blocks shown as notes come first (each once, edited whole), then the gap blocks", async () => {
    const REFTABS = "content/places/reftabs.json";
    const OTHER = "content/places/other.json";
    const tabs = json<{ labs: { subs: Record<string, unknown>[] } }>(w.fake.readFile(REFTABS));
    tabs.labs.subs = tabs.labs.subs.map((s) => ({ ...s, notes: [{ heading: "Thyroid" }, { block: B(61) }, { block: B(61), column: 1 }, { block: B(60) }] }));
    const other = json<{ sections: Record<string, unknown>[] }>(w.fake.readFile(OTHER));
    other.sections = other.sections.map((s) => (s.id === "vaccines" ? { ...s, notes: [{ block: B(60) }, { block: B(9999) }] } : s));
    w.fake.commitFiles({ [REFTABS]: serializeFile(REFTABS, tabs), [OTHER]: serializeFile(OTHER, other) });

    const docDir = `content/docs/${D(5)}`;
    const ref = await unitAt("ref:labs:cbc");
    expect(ref.parts.map((p) => (p.kind === "gap" ? p.gap.id : p.kind === "block" ? p.block.id : p.kind))).toEqual([B(61), B(60), G(1)]);
    const table = only(ref, "block");
    expect(table.path).toBe(`${docDir}/blocks/${B(61)}.json`);
    expect(table.owner).toEqual({ kind: "doc", path: `${docDir}/doc.json` });
    expect(table.slot.basePt).toBe(11);
    expect(table.slot.pageContentPt).toBe(792 - 36 - 36);
    expect(ref.scope.files).toEqual([`${docDir}/blocks/${B(60)}.json`, `${docDir}/blocks/${B(61)}.json`, `content/gapfill/${G(1)}.json`]);
    // The lead gap block, then the notes (a block on no page of hers is left out), then any gaps.
    expect((await unitAt("other:vaccines")).parts.map((p) => (p.kind === "gap" ? p.gap.id : p.kind === "block" ? p.block.id : p.kind))).toEqual([G(3), B(60)]);

    const build = buildSave(ref, new Map([[table.slot.id, setCell(table.slot.doc, R(601), 1, "low (edited)")]]), TODAY);
    expect(build.changes.map((c) => c.path)).toEqual([`${docDir}/blocks/${B(61)}.json`]);
    expect(build.changed).toEqual([B(61)]);
  });

  it("other key with an outline: the blocks of its Word doc items in order (a PDF or removed doc adds none), then its gap blocks", async () => {
    const OTHER = "content/places/other.json";
    const other = json<{ sections: Record<string, unknown>[] }>(w.fake.readFile(OTHER));
    other.sections = other.sections.map((s) => (s.id === "pe" ? { ...s, files: [D(1), D(5)], gaps: [G(1)], notes: [{ heading: "Cardiac" }, { doc: D(1) }, { doc: D(5) }, { gap: G(1) }] } : s));
    w.fake.commitFiles({ [OTHER]: serializeFile(OTHER, other) });
    const pe = await unitAt("other:pe");
    expect(pe.parts.map((p) => (p.kind === "gap" ? p.gap.id : p.kind === "block" ? p.block.id : p.kind))).toEqual([B(60), B(61), G(1)]);
    expect(only(pe, "block").owner).toEqual({ kind: "doc", path: `content/docs/${D(5)}/doc.json` });

    const DOC = `content/docs/${D(5)}/doc.json`;
    const doc = json<Record<string, unknown>>(w.fake.readFile(DOC));
    w.fake.commitFiles({ [DOC]: serializeFile(DOC, { ...doc, removed: { at: "2026-10-05T10:00:00Z", from: "b".repeat(40) } }) });
    expect((await unitAt("other:pe")).parts.map((p) => (p.kind === "gap" ? p.gap.id : p.kind))).toEqual([G(1)]);
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

  it("a topic page's new column widths and cell margins are saved on the table, naming every row it draws", async () => {
    const unit = await unitAt(`topic:fm:${R(101)}`);
    const part = only(unit, "rows");
    const edited = clone(part.slot.doc);
    const table = edited.content[0] as Node;
    const grid = (table.attrs?.grid as number[]).map((g, i) => (i === 0 ? g + 9 : i === 1 ? g - 9 : g));
    const cellMarginPt = { top: 2, right: 6.4, bottom: 2, left: 6.4 };
    table.attrs = { ...table.attrs, grid, cellMarginPt };
    const build = buildSave(unit, new Map([[part.slot.id, edited]]), TODAY);

    expect(build.changes.map((c) => c.path)).toEqual([blockPath(10)]);
    const saved = json<BlockFile>(changeOf(build, blockPath(10)));
    expect((saved.doc.content[0] as Node).attrs).toMatchObject({ grid, cellMarginPt });
    // The rows the topic page did not show are kept, and are drawn with the new widths too.
    expect(rowIds(saved.doc)).toEqual([R(100), R(101), R(102), R(103), R(104)]);
    expect(build.changed).toEqual([R(100), R(101), R(102), R(103), R(104)]);
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

  describe("a pharm file made from her Word page", () => {
    let pageFx: Fixture;
    beforeAll(async () => {
      pageFx = await publishFixture(undefined, writePharmReviewPage);
    }, 60_000);
    beforeEach(() => {
      w.stop();
      w = startWorld(pageFx);
    });
    const pageBlock = `content/docs/${PHARM_PAGE}/blocks/${B(81)}.json`;

    it("edits her table on the Pharm section once, however many cards cut it, and saves it to her page", async () => {
      const unit = await unitAt("pharm:fm:cardiovascular:antianginals");
      const tables = unit.parts.filter((p): p is Extract<Part, { kind: "block" }> => p.kind === "block" && p.block.id === B(81));
      expect(tables).toHaveLength(1);
      const part = tables[0];
      if (!part) throw new Error("no part shows her table");
      expect([part.path, part.owner]).toEqual([pageBlock, { kind: "doc", path: `content/docs/${PHARM_PAGE}/doc.json` }]);
      expect(unit.scope.files).toContain(pageBlock);

      const build = buildSave(unit, new Map([[part.slot.id, setCell(part.slot.doc, R(811), 2, "INR 2-3")]]), TODAY);
      expect(build.changes.map((c) => c.path)).toEqual([pageBlock]);
      expect(cellText(rowsOfDoc(json<BlockFile>(changeOf(build, pageBlock)).doc)[1] as Node, 2)).toBe("INR 2-3");
    });

    it("opens her table with the class card it is shown inside, after that card's own blocks", async () => {
      // Her warfarin card shown inside the nitrates card (C(2), placed in antianginals): the section lists
      // only C(2), whose card shows C(2)'s part and then hers.
      const inFx = await publishFixture(undefined, async (root) => {
        await writePharmReviewPage(root);
        const cards = await readContent<CardsFile>(root, "content/pharm/cards.json");
        await writeContent(root, "content/pharm/cards.json", { ...cards, cards: cards.cards.map((c) => (c.id === C(80) ? { ...c, in: C(2) } : c)) });
      });
      w.stop();
      w = startWorld(inFx);
      const sys = inFx.published.get("g/fm/s/cardiovascular.json") as SystemJson;
      const section = sys.pharm?.sections.find((s) => s.id === "antianginals");
      expect(section?.cards).toContain(C(2));
      expect(section?.cards).not.toContain(C(80));

      const unit = await unitAt("pharm:fm:cardiovascular:antianginals");
      const blocks = unit.parts.flatMap((p) => (p.kind === "block" ? [p.block.id] : []));
      expect(blocks.slice(blocks.indexOf(B(72)), blocks.indexOf(B(72)) + 2)).toEqual([B(72), B(81)]);
      const part = unit.parts.find((p): p is Extract<Part, { kind: "block" }> => p.kind === "block" && p.block.id === B(81));
      expect([part?.path, part?.owner]).toEqual([pageBlock, { kind: "doc", path: `content/docs/${PHARM_PAGE}/doc.json` }]);
    }, 60_000);
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

  describe("a gap block's differs note and look", () => {
    const ASSET = `${"e3".repeat(16)}.png`;
    const figure = {
      asset: ASSET, width: 960, height: 721, caption: "Hexaxial",
      credit: { author: "Jane Roe", license: "Public domain", licenseUrl: null, page: "https://commons.wikimedia.org/wiki/File:H.png", changes: null },
      evidence: { quote: "Hexaxial", accessed: "2026-10-05" },
    };
    const para = (text: string): DocJSON => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] } as DocJSON);
    const path = `content/gapfill/${G(1)}.json`;

    /** The labs unit with its gap block given a differs note and a figure (in memory). */
    async function gapUnit(meta: Partial<GapFile["meta"]> = {}): Promise<{ unit: EditUnit; part: Extract<Part, { kind: "gap" }> }> {
      const unit = await unitAt("general:fm:labs");
      const was = only(unit, "gap");
      const differs = para("Your notes say 8 h.");
      const gap: GapFile = { ...was.gap, meta: { ...was.gap.meta, differs: { doc: differs }, figures: [figure], ...meta } };
      const part = { ...was, gap, differs: { ...was.doc, id: `${G(1)}:differs`, doc: differs } };
      return { unit: { ...unit, parts: unit.parts.map((p) => (p === was ? part : p)) }, part };
    }

    it("an emptied differs note saves as null, not an empty paragraph", async () => {
      const { unit, part } = await gapUnit();
      const emptied = { type: "doc", content: [{ type: "paragraph" }] } as DocJSON;
      const build = buildSave(unit, new Map([[`${G(1)}:differs`, emptied]]), TODAY);
      const saved = json<GapFile>(changeOf(build, path));
      expect(saved.meta.differs).toBeNull();
      expect(saved.meta.ownerEdits).toEqual([...part.gap.meta.ownerEdits, TODAY]);
      // A kept differs note is saved as edited.
      const kept = json<GapFile>(changeOf(buildSave(unit, new Map([[`${G(1)}:differs`, para("Your notes say 6 h.")]]), TODAY), path));
      expect(JSON.stringify(kept.meta.differs?.doc)).toContain('"text":"Your notes say 6 h."');
    });

    it("a changed look writes each figure's width and asNotes, stamped as an edit", async () => {
      const { unit } = await gapUnit();
      const looks = new Map([[G(1), { widths: { [ASSET]: 300 }, asNotes: true }]]);
      const build = buildSave(unit, new Map(), TODAY, { looks });
      const saved = json<GapFile>(changeOf(build, path));
      expect(saved.meta.figures?.[0]?.widthPt).toBe(300);
      expect(saved.meta.figures?.[0]?.caption).toBe("Hexaxial");
      expect(saved.meta.asNotes).toBe(true);
      expect(saved.meta.ownerEdits).toEqual([TODAY]);
      expect(build.changed).toEqual([G(1)]);
    });

    it("a look back to natural size and labeled drops widthPt and asNotes from the file", async () => {
      const { unit } = await gapUnit({ asNotes: true, figures: [{ ...figure, widthPt: 300 }] });
      const build = buildSave(unit, new Map(), TODAY, { looks: new Map([[G(1), { widths: {}, asNotes: false }]]) });
      const saved = json<GapFile>(changeOf(build, path));
      expect(saved.meta.figures?.[0]).not.toHaveProperty("widthPt");
      expect(saved.meta).not.toHaveProperty("asNotes");
    });

    it("an unchanged look writes nothing", async () => {
      const { unit } = await gapUnit({ asNotes: true, figures: [{ ...figure, widthPt: 300 }] });
      const build = buildSave(unit, new Map(), TODAY, { looks: new Map([[G(1), { widths: { [ASSET]: 300 }, asNotes: true }]]) });
      expect(build.changes).toEqual([]);
    });

    it("a restore takes the version's look", async () => {
      const { unit } = await gapUnit({ asNotes: true, figures: [{ ...figure, widthPt: 300 }] });
      const { unit: version } = await gapUnit();
      const build = buildSave(unit, new Map(), TODAY, { restore: version });
      const saved = json<GapFile>(changeOf(build, path));
      expect(saved.meta.figures?.[0]).not.toHaveProperty("widthPt");
      expect(saved.meta).not.toHaveProperty("asNotes");
    });
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

describe("a topic's below area", () => {
  const belowPath = (topic: string): string => `${CV}/below/${topic}.json`;
  const prose = (text: string): DocJSON => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }) as DocJSON;
  const textOf = (doc: DocJSON): string[] => (doc.content as Node[]).map((p) => (p.content ?? []).map((t) => t.text ?? "").join(""));
  const commit = (build: ReturnType<typeof buildSave>): void => {
    w.fake.commitFiles(Object.fromEntries(build.changes.map((c) => [c.path, changeOf(build, c.path) ?? null])));
  };
  /** Saves `text` into topic R101's below area and commits it; returns the saved block. */
  async function addBelow(text: string): Promise<BlockFile> {
    const unit = await unitAt(`topic:fm:${R(101)}`);
    const build = buildSave(unit, new Map([[only(unit, "below").slot.id, prose(text)]]), TODAY);
    commit(build);
    return json<BlockFile>(changeOf(build, belowPath(R(101))));
  }

  it("leaving the empty area untouched, or saving it still empty, writes nothing", async () => {
    const unit = await unitAt(`topic:fm:${R(101)}`);
    const below = only(unit, "below");
    expect(buildSave(unit, new Map(), TODAY).changes).toEqual([]);
    expect(buildSave(unit, new Map([[below.slot.id, below.slot.doc]]), TODAY).changes).toEqual([]);
  });

  it("typing in it writes a new prose block at the topic's below path", async () => {
    const unit = await unitAt(`topic:fm:${R(101)}`);
    const build = buildSave(unit, new Map([[only(unit, "below").slot.id, prose("ECG strip here")]]), TODAY);
    expect(build.changes.map((c) => c.path)).toEqual([belowPath(R(101))]);
    const saved = json<BlockFile>(changeOf(build, belowPath(R(101))));
    expect(saved.kind).toBe("prose");
    expect(saved.id).toMatch(/^b_/);
    expect(textOf(saved.doc)).toEqual(["ECG strip here"]);
    expect(build.changed).toEqual([saved.id]);
  });

  it("once saved, the topic page loads it, an edit rewrites it in place, and emptying it deletes the file", async () => {
    const first = await addBelow("first note");
    const unit = await unitAt(`topic:fm:${R(101)}`);
    const below = only(unit, "below");
    expect(below.block?.id).toBe(first.id);
    expect(textOf(below.slot.doc)).toEqual(["first note"]);
    expect(unit.ids).toContain(first.id);

    const edit = buildSave(unit, new Map([[below.slot.id, prose("second note")]]), TODAY);
    expect(edit.changes.map((c) => c.path)).toEqual([belowPath(R(101))]);
    const rewritten = json<BlockFile>(changeOf(edit, belowPath(R(101))));
    expect(rewritten.id).toBe(first.id);
    expect(textOf(rewritten.doc)).toEqual(["second note"]);

    const emptied = buildSave(unit, new Map([[below.slot.id, { type: "doc", content: [{ type: "paragraph" }] } as DocJSON]]), TODAY);
    expect(emptied.changes).toEqual([{ path: belowPath(R(101)), sha: null }]);
    expect(emptied.files.get(belowPath(R(101)))).toBeNull();
    expect(emptied.changed).toEqual([first.id]);
  });

  it("shows under its table on the section and system pages, after the table holding the topic's last row", async () => {
    const saved = await addBelow("under the table");
    // R101 is in section "other" (see the system-page delete test above).
    const section = await unitAt("section:fm:cardiovascular:other");
    const kinds = (u: EditUnit): string[] => u.parts.map((p) => (p.kind === "below" ? `below ${p.topic}` : p.kind === "rows" ? `rows ${p.block.id}` : p.kind));
    expect(kinds(section)).toContain(`below ${R(101)}`);
    expect(kinds(section)[kinds(section).indexOf(`below ${R(101)}`) - 1]).toBe(`rows ${B(10)}`);
    expect(only(section, "below").block?.id).toBe(saved.id);

    const system = await unitAt("system:fm:cardiovascular");
    expect(kinds(system).slice(0, 2)).toEqual([`rows ${B(10)}`, `below ${R(101)}`]);
  });

  it("follows its topic when a save gives the topic a new first row", async () => {
    const saved = await addBelow("follows the topic");
    const unit = await unitAt(`topic:fm:${R(101)}`);
    const part = only(unit, "rows");
    const edited = addRow(dropRow(part.slot.doc, R(101)), R(100), R(105), ["", "before the rest", ""]);
    const build = buildSave(unit, new Map([[part.slot.id, edited]]), TODAY);

    expect(build.topicMoved?.topic).toBe(R(105));
    expect(json<BlockFile>(changeOf(build, belowPath(R(105))))).toEqual(saved);
    expect(build.changes).toContainEqual({ path: belowPath(R(101)), sha: null });
  });
});

// Orchestrator rulings 2026-10-04 21:02Z and 22:01Z: a save never leaves a `titled` entry the build
// would refuse — an edit that breaks the row's heading drops the entry, and the row is titled by
// 40 §40.2 again; an edit that keeps it keeps the entry.
describe("a save and titled rows", () => {
  /** Commits structure.json with `titled` (R101 under heading R100 "ARRHYTHMIAS | Presentation | Treatment"). */
  async function withTitled(titled: Record<string, number>): Promise<void> {
    const unit = await unitAt("system:fm:cardiovascular");
    const structure = { ...only(unit, "rows").sys.structure, titled };
    w.fake.commitFiles({ [CV_STRUCTURE]: serializeFile(CV_STRUCTURE, structure) });
  }

  /** Saves `edit` of B10's rows from the system page; returns the saved structure (null when unchanged) and the derivation the build would make. */
  async function save(edit: (doc: DocJSON) => DocJSON, key = "system:fm:cardiovascular") {
    const unit = await unitAt(key);
    const part = only(unit, "rows");
    const build = buildSave(unit, new Map([[part.slot.id, edit(part.slot.doc)]]), TODAY);
    const changed = changeOf(build, CV_STRUCTURE);
    const structure = changed === undefined ? part.sys.structure : json<StructureFile>(changed);
    const saved = json<BlockFile>(changeOf(build, blockPath(10)));
    const blocks = part.sys.blocks.map((b) => (b.id === saved.id ? saved : b));
    const topics = deriveTopics(blocks, structure);
    checkMembers("cardiovascular", topics, structure);
    return { written: changed !== undefined, structure, title: (id: string) => topics.topics.find((t) => t.id === id)?.title };
  }

  /** The heading row R100 with its cells replaced by `cells`. */
  function headingCells(doc: DocJSON, cells: Node[]): DocJSON {
    const out = clone(doc);
    const row = rowsOfDoc(out).find((r) => r.attrs?.id === R(100));
    if (!row) throw new Error("no heading row");
    row.content = cells;
    return out;
  }

  it("an edit that keeps the heading keeps the entry, and the title follows the edited cell", async () => {
    await withTitled({ [R(101)]: 0 });
    const kept = await save((d) => setCell(d, R(102), 1, "more AF text, revised"));
    expect(kept.written).toBe(false);
    expect(kept.title(R(101))).toBe("ARRHYTHMIAS");
    const renamed = await save((d) => setCell(d, R(100), 0, "TACHYARRHYTHMIAS"));
    expect(renamed.structure.titled).toEqual({ [R(101)]: 0 });
    expect(renamed.title(R(101))).toBe("TACHYARRHYTHMIAS");
  });

  it("deleting the titled row drops its entry", async () => {
    await withTitled({ [R(101)]: 0 });
    const r = await save((d) => dropRow(d, R(101)));
    expect(r.written).toBe(true);
    expect(r.structure).not.toHaveProperty("titled");
  });

  it("deleting the heading row above drops the entry; the row is titled by its own first cell again", async () => {
    await withTitled({ [R(101)]: 0 });
    const r = await save((d) => dropRow(d, R(100)));
    expect(r.structure).not.toHaveProperty("titled");
    expect(r.title(R(101))).toBe("Atrial fibrillation (AF)");
  });

  it("a row inserted between the heading and the titled row drops the entry", async () => {
    await withTitled({ [R(101)]: 0 });
    const r = await save((d) => addRow(d, R(100), R(105), ["", "inserted", ""]));
    expect(r.structure).not.toHaveProperty("titled");
    expect(r.title(R(101))).toBe("Atrial fibrillation (AF)");
  });

  it("a row added above the titled row on its own topic page is recorded under it, and the entry stays", async () => {
    await withTitled({ [R(101)]: 0 });
    const r = await save((d) => addRow(d, R(100), R(105), ["", "before AF", ""]), `topic:fm:${R(101)}`);
    expect(r.structure.members[R(105)]).toBe(R(101));
    expect(r.structure.titled).toEqual({ [R(101)]: 0 });
    expect(r.title(R(101))).toBe("ARRHYTHMIAS");
  });

  it("emptying the named heading cell drops the entry", async () => {
    await withTitled({ [R(101)]: 2 });
    const r = await save((d) => setCell(d, R(100), 2, ""));
    expect(r.structure).not.toHaveProperty("titled");
    expect(r.title(R(101))).toBe("Atrial fibrillation (AF)");
  });

  it("merging the named cell into the one before it drops the entry; a cell the merge leaves keeps its entry", async () => {
    await withTitled({ [R(101)]: 1 });
    const merged = { type: "table_cell", attrs: { colspan: 2, rowspan: 1 }, content: [{ type: "paragraph", content: [{ type: "text", text: "ARRHYTHMIAS" }] }] };
    const r = await save((d) => headingCells(d, [merged, cell("Treatment")]));
    expect(r.structure).not.toHaveProperty("titled");

    await withTitled({ [R(101)]: 2 });
    const k = await save((d) => headingCells(d, [merged, cell("Treatment")]));
    expect(k.structure.titled).toEqual({ [R(101)]: 2 });
    expect(k.title(R(101))).toBe("Treatment");
  });

  it("removing the column the entry names drops the entry", async () => {
    await withTitled({ [R(101)]: 2 });
    const r = await save((d) => {
      const out = clone(d);
      const table = out.content[0] as Node;
      table.attrs = { ...table.attrs, grid: [100, 100] };
      for (const row of table.content ?? []) row.content = (row.content ?? []).slice(0, 2);
      return out;
    });
    expect(r.structure).not.toHaveProperty("titled");
    expect(r.title(R(101))).toBe("Atrial fibrillation (AF)");
  });
});

// Ruling 2026-10-06: an `unlisted` row's entry lives as long as the row, and a restore brings it back with the row.
describe("a save and unlisted rows", () => {
  /** Commits structure.json with R131 "Heart failure" (B13) unlisted. */
  async function withUnlisted(): Promise<void> {
    const unit = await unitAt("system:fm:cardiovascular");
    const structure = { ...only(unit, "rows").sys.structure, unlisted: [R(131)] };
    w.fake.commitFiles({ [CV_STRUCTURE]: serializeFile(CV_STRUCTURE, structure) });
  }
  const b13 = (unit: EditUnit) => {
    const part = unit.parts.find((p): p is Extract<Part, { kind: "rows" }> => p.kind === "rows" && p.block.id === B(13));
    if (!part) throw new Error("no B13 rows part");
    return part;
  };
  const saveB13 = async (edit: (doc: DocJSON) => DocJSON) => {
    const unit = await unitAt("system:fm:cardiovascular");
    const part = b13(unit);
    return buildSave(unit, new Map([[part.slot.id, edit(part.slot.doc)]]), TODAY);
  };

  it("an edit that keeps the row keeps the entry, and the row stays out of the topics", async () => {
    await withUnlisted();
    const build = await saveB13((d) => setCell(d, R(131), 1, "HFrEF; loop diuretics; SGLT2i"));
    expect(changeOf(build, CV_STRUCTURE)).toBeUndefined();
    const unit = await unitAt("system:fm:cardiovascular");
    const t = deriveTopics(b13(unit).sys.blocks, b13(unit).sys.structure);
    expect(t.topics.map((x) => x.id)).not.toContain(R(131));
    expect(t.untitled).toContain(R(131));
  });

  it("deleting the row drops its entry, and a restore of the version before brings both back", async () => {
    await withUnlisted();
    const version = await unitAt("system:fm:cardiovascular");
    const build = await saveB13((d) => dropRow(d, R(131)));
    const saved = json<StructureFile>(changeOf(build, CV_STRUCTURE));
    expect(saved).not.toHaveProperty("unlisted");
    w.fake.commitFiles(Object.fromEntries(build.changes.flatMap((c) => ("content" in c ? [[c.path, c.content]] : []))));
    const restored = buildSave(await unitAt("system:fm:cardiovascular"), new Map(), TODAY, { restore: version });
    expect(json<StructureFile>(changeOf(restored, CV_STRUCTURE)).unlisted).toEqual([R(131)]);
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
