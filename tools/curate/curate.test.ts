// tools/curate (plan 90 §90.1): each command's write on the synthetic content tree of
// tools/build/test-fixture.ts, and its refusal of writes that break a 20 or 40 §40.1 invariant —
// a refused command leaves every file as it was.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readContent, readContentIfExists, writeContent } from "../../lib/content/fs.ts";
import type {
  BlockFile, CardsFile, ConceptsFile, DeckFile, EvidenceFile, FlagsFile, GapFile, GeneralFile, OtherFile, PharmFile,
  RefTabsFile, SlideMeta, StructureFile, SystemFile,
} from "../../lib/content/types.ts";
import { publish } from "../../lib/derive/publish.ts";
import { deriveTopics } from "../../lib/derive/topics.ts";
import { B, C, D, doc, G, P, para, R, S, tableDoc, U, writeFixture } from "../build/test-fixture.ts";
import { loadContent } from "../build/load.ts";
import { run, USAGE } from "./index.ts";
import { commitChanges } from "./tree.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pa-curate-"));
  await writeFixture(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const CV = "content/guides/fm/cardiovascular";
const PHARM = "content/pharm/cardio-med-list";
const text = (path: string): Promise<string> => readFile(join(root, ...path.split("/")), "utf8");
const read = <T>(path: string): Promise<T> => readContent<T>(root, path);

/** Write a draft file outside the content tree and return its path. */
async function draft(name: string, value: unknown): Promise<string> {
  const path = join(root, `${name}.json`);
  await writeFile(path, JSON.stringify(value), "utf8");
  return path;
}

/** Run a command expected to be refused; asserts its message and that the given files are byte-unchanged. */
async function refused(argv: string[], message: RegExp, unchanged: string[]): Promise<void> {
  const before = await Promise.all(unchanged.map(text));
  await expect(run(root, argv)).rejects.toThrow(message);
  expect(await Promise.all(unchanged.map(text))).toEqual(before);
}

/** `v`, failing the test when it is missing. */
function must<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`missing ${what}`);
  return v;
}

/** The single id in `after` that `before` lacks. */
function newId(after: readonly string[], before: readonly string[]): string {
  const added = after.filter((x) => !before.includes(x));
  expect(added).toHaveLength(1);
  return must(added[0], "new id");
}

describe("split", () => {
  it("moves the nodes from the index on into a new block right after it, in its owner list and section", async () => {
    const original = await read<BlockFile>(`${CV}/blocks/${B(11)}.json`);
    const lines = await run(root, ["split", B(11), "1"]);

    const sys = await read<SystemFile>(`${CV}/system.json`);
    const added = newId(sys.blocks, [B(10), B(11), B(12), B(13), B(14)]);
    expect(added).toMatch(/^b_[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(sys.blocks).toEqual([B(10), B(11), added, B(12), B(13), B(14)]);
    const first = await read<BlockFile>(`${CV}/blocks/${B(11)}.json`);
    const second = await read<BlockFile>(`${CV}/blocks/${added}.json`);
    expect(first.doc.content).toEqual(original.doc.content.slice(0, 1));
    expect(second.doc.content).toEqual(original.doc.content.slice(1));
    expect(second.kind).toBe("prose");
    const st = await read<StructureFile>(`${CV}/structure.json`);
    expect(st.members[added]).toBe("other");
    expect(st.listed).toEqual({ [B(11)]: "Murmurs" });
    expect(lines).toContain(`${B(11)} split at 1; the second part is ${added}`);
    const reread = await loadContent(root);
    expect(() => publish(reread)).not.toThrow();
  });

  it("inserts the new block into the pharm part holding the split block", async () => {
    await writeContent(root, `${PHARM}/blocks/${B(71)}.json`, { v: 1, id: B(71), kind: "prose", doc: doc(para("Calcium Channel Blockers"), para("MOA: block L-type channels")), meta: {} });
    await run(root, ["split", B(71), "1"]);
    const pf = await read<PharmFile>(`${PHARM}/pharmfile.json`);
    const added = newId(pf.blocks, [B(70), B(71), B(72), B(73)]);
    expect(pf.blocks).toEqual([B(70), B(71), added, B(72), B(73)]);
    expect(pf.parts.find((p) => p.id === P(2))?.blocks).toEqual([B(71), added]);
    expect(pf.parts.find((p) => p.id === P(3))?.blocks).toEqual([B(72)]);
  });

  it("refuses a table block and an index that is not an inner boundary", async () => {
    const files = [`${CV}/system.json`, `${CV}/blocks/${B(11)}.json`, `${CV}/blocks/${B(10)}.json`];
    await refused(["split", B(10), "1"], /only a prose block can be split/, files);
    await refused(["split", B(11), "0"], /between 1 and 1, got 0/, files);
    await refused(["split", B(11), "2"], /between 1 and 1, got 2/, files);
    await refused(["split", B(99), "1"], /no such block/, files);
  });
});

describe("rows", () => {
  it("sets the kinds of the named rows and leaves the others", async () => {
    await run(root, ["rows", B(10), `${R(102)}=heading`]);
    const block = await read<BlockFile>(`${CV}/blocks/${B(10)}.json`);
    const kinds = (block.doc.content[0] as { content: { attrs: { id: string; kind: string } }[] }).content.map((r) => [r.attrs.id, r.attrs.kind]);
    expect(kinds).toEqual([[R(100), "heading"], [R(101), "content"], [R(102), "heading"], [R(103), "heading"], [R(104), "content"]]);
  });

  it("refuses a change that leaves a new topic without a section (40 §40.1)", async () => {
    // As a content row, ARRHYTHMIAS starts a topic that structure.json gives no section.
    await refused(["rows", B(10), `${R(100)}=content`], new RegExp(`${R(100)}.*no members entry`), [`${CV}/blocks/${B(10)}.json`]);
  });

  it("refuses rows of another table and malformed assignments", async () => {
    await refused(["rows", B(10), `${R(201)}=heading`], /is not a row of/, [`${CV}/blocks/${B(10)}.json`]);
    await refused(["rows", B(10), `${R(101)}=title`], /is not <rowId>=heading\|content/, [`${CV}/blocks/${B(10)}.json`]);
    await refused(["rows", B(11), `${R(101)}=heading`], /not a table block/, [`${CV}/blocks/${B(11)}.json`]);
  });
});

// Orchestrator rulings 2026-10-04 21:02Z and 22:01Z: `titled` names the heading cell that titles a row's topic.
describe("titled", () => {
  const ST = `${CV}/structure.json`;
  const B10 = `${CV}/blocks/${B(10)}.json`;
  const B13 = `${CV}/blocks/${B(13)}.json`;
  /** Topic titles of FM Cardiovascular as the build derives them from what is on disk. */
  async function titles(): Promise<Map<string, string>> {
    const c = await loadContent(root);
    expect(() => publish(c)).not.toThrow();
    const sys = must(must(c.guides.find((g) => g.file.id === "fm"), "fm").systems.find((s) => s.file.id === "cardiovascular"), "cardiovascular");
    return new Map(deriveTopics(sys.blocks, sys.structure).topics.map((t) => [t.id, t.title]));
  }
  const kinds = async (path: string) => {
    const block = await read<BlockFile>(path);
    return (block.doc.content[0] as { content: { attrs: { id: string; kind: string } }[] }).content.map((r) => [r.attrs.id, r.attrs.kind]);
  };

  it("under a heading row, titles the row's topic with the label (cell 0 by default) and leaves the table as it is", async () => {
    const before = await text(B10);
    const lines = await run(root, ["titled", B(10), R(101)]);
    expect((await read<StructureFile>(ST)).titled).toEqual({ [R(101)]: 0 });
    expect(await text(B10)).toBe(before);
    expect(lines).toContain(`${R(101)}: titled by cell 0 of ${R(100)}`);
    expect((await titles()).get(R(101))).toBe("ARRHYTHMIAS");
  });

  it("the em shape: makes the row above a heading row, titles from the named cell, and gives the row the section it showed under", async () => {
    // Like em pulmonary b_0XAMGVVY65: "PULM | Acute Exacerbation of COPD (AECOPD)" stored as a content row over an empty-first-cell row.
    await writeContent(root, B13, { v: 1, id: B(13), kind: "table", doc: tableDoc(2, [
      [R(130), "content", "", "angina continues here"],
      [R(131), "content", "CARDIO", "Heart failure"],
      [R(132), "content", "", "HFrEF; loop diuretics"],
    ]), meta: {} });
    expect((await titles()).get(R(131))).toBe("CARDIO");

    const lines = await run(root, ["titled", B(13), `${R(132)}=1`]);
    expect(await kinds(B13)).toEqual([[R(130), "content"], [R(131), "heading"], [R(132), "content"]]);
    const st = await read<StructureFile>(ST);
    expect(st.titled).toEqual({ [R(132)]: 1 });
    expect(st.members[R(132)]).toBe("other");
    expect(st.members).not.toHaveProperty(R(131));
    expect(lines).toEqual(expect.arrayContaining([`${R(131)} is now a heading row`, `${R(132)}: titled by cell 1 of ${R(131)}`]));
    const t = await titles();
    expect(t.get(R(132))).toBe("Heart failure");
    expect(t.has(R(131))).toBe(false);
  });

  it("=off removes the entry, and the field with the last one", async () => {
    await run(root, ["titled", B(10), R(101)]);
    const lines = await run(root, ["titled", B(10), `${R(101)}=off`]);
    expect(await read<StructureFile>(ST)).not.toHaveProperty("titled");
    expect(lines).toContain(`${R(101)}: titled removed`);
    expect((await titles()).get(R(101))).toBe("Atrial fibrillation (AF)");
  });

  it("refuses an empty or missing heading cell, the first row, rows of another table, malformed entries and non-guide tables", async () => {
    const files = [ST, B10, B13];
    // R130 above R131 has an empty first cell: as a heading row its label is empty.
    await refused(["titled", B(13), R(131)], /cell 0 of heading row .* empty or missing/, files);
    await refused(["titled", B(10), `${R(101)}=7`], /cell 7 of heading row .* empty or missing/, files);
    await refused(["titled", B(10), R(100)], /first row of/, files);
    await refused(["titled", B(10), R(201)], /is not a row of/, files);
    await refused(["titled", B(10), `${R(101)}=x`], /is not <rowId>\[=<cell>\|=off\]/, files);
    await refused(["titled", B(11), R(101)], /not a table block of a guide system/, files);
  });
});

describe("structure", () => {
  const PU = "content/guides/fm/pulmonary/structure.json";
  const base = { v: 1, sections: [{ id: "asthma", title: "Asthma" }], listed: {}, drugTables: [], pharmSections: [], pharmFiles: [] };

  it("writes a structure whose members cover every topic, untitled row and prose block", async () => {
    await run(root, ["structure", "fm", "pulmonary", await draft("st", { ...base, members: { [R(200)]: "asthma", [R(201)]: "asthma" } })]);
    expect((await read<StructureFile>(PU)).members).toEqual({ [R(200)]: "asthma", [R(201)]: "asthma" });
  });

  it("refuses an uncovered row, an unknown id and an unknown section", async () => {
    await refused(["structure", "fm", "pulmonary", await draft("a", { ...base, members: { [R(201)]: "asthma" } })], new RegExp(`${R(200)}.*no members entry`), [PU]);
    await refused(["structure", "fm", "pulmonary", await draft("b", { ...base, members: { [R(200)]: "asthma", [R(201)]: "asthma", [R(101)]: "asthma" } })], new RegExp(`${R(101)}.*does not exist`), [PU]);
    await refused(["structure", "fm", "pulmonary", await draft("c", { ...base, members: { [R(200)]: "copd", [R(201)]: "asthma" } })], /a section id of this system/, [PU]);
    await refused(["structure", "fm", "nope", await draft("d", base)], /no system fm\/nope/, [PU]);
  });
});

describe("pharm-parts", () => {
  const files = [`${PHARM}/pharmfile.json`, "content/pharm/cards.json"];
  const cardsBefore = [C(1), C(2)];

  it("writes the parts, assigns missing part and card ids, and replaces the file's cards", async () => {
    const lines = await run(root, ["pharm-parts", "cardio-med-list", await draft("pp", {
      parts: [
        { id: P(1), role: "overview", title: "Overview", card: null, blocks: [B(70)] },
        { id: P(2), role: "card", title: "Calcium Channel Blockers", card: C(1), blocks: [B(71)] },
        { id: P(3), role: "card", title: "Nitrates", card: C(2), blocks: [B(72)] },
        { role: "card", title: "Beta Blockers", card: "bb", blocks: [B(73)] },
      ],
      cards: [
        { id: C(1), aliases: ["calcium channel blocker", "CCB", "amlodipine", "diltiazem"], home: { fm: "cardiovascular" } },
        { id: C(2), aliases: ["nitroglycerin", "nitrates"], home: {} },
        { key: "bb", aliases: ["metoprolol", "beta-blocker"], home: { pance: "cardiovascular" } },
      ],
    })]);
    const pf = await read<PharmFile>(`${PHARM}/pharmfile.json`);
    const cards = await read<CardsFile>("content/pharm/cards.json");
    const bb = newId(cards.cards.map((c) => c.id), cardsBefore);
    expect(bb).toMatch(/^c_/);
    expect(bb).not.toBe(C(3));
    const last = must(pf.parts[3], "fourth part");
    expect(last.id).toMatch(/^p_/);
    expect(last.id).not.toBe(P(4));
    expect(last.card).toBe(bb);
    expect(cards.cards.map((c) => [c.id, c.file])).toEqual([[C(1), "cardio-med-list"], [C(2), "cardio-med-list"], [bb, "cardio-med-list"]]);
    expect(lines).toContain(`card bb → ${bb}`);
  });

  const overview = { id: P(1), role: "overview", title: "Overview", card: null, blocks: [B(70)] };
  const ccb = { id: P(2), role: "card", title: "Calcium Channel Blockers", card: C(1), blocks: [B(71)] };
  const nitrates = { id: P(3), role: "card", title: "Nitrates", card: C(2), blocks: [B(72)] };
  const beta = { id: P(4), role: "card", title: "Beta Blockers", card: C(3), blocks: [B(73)] };
  const cards3 = [
    { id: C(1), aliases: ["amlodipine"], home: { fm: "cardiovascular" } },
    { id: C(2), aliases: ["nitroglycerin"], home: {} },
    { id: C(3), aliases: ["metoprolol"], home: {} },
  ];

  it("refuses parts that do not cover the file's blocks exactly once", async () => {
    await refused(["pharm-parts", "cardio-med-list", await draft("a", { parts: [overview, ccb, nitrates], cards: cards3.slice(0, 2) })], /parts covering every block exactly once/, files);
  });

  it("refuses a card with no part, a part naming another file's card, and a removed part still in use", async () => {
    await refused(["pharm-parts", "cardio-med-list", await draft("a", { parts: [overview, ccb, nitrates, { ...beta, card: C(2) }], cards: cards3 })], new RegExp(`card ${C(3)} has no part`), files);
    await refused(["pharm-parts", "cardio-med-list", await draft("b", { parts: [overview, ccb, nitrates, { ...beta, card: C(9) }], cards: cards3 })], /not a card of this file/, files);
    // structure.json of fm/cardiovascular shows P(1) as its overview; without an id the part gets a new one.
    const unnamed = { role: overview.role, title: overview.title, card: null, blocks: overview.blocks };
    await refused(["pharm-parts", "cardio-med-list", await draft("c", { parts: [unnamed, ccb, nitrates, beta], cards: cards3 })], new RegExp(`${P(1)}.*pharm part`), files);
  });

  it("refuses an unknown pharm notes file", async () => {
    await refused(["pharm-parts", "nope", await draft("a", { parts: [], cards: [] })], /no pharm notes file nope/, files);
  });
});

describe("cards", () => {
  const cardsPath = "content/pharm/cards.json";
  const ccb = { id: C(1), file: "cardio-med-list", aliases: ["calcium channel blocker", "CCB", "amlodipine", "diltiazem"], home: { fm: "cardiovascular" } };
  const nitrates = { id: C(2), file: "cardio-med-list", aliases: ["nitroglycerin", "nitrates"], home: {} };
  const beta = { id: C(3), file: "cardio-med-list", aliases: ["metoprolol"], home: { fm: "cardiovascular" } };
  const base = (): CardsFile["cards"] => [ccb, nitrates, beta];

  it("writes cards.json", async () => {
    await run(root, ["cards", await draft("c", { v: 1, cards: [ccb, nitrates, { ...beta, aliases: ["metoprolol", "beta blockers"] }] })]);
    expect((await read<CardsFile>(cardsPath)).cards.find((c) => c.id === C(3))?.aliases).toEqual(["metoprolol", "beta blockers"]);
  });

  it("refuses a card placed in no pharm section (40 §40.1), an unknown file and a card without a part", async () => {
    const nowhere = [ccb, { ...nitrates, aliases: ["zzz-no-such-drug"] }, beta];
    await refused(["cards", await draft("a", { v: 1, cards: nowhere })], new RegExp(C(2)), [cardsPath]);
    await refused(["cards", await draft("b", { v: 1, cards: [...base(), { id: C(9), file: "nope", aliases: ["x"], home: {} }] })], /pharm notes file nope/, [cardsPath]);
    await refused(["cards", await draft("c", { v: 1, cards: [...base(), { id: C(9), file: "cardio-med-list", aliases: ["x"], home: {} }] })], /has no part/, [cardsPath]);
  });
});

describe("general and places", () => {
  const GEN = "content/guides/fm/general.json";
  const gen = (over: Partial<GeneralFile> = {}): GeneralFile => ({
    v: 1,
    topics: [{ key: "labs", howto: "labs", links: [{ target: R(101), covers: "AF labs" }], files: [D(5)], gaps: [G(1)] }],
    workup: [{ id: "ams", title: "Altered mental status (AMS)", conds: "Delirium", gap: G(2) }, { id: "chest-pain", title: "Chest pain", conds: "Pulmonary embolism", gap: G(1) }],
    ...over,
  });

  it("writes general.json", async () => {
    await run(root, ["general", "fm", await draft("g", gen())]);
    expect(await read<GeneralFile>(GEN)).toEqual(gen());
  });

  it("refuses unknown targets, files and gaps, workup out of order, and PANCE", async () => {
    await refused(["general", "fm", await draft("a", gen({ topics: [{ key: "labs", howto: null, links: [{ target: R(777), covers: "x" }], files: [], gaps: [] }] }))], new RegExp(`${R(777)} names nothing`), [GEN]);
    await refused(["general", "fm", await draft("b", gen({ topics: [{ key: "labs", howto: null, links: [], files: [D(9)], gaps: [] }] }))], new RegExp(`${D(9)} names nothing`), [GEN]);
    await refused(["general", "fm", await draft("c", gen({ workup: [{ id: "x", title: "X", conds: "", gap: G(9) }] }))], new RegExp(`${G(9)} names nothing`), [GEN]);
    await refused(["general", "fm", await draft("d", gen({ workup: [...gen().workup].reverse() }))], /alphabetical order/, [GEN]);
    await refused(["general", "pance", await draft("e", gen())], /no general\.json/, [GEN]);
  });

  it("writes reftabs.json and other.json and refuses names of nothing", async () => {
    const other = await read<OtherFile>("content/places/other.json");
    const section = (id: string) => must(other.sections.find((s) => s.id === id), id);
    section("screenings").gaps = [G(1)];
    const reftabs = await read<RefTabsFile>("content/places/reftabs.json");
    reftabs.imaging.files = [D(1)];
    await run(root, ["places", await draft("p", { reftabs, other })]);
    expect((await read<OtherFile>("content/places/other.json")).sections.find((s) => s.id === "screenings")?.gaps).toEqual([G(1)]);
    expect((await read<RefTabsFile>("content/places/reftabs.json")).imaging.files).toEqual([D(1)]);

    const files = ["content/places/other.json", "content/places/reftabs.json"];
    section("emergency").files = [D(8)];
    await refused(["places", await draft("q", { other })], new RegExp(`${D(8)} names nothing`), files);
    must(reftabs.labs.subs[0], "labs sub").links = [{ target: B(999), covers: "x" }];
    await refused(["places", await draft("r", { reftabs })], new RegExp(`${B(999)} names nothing`), files);
    section("emergency").files = [];
    section("emergency").gaps = [];
    await refused(["places", await draft("s", { other })], /no gaps key outside legal and screenings/, files);
    await refused(["places", await draft("t", {})], /needs reftabs and\/or other/, files);
  });
});

describe("gap", () => {
  const block = (sentences: string[]): Omit<GapFile, "id"> => ({
    v: 1, kind: "gap", doc: doc(...sentences.map((s) => para(s))) as GapFile["doc"],
    meta: {
      title: "Lithium level", relevantTo: "Bipolar I disorder", written: "2026-10", differs: null,
      sources: [{ name: "Lithium label", org: "FDA", year: "2025", url: "https://dailymed.nlm.nih.gov/x", type: "reference", track: null }],
      ownerEdits: [],
    },
  });
  const evidence = (claims: [string, string][], result: "pass" | "fail" = "pass", verifier = "bo-2"): Omit<EvidenceFile, "block"> => ({
    v: 1, author: "ann-1",
    claims: claims.map(([t, quote]) => ({ text: t, source: 0, quote, locator: "section 2.2", accessed: "2026-10-05" })),
    verification: { verifier, at: "2026-10-06", result, notes: [] },
  });
  const trough = "Draw a trough 12 hours after the dose.";
  const target = "Target 0.8 to 1 mEq/L.";
  const sentences = [trough, target];
  const troughClaim: [string, string] = [trough, "obtain trough 12 hours after the last dose"];
  const claims: [string, string][] = [troughClaim, [target, "maintenance 0.8 to 1 mEq/L"]];

  it("writes a new gap block and its evidence under an assigned id", async () => {
    const lines = await run(root, ["gap", "new", await draft("g", { block: block(sentences), evidence: evidence(claims) })]);
    const id = must(/gap block → (?<id>g_\w{10})/.exec(lines.join("\n"))?.groups?.id, "assigned gap id");
    expect((await read<GapFile>(`content/gapfill/${id}.json`)).id).toBe(id);
    expect((await read<EvidenceFile>(`content/gapfill/${id}.evidence.json`)).block).toBe(id);
  });

  it("rewrites an existing gap block named by its id", async () => {
    await run(root, ["gap", G(2), await draft("g", { block: { ...block(["Check glucose first."]), id: G(2) }, evidence: evidence([["Check glucose first.", "check glucose first"]]) })]);
    expect((await read<GapFile>(`content/gapfill/${G(2)}.json`)).meta.title).toBe("Lithium level");
  });

  it("refuses unverified, mismatched or self-verified evidence and unsupported numbers, writing nothing", async () => {
    const g2 = [`content/gapfill/${G(2)}.json`, `content/gapfill/${G(2)}.evidence.json`];
    const write = async (b: unknown, e: unknown) => ["gap", G(2), await draft("x", { block: b, evidence: e })];
    await refused(await write(block(sentences), evidence(claims, "fail")), /lacks a passing evidence record/, g2);
    await refused(await write(block([trough, "Target 0.6 to 1 mEq/L."]), evidence(claims)), /no longer matches its verified claims/, g2);
    await refused(await write(block(sentences), evidence(claims, "pass", "ann-1")), /verifier must be a different session/, g2);
    await refused(await write(block(sentences), evidence([troughClaim, [target, "maintenance 0.6 to 1.2 mEq/L"]])), /claim 1 has the number 0\.8/, g2);
    const badSource = evidence(claims);
    badSource.claims = badSource.claims.map((cl, i) => (i === 0 ? { ...cl, source: 3 } : cl));
    await refused(await write(block(sentences), badSource), /claim 0 names source 3/, g2);
    await refused(["gap", "g_bad", await draft("y", { block: block(sentences), evidence: evidence(claims) })], /not a g_ id/, g2);
    expect(await readContentIfExists(root, `content/gapfill/${G(9)}.json`)).toBeNull();
  });
});

describe("slides", () => {
  const heading = (t: string) => ({ type: "heading_line", content: [{ type: "text", text: t }] });
  const card = (h: string, ...items: string[]) => ({ type: "slide_card", content: [para(h), ...items.map((i) => para(i))] });
  const verification = { verifier: "bo-2", at: "2026-10-06", result: "pass" as const, notes: [] };
  const contents = { doc: doc(heading("High-yield review slides")), meta: {} };
  const anginaEvidence = { item: "Chest pain on exertion", row: R(104), quote: "chest pain on exertion" };
  const angina = {
    doc: doc(heading("Stable angina"), card("Presentation", "Chest pain on exertion")),
    meta: { summarizes: [R(104)], evidence: [anginaEvidence], verification },
  };

  it("writes the deck and its slides, and deletes slide blocks no longer listed", async () => {
    await run(root, ["slides", "fm", await draft("s", { title: "High-yield review slides", slides: [{ id: S(1), ...contents }, angina] })]);
    const deck = await read<DeckFile>("content/slides/fm/deck.json");
    const [first, second, ...rest] = deck.slides;
    expect(rest).toEqual([]);
    expect(first).toBe(S(1));
    const added = must(second, "second slide");
    expect(added).not.toBe(S(2));
    const slide = await read<BlockFile<SlideMeta>>(`content/slides/fm/blocks/${added}.json`);
    expect(slide.doc.content[0]).toEqual(heading("Stable angina"));
    expect(slide.meta.evidence).toEqual([anginaEvidence]);
    expect(slide.meta.summarizes).toEqual([R(104)]);
    expect(await readContentIfExists(root, `content/slides/fm/blocks/${S(2)}.json`)).toBeNull();
  });

  it("refuses a quote not in its row, an unverified slide, a wrong contents slide and her own deck", async () => {
    const files = ["content/slides/fm/deck.json", `content/slides/fm/blocks/${S(2)}.json`];
    const deckOf = (slide: unknown) => draft("x", { title: "High-yield review slides", slides: [contents, slide] });
    await refused(["slides", "fm", await deckOf({ ...angina, meta: { ...angina.meta, evidence: [{ ...anginaEvidence, quote: "crushing pain" }] } })], /quote is not in/, files);
    await refused(["slides", "fm", await deckOf({ ...angina, meta: { ...angina.meta, verification: { ...verification, result: "fail" } } })], /lacks a passing evidence record/, files);
    await refused(["slides", "fm", await deckOf({ ...angina, meta: { ...angina.meta, summarizes: [R(777)] } })], new RegExp(`${R(777)} names nothing`), files);
    await refused(["slides", "fm", await draft("y", { title: "Other title", slides: [contents] })], /contents slide/, files);
    await refused(["slides", "psy", await draft("z", { title: "Psych", slides: [{ doc: doc(heading("Psych")), meta: {} }] })], /her own deck/, files);
  });
});

describe("flags and concepts", () => {
  const FLAGS = "content/updates/flags.json";
  const CONCEPTS = "content/updates/concepts.json";
  const researched = {
    kind: "rec", source: "gold", by: "agent", key: "k1", subject: "k1", guideline: "GOLD 2026 Report, ch. 3", org: "GOLD", published: "2025-11",
    quote: "New text.", grade: null, url: "https://goldcopd.org/2026", flagged: "2026-10-07", locator: "p. 40",
    verification: { verifier: "bo-2", at: "2026-10-07", result: "pass" },
  };

  it("appends researched flags with new ids and supersedes the current flag with the same key", async () => {
    await run(root, ["flags", await draft("f", { flags: [researched] })]);
    const { flags } = await read<FlagsFile>(FLAGS);
    const [u1, u2, u3, u4, u5, added, ...rest] = flags;
    expect([u1, u2, u3, u4, u5].map((f) => f?.id)).toEqual([U(1), U(2), U(3), U(4), U(5)]);
    expect(rest).toEqual([]);
    const flag = must(added, "appended flag");
    expect(flag.id).toMatch(/^u_/);
    expect(flag.supersededBy).toBeNull();
    expect(flag.key).toBe("k1");
    expect(u1?.supersededBy).toBe(flag.id);
    // U(4) was already superseded by U(1); it keeps that. U(2) has another key.
    expect(u4?.supersededBy).toBe(U(1));
    expect(u2?.supersededBy).toBeNull();
  });

  it("refuses check-made flags and drafts that carry ids", async () => {
    await refused(["flags", await draft("a", { flags: [{ ...researched, by: "check" }] })], /must be by "agent"/, [FLAGS]);
    await refused(["flags", await draft("b", { flags: [{ ...researched, id: U(9) }] })], /must not carry id/, [FLAGS]);
    await refused(["flags", await draft("c", { flags: [] })], /non-empty flags array/, [FLAGS]);
  });

  it("writes concepts and refuses unknown targets and keys no flag carries", async () => {
    const af = { id: "af", title: "AF", sourceKeys: { gold: ["k1"] }, targets: [R(101), G(1), D(5), B(11)] };
    const concepts: ConceptsFile = { v: 1, concepts: [af] };
    await run(root, ["concepts", await draft("k", concepts)]);
    expect(await read<ConceptsFile>(CONCEPTS)).toEqual(concepts);
    await refused(["concepts", await draft("a", { v: 1, concepts: [{ ...af, targets: [R(777)] }] })], new RegExp(`${R(777)} names nothing`), [CONCEPTS]);
    await refused(["concepts", await draft("b", { v: 1, concepts: [{ ...af, sourceKeys: { gold: ["k9"] } }] })], /no gold flag carries "k9"/, [CONCEPTS]);
    await refused(["concepts", await draft("c", { v: 1, concepts: [{ ...af, sourceKeys: { uspstf: ["k1"] } }] })], /no uspstf flag carries "k1"/, [CONCEPTS]);
  });
});

describe("staged changes are checked by the build's own loader", () => {
  const PSY_DECK = "content/slides/psy/deck.json";
  const D4 = `content/files/${D(4)}/file.json`;

  /** Commit `changes`, expecting a refusal; asserts its message and that the given files are byte-unchanged. */
  async function refusedCommit(changes: { path: string; value: unknown }[], message: RegExp, unchanged: string[]): Promise<void> {
    const before = await Promise.all(unchanged.map(text));
    await expect(commitChanges(root, changes)).rejects.toThrow(message);
    expect(await Promise.all(unchanged.map(text))).toEqual(before);
  }

  it("refuses a block file its owner does not list, writing nothing", async () => {
    const stray = `${CV}/blocks/${B(99)}.json`;
    const value = { v: 1, id: B(99), kind: "prose", doc: doc(para("stray")), meta: {} };
    await refusedCommit([{ path: stray, value }], /block file is not listed by its owner/, [`${CV}/system.json`]);
    expect(await readContentIfExists(root, stray)).toBeNull();
  });

  it("reads a removed document's own deck without its slide blocks, and refuses restoring the document while they are missing", async () => {
    const deck = await read<DeckFile>(PSY_DECK);
    expect(await commitChanges(root, [{ path: PSY_DECK, value: { ...deck, title: "Psych review" } }])).toEqual([PSY_DECK]);
    expect((await read<DeckFile>(PSY_DECK)).title).toBe("Psych review");

    const file = await read<Record<string, unknown>>(D4);
    await refusedCommit([{ path: D4, value: { ...file, removed: null } }], new RegExp(`${S(40)}\\.json: listed block file is missing`), [D4, PSY_DECK]);
  });

  it("refuses a site file naming a guide the tree does not have, writing nothing", async () => {
    const site = await read<{ eors: string[]; guideNames: Record<string, string> }>("content/site.json");
    const value = { ...site, eors: [...site.eors, "im"], guideNames: { ...site.guideNames, im: "Internal Medicine" } };
    await refusedCommit([{ path: "content/site.json", value }], /guides\/im\/guide\.json: file not found/, ["content/site.json"]);
  });
});

describe("command line", () => {
  it("refuses unknown commands and wrong argument counts with the usage", async () => {
    await expect(run(root, ["nope"])).rejects.toThrow(USAGE);
    await expect(run(root, [])).rejects.toThrow(USAGE);
    await expect(run(root, ["split", B(11)])).rejects.toThrow(USAGE);
    await expect(run(root, ["rows", B(10)])).rejects.toThrow(USAGE);
  });

  it("refuses a draft that is not JSON", async () => {
    const path = join(root, "bad.json");
    await writeFile(path, "{ nope", "utf8");
    await expect(run(root, ["cards", path])).rejects.toThrow(/bad\.json: not JSON/);
  });

  it("refuses to run on a tree that is missing a curation file", async () => {
    await rm(join(root, "content", "updates", "concepts.json"));
    await expect(run(root, ["split", B(11), "1"])).rejects.toThrow(/concepts\.json: file not found/);
  });
});
