// The owner's local overlay (plan 50 §50.5): published data patched with her saved files until the
// deployed site contains them, and dropped once it does.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BlockFile, DocJSON, GapFile, MedsFile, OtherFile, StructureFile, WordDocFile, AsIsFile } from "../../lib/content/index.ts";
import type { DocJson, DocList, DocRef, OtherJson, PubBlock, PubGap, PubNote, PubOtherNote, RefTabJson, SystemJson } from "../../lib/derive/published.ts";
import { B, C, D, G, R } from "../../tools/build/test-fixture.ts";
import { loadData } from "../data/load.ts";
import { memoryStore, type KvStore } from "./idb.ts";
import {
  overlayEntries, patchPublished, pruneOverlay, recordSaved, setOverlayStoreForTests, startOverlay, stopOverlay, type OverlayEntry,
} from "./overlay.ts";
import { Snapshot } from "./snapshot.ts";
import { loadFixture, startWorld, type Fixture, type World } from "./testkit.ts";
import { buildSave, loadUnit } from "./units.ts";

const CV = "content/guides/fm/cardiovascular";
const SYS = "g/fm/s/cardiovascular.json";

let fx: Fixture;
let w: World;
let published: Map<string, unknown>;
let store: KvStore<OverlayEntry>;

beforeAll(async () => {
  fx = await loadFixture();
}, 60_000);

beforeEach(() => {
  published = new Map(fx.published);
  w = startWorld(fx, published);
  store = memoryStore<OverlayEntry>();
  setOverlayStoreForTests(store);
});

afterEach(() => {
  stopOverlay();
  w.stop();
});

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const fileJson = <T>(path: string): T => {
  const bytes = fx.files[path];
  if (!bytes) throw new Error(`${path} is not in the fixture`);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
};
const para = (text: string): DocJSON => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const pub = <T>(path: string): T => clone(fx.published.get(path) as T);
const need = <T>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new Error(`${what} is not in the fixture`);
  return v;
};

// The fixture's places have no outline or notes; these put some into their published pages.
const guidelines = (other: unknown): OtherJson["sections"][number] => need((other as OtherJson).sections.find((s) => s.id === "guidelines"), "the Guidelines section");
/** Published other.json with `notes` as the Guidelines section's outline. */
const otherWith = (notes: PubOtherNote[]): OtherJson => {
  const o = pub<OtherJson>("other.json");
  return { ...o, sections: o.sections.map((s) => (s.id === "guidelines" ? { ...s, notes } : s)) };
};
/** Published ref/labs.json with `notes` as its first sub's notes. */
const refWith = (notes: PubNote[]): RefTabJson => {
  const r = pub<RefTabJson>("ref/labs.json");
  return { ...r, subs: r.subs.map((s, i) => (i === 0 ? { ...s, notes } : s)) };
};
/** The blocks of her Word page "Thyroid notes" (D(5)), as published. */
const thyroidBlocks = (): [PubBlock, PubBlock] => {
  const [b60, b61] = pub<DocJson>(`docs/${D(5)}.json`).blocks ?? [];
  if (b60?.id !== B(60) || b61?.id !== B(61)) throw new Error("expected D(5)'s blocks B(60), B(61)");
  return [b60, b61];
};
const blockNote = (block: PubBlock): Extract<PubNote, { block: PubBlock }> => ({ block, basePt: 11, column: null, rows: null });

describe("patchPublished", () => {
  it("returns the published file itself when nothing is overlaid", () => {
    const sys = pub<SystemJson>(SYS);
    expect(patchPublished(SYS, sys, new Map())).toBe(sys);
  });

  it("puts a saved prose block's doc into the system page", () => {
    const block = { ...fileJson<BlockFile>(`${CV}/blocks/${B(11)}.json`), doc: para("Murmurs, revised") };
    const out = patchPublished(SYS, pub<SystemJson>(SYS), new Map([[`${CV}/blocks/${B(11)}.json`, block]])) as SystemJson;
    expect(out.blocks.find((b) => b.id === B(11))?.doc).toEqual(para("Murmurs, revised"));
    expect(out.blocks.find((b) => b.id === B(10))?.doc).toEqual(pub<SystemJson>(SYS).blocks.find((b) => b.id === B(10))?.doc);
  });

  it("re-derives rows, topics and sections when a save added a row (structure.json from the overlay)", async () => {
    const unit = await loadUnit(`topic:fm:${R(101)}`, await Snapshot.at(w.git));
    const part = unit.parts[0];
    if (part?.kind !== "rows") throw new Error("expected a rows part");
    const doc = clone(part.slot.doc) as DocJSON & { content: { content: unknown[] }[] };
    const row = { type: "table_row", attrs: { id: R(105), kind: "content" }, content: ["", "new line", ""].map((t) => ({ type: "table_cell", content: [t ? { type: "paragraph", content: [{ type: "text", text: t }] } : { type: "paragraph" }] })) };
    doc.content[0]?.content.push(row);
    const build = buildSave(unit, new Map([[part.slot.id, doc]]), "2026-10-04");
    expect(build.files.has(`${CV}/structure.json`)).toBe(true);

    const out = patchPublished(SYS, pub<SystemJson>(SYS), build.files) as SystemJson;
    expect(out.rows[R(105)]).toMatchObject({ block: B(10), kind: "content", topic: R(101) });
    expect(out.topics.find((t) => t.id === R(101))?.rows).toContain(R(105));
    const other = out.sections.find((s) => s.id === "other")?.items.find((i) => i.block === B(10));
    expect(other?.rows).toContain(R(105));
    // A topic's meds panel is kept from the published page.
    expect(out.topics.find((t) => t.id === R(101))?.meds).toEqual(pub<SystemJson>(SYS).topics.find((t) => t.id === R(101))?.meds);
  });

  it("uses the structure.json passed in when only a table of the system is overlaid", () => {
    const block = fileJson<BlockFile>(`${CV}/blocks/${B(10)}.json`);
    const structure = fileJson<StructureFile>(`${CV}/structure.json`);
    const withoutStructure = patchPublished(SYS, pub<SystemJson>(SYS), new Map([[`${CV}/blocks/${B(10)}.json`, block]]), null) as SystemJson;
    const withStructure = patchPublished(SYS, pub<SystemJson>(SYS), new Map([[`${CV}/blocks/${B(10)}.json`, block]]), structure) as SystemJson;
    expect(withoutStructure.topics).toEqual(pub<SystemJson>(SYS).topics);
    expect(withStructure.topics.map((t) => t.id)).toEqual(pub<SystemJson>(SYS).topics.map((t) => t.id));
  });

  it("shows a saved below block on its topic, and drops one the save deleted", () => {
    const structure = fileJson<StructureFile>(`${CV}/structure.json`);
    const path = `${CV}/below/${R(101)}.json`;
    const below: BlockFile = { v: 1, id: B(901), kind: "prose", doc: para("notes under AF"), meta: {} } as BlockFile;
    const added = patchPublished(SYS, pub<SystemJson>(SYS), new Map([[path, below]]), structure) as SystemJson;
    expect(added.topics.find((t) => t.id === R(101))?.below).toEqual({ id: B(901), kind: "prose", doc: para("notes under AF") });
    expect(added.topics.filter((t) => t.id !== R(101)).every((t) => t.below === null)).toBe(true);

    const removed = patchPublished(SYS, added, new Map([[path, null]]), structure) as SystemJson;
    expect(removed.topics.find((t) => t.id === R(101))?.below).toBeNull();
  });

  it("shows her saved meds panel on its topic (a card off, one added from the page, her version), and drops one the save deleted", () => {
    const structure = fileJson<StructureFile>(`${CV}/structure.json`);
    const path = `${CV}/meds/${R(101)}.json`;
    const pieces = [{ kind: "notes" as const, basePt: 9, title: null, file: "Cardio med list", doc: para("my CCB notes") }];
    const file: MedsFile = { v: 1, add: [C(3)], remove: [], own: [{ target: C(1), pieces }] };
    const added = patchPublished(SYS, pub<SystemJson>(SYS), new Map([[path, file]]), structure) as SystemJson;
    const af = added.topics.find((t) => t.id === R(101));
    expect(af?.meds).toEqual(pub<SystemJson>(SYS).topics.find((t) => t.id === R(101))?.meds);
    expect(af?.medsEdit).toEqual({ remove: [], add: [expect.objectContaining({ card: C(3), target: C(3) })], own: { [C(1)]: pieces } });
    expect(added.topics.filter((t) => t.id !== R(101)).every((t) => t.medsEdit === null)).toBe(true);

    const removed = patchPublished(SYS, added, new Map([[path, null]]), structure) as SystemJson;
    expect(removed.topics.find((t) => t.id === R(101))?.medsEdit).toBeNull();
    // A save of another file of the system keeps the published panel of hers.
    const kept = patchPublished(SYS, added, new Map([[`${CV}/below/${R(104)}.json`, null]]), structure) as SystemJson;
    expect(kept.topics.find((t) => t.id === R(101))?.medsEdit).toEqual(af?.medsEdit);
  });

  it("patches a saved gap block wherever it is shown, with its owner edits", () => {
    const gap = fileJson<GapFile>(`content/gapfill/${G(1)}.json`);
    const saved: GapFile = { ...gap, doc: para("Check TSH and free T4."), meta: { ...gap.meta, ownerEdits: ["2026-10-04"] } };
    const files = new Map([[`content/gapfill/${G(1)}.json`, saved]]);
    for (const path of ["g/fm/general/labs.json", "ref/labs.json"]) {
      const text = JSON.stringify(patchPublished(path, pub(path), files));
      const found = JSON.stringify(para("Check TSH and free T4.").content);
      expect(text, path).toContain(found);
      expect(text, path).toContain('"ownerEdits":["2026-10-04"]');
    }
  });

  it("a saved gap block switched to her notes shows as her notes; switched back, labeled again", () => {
    const path = `content/gapfill/${G(1)}.json`;
    const gap = fileJson<GapFile>(path);
    const gapIn = (v: unknown): { asNotes: boolean } | undefined => (v as { subs: { gaps: { id: string; asNotes: boolean }[] }[] }).subs[0]?.gaps.find((g) => g.id === G(1));
    const on = patchPublished("ref/labs.json", pub("ref/labs.json"), new Map([[path, { ...gap, meta: { ...gap.meta, asNotes: true } }]]));
    expect(gapIn(on)?.asNotes).toBe(true);
    const off = patchPublished("ref/labs.json", on, new Map([[path, gap]]));
    expect(gapIn(off)?.asNotes).toBe(false);
  });

  it("moves a removed document to Removed, and a new one in its section's file list to Pending", () => {
    const removed: AsIsFile = { ...fileJson<AsIsFile>(`content/files/${D(1)}/file.json`), removed: { at: "2026-10-04T05:00:00Z", from: "b".repeat(40) } };
    const other = fileJson<OtherFile>("content/places/other.json");
    const added = D(8);
    const nextOther: OtherFile = { ...other, sections: other.sections.map((s) => (s.id === "guidelines" ? { ...s, files: [...s.files, added] } : s)) };
    const upload: AsIsFile = { v: 1, id: added, name: "Lipid guideline", kind: "pdf", original: "lipids.pdf", view: null, pages: null, text: null, removed: null, state: "processing" } as AsIsFile;
    const files = new Map<string, unknown>([
      [`content/files/${D(1)}/file.json`, removed],
      ["content/places/other.json", nextOther],
      [`content/files/${added}/file.json`, upload],
    ]);

    const out = patchPublished("other.json", pub("other.json"), files) as { sections: { id: string; files: DocList }[] };
    const list = out.sections.find((s) => s.id === "guidelines")?.files;
    expect(list?.files.map((f) => f.id)).toEqual([]);
    expect(list?.removed).toEqual([{ id: D(1), name: "ACLS algorithms", at: "2026-10-04T05:00:00Z" }]);
    expect(list?.pending).toEqual([{ id: added, name: "Lipid guideline", state: "processing" }]);
  });

  describe("a place's outline and notes, by the build's rule", () => {
    const ACLS = `content/files/${D(1)}/file.json`;
    const acls = (): DocRef => need(guidelines(pub("other.json")).files.files.find((f) => f.id === D(1)), "D(1) in Guidelines");
    const outline = (d: DocRef): PubOtherNote[] => [{ heading: "Algorithms", sub: false, id: "algorithms" }, { original: d }, { doc: d }];

    it("drops a removed document's original and doc items", () => {
      const removed: AsIsFile = { ...fileJson<AsIsFile>(ACLS), removed: { at: "2026-10-04T05:00:00Z", from: "b".repeat(40) } };
      const out = patchPublished("other.json", otherWith(outline(acls())), new Map([[ACLS, removed]]));
      expect(guidelines(out).notes).toEqual([{ heading: "Algorithms", sub: false, id: "algorithms" }]);
    });

    it("shows a renamed document's items under its new name", () => {
      const renamed: AsIsFile = { ...fileJson<AsIsFile>(ACLS), name: "ACLS algorithms 2025" };
      const out = patchPublished("other.json", otherWith(outline(acls())), new Map([[ACLS, renamed]]));
      expect(guidelines(out).notes).toEqual(outline({ ...acls(), name: "ACLS algorithms 2025" }));
    });

    it("drops the blocks it is told are hidden from a reference tab's notes, and keeps the rest", () => {
      const [b60, b61] = thyroidBlocks();
      const notes: PubNote[] = [{ heading: "Thyroid" }, blockNote(b60), blockNote(b61)];
      const block = { ...fileJson<BlockFile>(`${CV}/blocks/${B(11)}.json`), doc: para("Murmurs, revised") };
      const out = patchPublished("ref/labs.json", refWith(notes), new Map([[`${CV}/blocks/${B(11)}.json`, block]]), null, undefined, new Set([B(60)]));
      expect((out as RefTabJson).subs[0]?.notes).toEqual([{ heading: "Thyroid" }, blockNote(b61)]);
    });
  });

  it("leaves published Removed and Processing documents alone when the overlay holds only other files", () => {
    const block = { ...fileJson<BlockFile>(`${CV}/blocks/${B(11)}.json`), doc: para("Murmurs, revised") };
    const files = new Map([[`${CV}/blocks/${B(11)}.json`, block]]);
    for (const path of ["other.json", "g/fm/general/labs.json"]) {
      expect(patchPublished(path, pub(path), files), path).toEqual(pub(path));
    }
    const labs = JSON.stringify(pub("g/fm/general/labs.json"));
    expect(labs).toContain(`"pending":[{"id":"${D(7)}"`);
    expect(JSON.stringify(pub("other.json"))).toContain(`"removed":[{"id":"${D(6)}"`);
  });

  it("renames a Word document on its own page", () => {
    const doc: WordDocFile = { ...fileJson<WordDocFile>(`content/docs/${D(5)}/doc.json`), name: "Thyroid notes (2026)" };
    const out = patchPublished(`docs/${D(5)}.json`, pub(`docs/${D(5)}.json`), new Map([[`content/docs/${D(5)}/doc.json`, doc]])) as { name: string };
    expect(out.name).toBe("Thyroid notes (2026)");
  });

  it("carries an overlaid record's failed-replacement marker onto its page, and drops a published one the record no longer has", () => {
    const marker = { fileName: "chart2.png", at: "2026-10-04T12:00:00Z" };
    const path = `docs/${D(1)}.json`;
    const record = `content/files/${D(1)}/file.json`;
    const failed = patchPublished(path, pub(path), new Map([[record, { ...fileJson<AsIsFile>(record), replaceFailed: marker }]])) as DocJson;
    expect(failed.replaceFailed).toEqual(marker);
    expect(failed.name).toBe(pub<DocJson>(path).name);

    const dismissed = patchPublished(path, { ...pub<DocJson>(path), replaceFailed: marker }, new Map([[record, fileJson<AsIsFile>(record)]])) as DocJson;
    expect(dismissed).not.toHaveProperty("replaceFailed");
    expect(dismissed).toEqual(pub(path));
  });

  it("leaves gap blocks it has no file for untouched", () => {
    const gap = fileJson<GapFile>(`content/gapfill/${G(2)}.json`);
    const out = patchPublished("ref/labs.json", pub("ref/labs.json"), new Map([[`content/gapfill/${G(2)}.json`, { ...gap, doc: para("x") }]]));
    expect(out).toEqual(pub("ref/labs.json"));
    expect(((out as { subs: { gaps: PubGap[] }[] }).subs[0]?.gaps[0])?.doc).toEqual(pub<{ subs: { gaps: PubGap[] }[] }>("ref/labs.json").subs[0]?.gaps[0]?.doc);
  });
});

describe("the overlay on the owner's device", () => {
  const PATH = `${CV}/blocks/${B(11)}.json`;
  const saved = (): BlockFile => ({ ...fileJson<BlockFile>(PATH), doc: para("Murmurs, saved here") });
  const murmurs = async (): Promise<unknown> => (await loadData<SystemJson>(SYS)).blocks.find((b) => b.id === B(11))?.doc;

  it("shows a save at once, keeps it in the device store, and stops when she signs out", async () => {
    published.set("build.json", { commit: "0".repeat(40), builtAt: "2026-10-01T00:00:00Z", siteBytes: 0 });
    await startOverlay(w.git);
    await recordSaved(new Map([[PATH, saved()]]), w.fake.head());

    expect(await murmurs()).toEqual(para("Murmurs, saved here"));
    expect((await store.get(PATH))?.json).toEqual(saved());

    stopOverlay();
    expect(await murmurs()).toEqual(pub<SystemJson>(SYS).blocks.find((b) => b.id === B(11))?.doc);
  });

  it("loads the stored entries at sign-in", async () => {
    await store.put(PATH, { commit: "f".repeat(40), json: saved() });
    published.set("build.json", { commit: "0".repeat(40), builtAt: "x", siteBytes: 0 });
    await startOverlay(w.git);
    expect(overlayEntries().has(PATH)).toBe(true);
    expect(await murmurs()).toEqual(para("Murmurs, saved here"));
  });

  it("drops entries the deployed site already contains, and keeps newer ones", async () => {
    const savedAt = w.fake.commitFiles({ "content/x.txt": "1" }, { message: "Edit: Murmurs" });
    const later = w.fake.commitFiles({ "content/x.txt": "2" }, { message: "Edit: later" });
    await store.put(PATH, { commit: savedAt, json: saved() });
    await store.put(`${CV}/blocks/${B(14)}.json`, { commit: later, json: fileJson<BlockFile>(`${CV}/blocks/${B(14)}.json`) });
    published.set("build.json", { commit: savedAt, builtAt: "x", siteBytes: 0 });

    await startOverlay(w.git);

    expect([...overlayEntries().keys()]).toEqual([`${CV}/blocks/${B(14)}.json`]);
    expect(await store.get(PATH)).toBeUndefined();
    expect(await murmurs()).toEqual(pub<SystemJson>(SYS).blocks.find((b) => b.id === B(11))?.doc);
  });

  it("leaves the blocks of a Word page she removed out of place notes", async () => {
    const [b60, b61] = thyroidBlocks();
    published.set("ref/labs.json", refWith([blockNote(b60), blockNote(b61)]));
    published.set("other.json", otherWith([{ heading: "Thyroid", sub: false, id: "thyroid" }, blockNote(b61)]));
    published.set("build.json", { commit: "0".repeat(40), builtAt: "2026-10-01T00:00:00Z", siteBytes: 0 });
    await startOverlay(w.git);
    const record = `content/docs/${D(5)}/doc.json`;
    await recordSaved(new Map([[record, { ...fileJson<WordDocFile>(record), removed: { at: "2026-10-04T05:00:00Z", from: "b".repeat(40) } }]]), w.fake.head());

    expect((await loadData<RefTabJson>("ref/labs.json")).subs[0]?.notes).toEqual([]);
    expect(guidelines(await loadData<OtherJson>("other.json")).notes).toEqual([{ heading: "Thyroid", sub: false, id: "thyroid" }]);
  });

  it("keeps everything when build.json can't be read", async () => {
    await recordSaved(new Map([[PATH, saved()]]), w.fake.head());
    await startOverlay(w.git);
    await pruneOverlay();
    expect(overlayEntries().has(PATH)).toBe(true);
  });
});
