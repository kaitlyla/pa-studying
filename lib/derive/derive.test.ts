// Plan 99 §99.1 `lib/derive/derive.test.ts`: topics (40 §40.2), navigation and pages (§40.3), pharm
// (§40.4–§40.5), published data and invariants (§40.1, §40.8). Unit topics run on in-memory blocks;
// the rest publish the synthetic tree of tools/build/test-fixture.ts, written and read through lib/content.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeContent } from "../content/fs.ts";
import { systemRowOrder } from "../content/splice.ts";
import type { BlockFile, StructureFile } from "../content/types.ts";
import { loadContent } from "../../tools/build/load.ts";
import { B, C, D, G, GONE, P, R, S, tableDoc, U, writeFixture } from "../../tools/build/test-fixture.ts";
import { BuildError } from "./errors.ts";
import type { Content, GuideData, SystemData } from "./model.ts";
import { CardMatcher, medsPanel, phraseMatcher, stubLabel } from "./pharm.ts";
import { publish, type PublishResult } from "./publish.ts";
import type { DocList, GeneralJson, HostsJson, NavJson, OtherJson, SiteJson, SlidesJson, SystemJson, UpdatesJson } from "./published.ts";
import { fileLocation, parseHash } from "./routes.ts";
import { tableOf } from "./text.ts";
import { checkMembers, deriveTopics } from "./topics.ts";

const table = (id: string, columns: number, rows: Parameters<typeof tableDoc>[1]): BlockFile =>
  ({ v: 1, id, kind: "table", doc: tableDoc(columns, rows), meta: {} }) as unknown as BlockFile;
const structureOf = (over: Partial<StructureFile> = {}): StructureFile => ({
  v: 1, sections: [], members: {}, listed: {}, drugTables: [], pharmSections: [], pharmFiles: [], ...over,
});

/** Runs `fn` and returns the BuildError it throws. */
function buildError(fn: () => unknown): BuildError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BuildError);
    return e as BuildError;
  }
  throw new Error("expected a BuildError");
}

let root: string;
let base: Content;
let out: PublishResult;
const file = <T>(path: string): T => {
  const v = out.files.get(path);
  if (v === undefined) throw new Error(`no published ${path}`);
  return v as T;
};
const guide = (c: Content, id: string): GuideData => {
  const g = c.guides.find((x) => x.file.id === id);
  if (!g) throw new Error(id);
  return g;
};
const system = (c: Content, g: string, s: string): SystemData => {
  const x = guide(c, g).systems.find((y) => y.file.id === s);
  if (!x) throw new Error(`${g}/${s}`);
  return x;
};
/** A deep copy of the fixture content with `f` applied. */
const mutated = (f: (c: Content) => void): Content => {
  const c = structuredClone(base);
  f(c);
  return c;
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pa-derive-"));
  await writeFixture(root);
  base = await loadContent(root);
  out = publish(base);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("topics (40 §40.2)", () => {
  const cv = () => system(base, "fm", "cardiovascular");
  const topics = () => deriveTopics(cv().blocks, cv().structure);
  const topic = (id: string) => topics().topics.find((t) => t.id === id);

  it("a heading row sets the label and column headings for the rows below it until the next heading row", () => {
    const t = topics();
    expect(t.headings.get(R(100))).toEqual({ label: "ARRHYTHMIAS", columns: ["Presentation", "Treatment"] });
    expect(t.rows.get(R(101))?.heading).toBe(R(100));
    expect(t.rows.get(R(102))?.heading).toBe(R(100));
    expect(t.rows.get(R(104))?.heading).toBe(R(103));
  });

  it("a content row with first-cell text starts a topic titled with whitespace collapsed", () => {
    expect(topic(R(101))?.title).toBe("Atrial fibrillation (AF)");
  });

  it("an empty first cell right under a labeled heading row starts a topic titled with the label", () => {
    expect(topic(R(104))).toMatchObject({ title: "Stable angina", rows: [R(104), R(130)] });
  });

  it("otherwise an empty first cell continues the topic above", () => {
    expect(topic(R(101))?.rows).toEqual([R(101), R(102)]);
    expect(topics().rows.get(R(102))?.topic).toBe(R(101));
  });

  it("first rows with an empty first cell join the last topic of the previous non-drug table, skipping drug tables", () => {
    // B13 follows the drug table B12; R130 joins B10's last topic, not the condition topic of B12.
    expect(topics().rows.get(R(130))?.topic).toBe(R(104));
  });

  it("with no earlier topic they are untitled in-place material", () => {
    const pu = system(base, "fm", "pulmonary");
    const t = deriveTopics(pu.blocks, pu.structure);
    expect(t.untitled).toEqual([R(200)]);
    expect(t.rows.get(R(200))?.topic).toBeNull();
    expect(t.topics.map((x) => x.title)).toEqual(["Asthma"]);
  });

  it("one-column tables are not topic tables; they behave as prose blocks", () => {
    const t = topics();
    expect(t.proseBlocks).toEqual([B(11), B(14)]);
    expect(t.rows.has(R(140))).toBe(false);
  });

  it("drug-table condition rows form topics; the other drug rows belong to no topic", () => {
    expect(topic(R(123))).toMatchObject({ title: "Prinzmetal angina", condition: true, block: B(12), section: "cad" });
    expect(topics().rows.get(R(121))).toMatchObject({ drug: true, topic: null });
  });

  it("a one-column drug table still resolves its rows: condition topics form, and the save order includes them", () => {
    const one = table(B(90), 1, [[R(900), "content", "Propranolol"], [R(901), "content", "Essential tremor"]]);
    const st = structureOf({ drugTables: [{ block: B(90), pharmSection: "x", conditionRows: [R(901)] }] });
    const t = deriveTopics([one], st);
    expect(t.topics.map((x) => [x.id, x.title, x.condition])).toEqual([[R(901), "Essential tremor", true]]);
    expect(t.proseBlocks).toEqual([]);
    expect(systemRowOrder([one], st, B(90))).toEqual([R(900), R(901)]);
  });

  it("in a system with sections, the build fails naming a condition row with no members entry", () => {
    const st = structuredClone(cv().structure);
    delete st.members[R(123)];
    const e = buildError(() => checkMembers("fm/cardiovascular", deriveTopics(cv().blocks, st), st));
    expect(e.id).toBe(R(123));
    expect(e.message).toMatch(/condition row/);
  });

  it("every content row of a non-drug multi-column table ends in exactly one topic or untitled material", () => {
    for (const g of base.guides) {
      for (const s of g.systems) {
        const t = deriveTopics(s.blocks, s.structure);
        const drug = new Set(s.structure.drugTables.map((d) => d.block));
        for (const b of s.blocks) {
          const tb = tableOf(b);
          if (!tb || drug.has(b.id) || tb.columns < 2) continue;
          for (const r of tb.rows.filter((x) => x.kind === "content")) {
            const n = t.topics.filter((x) => x.rows.includes(r.id)).length + (t.untitled.includes(r.id) ? 1 : 0);
            expect(n, r.id).toBe(1);
          }
        }
        for (const x of t.topics) expect(x.title).not.toBe("");
      }
    }
  });
});

describe("navigation and pages (40 §40.3)", () => {
  const nav = (g: string) => file<NavJson>(`g/${g}/nav.json`);
  const page = (g: string, s: string) => file<SystemJson>(`g/${g}/s/${s}.json`);

  it("nav.json lists systems in guide order with sections and their entries in guide order", () => {
    const fm = nav("fm");
    expect(fm.systems.map((s) => s.id)).toEqual(["cardiovascular", "pulmonary", "renal"]);
    const cv = fm.systems[0];
    expect(cv?.sections).toEqual([
      { id: "cad", title: "Coronary artery disease", entries: [
        { kind: "topic", id: R(104), title: "Stable angina" }, { kind: "topic", id: R(123), title: "Prinzmetal angina" },
      ] },
      { id: "other", title: "Cardiovascular — other", entries: [
        { kind: "topic", id: R(101), title: "Atrial fibrillation (AF)" }, { kind: "block", id: B(11), title: "Murmurs" },
        { kind: "topic", id: R(131), title: "Heart failure" },
      ] },
    ]);
    expect(cv?.entries).toEqual([]);
  });

  it("with sections: [] the entries hang directly under the system", () => {
    const pu = nav("fm").systems[1];
    expect(pu?.sections).toEqual([]);
    expect(pu?.entries).toEqual([{ kind: "topic", id: R(201), title: "Asthma" }]);
  });

  it("general keys come in the fixed order and only those present", () => {
    expect(nav("fm").general).toEqual([{ key: "labs", label: "Labs" }]);
    const c = mutated((x) => {
      const gen = guide(x, "fm").general;
      gen?.topics.unshift({ key: "screenings", howto: null, links: [], files: [], gaps: [] }, { key: "ekg", howto: null, links: [], files: [], gaps: [] });
    });
    const n = publish(c).files.get("g/fm/nav.json") as NavJson;
    expect(n.general.map((x) => x.key)).toEqual(["labs", "ekg", "screenings"]);
  });

  it("an EOR guide carries its deck title as the slides item; a removed own deck shows none and is listed as removed", () => {
    expect(nav("fm").slides).toEqual({ title: "High-yield review slides" });
    expect(nav("psy").slides).toBeNull();
    expect(nav("psy").removed).toEqual([{ id: D(4), name: "Psych review slides", at: "2026-10-03T10:00:00Z" }]);
  });

  it("PANCE ends with its sidebarEnd document and has no general topics or slides", () => {
    const p = nav("pance");
    expect(p.sidebarEnd).toEqual({ id: D(3), name: "Receptor chart", kind: "image", route: `#/file/${D(3)}` });
    expect(p.general).toEqual([]);
    expect(p.slides).toBeNull();
  });

  it("a section page shows only member topics' rows, each run preceded once by its heading row", () => {
    const [cad, other] = page("fm", "cardiovascular").sections;
    expect(cad?.items).toEqual([
      { block: B(10), rows: [R(103), R(104)] },
      { block: B(12), rows: [R(120), R(123)] },
      { block: B(13), rows: [R(130)] },
    ]);
    expect(other?.items).toEqual([
      { block: B(10), rows: [R(100), R(101), R(102)] },
      { block: B(11), rows: null },
      { block: B(13), rows: [R(131)] },
      { block: B(14), rows: null },
    ]);
  });

  it("a drug row never appears on a section page, even with a members entry", () => {
    const c = mutated((x) => {
      system(x, "fm", "cardiovascular").structure.members[R(121)] = "cad";
    });
    const cad = (publish(c).files.get("g/fm/s/cardiovascular.json") as SystemJson).sections[0];
    expect(cad?.items.find((i) => i.block === B(12))?.rows).toEqual([R(120), R(123)]);
  });

  it("the system page shows a stub in place of each drug table", () => {
    expect(page("fm", "cardiovascular").stubs).toEqual({ [B(12)]: { label: "ANTIANGINALS", section: "antianginals" } });
    expect(page("fm", "cardiovascular").blocks.map((b) => b.id)).toEqual([B(10), B(11), B(12), B(13), B(14)]);
  });

  it("the File page location follows each `from` origin, using the same labels as the rest of the site", () => {
    const ix = file<SiteJson>("site.json").index;
    expect(fileLocation(ix, "#/eor/fm/pharm/cardiovascular/antianginals")).toBe("EOR › Family Medicine › Cardiovascular pharm");
    expect(fileLocation(ix, "#/eor/fm/pharm/renal")).toBe("EOR › Family Medicine › Urology/Renal pharm");
    expect(fileLocation(ix, "#/pance/pharm/cardiovascular")).toBe("PANCE › Cardiovascular pharm");
    expect(fileLocation(ix, "#/other/notes")).toBe("Other › Notes");
    expect(fileLocation(ix, "#/labs")).toBe("Labs");
    expect(fileLocation(ix, "#/imaging/cbc?q=x")).toBe("Imaging");
    expect(fileLocation(ix, "#/eor/fm/general/labs")).toBe("EOR › Family Medicine › Labs");
    expect(fileLocation(ix, "#/pance")).toBe("PANCE");
    expect(fileLocation(ix, `#/eor/fm/t/${R(101)}`)).toBeNull();
    expect(fileLocation(ix, null)).toBeNull();
  });

  it("with no `from`, a document's location is its first placement in site order", () => {
    const hosts = file<HostsJson>("hosts.json");
    // D1 is listed in fm Cardiovascular pharm files and later on Other › Guidelines.
    expect(hosts[D(1)]).toEqual({ route: `#/file/${D(1)}`, loc: "EOR › Family Medicine › Cardiovascular pharm" });
    // D5 is listed on fm General › Labs and later on the Labs reference tab.
    expect(hosts[D(5)]).toEqual({ route: `#/file/${D(5)}`, loc: "EOR › Family Medicine › Labs" });
    expect(hosts[D(3)]?.loc).toBe("PANCE");
  });
});

describe("pharm (40 §40.4–§40.5)", () => {
  const page = (g: string, s: string) => file<SystemJson>(`g/${g}/s/${s}.json`);
  const meds = (id: string) => page("fm", "cardiovascular").topics.find((t) => t.id === id)?.meds;

  it("alias match is whole-word, case-insensitive and on NFC text", () => {
    expect(phraseMatcher(["CCB"])("ccb first-line")).toBe(true);
    expect(phraseMatcher(["CCB"])("CCBs")).toBe(false);
    expect(phraseMatcher(["CCB"])("xCCB")).toBe(false);
    const composed = `caf${String.fromCodePoint(0xe9)}`;
    const decomposed = `cafe${String.fromCodePoint(0x301)}`;
    expect(phraseMatcher([decomposed])(`a ${composed} b`)).toBe(true);
    expect(phraseMatcher([composed])(`a ${decomposed} b`)).toBe(true);
  });

  it("matches hyphenated and punctuated aliases literally", () => {
    expect(phraseMatcher(["beta-blocker"])("Start a Beta-blocker today")).toBe(true);
    expect(phraseMatcher(["beta-blocker"])("beta-blockers")).toBe(false);
    expect(phraseMatcher(["beta-blocker"])("betaXblocker")).toBe(false);
    expect(phraseMatcher(["propranolol (non-selective)"])("Propranolol (non-selective)")).toBe(true);
  });

  it("a meds panel picks up a hyphenated drug row named in the condition", () => {
    const blocks = [
      table(B(91), 2, [[R(910), "content", "Essential tremor", "first-line beta-blocker (non-selective)"]]),
      table(B(92), 2, [[R(920), "content", "Beta-blocker (non-selective)", "propranolol"]]),
    ];
    const st = structureOf({ drugTables: [{ block: B(92), pharmSection: "x", conditionRows: [] }] });
    const t = deriveTopics(blocks, st);
    const s = { guide: "fm", system: "x", structure: st, topics: t };
    const tremor = t.topics.find((x) => x.id === R(910));
    if (!tremor) throw new Error("no topic");
    // Comes from step 2 too: drop the following table to prove the first-cell match alone finds it.
    const panel = medsPanel(s, [B(92), B(91)], tremor, new CardMatcher([]), (c) => c);
    expect(panel).toEqual([{ card: null, title: "Beta-blocker (non-selective)", rows: [R(920)], section: "x", target: R(920) }]);
  });

  it("card order follows table rows, then `also`; a card unplaced in a home guide is appended to that home system's first pharm section", () => {
    const ps = page("fm", "cardiovascular").pharm?.sections[0];
    // Nitroglycerin → Nitrates (C2), Amlodipine → CCB (C1), Ranolazine → none; C3 has home fm/cardiovascular.
    expect(ps).toMatchObject({ id: "antianginals", cards: [C(2), C(1), C(3)], alsoFrom: 2 });
    expect(page("pance", "cardiovascular").pharm?.sections[0]?.cards).toEqual([C(3)]);
  });

  it("an explicit `also` card follows the table cards", () => {
    const c = mutated((x) => {
      const ps = system(x, "pance", "cardiovascular").structure.pharmSections[0];
      if (ps) ps.also = [C(2)];
    });
    expect((publish(c).files.get("g/pance/s/cardiovascular.json") as SystemJson).pharm?.sections[0]?.cards).toEqual([C(3), C(2)]);
  });

  it("a card placed nowhere fails the build naming it; so does a card naming a missing pharm file", () => {
    const nowhere = mutated((x) => x.cards.cards.push({ id: C(4), file: "cardio-med-list", aliases: ["warfarin"], home: {} }));
    expect(buildError(() => publish(nowhere)).id).toBe(C(4));
    const noFile = mutated((x) => x.cards.cards.push({ id: C(5), file: "missing", aliases: ["nitroglycerin"], home: {} }));
    expect(buildError(() => publish(noFile)).id).toBe(C(5));
  });

  it("a published card lists its notes parts in order, so a search anchor can name one", () => {
    expect(page("fm", "cardiovascular").cards[C(1)]).toMatchObject({
      title: "Calcium Channel Blockers", file: "cardio med list", basePt: 11, blocks: [B(71)], parts: [{ id: P(2), blocks: [B(71)] }],
    });
  });

  it("search lists a card's notes once, under its first placement in site order", () => {
    const beta = out.units.filter((u) => u.title === "Beta Blockers");
    expect(beta).toHaveLength(1);
    expect(beta[0]).toMatchObject({ route: `#/eor/fm/pharm/cardiovascular/antianginals/${C(3)}`, loc: "EOR › Family Medicine › Cardiovascular pharm", at: P(4) });
  });

  it("a system has a Pharm section only with drug tables, placed cards or pharmFiles (D3)", () => {
    const fm = file<NavJson>("g/fm/nav.json").systems;
    expect(fm.map((s) => s.pharm)).toEqual([{ sections: [{ id: "antianginals", title: "Antianginals" }] }, null, { sections: [] }]);
    expect(page("fm", "renal").pharm?.files.files.map((f) => f.id)).toEqual([D(2)]);
  });

  it("the stub label is the first heading row's first cell, else the first row's", () => {
    const pance = page("pance", "cardiovascular");
    expect(pance.stubs[B(50)]?.label).toBe("Metoprolol");
    const t = tableOf(table(B(93), 2, [[R(930), "content", "x", "y"], [R(931), "heading", "  BETA  BLOCKERS ", "z"]]));
    if (!t) throw new Error("no table");
    expect(stubLabel(t)).toBe("BETA BLOCKERS");
  });

  it("meds panel: the following drug table, grouped by card, with a card-less row as its own card", () => {
    expect(meds(R(101))).toEqual([
      { card: C(2), title: "Nitrates", rows: [R(120), R(121)], section: "antianginals", target: C(2) },
      { card: C(1), title: "Calcium Channel Blockers", rows: [R(120), R(122)], section: "antianginals", target: C(1) },
      { card: null, title: "Ranolazine", rows: [R(120), R(124)], section: "antianginals", target: R(124) },
    ]);
  });

  it("a condition-row topic has no following table: only same-system alias rows, and never a condition row", () => {
    expect(meds(R(123))).toEqual([{ card: C(1), title: "Calcium Channel Blockers", rows: [R(120), R(122)], section: "antianginals", target: C(1) }]);
  });

  it("a topic after the system's last drug table, naming no drug, has no meds", () => {
    expect(meds(R(131))).toEqual([]);
  });

  it("Treats lists the condition topics drawing on the section's tables, in guide order; the system pharm page lists sections then files", () => {
    const pharm = page("fm", "cardiovascular").pharm;
    expect(pharm?.sections.map((s) => [s.id, s.treats])).toEqual([["antianginals", [R(101), R(104), R(123)]]]);
    expect(pharm?.files).toEqual({ files: [{ id: D(1), name: "ACLS algorithms", kind: "pdf", route: `#/file/${D(1)}` }], removed: [], pending: [] });
  });
});

describe("published data and invariants (40 §40.1, §40.8)", () => {
  it("fails naming a structure.json id that does not exist", () => {
    const c = mutated((x) => {
      system(x, "fm", "cardiovascular").structure.members[GONE] = "cad";
    });
    expect(buildError(() => publish(c)).id).toBe(GONE);
  });

  it("fails naming a gap block without a passing evidence record, or whose text no longer matches its claims", () => {
    const fail = mutated((x) => {
      const ev = x.gaps.get(G(1))?.evidence;
      if (ev) ev.verification.result = "fail";
    });
    expect(buildError(() => publish(fail)).id).toBe(G(1));
    const drift = mutated((x) => {
      const ev = x.gaps.get(G(2))?.evidence;
      const claim = ev?.claims[0];
      if (claim) claim.text = "Check sodium.";
    });
    expect(buildError(() => publish(drift)).id).toBe(G(2));
  });

  it("fails naming a generated slide whose items lack matching passing evidence", () => {
    const c = mutated((x) => {
      const ev = x.decks.get("fm")?.slides[1]?.meta.evidence?.[0];
      if (ev) ev.item = "Regularly irregular";
    });
    expect(buildError(() => publish(c)).id).toBe(S(2));
  });

  it("fails naming a missing curation file", async () => {
    const tree = await mkdtemp(join(tmpdir(), "pa-derive-missing-"));
    try {
      await writeFixture(tree);
      await removeContent(tree, "content/updates/checks.json");
      await expect(loadContent(tree)).rejects.toThrow(/updates\/checks\.json/);
    } finally {
      await rm(tree, { recursive: true, force: true });
    }
  });

  it("drops dangling references into build.json.dropped", () => {
    expect(out.dropped).toEqual([
      { file: "content/updates/concepts.json", id: GONE },
      { file: "content/guides/fm/general.json", id: GONE },
      { file: `content/slides/fm/blocks/${S(2)}.json`, id: GONE },
    ]);
    expect(file<GeneralJson>("g/fm/general/labs.json").links).toEqual([{
      target: R(101), title: "Atrial fibrillation (AF)", covers: "AF labs", route: `#/eor/fm/t/${R(101)}`,
      loc: "EOR › Family Medicine › Cardiovascular › Cardiovascular — other", flagged: true,
    }]);
    expect(file<SlidesJson>("g/fm/slides.json").slides[1]?.summarizes).toEqual([
      { id: R(101), title: "Atrial fibrillation (AF)", route: `#/eor/fm/t/${R(101)}` },
    ]);
  });

  const occurrences = (id: string): number => JSON.stringify([...out.files.values(), out.units]).split(id).length - 1;

  it("removed documents are absent from every output except the `removed` lists of the places holding them", () => {
    const labs = file<GeneralJson>("g/fm/general/labs.json").files;
    const notes = file<OtherJson>("other.json").sections.find((s) => s.id === "notes")?.files as DocList;
    expect(labs.removed).toEqual([{ id: D(6), name: "Old handout", at: "2026-10-03T10:00:00Z" }]);
    expect(notes.removed.map((x) => x.id)).toEqual([D(6)]);
    expect(notes.files).toEqual([]);
    expect(occurrences(D(6))).toBe(2);
    expect(occurrences(D(4))).toBe(1);
    expect(out.files.has(`docs/${D(6)}.json`)).toBe(false);
    expect(out.stored.map((s) => s.doc)).not.toContain(D(6));
  });

  it("processing or failed documents appear only in `pending`", () => {
    expect(file<GeneralJson>("g/fm/general/labs.json").files.pending).toEqual([{ id: D(7), name: "New upload", state: "processing" }]);
    expect(occurrences(D(7))).toBe(1);
  });

  it("updates.json is newest first by `published` (later flagged first on a tie) with its Added to locations", () => {
    const u = file<UpdatesJson>("updates.json");
    expect(u.flags.map((f) => f.id)).toEqual([U(2), U(3), U(1), U(5), U(4)]);
    const added = Object.fromEntries(u.flags.map((f) => [f.id, f.addedTo]));
    expect(added[U(1)]).toEqual([
      { route: `#/eor/fm/t/${R(101)}`, loc: "EOR › Family Medicine › Cardiovascular › Cardiovascular — other" },
      { route: "#/eor/fm/general/labs", loc: "EOR › Family Medicine › Labs" },
    ]);
    expect(added[U(5)]).toEqual([
      { route: `#/eor/fm/t/${R(201)}`, loc: "EOR › Family Medicine › Pulmonary" },
      { route: `#/file/${D(5)}`, loc: "EOR › Family Medicine › Labs" },
    ]);
    // A failed agent flag, an edition flag and a superseded flag are listed but placed nowhere.
    expect([added[U(2)], added[U(3)], added[U(4)]]).toEqual([[], [], []]);
  });

  it("hosts.json maps every hosted id, and no removed or pending document", () => {
    const hosts = file<HostsJson>("hosts.json");
    const hosted = [
      B(1), B(10), B(11), B(12), B(13), B(14), R(100), R(101), R(102), R(103), R(104), R(120), R(121), R(122), R(123), R(124),
      R(130), R(131), B(20), R(200), R(201), B(50), R(500), R(501), D(1), D(2), D(3), D(5), B(60), B(61), G(1), G(2), G(3),
      S(1), S(2), U(1), U(2), U(3), U(4), U(5), C(1), C(2), C(3), P(1), P(2), P(3), P(4), B(70), B(71), B(72), B(73),
    ];
    for (const id of hosted) expect(hosts[id], id).toBeDefined();
    for (const id of [D(4), D(6), D(7)]) expect(hosts[id], id).toBeUndefined();
    expect(hosts[R(121)]?.route).toBe(`#/eor/fm/pharm/cardiovascular/antianginals/${R(121)}`);
    expect(hosts[B(11)]?.route).toBe(`#/eor/fm/b/${B(11)}`);
    expect(hosts[G(2)]).toEqual({ route: "#/eor/fm/workup/ams", loc: "EOR › Family Medicine › Initial workup" });
    expect(hosts[S(2)]?.route).toBe("#/eor/fm/slides/2");
  });

  it("every route the build emits round-trips through the shared parser", () => {
    const routes = new Set<string>();
    const collect = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(collect);
      else if (v !== null && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          if (k === "route" && typeof x === "string") routes.add(x);
          else collect(x);
        }
      }
    };
    collect([...out.files.values(), out.units]);
    expect(routes.size).toBeGreaterThan(20);
    for (const r of routes) {
      const parsed = parseHash(r);
      expect(parsed.kind, r).not.toBe("notfound");
      expect(parsed.path, r).toBe(r);
    }
  });

  it("every search unit sharing a route carries a distinct anchor", () => {
    const byRoute = new Map<string, (string | null)[]>();
    for (const u of out.units) byRoute.set(u.route, [...(byRoute.get(u.route) ?? []), u.at]);
    for (const [route, ats] of byRoute) {
      if (ats.length > 1) expect(new Set(ats).size, route).toBe(ats.length);
    }
    const d5 = out.units.filter((u) => u.route === `#/file/${D(5)}`).map((u) => u.at);
    expect(d5).toEqual([B(60), R(600), R(601)]);
    expect(out.units.filter((u) => u.route === `#/file/${D(1)}`).map((u) => u.at)).toEqual(["p1"]);
    expect(out.units.find((u) => u.route === "#/eor/fm/workup/ams")?.at).toBeNull();
  });
});
