// Plan 99 §99.1 `lib/derive/derive.test.ts`: topics (40 §40.2), navigation and pages (§40.3), pharm
// (§40.4–§40.5), published data and invariants (§40.1, §40.8). Unit topics run on in-memory blocks;
// the rest publish the synthetic tree of tools/build/test-fixture.ts, written and read through lib/content.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeContent, writeContent } from "../content/fs.ts";
import { topicBelowPath, topicMedsPath } from "../content/files.ts";
import { systemRowOrder } from "../content/splice.ts";
import type { BlockFile, MedsFile, MedsPiece, StructureFile, UsesFile } from "../content/types.ts";
import { schema } from "../schema.ts";
import { loadContent } from "../../tools/build/load.ts";
import { B, C, D, G, GONE, P, PHARM_PAGE, R, S, tableDoc, U, writeFixture, writePharmReviewPage } from "../../tools/build/test-fixture.ts";
import { uncoveredText } from "./coverage.ts";
import { BuildError } from "./errors.ts";
import type { Content, GuideData, SystemData } from "./model.ts";
import { type Card, CardMatcher, meantCards, medsPanel, panelHome, type PharmPlace, phraseMatcher, sectionRowCards, stubLabel, topicText, treatmentColumn } from "./pharm.ts";
import { publish, type PublishResult } from "./publish.ts";
import {
  docPath, generalPath, homePath, HOSTS_PATH, navPath, OTHER_PATH, REF_PATH_RE, refPath, SITE_PATH, slidesPath, systemPath, UPDATES_PATH, workupPath,
  type DocJson, type DocList, type GeneralJson, type HostsJson, type NavJson, type OtherJson, type RefTabJson, type SiteJson, type SlidesJson, type SystemJson, type UpdatesJson,
} from "./published.ts";
import { GENERAL_KEYS } from "../content/types.ts";
import { fileLocation, guideBase, guideViewHash, otherHash, parseHash, REF_TABS, refHash } from "./routes.ts";
import { docText, tableOf } from "./text.ts";
import { belowUnder, checkMembers, deriveTopics, fitTopicRows, navEntries, publishedRows, publishedSections, sectionItems, topicsBelow, withHeadings, type Topic } from "./topics.ts";
import { addDoc } from "./doclist.ts";
import { entryPieces, pageCard, panelEntries, publishedEdit, shownPieces } from "./panel.ts";

const table = (id: string, columns: number, rows: Parameters<typeof tableDoc>[1]): BlockFile =>
  ({ v: 1, id, kind: "table", doc: tableDoc(columns, rows), meta: {} }) as unknown as BlockFile;
/** A structure; unless given, its pharm sections are the ones its drug tables name, holding those tables. */
const structureOf = (over: Partial<StructureFile> = {}): StructureFile => {
  const drugTables = over.drugTables ?? [];
  const pharmSections = [...new Set(drugTables.map((d) => d.pharmSection))].map((id) => ({
    id, title: id, tables: drugTables.filter((d) => d.pharmSection === id).map((d) => d.block), overview: null, lo: null, also: [],
  }));
  return { v: 1, sections: [], members: {}, listed: {}, drugTables, pharmSections, pharmFiles: [], ...over };
};
/** The cards `sectionRowCards` lists for one drug row of a pharm section (`section`) with no Overview or LO. */
const rowCards = (m: CardMatcher, t: ReturnType<typeof deriveTopics>, row: Parameters<typeof sectionRowCards>[2][number], section: string, title = "") =>
  sectionRowCards(m, t, [row], { id: section, title, lists: new Set() }).get(row.id);

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

  describe("a multi-column table the structure lists by name", () => {
    const comparison = () => table(B(95), 3, [
      [R(950), "heading", "State", "Pupils", "Tx"],
      [R(951), "content", "Cocaine intox", "Mydriasis", "Benzos"],
      [R(952), "content", "Opioid intox", "Miosis", "Naloxone"],
    ]);
    const after = () => table(B(96), 2, [[R(960), "content", "Alcohol", "notes"]]);
    const sections = [{ id: "substance", title: "Substance-related disorders" }];

    it("is one sidebar entry under its listed title, ahead of the section's topics, and forms no topics", () => {
      const blocks = [comparison(), after()];
      const st = structureOf({ sections, listed: { [B(95)]: "Intoxication/Withdraw Comparison" }, members: { [B(95)]: "substance", [R(960)]: "substance" } });
      const t = deriveTopics(blocks, st);
      expect(t.proseBlocks).toEqual([B(95)]);
      expect(t.topics.map((x) => x.title)).toEqual(["Alcohol"]);
      expect([R(950), R(951), R(952)].some((id) => t.rows.has(id))).toBe(false);
      expect(navEntries(t, st, [B(95), B(96)]).sections[0]?.entries).toEqual([
        { kind: "block", id: B(95), title: "Intoxication/Withdraw Comparison" },
        { kind: "topic", id: R(960), title: "Alcohol" },
      ]);
      expect(sectionItems(t, st, [B(95), B(96)], "substance")).toEqual([{ block: B(95), rows: null }, { block: B(96), rows: [R(960)] }]);
    });

    it("unlisted, the same table still forms one topic per titled row", () => {
      const t = deriveTopics([comparison()], structureOf());
      expect(t.proseBlocks).toEqual([]);
      expect(t.topics.map((x) => x.title)).toEqual(["Cocaine intox", "Opioid intox"]);
    });
  });

  describe("a run of blocks listed as one entry", () => {
    const prose = (id: string, text: string): BlockFile =>
      ({ v: 1, id, kind: "prose", doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }, meta: {} }) as unknown as BlockFile;
    const blank = (id: string): BlockFile => ({ v: 1, id, kind: "prose", doc: { type: "doc", content: [{ type: "paragraph" }] }, meta: {} }) as unknown as BlockFile;
    const first = () => table(B(71), 3, [
      [R(710), "heading", "1st TM SCREENING", "NT", "hCG"],
      [R(711), "content", "Down's (21)", "up", "up"],
      [R(712), "content", "Edward's (18)", "up", "down"],
    ]);
    const quad = () => table(B(73), 2, [[R(730), "heading", "QUAD SCREEN", "AFP"], [R(731), "content", "Turner's", "nml"]]);
    const after = () => table(B(74), 2, [[R(740), "content", "Abortion", "notes"]]);
    const sections = [{ id: "pregnancy", title: "Pregnancy" }];
    const blocks = () => [prose(B(70), "Nuchal Translucency"), first(), blank(B(72)), quad(), after()];
    const ids = [B(70), B(71), B(72), B(73), B(74)];
    const st = () => structureOf({
      sections, listed: { [B(70)]: "Trimester screening" },
      members: { [B(70)]: "pregnancy", [B(71)]: B(70), [B(72)]: B(70), [B(73)]: B(70), [R(740)]: "pregnancy" },
    });

    it("is one sidebar entry listing the run, its tables form no topics, and its blocks show in the listed block's section", () => {
      const t = deriveTopics(blocks(), st());
      expect(t.proseBlocks).toEqual([B(70), B(71), B(72), B(73)]);
      expect(t.topics.map((x) => x.title)).toEqual(["Abortion"]);
      expect([R(710), R(711), R(712), R(730), R(731)].some((id) => t.rows.has(id))).toBe(false);
      expect(navEntries(t, st(), ids).sections[0]?.entries).toEqual([
        { kind: "block", id: B(70), title: "Trimester screening", blocks: [B(70), B(71), B(72), B(73)] },
        { kind: "topic", id: R(740), title: "Abortion" },
      ]);
      expect(sectionItems(t, st(), ids, "pregnancy")).toEqual([
        { block: B(70), rows: null }, { block: B(71), rows: null }, { block: B(72), rows: null }, { block: B(73), rows: null }, { block: B(74), rows: [R(740)] },
      ]);
      expect(() => checkMembers("obstetrics-gynecology", t, st())).not.toThrow();
    });

    it("refuses a block recorded under a listed block that is not the run directly above it", () => {
      const gap = structureOf({
        sections, listed: { [B(70)]: "Trimester screening" },
        members: { [B(70)]: "pregnancy", [B(72)]: "pregnancy", [B(73)]: B(70), [R(740)]: "pregnancy" },
      });
      const err = buildError(() => deriveTopics([prose(B(70), "NT"), blank(B(72)), quad(), after()], gap));
      expect(err.id).toBe(B(73));
      expect(err.message).toMatch(/not the listed block of the run directly above it/);
    });
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

  describe("merged cells read on the table grid", () => {
    type Cell = string | { text: string; rowspan?: number; colspan?: number };
    /** A table block whose cells may span rows or columns, stored as the importer stores them. */
    const merged = (id: string, columns: number, rows: [string, "heading" | "content", ...Cell[]][]): BlockFile => {
      const cell = (c: Cell) => {
        const { text, rowspan = 1, colspan = 1 } = typeof c === "string" ? { text: c } : c;
        return { type: "table_cell", attrs: { colspan, rowspan }, content: [text === "" ? { type: "paragraph" } : { type: "paragraph", content: [{ type: "text", text }] }] };
      };
      const content = rows.map(([rid, kind, ...cells]) => ({ type: "table_row", attrs: { id: rid, kind }, content: cells.map(cell) }));
      return { v: 1, id, kind: "table", doc: { type: "doc", content: [{ type: "table", attrs: { grid: Array(columns).fill(100) }, content }] }, meta: {} } as unknown as BlockFile;
    };
    const GCA = { text: "Giant Cell (Temporal) Arteritis", rowspan: 2 };
    const notes = ["large & medium vessel vasculitis", "HA, jaw claudication", "increased ESR & CRP", "high-dose corticosteroids"];

    it("a name cell merged down over the row below reads as an empty first cell there, so that row continues its topic", () => {
      // IM Cardiovascular b_P33Q4DSSPV as imported: the second row stores 4 cells for a 5-column grid.
      const b = merged(B(91), 5, [[R(910), "content", GCA, "About", "Clinical Manifestations", "Diagnostics", "Management"], [R(911), "content", ...notes]]);
      expect(tableOf(b)?.rows.map((r) => r.cells)).toEqual([
        ["Giant Cell (Temporal) Arteritis", "About", "Clinical Manifestations", "Diagnostics", "Management"],
        ["", ...notes],
      ]);
      const t = deriveTopics([b], structureOf());
      expect(t.topics.map((x) => [x.id, x.title, x.rows])).toEqual([[R(910), "Giant Cell (Temporal) Arteritis", [R(910), R(911)]]]);
      expect(t.rows.get(R(911))?.topic).toBe(R(910));
      expect(t.untitled).toEqual([]);
      for (const n of notes) expect(topicText(t, t.topics[0] as Topic)).toContain(n);
    });

    it("as a heading row, the merged name titles the topic below it, whose cells align with the heading's columns", () => {
      const b = merged(B(92), 5, [[R(920), "heading", GCA, "About", "CM", "Dx", "Mgmt"], [R(921), "content", ...notes]]);
      const t = deriveTopics([b], structureOf());
      expect(t.headings.get(R(920))).toEqual({ label: "Giant Cell (Temporal) Arteritis", columns: ["About", "CM", "Dx", "Mgmt"] });
      expect(t.topics.map((x) => [x.id, x.title, x.rows])).toEqual([[R(921), "Giant Cell (Temporal) Arteritis", [R(921)]]]);
      const row = t.tables.get(B(92))?.rows[1];
      expect(row?.cells.slice(1)).toEqual(notes);
      expect(row?.cells[1]).toBe(notes[0]); // under "About"
    });

    it("FM Heart Failure: rows under a merged name join it, not the topic before it, and the next name starts its own topic", () => {
      // FM Cardiovascular b_7FQFC7QZ0W r_N063KS4CHX, with a three-row merge to show the span is followed.
      const b = merged(B(93), 3, [
        [R(930), "content", "Hypertension", "stage 1", "lifestyle"],
        [R(931), "content", { text: "Heart Failure", rowspan: 3 }, "ACCF/AHA stages", "BNP"],
        [R(932), "content", "L-side sxs", "echo"],
        [R(933), "content", "R-side sxs", "loop diuretics"],
        [R(934), "content", "Myocarditis", "viral", "supportive"],
      ]);
      const t = deriveTopics([b], structureOf());
      expect(t.topics.map((x) => [x.title, x.rows])).toEqual([
        ["Hypertension", [R(930)]],
        ["Heart Failure", [R(931), R(932), R(933)]],
        ["Myocarditis", [R(934)]],
      ]);
      expect(t.tables.get(B(93))?.rows[3]?.cells).toEqual(["", "R-side sxs", "loop diuretics"]);
    });

    it("a column-spanning cell sits in its first grid column and the columns it covers read as empty", () => {
      const b = merged(B(94), 4, [
        [R(940), "heading", "ARRHYTHMIAS", { text: "Presentation", colspan: 2 }, "Treatment"],
        [R(941), "content", { text: "Atrial flutter", colspan: 2 }, "sawtooth", "rate control"],
        [R(942), "content", "AF", "irregular", "no P", "anticoagulate"],
      ]);
      const t = deriveTopics([b], structureOf());
      expect(t.headings.get(R(940))?.columns).toEqual(["Presentation", "", "Treatment"]);
      expect(t.tables.get(B(94))?.rows.map((r) => r.cells)).toEqual([
        ["ARRHYTHMIAS", "Presentation", "", "Treatment"],
        ["Atrial flutter", "", "sawtooth", "rate control"],
        ["AF", "irregular", "no P", "anticoagulate"],
      ]);
      expect(t.topics.map((x) => x.title)).toEqual(["Atrial flutter", "AF"]);
    });
  });

  it("in a system with sections, the build fails naming a condition row with no members entry", () => {
    const st = structuredClone(cv().structure);
    delete st.members[R(123)];
    const e = buildError(() => checkMembers("fm/cardiovascular", deriveTopics(cv().blocks, st), st));
    expect(e.id).toBe(R(123));
    expect(e.message).toMatch(/condition row/);
  });

  // Orchestrator ruling 2026-10-04 04:44Z: a row recorded in `members` under a later topic row shows
  // with that topic, ahead of its first row, instead of continuing the topic above it.
  describe("rows recorded under a topic (ruling 04:44Z)", () => {
    const rows = (...r: Parameters<typeof tableDoc>[1]) => table(B(91), 2, r);
    const [H, A, X, F, Y] = [R(910), R(911), R(912), R(913), R(914)];

    it("a blank row recorded under the next topic joins it, not the topic above", () => {
      const blocks = [rows([A, "content", "Alpha", "a"], [X, "content", "", "x text"], [F, "content", "Foxtrot", "f"])];
      expect(deriveTopics(blocks, structureOf()).rows.get(X)?.topic).toBe(A); // positional rule without the record
      const t = deriveTopics(blocks, structureOf({ members: { [X]: F } }));
      expect(t.topics.map((x) => [x.id, x.rows])).toEqual([[A, [A]], [F, [X, F]]]);
      expect(t.rows.get(X)?.topic).toBe(F);
    });

    it("a labeled heading row above a recorded row still titles the topic below it", () => {
      const blocks = [rows([H, "heading", "Stable angina", "P"], [X, "content", "", "x"], [F, "content", "", "f"])];
      const t = deriveTopics(blocks, structureOf({ members: { [X]: F } }));
      expect(t.topics.map((x) => [x.id, x.title, x.rows])).toEqual([[F, "Stable angina", [X, F]]]);
    });

    it("several recorded rows keep table order, and a row with first-cell text still starts its own topic", () => {
      const blocks = [rows([A, "content", "Alpha", "a"], [Y, "content", "", "y"], [X, "content", "Xray", "x"], [F, "content", "Foxtrot", "f"])];
      const t = deriveTopics(blocks, structureOf({ members: { [Y]: F, [X]: F } }));
      expect(t.topics.map((x) => [x.id, x.rows])).toEqual([[A, [A]], [X, [X]], [F, [Y, F]]]);
    });

    it("takes the section of the topic it is recorded under", () => {
      const blocks = [rows([A, "content", "Alpha", "a"], [X, "content", "Xray", "x"], [Y, "content", "", "y"], [F, "content", "Foxtrot", "f"])];
      const st = structureOf({ sections: [{ id: "s1", title: "S1" }, { id: "s2", title: "S2" }], members: { [A]: "s1", [X]: F, [Y]: F, [F]: "s2" } });
      const t = deriveTopics(blocks, st);
      expect(t.topics.map((x) => [x.id, x.section])).toEqual([[A, "s1"], [X, "s2"], [F, "s2"]]);
      expect(() => checkMembers("fm/x", t, st)).not.toThrow();
    });

    it("fails the build when the recorded topic row is not a later row of the same table", () => {
      const blocks = [rows([F, "content", "Foxtrot", "f"], [X, "content", "", "x"])];
      const e = buildError(() => deriveTopics(blocks, structureOf({ members: { [X]: F } })));
      expect(e.id).toBe(X);
      expect(e.message).toMatch(/not a later topic or untitled row of the same table/);
    });
  });

  // Orchestrator rulings 2026-10-04 21:02Z and 22:01Z (amending §40.2): a content row listed in
  // `titled` starts a topic titled with the named cell of the heading row directly above it.
  describe("titled rows (rulings 21:02Z, 22:01Z)", () => {
    // psy b_GDBK71BB64: the label row "Serotonin Syndrome" names the condition; the row below holds its notes.
    const [SS, SSN] = ["r_0YBBFWYXDA", "r_CEEX5DZ1WB"];
    const serotonin = (kind: "heading" | "content") => table("b_GDBK71BB64", 5, [
      [SS, kind, "Serotonin Syndrome", "", "", "", ""],
      [SSN, "content", "Rapid onset, 2+ serotonin agents or dosage changes", "S/SXS: mental status changes", "", "TX: BDZs, IVF, cooling", ""],
    ]);
    // em pulmonary b_0XAMGVVY65: "PULM | Acute Exacerbation of COPD (AECOPD) | | " over a row with an empty first cell.
    const [COPD, AE, AEN] = ["r_DTR443XYG0", "r_X3DMHZGC37", "r_6P35S0G0ES"];
    const pulm = () => table("b_0XAMGVVY65", 4, [
      [COPD, "content", "COPD", "persistent respiratory symptoms", "spirometry", "Group A"],
      [AE, "heading", "PULM", "Acute Exacerbation of COPD (AECOPD)", "", ""],
      [AEN, "content", "", "acute worsening of respiratory symptoms", "Initial Evaluation: vitals", "SABA +/- SAMA"],
    ]);
    const titles = (blocks: BlockFile[], st: StructureFile) => deriveTopics(blocks, st).topics.map((x) => [x.id, x.title, x.rows]);

    it("label row then notes row, titled from cell 0: the notes row's topic takes the label, not its notes text", () => {
      expect(titles([serotonin("heading")], structureOf())).toEqual([[SSN, "Rapid onset, 2+ serotonin agents or dosage changes", [SSN]]]);
      expect(titles([serotonin("heading")], structureOf({ titled: { [SSN]: 0 } }))).toEqual([[SSN, "Serotonin Syndrome", [SSN]]]);
    });

    it("the em case: a heading row titled from cell 1 over an empty-first-cell row", () => {
      expect(titles([pulm()], structureOf())).toEqual([[COPD, "COPD", [COPD]], [AEN, "PULM", [AEN]]]);
      const t = deriveTopics([pulm()], structureOf({ titled: { [AEN]: 1 } }));
      expect(t.topics.map((x) => [x.id, x.title, x.rows])).toEqual([[COPD, "COPD", [COPD]], [AEN, "Acute Exacerbation of COPD (AECOPD)", [AEN]]]);
      expect(t.rows.get(AEN)).toMatchObject({ heading: AE, topic: AEN });
    });

    it("the cell's text is taken with whitespace collapsed, as labels are", () => {
      const b = table(B(95), 2, [[R(950), "heading", "  Acute\n  kidney   injury ", "x"], [R(951), "content", "notes", "more"]]);
      expect(titles([b], structureOf({ titled: { [R(951)]: 0 } }))).toEqual([[R(951), "Acute kidney injury", [R(951)]]]);
    });

    it("rows recorded under the titled row between it and the heading keep the heading directly above it", () => {
      const b = table(B(95), 2, [[R(950), "heading", "Gout", "Tx"], [R(952), "content", "", "added above"], [R(951), "content", "notes", "colchicine"]]);
      expect(titles([b], structureOf({ members: { [R(952)]: R(951) }, titled: { [R(951)]: 0 } }))).toEqual([[R(951), "Gout", [R(952), R(951)]]]);
    });

    it.each([
      ["with a content row, not a heading row, above it", () => [serotonin("content")], { [SSN]: 0 }, SSN, /no heading row is directly above it/],
      ["whose named heading cell is empty", () => [pulm()], { [AEN]: 2 }, AEN, new RegExp(`cell 2 of heading row ${AE}, which is empty or missing`)],
      ["whose named cell is past the table's columns", () => [pulm()], { [AEN]: 9 }, AEN, /cell 9 .* empty or missing/],
      ["that is not directly below the heading row", () => [pulm()], { [COPD]: 0 }, COPD, /no heading row is directly above it/],
      ["that is itself a heading row", () => [pulm()], { [AE]: 0 }, AE, /not a content row of a topic table/],
      ["that is no row of the system", () => [pulm()], { [R(999)]: 0 }, R(999), /not a content row of a topic table/],
    ])("fails the build for a titled row %s", (_name, blocks, entries, id, message) => {
      const e = buildError(() => deriveTopics(blocks(), structureOf({ titled: entries })));
      expect(e.id).toBe(id);
      expect(e.message).toMatch(message);
    });

    it("fails the build for a titled drug row of a drug table", () => {
      const drug = table(B(96), 2, [[R(960), "heading", "BETA BLOCKERS", "MOA"], [R(961), "content", "Metoprolol", "β1"]]);
      const st = structureOf({ drugTables: [{ block: B(96), pharmSection: "x", conditionRows: [] }], titled: { [R(961)]: 0 } });
      expect(buildError(() => deriveTopics([drug], st)).id).toBe(R(961));
    });

    it("fitTopicRows keeps the structure itself when every entry fits", () => {
      const st = structureOf({ titled: { [AEN]: 1 } });
      expect(fitTopicRows([pulm()], st)).toBe(st);
      const none = structureOf();
      expect(fitTopicRows([pulm()], none)).toBe(none);
    });

    it("fitTopicRows drops only the entries that no longer fit, and the field when none is left", () => {
      const both = [pulm(), serotonin("heading")];
      const st = structureOf({ titled: { [AEN]: 1, [SSN]: 0 } });
      expect(fitTopicRows(both, st)).toBe(st);
      // The serotonin label row is a content row again: that entry no longer fits.
      const kept = fitTopicRows([pulm(), serotonin("content")], st);
      expect(kept.titled).toEqual({ [AEN]: 1 });
      expect(() => deriveTopics([pulm(), serotonin("content")], kept)).not.toThrow();
      const gone = fitTopicRows([serotonin("content")], structureOf({ titled: { [SSN]: 0, [AEN]: 1 } }));
      expect(gone).not.toHaveProperty("titled");
      expect(titles([serotonin("content")], gone)).toEqual([[SS, "Serotonin Syndrome", [SS]], [SSN, "Rapid onset, 2+ serotonin agents or dosage changes", [SSN]]]);
    });

    it("fitTopicRows ignores a recorded row the build would refuse, leaving that to the build's own check", () => {
      const b = table(B(95), 2, [[R(950), "heading", "Gout", "Tx"], [R(951), "content", "notes", "colchicine"], [R(952), "content", "", "stray"]]);
      const st = structureOf({ members: { [R(952)]: R(951) }, titled: { [R(951)]: 0 } });
      expect(fitTopicRows([b], st)).toBe(st);
      expect(buildError(() => deriveTopics([b], st)).id).toBe(R(952));
    });

    // Ruling 2026-10-06: a `titled` value may be the title itself, used verbatim.
    describe("titled by a title given as text", () => {
      // pance reproductive b_74Z623HCPB: "OB | NONHORMONAL" over a "Contraceptive Methods" row.
      const [NH, NHR, HH, HR] = [R(970), R(971), R(972), R(973)];
      const contraception = () => table(B(97), 2, [
        [NH, "heading", "OB", "NONHORMONAL"], [NHR, "content", "Contraceptive Methods", "Behavioral methods"],
        [HH, "heading", "", "HORMONAL"], [HR, "content", "Contraceptive Methods", "Progesterone"],
      ]);

      it("the row's topic takes that title, whatever the heading row above it says", () => {
        const st = structureOf({ titled: { [NHR]: "Contraceptive Methods – Nonhormonal", [HR]: "Contraceptive Methods – Hormonal" } });
        expect(titles([contraception()], st)).toEqual([
          [NHR, "Contraceptive Methods – Nonhormonal", [NHR]], [HR, "Contraceptive Methods – Hormonal", [HR]],
        ]);
      });

      it("needs no heading row above the row", () => {
        expect(titles([serotonin("content")], structureOf({ titled: { [SSN]: "Serotonin syndrome notes" } }))).toEqual([
          [SS, "Serotonin Syndrome", [SS]], [SSN, "Serotonin syndrome notes", [SSN]],
        ]);
      });

      it("fails the build for a row that is no content row of a topic table, and fitTopicRows drops it", () => {
        const st = structureOf({ titled: { [NH]: "Contraception", [HR]: "Contraceptive Methods – Hormonal" } });
        const e = buildError(() => deriveTopics([contraception()], st));
        expect(e.id).toBe(NH);
        expect(e.message).toMatch(/not a content row of a topic table/);
        expect(fitTopicRows([contraception()], st).titled).toEqual({ [HR]: "Contraceptive Methods – Hormonal" });
      });
    });
  });

  // Agent decision (Orchestrator 2026-10-06), amending §40.2: an empty-first-cell row under a heading
  // label equal to the title of the topic it would otherwise continue continues that topic.
  describe("a heading label repeating the topic a row would continue", () => {
    // fm GI: her Cirrhosis row, a blank paragraph, then "Cirrhosis | Complications of Portal HTN" over rows with an empty first cell.
    const [GH, CIR, CH, C1, C2] = [R(980), R(981), R(982), R(983), R(984)];
    const blocks = (label: string) => [
      table(B(98), 2, [[GH, "heading", "GI", "About"], [CIR, "content", "Cirrhosis", "chronic liver injury"]]),
      { v: 1, id: B(99), kind: "prose", doc: { type: "doc", content: [{ type: "paragraph" }] }, meta: {} } as unknown as BlockFile,
      table(B(100), 2, [[CH, "heading", label, "Complications of Portal HTN"], [C1, "content", "", "Esophageal varices"], [C2, "content", "", "Ascites"]]),
    ];

    it("rows of the next table continue the topic their label names again", () => {
      const t = deriveTopics(blocks("Cirrhosis"), structureOf());
      expect(t.topics.map((x) => [x.id, x.title, x.rows])).toEqual([[CIR, "Cirrhosis", [CIR, C1, C2]]]);
      expect(t.rows.get(C1)).toMatchObject({ heading: CH, topic: CIR });
      // Her heading row still shows above the rows it heads on the topic's page.
      expect(withHeadings(t, [CIR, C1, C2])).toEqual([GH, CIR, CH, C1, C2]);
    });

    it("a row of the same table continues the topic its label names again", () => {
      const b = table(B(98), 2, [[GH, "heading", "Gout", "Tx"], [CIR, "content", "Gout", "notes"], [CH, "heading", "Gout", "Flares"], [C1, "content", "", "colchicine"]]);
      expect(deriveTopics([b], structureOf()).topics.map((x) => [x.id, x.title, x.rows])).toEqual([[CIR, "Gout", [CIR, C1]]]);
    });

    it("a different label still starts its own topic, and a titled row keeps its own", () => {
      expect(deriveTopics(blocks("Ascites"), structureOf()).topics.map((x) => [x.id, x.title])).toEqual([[CIR, "Cirrhosis"], [C1, "Ascites"]]);
      expect(deriveTopics(blocks("Cirrhosis"), structureOf({ titled: { [C1]: 1 } })).topics.map((x) => [x.id, x.title, x.rows])).toEqual([
        [CIR, "Cirrhosis", [CIR]], [C1, "Complications of Portal HTN", [C1, C2]],
      ]);
    });
  });

  // Ruling 2026-10-06 (her "Show it once"): an `unlisted` row starts no topic and shows in place only.
  describe("unlisted rows", () => {
    // fm dermatology b_M5GE8RVXWN: her second copy of Pityriasis (Tinea) Versicolor ends the Papulosquamous table.
    const [PH, PR, PV, PV2, NX, NX2] = [R(985), R(986), R(987), R(988), R(989), R(990)];
    const blocks = () => [
      table(B(101), 2, [[PH, "heading", "Papulosquamous", "About"], [PR, "content", "Pityriasis Rosea", "herald patch"], [PV, "content", "Pityriasis (Tinea) Versicolor", "Malassezia"], [PV2, "content", "", "KOH prep"]]),
      table(B(102), 2, [[NX, "content", "", "continued"], [NX2, "content", "Seborrheic Keratosis", "stuck-on"]]),
    ];
    const sections = { sections: [{ id: "s1", title: "S1" }], members: { [PR]: "s1", [PV]: "s1", [NX2]: "s1" } };

    it("the row and the rows that would continue it are shown in place only, not joining the topic above", () => {
      const st = structureOf({ ...sections, unlisted: [PV] });
      const t = deriveTopics(blocks(), st);
      expect(t.topics.map((x) => [x.id, x.title, x.rows])).toEqual([[PR, "Pityriasis Rosea", [PR]], [NX2, "Seborrheic Keratosis", [NX2]]]);
      expect(t.untitled).toEqual([PV, PV2, NX]);
      expect(t.rows.get(PV)?.topic).toBeNull();
      // Not a sidebar entry, but still on its section page with its table's heading row.
      expect(navEntries(t, st, [B(101), B(102)]).sections[0]?.entries.map((e) => e.id)).toEqual([PR, NX2]);
      expect(sectionItems(t, st, [B(101), B(102)], "s1")).toEqual([{ block: B(101), rows: [PH, PR, PV] }, { block: B(102), rows: [NX2] }]);
    });

    it.each([
      ["that would continue a topic", { unlisted: [PV2] }, PV2, /unlisted, but it starts no topic/],
      ["that is a heading row", { unlisted: [PH] }, PH, /not a content row of a topic table/],
      ["that is no row of the system", { unlisted: [R(999)] }, R(999), /not a content row of a topic table/],
    ])("fails the build for an unlisted row %s", (_name, over, id, message) => {
      const e = buildError(() => deriveTopics(blocks(), structureOf(over)));
      expect(e.id).toBe(id);
      expect(e.message).toMatch(message);
    });

    it("fails the build for an unlisted condition row of a drug table", () => {
      const drug = table(B(96), 2, [[R(960), "heading", "BETA BLOCKERS", "MOA"], [R(961), "content", "Hypertension", "β1"]]);
      const st = structureOf({ drugTables: [{ block: B(96), pharmSection: "x", conditionRows: [R(961)] }], unlisted: [R(961)] });
      expect(buildError(() => deriveTopics([drug], st)).message).toMatch(/unlisted, but it is a row of a drug table/);
    });

    it("fitTopicRows drops the entries whose row no longer fits, and the field when none is left", () => {
      const st = structureOf({ unlisted: [PV] });
      expect(fitTopicRows(blocks(), st)).toBe(st);
      // She deleted the row: the entry goes.
      const without = [table(B(101), 2, [[PH, "heading", "Papulosquamous", "About"], [PR, "content", "Pityriasis Rosea", "herald patch"]])];
      expect(fitTopicRows(without, st)).not.toHaveProperty("unlisted");
      expect(fitTopicRows(blocks(), structureOf({ unlisted: [PV, PV2] })).unlisted).toEqual([PV]);
    });
  });

  it("sectionItems: whole member prose blocks, and each table's rows shown under the section with their heading row once per run", () => {
    const [H, A, A2, F, P1, P2] = [R(920), R(921), R(922), R(923), B(93), B(94)];
    const blocks = [
      table(B(92), 2, [[H, "heading", "LABEL", "c"], [A, "content", "Alpha", "a"], [A2, "content", "", "a2"], [F, "content", "Foxtrot", "f"]]),
      { v: 1, id: P1, kind: "prose", doc: { type: "doc", content: [{ type: "paragraph" }] }, meta: {} } as unknown as BlockFile,
      { v: 1, id: P2, kind: "prose", doc: { type: "doc", content: [{ type: "paragraph" }] }, meta: {} } as unknown as BlockFile,
    ];
    const st = structureOf({ sections: [{ id: "s1", title: "S1" }, { id: "s2", title: "S2" }], members: { [A]: "s1", [F]: "s2", [P1]: "s2", [P2]: "s1" } });
    const t = deriveTopics(blocks, st);
    const ids = blocks.map((b) => b.id);
    expect(sectionItems(t, st, ids, "s1")).toEqual([{ block: B(92), rows: [H, A, A2] }, { block: P2, rows: null }]);
    expect(sectionItems(t, st, ids, "s2")).toEqual([{ block: B(92), rows: [H, F] }, { block: P1, rows: null }]);
    // The published system page uses the same items.
    const sys = file<SystemJson>("g/fm/s/cardiovascular.json");
    const cv = system(base, "fm", "cardiovascular");
    const ct = deriveTopics(cv.blocks, cv.structure);
    for (const sec of sys.sections) expect(sec.items).toEqual(sectionItems(ct, cv.structure, cv.blocks.map((b) => b.id), sec.id));
    expect(publishedRows(ct)).toEqual({ rows: sys.rows, headings: sys.headings });
  });

  it("publishedSections lists the structure's sections in order, each titled, with its sectionItems", () => {
    const [H, A, F, P1] = [R(920), R(921), R(923), B(93)];
    const blocks = [
      table(B(92), 2, [[H, "heading", "LABEL", "c"], [A, "content", "Alpha", "a"], [F, "content", "Foxtrot", "f"]]),
      { v: 1, id: P1, kind: "prose", doc: { type: "doc", content: [{ type: "paragraph" }] }, meta: {} } as unknown as BlockFile,
    ];
    const st = structureOf({ sections: [{ id: "s2", title: "Second" }, { id: "s1", title: "First" }, { id: "s3", title: "Empty" }], members: { [A]: "s1", [F]: "s2", [P1]: "s2" } });
    const t = deriveTopics(blocks, st);
    expect(publishedSections(t, st, blocks.map((b) => b.id))).toEqual([
      { id: "s2", title: "Second", items: [{ block: B(92), rows: [H, F] }, { block: P1, rows: null }] },
      { id: "s1", title: "First", items: [{ block: B(92), rows: [H, A] }] },
      { id: "s3", title: "Empty", items: [] },
    ]);
    expect(publishedSections(t, structureOf({ members: st.members }), blocks.map((b) => b.id))).toEqual([]);
    // The published system page is exactly this.
    const cv = system(base, "fm", "cardiovascular");
    const ct = deriveTopics(cv.blocks, cv.structure);
    const sections = file<SystemJson>("g/fm/s/cardiovascular.json").sections;
    expect(sections.length).toBeGreaterThan(0);
    expect(sections).toEqual(publishedSections(ct, cv.structure, cv.blocks.map((b) => b.id)));
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

describe("a topic's below block (her notes and pictures under the topic)", () => {
  const BELOW = topicBelowPath("fm", "cardiovascular", R(104));
  let belowBlock: BlockFile;
  const withBelow = (): Content => mutated((c) => system(c, "fm", "cardiovascular").below.set(R(104), belowBlock));

  // Written and read back through lib/content, as the build reads it.
  beforeAll(async () => {
    expect(system(base, "fm", "cardiovascular").below.size).toBe(0);
    await writeContent(root, BELOW, { v: 1, id: B(900), kind: "prose", doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "angina strip below" }] }] }, meta: {} });
    try {
      const loaded = system(await loadContent(root), "fm", "cardiovascular").below;
      expect([...loaded.keys()]).toEqual([R(104)]);
      belowBlock = loaded.get(R(104)) as BlockFile;
    } finally {
      await removeContent(root, BELOW);
    }
  });

  it("loads from below/<topic>.json beside the system's blocks", () => {
    expect(belowBlock.id).toBe(B(900));
    expect(belowBlock.kind).toBe("prose");
  });

  it("is published on its topic, and its text finds the topic in search", () => {
    const res = publish(withBelow());
    const sys = res.files.get(systemPath("fm", "cardiovascular")) as SystemJson;
    expect(sys.topics.find((t) => t.id === R(104))?.below).toEqual({ id: B(900), kind: "prose", doc: belowBlock.doc });
    expect(sys.topics.filter((t) => t.id !== R(104)).every((t) => t.below === null)).toBe(true);
    const unit = res.units.find((u) => u.at === R(104) && u.label === "notes");
    expect(unit?.text).toContain("angina strip below");
    expect(out.units.find((u) => u.at === R(104) && u.label === "notes")?.text).not.toContain("angina strip below");
  });

  it("shows under the table holding the topic's last row, and not under its other tables", () => {
    const sys = publish(withBelow()).files.get(systemPath("fm", "cardiovascular")) as SystemJson;
    const rows = sys.topics.find((t) => t.id === R(104))?.rows ?? [];
    expect(rows.at(-1)).toBe(R(130));
    expect(belowUnder(sys.topics, [R(130), R(131)]).map((b) => b.id)).toEqual([B(900)]);
    expect(belowUnder(sys.topics, [R(100), R(101), R(102), R(103), R(104)])).toEqual([]);
  });

  it("topicsBelow keeps topic order and needs both a below block and the last row shown", () => {
    const topics = [{ id: "a", rows: ["1", "2"] }, { id: "b", rows: ["3"] }, { id: "c", rows: ["4"] }, { id: "d", rows: [] }];
    const has = (t: { id: string }): boolean => t.id !== "c";
    expect(topicsBelow(topics, ["4", "3", "2"], has).map((t) => t.id)).toEqual(["a", "b"]);
    expect(topicsBelow(topics, ["1"], has)).toEqual([]);
  });
});

describe("her own meds panel for a topic (content MedsFile)", () => {
  // In the fixture, FM Stable angina R(104)'s panel is Nitrates C(2) (her rows and notes) then the
  // card-less Ranolazine row R(124); AF R(101) and Prinzmetal R(123) both show CCBs C(1).
  const CV = systemPath("fm", "cardiovascular");
  const para = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
  const mine = (text: string): MedsPiece => ({ kind: "notes", basePt: 9, title: null, file: "Cardio med list", doc: para(text) as unknown as MedsPiece["doc"] });
  const withMeds = (files: [string, MedsFile][]): Content => mutated((c) => {
    for (const [topic, f] of files) system(c, "fm", "cardiovascular").meds.set(topic, f);
  });
  const topicOf = (res: PublishResult, id: string) => {
    const t = (res.files.get(CV) as SystemJson).topics.find((x) => x.id === id);
    if (!t) throw new Error(`no topic ${id}`);
    return t;
  };
  /** What `res` reports dropped that the fixture's own publish does not. */
  const newDropped = (res: PublishResult) => res.dropped.filter((d) => !out.dropped.some((x) => x.file === d.file && x.id === d.id));
  let loaded: MedsFile;

  // Written and read back through lib/content, as the build reads it.
  beforeAll(async () => {
    const path = topicMedsPath("fm", "cardiovascular", R(104));
    expect(system(base, "fm", "cardiovascular").meds.size).toBe(0);
    await writeContent(root, path, { v: 1, add: [C(3)], remove: [R(124)], own: [{ target: C(2), pieces: [mine("my nitrates under stable angina")] }] });
    try {
      loaded = system(await loadContent(root), "fm", "cardiovascular").meds.get(R(104)) as MedsFile;
    } finally {
      await removeContent(root, path);
    }
  });

  it("the derived panel is as the fixture says (the cases below rely on it)", () => {
    expect(topicOf(out, R(104)).meds.map((m) => m.target)).toEqual([C(2), R(124)]);
    expect(topicOf(out, R(101)).meds.map((m) => m.target)).toEqual([C(1)]);
    expect(topicOf(out, R(123)).meds.map((m) => m.target)).toEqual([C(1)]);
    expect((out.files.get(CV) as SystemJson).topics.every((t) => t.medsEdit === null)).toBe(true);
  });

  it("loads from meds/<topic>.json beside the system's blocks", () => {
    expect(loaded).toMatchObject({ v: 1, add: [C(3)], remove: [R(124)] });
    expect(loaded.own.map((o) => o.target)).toEqual([C(2)]);
  });

  it("publishes on its topic only: the derived panel is kept, and the panel shows hers (removed off, added after, her version)", () => {
    const res = publish(withMeds([[R(104), loaded]]));
    const angina = topicOf(res, R(104));
    expect(angina.meds).toEqual(topicOf(out, R(104)).meds);
    expect(angina.medsEdit?.remove).toEqual([R(124)]);
    expect(angina.medsEdit?.add).toEqual([expect.objectContaining({ card: C(3), target: C(3), rows: [] })]);
    expect(Object.keys(angina.medsEdit?.own ?? {})).toEqual([C(2)]);
    expect(panelEntries(angina).map((e) => [e.med.target, e.own === null ? null : docText(e.own[0]?.doc ?? { type: "doc", content: [] })])).toEqual([
      [C(2), "my nitrates under stable angina"],
      [C(3), null],
    ]);
    expect((res.files.get(CV) as SystemJson).topics.filter((t) => t.id !== R(104)).every((t) => t.medsEdit === null)).toBe(true);
    // The card she added has its notes on the page.
    expect((res.files.get(CV) as SystemJson).cards[C(3)]).toBeDefined();
    expect(res.dropped).toEqual(out.dropped);
  });

  it("her version is found by search on its condition's page, and nothing of hers is left uncovered", () => {
    const res = publish(withMeds([[R(104), loaded]]));
    const hosts = res.files.get(HOSTS_PATH) as HostsJson;
    const unit = res.units.find((u) => u.at === `meds-${C(2)}`);
    expect(unit).toMatchObject({ title: "Nitrates", route: hosts[R(104)]?.route, label: "notes" });
    expect(unit?.text).toContain("my nitrates under stable angina");
    const content = withMeds([[R(104), loaded]]);
    expect(uncoveredText(content, res.units, res.files)).toEqual(uncoveredText(base, out.units, out.files));
    const without = res.units.filter((u) => u !== unit);
    expect(uncoveredText(content, without, res.files).map((u) => u.text)).toContain("my nitrates under stable angina");
  });

  it("a version of an entry she also removed, or of an entry the panel no longer has, is not shown; one of a card shows it as added", () => {
    const content = withMeds([[R(104), {
      v: 1, add: [], remove: [C(2)],
      own: [{ target: C(2), pieces: [mine("removed")] }, { target: C(1), pieces: [mine("ccb under angina")] }, { target: R(999), pieces: [mine("gone row")] }],
    }]]);
    const res = publish(content);
    const e = topicOf(res, R(104)).medsEdit;
    expect(e?.add.map((m) => m.target)).toEqual([C(1)]);
    expect(Object.keys(e?.own ?? {})).toEqual([C(1)]);
    expect(panelEntries(topicOf(res, R(104))).map((x) => x.med.target)).toEqual([R(124), C(1)]);
    expect(newDropped(res)).toEqual([{ file: topicMedsPath("fm", "cardiovascular", R(104)), id: R(999) }]);
    // Coverage checks only what the panel shows: the versions left out are not reported as unsearchable.
    expect(uncoveredText(content, res.units, res.files)).toEqual(uncoveredText(base, out.units, out.files));
    const shown = res.units.filter((u) => u.at !== `meds-${C(1)}`);
    expect(uncoveredText(content, shown, res.files).map((u) => u.text)).toEqual([...uncoveredText(base, out.units, out.files).map((u) => u.text), "ccb under angina"]);
  });

  it("reports what names nothing to dropped: a removed target the panel lacks, an unknown card, a file for no topic", () => {
    const res = publish(withMeds([
      [R(104), { v: 1, add: [C(99)], remove: [R(998)], own: [] }],
      [R(997), { v: 1, add: [C(3)], remove: [], own: [] }],
    ]));
    const where = (t: string) => topicMedsPath("fm", "cardiovascular", t);
    expect(newDropped(res)).toEqual([
      { file: where(R(104)), id: C(99) },
      { file: where(R(104)), id: R(998) },
      { file: where(R(997)), id: R(997) },
    ]);
    expect(topicOf(res, R(104)).medsEdit).toEqual({ remove: [R(998)], add: [], own: {} });
  });

  it("an edit to the card's pharm notes changes the condition she has no version for, and not her version", () => {
    const ccb = (out.files.get(CV) as SystemJson).cards[C(1)];
    const block = ccb?.blocks[0];
    if (!block) throw new Error("no CCB notes block");
    const content = withMeds([[R(101), { v: 1, add: [], remove: [], own: [{ target: C(1), pieces: [mine("my CCB notes for AF")] }] }]]);
    const notes = content.pharm.flatMap((p) => p.blocks).find((b) => b.id === block);
    if (!notes) throw new Error("no CCB notes block in content");
    const first = (n: { text?: string; content?: unknown[] }): { text?: string } | null =>
      typeof n.text === "string" ? n : (n.content ?? []).reduce<{ text?: string } | null>((f, c) => f ?? first(c as { content?: unknown[] }), null);
    const leaf = first(notes.doc as { content?: unknown[] });
    if (!leaf) throw new Error("no text in the CCB notes");
    leaf.text = `${leaf.text ?? ""} PHARMEDIT`;
    const sys = publish(content).files.get(CV) as SystemJson;
    const text = (topic: string) => {
      const t = sys.topics.find((x) => x.id === topic);
      const e = t ? panelEntries(t).find((x) => x.med.target === C(1)) : undefined;
      if (!t || !e) throw new Error(`no CCB entry on ${topic}`);
      return shownPieces(sys, t, e, 10).map((p) => docText(p.doc)).join("\n");
    };
    expect(text(R(123))).toContain("PHARMEDIT");
    expect(text(R(101))).toBe("my CCB notes for AF");
  });

  it("entryPieces is what the published panel shows of a card: her guide rows at the guide's size, then her notes at her file's", () => {
    const sys = out.files.get(CV) as SystemJson;
    const angina = topicOf(out, R(104));
    const [nitrates, ranolazine] = angina.meds;
    if (!nitrates || !ranolazine) throw new Error("no entries");
    const pieces = entryPieces(sys, angina, nitrates, 10);
    expect(pieces.map((p) => [p.kind, p.basePt, p.file])).toEqual([["rows", 10, null], ...pieces.slice(1).map((p) => ["notes", sys.cards[C(2)]?.basePt, p.file])]);
    expect(pieces.length).toBeGreaterThan(1);
    expect(entryPieces(sys, angina, ranolazine, 10).map((p) => p.kind)).toEqual(["rows"]);
    expect(shownPieces(sys, angina, { med: nitrates, own: null }, 10)).toEqual(pieces);
  });

  it("publishedEdit: a card already on the panel is not added twice, nor one she removed", () => {
    const derived = topicOf(out, R(104)).meds;
    const missing: string[] = [];
    const card = (id: string) => (id === C(9) ? { card: id, title: "Nine", rows: [], section: "x", system: "cardiovascular", target: id } : null);
    const e = publishedEdit({ v: 1, add: [C(2), C(9), C(9), C(8)], remove: [C(8)], own: [] }, derived, card, (t) => missing.push(t));
    expect(e.add.map((m) => m.target)).toEqual([C(9)]);
    expect(missing).toEqual([C(8)]);
  });

  it("pageCard: a card added on another panel of the page, else from its Pharm section, else from a panel entry, else none", () => {
    const sys = out.files.get(CV) as SystemJson;
    expect(pageCard(sys, C(99))).toBeNull();
    const fromSection = pageCard(sys, C(1));
    expect(fromSection).toMatchObject({ card: C(1), target: C(1), rows: [], system: "cardiovascular" });
    expect(sys.pharm?.sections.some((s) => s.id === fromSection?.section && s.cards.includes(C(1)))).toBe(true);
    const noSection = { ...sys, pharm: null };
    expect(pageCard(noSection, C(2))).toMatchObject({ card: C(2), section: nitrateSection(sys) });
    const added = { card: C(3), title: "Added", rows: [], section: "elsewhere", system: "pulmonary", target: C(3) };
    const withAdded = { ...sys, topics: sys.topics.map((t) => (t.id === R(101) ? { ...t, medsEdit: { remove: [], add: [added], own: {} } } : t)) };
    expect(pageCard(withAdded, C(3))).toBe(added);
  });
  const nitrateSection = (sys: SystemJson): string | undefined => {
    const m = sys.topics.flatMap((t) => t.meds).find((x) => x.card === C(2));
    return m && m.part === undefined ? m.section : undefined;
  };
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

  it("a run listed as one entry: its blocks are hosted on the listed block's page, and a recorded table's rows are searched by their own names to that page", () => {
    const c = mutated((x) => {
      const pu = system(x, "fm", "pulmonary");
      const doc = schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Nuchal Translucency" }] }] }).toJSON();
      const head = { v: 1, id: B(21), kind: "prose", doc, meta: {} } as unknown as BlockFile;
      const quad = table(B(22), 2, [[R(220), "heading", "QUAD SCREEN", "AFP"], [R(221), "content", "Trisomy 21", "low AFP"]]);
      quad.doc = schema.nodeFromJSON(quad.doc).toJSON() as BlockFile["doc"];
      pu.blocks.push(head, quad);
      pu.file.blocks.push(B(21), B(22));
      pu.structure.listed[B(21)] = "Trimester screening";
      pu.structure.members[B(22)] = B(21);
    });
    const res = publish(c);
    const route = guideViewHash("fm", { kind: "block", id: B(21) });
    const nav = res.files.get(navPath("fm")) as NavJson;
    expect(nav.systems.find((s) => s.id === "pulmonary")?.entries).toEqual([
      { kind: "topic", id: R(201), title: "Asthma" },
      { kind: "block", id: B(21), title: "Trimester screening", blocks: [B(21), B(22)] },
    ]);
    // A listed block with no run keeps its entry as it was, with no `blocks`.
    const other = nav.systems.find((s) => s.id === "cardiovascular")?.sections.find((s) => s.id === "other");
    expect(other?.entries.find((e) => e.id === B(11))).toEqual({ kind: "block", id: B(11), title: "Murmurs" });
    const page = res.files.get(systemPath("fm", "pulmonary")) as SystemJson;
    expect(page.topics.map((t) => t.title)).toEqual(["Asthma"]);
    const hosts = res.files.get(HOSTS_PATH) as HostsJson;
    expect(hosts[B(21)]?.route).toBe(route);
    expect(hosts[B(22)]?.route).toBe(route);
    expect(res.units.find((u) => u.at === B(21))).toMatchObject({ title: "Trimester screening", route });
    // The recorded table forms no topics, but each row stays a unit under its own name, at that row.
    expect(res.units.some((u) => u.at === B(22))).toBe(false);
    expect(res.units.filter((u) => u.at === R(220) || u.at === R(221)).map((u) => ({ title: u.title, route: u.route, at: u.at, text: u.text }))).toEqual([
      { title: "QUAD SCREEN", route, at: R(220), text: "QUAD SCREEN AFP" },
      { title: "Trisomy 21", route, at: R(221), text: "Trisomy 21 low AFP" },
    ]);
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
    const s = { guide: "fm", system: "x", structure: st, topics: t, partFiles: new Map() };
    const tremor = t.topics.find((x) => x.id === R(910));
    if (!tremor) throw new Error("no topic");
    // No heading row labels a treatment column, so all of the topic's text is searched.
    const panel = medsPanel(s, [B(92), B(91)], tremor, new CardMatcher([]), (c) => c, new Set(["x"]), () => null, () => new Set());
    expect(panel).toEqual([{ card: null, title: "Beta-blocker (non-selective)", rows: [R(920)], section: "x", system: "x", target: R(920) }]);
  });

  it("a meds panel card keeps only its rows from pharm sections that treat the condition's section, if it has any", () => {
    // FM Cardiovascular: her BB rows sit in the Hypertension and the Antiarrhythmics tables; a hypertension panel shows the first only.
    const blocks = [
      table(B(91), 2, [[R(910), "content", "Hypertension", "beta blockers"]]),
      table(B(92), 2, [[R(920), "content", "Beta blockers", "metoprolol"]]),
      table(B(93), 2, [[R(930), "content", "Beta blockers", "class II"]]),
    ];
    const st = structureOf({
      drugTables: [
        { block: B(92), pharmSection: "hypertension", conditionRows: [] },
        { block: B(93), pharmSection: "antiarrhythmics", conditionRows: [] },
      ],
    });
    const t = deriveTopics(blocks, st);
    const s = { guide: "fm", system: "cardiovascular", structure: st, topics: t, partFiles: new Map() };
    const htn = t.topics.find((x) => x.id === R(910));
    if (!htn) throw new Error("no topic");
    const cards = new CardMatcher([{ id: C(1), file: "f", aliases: ["beta blockers"], home: {} }]);
    const rows = (relevant: string[]) => medsPanel(s, [B(91), B(92), B(93)], htn, cards, (c) => c, new Set(relevant), () => null, () => new Set()).map((m) => [m.card, m.rows]);
    expect(rows(["hypertension"])).toEqual([[C(1), [R(920)]]]);
    expect(rows(["hypertension", "antiarrhythmics"])).toEqual([[C(1), [R(920), R(930)]]]);
    expect(rows(["antiarrhythmics"])).toEqual([[C(1), [R(930)]]]);
    // A card her text names with no row in a treating section keeps all its rows rather than vanishing.
    expect(rows([])).toEqual([[C(1), [R(920), R(930)]]]);
    expect(rows(["heart-failure"])).toEqual([[C(1), [R(920), R(930)]]]);
  });

  describe("a meds panel offers only drugs named in the condition's treatment column", () => {
    // EM Cardiovascular as imported: infective endocarditis sits in the block just before the antiarrhythmics table.
    const drugs = table(B(92), 2, [
      [R(920), "content", "Amiodarone", "class III"],
      [R(921), "content", "Beta blockers", "class II"],
      [R(922), "content", "Adenosine", "AV nodal"],
    ]);
    const panelFor = (conditions: ReturnType<typeof table>, id: string) => {
      const st = structureOf({ drugTables: [{ block: B(92), pharmSection: "antiarrhythmics", conditionRows: [] }] });
      const t = deriveTopics([conditions, drugs], st);
      const topic = t.topics.find((x) => x.id === id);
      if (!topic) throw new Error(`no topic ${id}`);
      return medsPanel({ guide: "em", system: "cardiovascular", structure: st, topics: t, partFiles: new Map() }, [B(91), B(92)], topic, new CardMatcher([]), (c) => c, new Set(["antiarrhythmics"]), () => null, () => new Set()).map((m) => m.title);
    };
    const cardio = table(B(91), 3, [
      [R(910), "heading", "CARDIO", "Etiology", "Management"],
      [R(911), "content", "Infective endocarditis", "staph aureus", "vancomycin + ceftriaxone"],
      [R(912), "content", "AV block", "beta blockers, CCBs", "pacing"],
      [R(913), "content", "Atrial fibrillation", "", "rate control; amiodarone for rhythm"],
    ]);

    it("a drug table following the condition contributes nothing it does not name", () => {
      expect(panelFor(cardio, R(911))).toEqual([]);
    });

    it("a drug named only as a cause is not offered; one named in Management is", () => {
      expect(panelFor(cardio, R(912))).toEqual([]);
      expect(panelFor(cardio, R(913))).toEqual(["Amiodarone"]);
    });

    it("a column under a Management heading cell that spans it counts as treatment", () => {
      const spanned = table(B(91), 4, [
        [R(910), "heading", "ARRHYTHMIAS", "About", "Management", ""],
        [R(911), "content", "SVT", "beta blockers can cause it", "vagal maneuvers", "adenosine"],
      ]);
      expect(panelFor(spanned, R(911))).toEqual(["Adenosine"]);
    });
  });

  it("a drug row matching several cards files under the cards the treatment text names, not every card it matches", () => {
    // FM Orthopedics as imported: her gout table's "NSAIDs: Naproxen Indomethacin" row also matches the
    // naproxen (Propionic Acid) and indomethacin (Acetic acid) cards; rotator cuff says only "NSAIDs".
    const cards = new CardMatcher([
      { id: C(7), file: "f", aliases: ["NSAIDs", "NSAID"], home: {} },
      { id: C(8), file: "f", aliases: ["naproxen", "ibuprofen"], home: {} },
      { id: C(9), file: "f", aliases: ["indomethacin"], home: {} },
    ]);
    const blocks = [
      table(B(91), 3, [
        [R(910), "heading", "SHOULDER", "About", "Management"],
        [R(911), "content", "Rotator cuff injuries", "supraspinatus", "Tear: conservative (e.g., PT, NSAIDs, steroid injections) vs surgery"],
        [R(912), "content", "Gout flare", "MSU crystals", "naproxen or colchicine"],
      ]),
      table(B(92), 2, [[R(920), "content", "NSAIDs: Naproxen Indomethacin", "first-line"]]),
    ];
    const st = structureOf({ drugTables: [{ block: B(92), pharmSection: "gout", conditionRows: [] }] });
    const t = deriveTopics(blocks, st);
    const s = { guide: "fm", system: "orthopedics-rheumatology", structure: st, topics: t, partFiles: new Map() };
    const panel = (id: string) => {
      const topic = t.topics.find((x) => x.id === id);
      if (!topic) throw new Error(`no topic ${id}`);
      return medsPanel(s, [B(91), B(92)], topic, cards, (c) => c, new Set(["gout"]), () => null, () => new Set()).map((m) => [m.card, m.rows]);
    };
    expect(panel(R(911))).toEqual([[C(7), [R(920)]]]);
    expect(panel(R(912))).toEqual([[C(8), [R(920)]]]);
  });

  describe("her word for a drug class in the treatment text names every card of that class", () => {
    // EM Cardiovascular as imported: Myocarditis "TX: diuretics, vasodilators (e.g., nitrates) ... inotropes";
    // her HF table lists each diuretic class, and dobutamine and milrinone together as positive inotropes.
    const loop = { id: C(1), file: "cardio", aliases: ["Loop Diuretics", "furosemide"], home: {}, classWords: ["diuretics", "diuretic"] };
    const kSparing = { id: C(2), file: "cardio", aliases: ["Potassium Sparing Diuretics", "spironolactone"], home: {}, classWords: ["diuretics", "diuretic"] };
    const dobutamine = { id: C(3), file: "cardio", aliases: ["dobutamine"], home: {}, classWords: ["inotropes", "inotropic support"] };
    const milrinone = { id: C(4), file: "cardio", aliases: ["milrinone"], home: {}, classWords: ["inotropes", "inotropic support"] };
    const cards = new CardMatcher([loop, kSparing, dobutamine, milrinone]);
    const drugs = table(B(92), 2, [
      [R(921), "content", "K-Sparing Diuretics: Spironolactone, eplerenone", "MOA"],
      [R(922), "content", "Loop Diuretics: furosemide, bumetanide", "MOA"],
      [R(923), "content", "Positive Inotropes in ADHF: Dobutamine, milrinone", "MOA"],
    ]);
    const st = structureOf({ drugTables: [{ block: B(92), pharmSection: "heart-failure", conditionRows: [] }] });
    const panelFor = (management: string) => {
      const conditions = table(B(91), 2, [[R(910), "heading", "CARDIO", "Management"], [R(911), "content", "Myocarditis", management]]);
      const t = deriveTopics([conditions, drugs], st);
      const topic = t.topics.find((x) => x.id === R(911));
      if (!topic) throw new Error("no topic");
      return medsPanel({ guide: "em", system: "cardiovascular", structure: st, topics: t, partFiles: new Map() }, [B(91), B(92)], topic, cards, (c) => c, new Set(), () => null, () => new Set()).map((m) => [m.card, m.rows]);
    };

    it("each card of the class shows with its own rows", () => {
      expect(panelFor("supportive: diuretics, inotropes")).toEqual([[C(2), [R(921)]], [C(1), [R(922)]], [C(3), [R(923)]], [C(4), [R(923)]]]);
      expect(panelFor("diuretics")).toEqual([[C(2), [R(921)]], [C(1), [R(922)]]]);
    });

    it("a class word never files a drug row under another card of the class", () => {
      // "K-Sparing Diuretics" names the potassium-sparing card only, not every card whose class word is "diuretics".
      const row = tableOf(drugs)?.rows.find((r) => r.id === R(921));
      if (!row) throw new Error("no row");
      expect(rowCards(cards, deriveTopics([drugs], st), row, "heart-failure")).toEqual([C(2)]);
    });

    it("a class word inside a card's own name names only that card", () => {
      // FM Hypertension: "thiazide diuretic"; Hyponatremia: "fluid restriction +/- loop diuretics".
      expect(panelFor("fluid restriction +/- loop diuretics")).toEqual([[C(1), [R(922)]]]);
    });

    it("a class word under her negative sign, or in an item that says to avoid it, names nothing", () => {
      expect(panelFor("avoid vasodilators/⊖inotropes")).toEqual([]);
      expect(panelFor("( − ) inotropes")).toEqual([]);
      expect(panelFor("use Negative  inotropes")).toEqual([]);
      expect(panelFor("▪︎AVOID dobutamine, diuretics, ACEI/ARBs")).toEqual([]);
      expect(panelFor("hold diuretics")).toEqual([]);
      expect(panelFor("diuretics CI in anuria")).toEqual([[C(2), [R(921)]], [C(1), [R(922)]]]);
    });

    it("a class word her item calls contraindicated after it names nothing, until the item ends", () => {
      // FM Orthopedics, Patellar tendinitis: "steroid injection contraindicated (risk of tendon rupture)".
      expect(panelFor("diuretics contraindicated in anuria")).toEqual([]);
      expect(panelFor("inotropic support, diuretics are contraindicated")).toEqual([[C(3), [R(923)]], [C(4), [R(923)]]]);
      expect(panelFor("diuretics; inotropes contraindicated")).toEqual([[C(2), [R(921)]], [C(1), [R(922)]]]);
      expect(panelFor("diuretics\nNSAIDs contraindicated")).toEqual([[C(2), [R(921)]], [C(1), [R(922)]]]);
    });

    it("an avoid ends with its item: a new line, a bullet or a semicolon", () => {
      const both = [[C(2), [R(921)]], [C(1), [R(922)]], [C(3), [R(923)]], [C(4), [R(923)]]];
      expect(panelFor("isotonic fluids (AVOID a large amount!)\nInotropic support; diuretics")).toEqual(both);
      expect(panelFor("not transplant candidates ▪︎inotropic support • diuretics")).toEqual(both);
    });

    it("an avoid reaches through her list of drugs, up to an element naming none, an arrow, a later colon or its closing parenthesis", () => {
      const k = [[C(2), [R(921)]], [C(1), [R(922)]]];
      // EM Cardiovascular, HOCM: "AVOID nitrates, diuretics, ACEI/ARBs"; Vasospastic angina: "AVOID: nonselective beta blockers".
      expect(panelFor("AVOID dobutamine, diuretics")).toEqual([]);
      expect(panelFor("AVOID: diuretics")).toEqual([]);
      // EM Orthopedics, Stress fracture: "avoid high-impact activities, splint, post-op shoe, ibuprofen/acetaminophen".
      expect(panelFor("avoid high-impact activities, splint, diuretics")).toEqual(k);
      expect(panelFor("not transplant candidates, inotropic support")).toEqual([[C(3), [R(923)]], [C(4), [R(923)]]]);
      // Herniated disk "(avoid bed rest), NSAIDs"; Ulnar nerve "(e.g., avoid prolonged resting on elbow & repeated flexion), nighttime bracing, NSAIDs".
      expect(panelFor("(avoid bed rest), diuretics")).toEqual(k);
      expect(panelFor("behavior modification (e.g., avoid resting on elbow), bracing, diuretics")).toEqual(k);
      // Reactive arthritis: "if no response ⇢ sulfasalazine, MTX", "No response to NSAIDs: sulfasalazine, methotrexate"; Bronchiectasis "if CI 🡪 methotrexate".
      expect(panelFor("if no response ⇢ diuretics")).toEqual(k);
      expect(panelFor("if CI 🡪 diuretics")).toEqual(k);
      expect(panelFor("No response to dobutamine: diuretics")).toEqual(k);
      // ACS: "*AVOID in inferior, PDE-5 inhibitor in last 24h" — a when, not a what, keeps the avoid going.
      expect(panelFor("*AVOID in inferior, diuretics in last 24h")).toEqual([]);
    });

    it("an avoid word paired with her label by a slash labels the case for the drugs after it", () => {
      // EM Endocrinology, DM II: "•intolerance/CI: GLP-1 receptor agonists, SGLT2 inhibitors"; EM Cardio, Myocarditis: "DC/avoid cardiotoxic drugs (e.g., NSAIDs)".
      expect(panelFor("intolerance/CI: diuretics")).toEqual([[C(2), [R(921)]], [C(1), [R(922)]]]);
      expect(panelFor("DC/avoid cardiotoxic drugs (e.g., diuretics)")).toEqual([]);
    });

    it("contraindicated rules out only the drug of its own clause", () => {
      // IM Cardiovascular, Stable angina: "CCBs: indicated if beta blockers are contraindicated".
      expect(panelFor("dobutamine: indicated if diuretics are contraindicated")).toEqual([[C(3), [R(923)]]]);
    });

    it("a class word heading her list names nothing; the list's items name their own cards", () => {
      // FM Insomnia "Antidepressants: off-label use…"; Surgery N/V "Antiemetics ⏎•scopolamine patch", "Rescue antiemetics – if N/V occur in the PACU… ⏎•prochlorperazine".
      expect(panelFor("Inotropic support:\n•dobutamine, epinephrine")).toEqual([[C(3), [R(923)]]]);
      expect(panelFor("Inotropes \n•dobutamine")).toEqual([[C(3), [R(923)]]]);
      expect(panelFor("Rescue inotropes – if refractory, use another class\n•milrinone")).toEqual([[C(4), [R(923)]]]);
      // Her dash gloss on that line is its heading too: "…we administer an antiemetic from a different class".
      expect(panelFor("Rescue inotropes – if refractory, give inotropes of another class\n•milrinone")).toEqual([[C(4), [R(923)]]]);
      expect(panelFor("Rescue milrinone – if refractory, give inotropes of another class")).toEqual([[C(3), [R(923)]], [C(4), [R(923)]]]);
      expect(panelFor("•inotropes\n•furosemide")).toEqual([[C(1), [R(922)]], [C(3), [R(923)]], [C(4), [R(923)]]]);
      // Peds HIT: "non-heparin anticoagulants ⏎- direct thrombin inhibitors" — a dashed list heads the same way.
      expect(panelFor("non-heparin inotropes\n- dobutamine")).toEqual([[C(3), [R(923)]]]);
      expect(panelFor("inotropes - dobutamine preferred")).toEqual([[C(3), [R(923)]], [C(4), [R(923)]]]);
    });

    it("a drug word her point has twice, once followed by not, sets a condition", () => {
      // IM Cardiovascular, Hypertensive emergency: "Lower BP ≤185/110 before thrombolytic therapy started ⏎ – If thrombolytic therapy not planned, only ↓ BP if >220/120".
      expect(panelFor("•Labetalol\n  – Lower BP before inotropic support started\n  – If inotropic support not planned, only ↓ BP if >220/120")).toEqual([]);
      // Anorexia nervosa: "SSRIs have not been effective, but may be used for comorbid anxiety or depression".
      expect(panelFor("dobutamine has not been effective, but may be used")).toEqual([[C(3), [R(923)]]]);
      // Hypertension: "ACEI ⇣ mortality (ARB if not tolerated)".
      expect(panelFor("furosemide (dobutamine if not tolerated)")).toEqual([[C(1), [R(922)]], [C(3), [R(923)]]]);
    });

    it("a card's own name follows the same rules as a class word", () => {
      expect(panelFor("furosemide")).toEqual([[C(1), [R(922)]]]);
      expect(panelFor("AVOID furosemide")).toEqual([]);
      expect(panelFor("furosemide contraindicated")).toEqual([]);
      expect(panelFor("⊖dobutamine")).toEqual([]);
      // A row's own name in her text follows them too: "Loop Diuretics" is the row's first cell.
      const byRowName = (management: string) => {
        const t = deriveTopics([table(B(91), 2, [[R(910), "heading", "CARDIO", "Management"], [R(911), "content", "Myocarditis", management]]), drugs], st);
        const topic = t.topics.find((x) => x.id === R(911));
        if (!topic) throw new Error("no topic");
        return medsPanel({ guide: "em", system: "cardiovascular", structure: st, topics: t, partFiles: new Map() }, [B(91), B(92)], topic, new CardMatcher([]), (c) => c, new Set(), () => null, () => new Set()).map((m) => m.rows);
      };
      expect(byRowName("Loop Diuretics: furosemide, bumetanide")).toEqual([[R(922)]]);
      expect(byRowName("avoid Loop Diuretics: furosemide, bumetanide")).toEqual([]);
    });

    it("the losing side of her comparison names nothing", () => {
      // FM Cardiovascular, DVT: "AC w/ DOAC recommended over ASA"; "Proximal DVT ⇢ AC alone > thrombolytic + AC".
      expect(panelFor("dobutamine recommended over diuretics")).toEqual([[C(3), [R(923)]]]);
      expect(panelFor("inotropes alone > diuretics + inotropes")).toEqual([[C(3), [R(923)]], [C(4), [R(923)]]]);
      expect(panelFor("diuretics over 3 days")).toEqual([[C(2), [R(921)]], [C(1), [R(922)]]]);
      // FM APS: "Warfarin preferred vs DOACs".
      expect(panelFor("dobutamine preferred vs diuretics")).toEqual([[C(3), [R(923)]]]);
    });

    it("a drug word her item also carries under ⊘ sets a condition, not a treatment", () => {
      // FM Cardiovascular, Hypertensive crises: "⇣ BP only if ≥185/110 (thrombolytic therapy) or ≥220/120 (⊘thrombolytic therapy)".
      expect(panelFor("⇣ BP only if ≥185/110 (inotropic support) or ≥220/120 (⊘inotropic support) » diuretics")).toEqual([[C(2), [R(921)]], [C(1), [R(922)]]]);
      expect(panelFor("diuretics, ⊘dobutamine")).toEqual([[C(2), [R(921)]], [C(1), [R(922)]]]);
    });
  });

  describe("a card her treatment text names with no row in the system", () => {
    // EM Pulmonary, Pulmonary embolism: "LMWH, fondaparinux, DOACs" — her DOAC rows are in EM Cardiovascular.
    const xa = { id: C(1), file: "anticoag", aliases: ["Factor Xa Inhibitors", "apixaban"], home: {}, classWords: ["DOACs"] };
    const heparin = { id: C(2), file: "anticoag", aliases: ["Heparin", "fondaparinux"], home: {} };
    const cards = new CardMatcher([xa, heparin]);
    const drugs = table(B(92), 2, [[R(921), "content", "Heparin: LMWH, fondaparinux", "MOA"]]);
    const st = structureOf({ drugTables: [{ block: B(92), pharmSection: "anticoagulants", conditionRows: [] }] });
    const panelFor = (management: string, home: (card: string) => { system: string | null; section: string } | null) => {
      const t = deriveTopics([table(B(91), 2, [[R(910), "heading", "PULM", "Management"], [R(911), "content", "Pulmonary embolism", management]]), drugs], st);
      const topic = t.topics.find((x) => x.id === R(911));
      if (!topic) throw new Error("no topic");
      return medsPanel({ guide: "em", system: "pulmonary", structure: st, topics: t, partFiles: new Map() }, [B(91), B(92)], topic, cards, (c) => `title ${c}`, new Set(), home, () => new Set());
    };

    it("follows the cards with rows, with the pharm section her pharm places it in", () => {
      const asked: string[] = [];
      const home = (card: string) => {
        asked.push(card);
        return { system: "cardiovascular", section: "anticoagulants" };
      };
      expect(panelFor("LMWH, fondaparinux, DOACs", home)).toEqual([
        { card: C(2), title: `title ${C(2)}`, rows: [R(921)], section: "anticoagulants", system: "pulmonary", target: C(2) },
        { card: C(1), title: `title ${C(1)}`, rows: [], section: "anticoagulants", system: "cardiovascular", target: C(1) },
      ]);
      // The card with rows is asked too, for the section it links to; its rows are not in that section.
      expect(asked).toEqual([C(2), C(1)]);
    });

    it("keeps another guide's pharm section, without a system to link to", () => {
      expect(panelFor("DOACs", () => ({ system: null, section: "anticoagulants" }))).toEqual([
        { card: C(1), title: `title ${C(1)}`, rows: [], section: "anticoagulants", system: null, target: C(1) },
      ]);
    });

    it("is left out when her text rules it out, or no pharm section places it", () => {
      const home = () => ({ system: "cardiovascular", section: "anticoagulants" });
      expect(panelFor("avoid DOACs", home)).toEqual([]);
      expect(panelFor("DOACs", () => null)).toEqual([]);
    });

    it("is left out of a condition its card was not written for (`diseases`)", () => {
      const panel = (diseases: string[], management = "DOACs") => {
        const scoped = new CardMatcher([{ ...xa, diseases }, heparin]);
        const t = deriveTopics([table(B(91), 2, [[R(910), "heading", "PULM", "Management"], [R(911), "content", "Pulmonary embolism", management]]), drugs], st);
        const topic = t.topics.find((x) => x.id === R(911));
        if (!topic) throw new Error("no topic");
        const home = () => ({ system: "cardiovascular", section: "anticoagulants" });
        return medsPanel({ guide: "em", system: "pulmonary", structure: st, topics: t, partFiles: new Map() }, [B(91), B(92)], topic, scoped, (c) => c, new Set(), home, () => new Set()).map((m) => m.card);
      };
      expect(panel(["deep vein thrombosis"])).toEqual([]);
      expect(panel(["pulmonary embolism"])).toEqual([C(1)]);
      // Her item naming the card names one of its diseases.
      expect(panel(["deep vein thrombosis"], "Deep vein thrombosis: DOACs")).toEqual([C(1)]);
      expect(panel(["deep vein thrombosis"], "Deep vein thrombosis: LMWH\nDOACs")).toEqual([]);
    });

    it("is left out of a topic without a Treatment column, whose notes name causes too", () => {
      // PSY Psychosis has no Treatment column; "cocaine" there is a cause, not her local anesthetic card.
      const t = deriveTopics([table(B(91), 2, [[R(910), "heading", "PULM", "Etiology"], [R(911), "content", "Pulmonary embolism", "DOACs"]]), drugs], st);
      const topic = t.topics.find((x) => x.id === R(911));
      if (!topic) throw new Error("no topic");
      const home = () => ({ system: "cardiovascular", section: "anticoagulants" });
      expect(medsPanel({ guide: "em", system: "pulmonary", structure: st, topics: t, partFiles: new Map() }, [B(91), B(92)], topic, cards, (c) => c, new Set(), home, () => new Set())).toEqual([]);
    });

    it("shows on a topic without a Treatment column when written for the condition its title names", () => {
      // EM GI «Nausea/Vomiting» has no Treatment column; her antiemetic steroid card is written for N/V.
      const scoped = new CardMatcher([{ ...xa, diseases: ["pulmonary embolism"] }, heparin]);
      const t = deriveTopics([table(B(91), 2, [[R(910), "heading", "PULM", "Etiology"], [R(911), "content", "Pulmonary embolism", "DOACs"]]), drugs], st);
      const topic = t.topics.find((x) => x.id === R(911));
      if (!topic) throw new Error("no topic");
      const home = () => ({ system: "cardiovascular", section: "anticoagulants" });
      expect(medsPanel({ guide: "em", system: "pulmonary", structure: st, topics: t, partFiles: new Map() }, [B(91), B(92)], topic, scoped, (c) => c, new Set(), home, () => new Set()).map((m) => m.card)).toEqual([C(1)]);
    });

    describe("her \"TX:\" lead-in on a topic without a Treatment column", () => {
      // PANCE GI ETEC sits under an unlabelled "Bacteria" heading row: "TX: ciprofloxacin or azithromycin".
      const topicOf = (cells: string[]) => {
        const t = deriveTopics([table(B(91), cells.length + 1, [[R(910), "heading", "PULM", ...cells.map(() => "")], [R(911), "content", "Pulmonary embolism", ...cells]]), drugs], st);
        const topic = t.topics.find((x) => x.id === R(911));
        if (!topic) throw new Error("no topic");
        return { t, topic };
      };
      const column = (...cells: string[]) => {
        const { t, topic } = topicOf(cells);
        return treatmentColumn(t, topic);
      };
      const panel = (...cells: string[]) => {
        const { t, topic } = topicOf(cells);
        const home = () => ({ system: "cardiovascular", section: "anticoagulants" });
        return medsPanel({ guide: "em", system: "pulmonary", structure: st, topics: t, partFiles: new Map() }, [B(91), B(92)], topic, cards, (c) => c, new Set(), home, () => new Set()).map((m) => m.card);
      };

      it("is her treatment text, so the cards it names show", () => {
        expect(column("RFs: travel\nTX: DOACs\nor LMWH x 3 mo")).toBe("TX: DOACs\nor LMWH x 3 mo");
        expect(column("• ACUTE TX: DOACs")).toBe("• ACUTE TX: DOACs");
        expect(panel("RFs: travel\nTX: DOACs")).toEqual([C(1)]);
      });

      it("ends at her next labelled lead-in, so a drug named after it treats nothing", () => {
        // PANCE Hereditary Polyposis: "➁ Peutz-Jeghers syndrome (PJS):" opens the next syndrome, not more treatment.
        expect(column("TX: LMWH\nDX: DOACs")).toBe("TX: LMWH");
        expect(column("TX: LMWH\nS/SXS: DOACs")).toBe("TX: LMWH");
        expect(column("TX: LMWH\nComplications: DOACs")).toBe("TX: LMWH");
        expect(column("     ▪︎TX: LMWH\n➁ Peutz-Jeghers syndrome (PJS): DOACs")).toBe("     ▪︎TX: LMWH");
        expect(panel("TX: LMWH\nDX: DOACs")).toEqual([]);
      });

      it("keeps a labelled line bulleted under it, which is more of her treatment", () => {
        // EM Metabolic Acidosis: "TX: directed at underlying cause" / "•renal failure: give alkali (NaHCO3…)".
        expect(column("TX: LMWH\n•renal failure: DOACs")).toBe("TX: LMWH\n•renal failure: DOACs");
        expect(column("TX:\n  Stage I: DOACs\nDX: biopsy")).toBe("TX:\n  Stage I: DOACs");
        expect(panel("TX: LMWH\n•renal failure: DOACs")).toEqual([C(1)]);
      });

      it("leaves out her causes and risk factors outside it", () => {
        // PANCE C. diff: "RFs: recent ABX use (FQs, clindamycin…)" names causes.
        expect(column("RFs: recent DOACs use\nTX: LMWH")).toBe("TX: LMWH");
        expect(panel("RFs: recent DOACs use\nTX: LMWH")).toEqual([]);
      });

      it("stays within its own cell, and each of her TX lead-ins counts", () => {
        expect(column("TX: LMWH", "DOACs")).toBe("TX: LMWH");
        expect(column("ACUTE TX: LMWH", "CHRONIC TX: DOACs")).toBe("ACUTE TX: LMWH\nCHRONIC TX: DOACs");
      });

      it("is absent when her cells have none", () => {
        expect(column("RFs: travel\nDOACs")).toBeNull();
        expect(panel("RFs: travel\nDOACs")).toEqual([]);
      });
    });

    it("a row only her row name occurs files under its cards written for the condition, else is not hers", () => {
      // PANCE Conduct disorder: propranolol for aggression is not her anxiety β-blocker row.
      // Her section is written for both diseases, so the row lists the card either way.
      const vte = structureOf({
        drugTables: [{ block: B(92), pharmSection: "anticoagulants", conditionRows: [] }],
        pharmSections: [{ id: "anticoagulants", title: "DVT and pulmonary embolism", tables: [B(92)], overview: null, lo: null, also: [] }],
      });
      const panel = (diseases: string[]) => {
        const scoped = new CardMatcher([xa, { ...heparin, diseases }]);
        const t = deriveTopics([table(B(91), 2, [[R(910), "heading", "PULM", "Management"], [R(911), "content", "Pulmonary embolism", "Heparin: LMWH, fondaparinux"]]), drugs], vte);
        const topic = t.topics.find((x) => x.id === R(911));
        if (!topic) throw new Error("no topic");
        return medsPanel({ guide: "em", system: "pulmonary", structure: vte, topics: t, partFiles: new Map() }, [B(91), B(92)], topic, scoped, (c) => c, new Set(), () => null, () => new Set()).map((m) => [m.card, m.rows]);
      };
      expect(panel(["DVT"])).toEqual([]);
      expect(panel(["pulmonary embolism"])).toEqual([[C(2), [R(921)]]]);
    });

    describe("a drug name her pharm files put on cards written for other uses", () => {
      // "lidocaine" is on her antiarrhythmic (cardio file) and her local anesthetic (anesthesia file) card;
      // "lidocaine gel" on hand, foot & mouth disease is neither card's use.
      const classIb = { id: C(3), file: "cardio", aliases: ["Class Ib", "lidocaine", "mexiletine"], home: {} };
      const local = { id: C(4), file: "anesthesia", aliases: ["Local Anesthetics", "lidocaine"], home: {} };
      const shared = new CardMatcher([classIb, local]);
      const panel = (management: string, home: (card: string) => { system: string | null; section: string } | null) => {
        const t = deriveTopics([table(B(91), 2, [[R(910), "heading", "DERM", "Management"], [R(911), "content", "HFMD", management]]), drugs], st);
        const topic = t.topics.find((x) => x.id === R(911));
        if (!topic) throw new Error("no topic");
        return medsPanel({ guide: "em", system: "dermatology", structure: st, topics: t, partFiles: new Map() }, [B(91), B(92)], topic, shared, (c) => c, new Set(), home, () => new Set()).map((m) => m.card);
      };

      it("names no card placed only in other systems", () => {
        expect(panel("lidocaine gel", () => ({ system: "cardiovascular", section: "antiarrhythmics" }))).toEqual([]);
        expect(panel("lidocaine gel", () => ({ system: null, section: "local-anesthetics" }))).toEqual([]);
      });

      it("names the card the system itself places", () => {
        const home = (card: string) => (card === C(4) ? { system: "dermatology", section: "local-anesthetics" } : { system: "cardiovascular", section: "antiarrhythmics" });
        expect(panel("lidocaine gel", home)).toEqual([C(4)]);
      });

      it("a word only one card has still names that card", () => {
        expect(panel("mexiletine", () => ({ system: "cardiovascular", section: "antiarrhythmics" }))).toEqual([C(3)]);
      });

      it("a topical form names no card: her drug cards are systemic", () => {
        // EM Derm, Atopic dermatitis: "topical steroids"; Hair loss: "topical minoxidil".
        const home = (card: string) => (card === C(4) ? { system: "dermatology", section: "local-anesthetics" } : null);
        expect(panel("topical lidocaine", home)).toEqual([]);
      });
    });

    describe("a drug word cards of several med lists share (`meantCards`)", () => {
      // "aspirin" is on her antiplatelet card and her pain list's Salicylates card.
      const antiplatelet = { id: C(5), file: "antiplatelet", aliases: ["aspirin", "ASA"], home: {} };
      const p2y12 = { id: C(6), file: "antiplatelet", aliases: ["clopidogrel"], home: {} };
      const salicylates = { id: C(7), file: "pain", aliases: ["aspirin"], home: {} };
      const m = new CardMatcher([antiplatelet, p2y12, salicylates]);
      const sections: Record<string, string[]> = { [C(5)]: ["antiplatelets"], [C(6)]: ["antiplatelets"], [C(7)]: ["pain"] };
      const meant = (text: string, shows: (c: string) => boolean = () => true) =>
        meantCards(m, "Coronary artery disease", text, m.namedBy(text), { inSystem: () => false, sectionsOf: (c) => new Set(sections[c]), shows });

      it("names the card sharing a pharm section with a card of its own med list her same item names", () => {
        // FM ACS: "aspirin + clopidogrel" is her antiplatelet aspirin, not her Salicylates.
        expect(meant("DAPT: aspirin + clopidogrel")).toEqual([C(5), C(6)]);
      });

      it("names neither when no such card shares her item, and none of them is the system's own", () => {
        expect(meant("aspirin\nclopidogrel")).toEqual([C(6)]);
        expect(meant("aspirin")).toEqual([]);
      });

      it("a word only one card has names it alone, even shared with another list", () => {
        expect(meant("ASA")).toEqual([C(5)]);
      });

      it("a card the panel cannot show is no evidence", () => {
        expect(meant("aspirin + clopidogrel", (c) => c !== C(6))).toEqual([]);
      });

      it("a card her data rules out for the condition (`notDiseases`) contests nothing, so the other holder is meant", () => {
        // FM Acute Rheumatic Fever: "Aspirin" is her pain list's Salicylates card, not her antiplatelet card.
        const ruled = new CardMatcher([{ ...antiplatelet, notDiseases: ["rheumatic fever"] }, p2y12, salicylates]);
        const title = "Acute Rheumatic Fever";
        const at = (t: string) =>
          meantCards(ruled, t, "high-dose aspirin", ruled.namedBy("high-dose aspirin"), { inSystem: () => false, sectionsOf: (c) => new Set(sections[c]), shows: (c) => ruled.writtenFor(c, t) });
        expect(at(title)).toEqual([C(7)]);
        // Elsewhere both still hold the word, and nothing in the item favors either.
        expect(at("Pericarditis")).toEqual([]);
      });

      it("of a drug word two med lists hold, the card whose diseases her condition or item names is meant", () => {
        // Surg Nausea/Vomiting: "dexamethasone" is her antiemetic steroid card, not her migraine list's steroid card.
        const antiemetic = { id: C(8), file: "gi", aliases: ["dexamethasone"], home: {}, diseases: ["nausea", "vomiting", "PONV"] };
        const migraine = { id: C(9), file: "neuro", aliases: ["dexamethasone"], home: {} };
        const both = new CardMatcher([antiemetic, migraine]);
        const at = (title: string, text: string) =>
          meantCards(both, title, text, both.namedBy(text), { inSystem: () => false, sectionsOf: () => new Set(), shows: (c) => both.writtenFor(c, title, text, both.namedBy(text).get(c)) });
        expect(at("Nausea/Vomiting", "dexamethasone 4 mg IV")).toEqual([C(8)]);
        expect(at("Postoperative care", "PONV prophylaxis: dexamethasone")).toEqual([C(8)]);
        expect(at("Migraine HA", "dexamethasone to prevent recurrence")).toEqual([]);
      });

      it("of a drug's own name cards of one med list hold, the ones that fit are meant, else all of them", () => {
        // OB Hyperemesis: "methylprednisolone" is her antiemetic steroid card, not her IBD glucocorticoid card (both her GI list).
        const antiemetic = { id: C(8), file: "gi", aliases: ["methylprednisolone"], home: {}, diseases: ["hyperemesis", "nausea"] };
        const ibd = { id: C(9), file: "gi", aliases: ["methylprednisolone"], home: {} };
        const both = new CardMatcher([antiemetic, ibd]);
        const at = (title: string, text: string) =>
          meantCards(both, title, text, both.namedBy(text), { inSystem: () => false, sectionsOf: () => new Set(), shows: (c) => both.writtenFor(c, title, text, both.namedBy(text).get(c)) });
        expect(at("Hyperemesis gravidarum", "if refractory: methylprednisolone")).toEqual([C(8)]);
        // Neither fits: the card that may show keeps the word.
        expect(at("Bursitis", "methylprednisolone injection")).toEqual([C(9)]);
      });
    });
  });

  it("a card with no row takes its pharm section from the system, else the guide, else the site without a link", () => {
    const at = (guide: string, system: string, section: string) => ({ guide, system, section });
    const places = [at("fm", "cardiovascular", "anticoag"), at("em", "cardiovascular", "anticoag"), at("em", "pulmonary", "pe")];
    expect(panelHome(places, "em", "pulmonary")).toEqual({ system: "pulmonary", section: "pe" });
    expect(panelHome(places, "em", "renal")).toEqual({ system: "cardiovascular", section: "anticoag" });
    expect(panelHome(places, "ob", "obstetrics")).toEqual({ system: null, section: "anticoag" });
    expect(panelHome([], "em", "renal")).toBeNull();
  });

  it("a card with no row prefers, within the system or else the guide, a pharm section relevant to the condition", () => {
    // PANCE: her CCB card is in the antiarrhythmics, antianginals and hypertension sections; a hypertension panel opens the last.
    const at = (guide: string, system: string, section: string) => ({ guide, system, section });
    const places = [at("pance", "cardiovascular", "antiarrhythmics"), at("pance", "cardiovascular", "hypertension"), at("em", "cardiovascular", "hypertension")];
    expect(panelHome(places, "pance", "cardiovascular", new Set(["hypertension"]))).toEqual({ system: "cardiovascular", section: "hypertension" });
    expect(panelHome(places, "pance", "renal", new Set(["hypertension"]))).toEqual({ system: "cardiovascular", section: "hypertension" });
    expect(panelHome(places, "pance", "cardiovascular", new Set(["heart-failure"]))).toEqual({ system: "cardiovascular", section: "antiarrhythmics" });
    // A preferred section of another guide never beats the panel's own guide.
    expect(panelHome([places[0] as PharmPlace, at("em", "cardiovascular", "hypertension")], "pance", "cardiovascular", new Set(["hypertension"]))).toEqual({
      system: "cardiovascular", section: "antiarrhythmics",
    });
  });

  describe("a meds panel's tables, links and condition notes", () => {
    const panelOf = (
      blocks: BlockFile[], st: StructureFile, title: string, management: string, m: CardMatcher,
      opts: { relevant?: string[]; home?: (card: string, prefer?: ReadonlySet<string>) => { system: string | null; section: string } | null } = {},
    ) => {
      const conditions = table(B(91), 2, [[R(910), "heading", "MSK", "Management"], [R(911), "content", title, management]]);
      const t = deriveTopics([conditions, ...blocks], st);
      const topic = t.topics.find((x) => x.id === R(911));
      if (!topic) throw new Error("no topic");
      const s = { guide: "fm", system: "orthopedics-rheumatology", structure: st, topics: t, partFiles: new Map() };
      return medsPanel(s, [B(91), ...blocks.map((b) => b.id)], topic, m, (c) => c, new Set(opts.relevant ?? []), opts.home ?? (() => null), () => new Set());
    };

    it("a table written only for some conditions (`onlyFor`) shows only under a condition whose title names one", () => {
      // FM Orthopedics: her Gout table's "ACUTE › NSAIDs" row is gout dosing, not her ankle sprain's NSAIDs.
      const nsaids = new CardMatcher([{ id: C(1), file: "nsaids", aliases: ["NSAIDs", "naproxen"], home: {} }]);
      const gout = table(B(92), 2, [[R(920), "content", "NSAIDs: naproxen 500 mg BID", "acute flare"]]);
      const dmards = table(B(93), 2, [[R(930), "content", "NSAIDs", "symptom relief"]]);
      const st = (onlyFor?: string[]) => structureOf({
        drugTables: [{ block: B(92), pharmSection: "gout", conditionRows: [], ...(onlyFor ? { onlyFor } : {}) }, { block: B(93), pharmSection: "dmards", conditionRows: [] }],
      });
      const rows = (s: StructureFile, title: string) => panelOf([gout, dmards], s, title, "rest, ice, NSAIDs", nsaids).map((x) => [x.card, x.rows]);
      expect(rows(st(["gout"]), "Ankle sprain")).toEqual([[C(1), [R(930)]]]);
      expect(rows(st(["gout"]), "Gout")).toEqual([[C(1), [R(920)]]]);
      // Without the flag her gout row shows under the sprain too.
      expect(rows(st(), "Ankle sprain")).toEqual([[C(1), [R(920), R(930)]]]);
    });

    it("a card with rows links to the pharm section `home` gives it when one of its rows is there, else to its first row's", () => {
      // FM Cardiovascular, CAD: her statins rows sit in her antiplatelets and her hyperlipidemia tables.
      const statins = new CardMatcher([{ id: C(1), file: "cardio", aliases: ["statins", "atorvastatin"], home: {} }]);
      const blocks = [table(B(92), 2, [[R(920), "content", "Statins: atorvastatin", "plaque"]]), table(B(93), 2, [[R(930), "content", "Statins", "LDL"]])];
      const st = structureOf({ drugTables: [{ block: B(92), pharmSection: "antiplatelets", conditionRows: [] }, { block: B(93), pharmSection: "hyperlipidemia", conditionRows: [] }] });
      const asked: (ReadonlySet<string> | undefined)[] = [];
      const link = (system: string, section: string) => (_card: string, prefer?: ReadonlySet<string>) => {
        asked.push(prefer);
        return { system, section };
      };
      const relevant = ["antiplatelets", "hyperlipidemia"];
      const panel = (home: ReturnType<typeof link>) => panelOf(blocks, st, "Coronary artery disease", "high-intensity statins", statins, { relevant, home }).map((x) => [x.rows, x.section, x.system]);
      expect(panel(link("orthopedics-rheumatology", "hyperlipidemia"))).toEqual([[[R(920), R(930)], "hyperlipidemia", "orthopedics-rheumatology"]]);
      // The panel's relevant sections are what `home` prefers.
      expect([...(asked[0] ?? [])]).toEqual(relevant);
      expect(panel(link("orthopedics-rheumatology", "lipid-lowering"))).toEqual([[[R(920), R(930)], "antiplatelets", "orthopedics-rheumatology"]]);
      // A section of the same id in another system holds none of the panel's rows.
      expect(panel(link("cardiovascular", "hyperlipidemia"))).toEqual([[[R(920), R(930)], "antiplatelets", "orthopedics-rheumatology"]]);
    });

    it("her word for a card names its rows in the pharm section named for the condition first, then in relevant sections", () => {
      // FM Orthopedics: her gout "corticosteroids" is her Gout table's Glucocorticoids row, not her RA table's Corticosteroids row.
      const steroids = new CardMatcher([{ id: C(1), file: "gi", aliases: ["Glucocorticoids", "corticosteroids", "prednisone"], home: {} }]);
      const blocks = [table(B(92), 2, [[R(920), "content", "Glucocorticoids: prednisone", "flare"]]), table(B(93), 2, [[R(930), "content", "Corticosteroids", "bridge"]])];
      const st = structureOf({ drugTables: [{ block: B(92), pharmSection: "gout", conditionRows: [] }, { block: B(93), pharmSection: "dmards", conditionRows: [] }] });
      const rows = (title: string) => panelOf(blocks, st, title, "NSAIDs, colchicine or corticosteroids", steroids, { relevant: ["gout", "dmards"] }).map((x) => x.rows);
      expect(rows("Gout")).toEqual([[R(920)]]);
      expect(rows("Pseudogout")).toEqual([[R(930)]]);
    });

    it("her drug name names a row of its drug by the row's drug, not by a note on another drug", () => {
      // FM Tobacco use: "bupropion" is her Bupropion row, not her Vortioxetine row's "↓ CYP2D6 (like bupropion)".
      const atypicals = new CardMatcher([{ id: C(1), file: "bh", aliases: ["bupropion", "vortioxetine"], home: {} }]);
      const blocks = [table(B(92), 2, [[R(920), "content", "Bupropion", "NDRI"], [R(921), "content", "Vortioxetine", "↓ CYP2D6 (like bupropion)"]])];
      const st = structureOf({ drugTables: [{ block: B(92), pharmSection: "depression", conditionRows: [] }] });
      expect(panelOf(blocks, st, "Tobacco use", "varenicline or bupropion", atypicals).map((x) => x.rows)).toEqual([[R(920)]]);
    });

    it("a card with notes written for the condition (`partTitled`) shows under it though her text names none of its drugs", () => {
      // Psy: her levodopa card's restless-legs notes on Restless Leg Syndrome, whose text names dopamine agonists and iron.
      const parts = new Map([[C(1), [["restless leg syndrome", "RLS"]]]]);
      const levodopa = (notDiseases?: string[]) =>
        new CardMatcher([{ id: C(1), file: "neuro", aliases: ["levodopa"], home: {}, ...(notDiseases ? { notDiseases } : {}) }, { id: C(2), file: "neuro", aliases: ["iron"], home: {} }], parts);
      const home = () => ({ system: "neurology", section: "parkinson-disease" });
      const cards = (m: CardMatcher, title: string) => panelOf([], structureOf(), title, "iron supplementation", m, { home }).map((x) => [x.card, x.rows, x.section]);
      expect(cards(levodopa(), "Restless Leg Syndrome")).toEqual([[C(2), [], "parkinson-disease"], [C(1), [], "parkinson-disease"]]);
      expect(cards(levodopa(), "Iron deficiency anemia")).toEqual([[C(2), [], "parkinson-disease"]]);
      expect(cards(levodopa(["restless leg"]), "Restless Leg Syndrome")).toEqual([[C(2), [], "parkinson-disease"]]);
      expect(levodopa().partTitled("RLS in pregnancy", new Set())).toEqual([C(1)]);
      expect(levodopa().partTitled("Parkinson disease", new Set())).toEqual([]);
    });

    it("a part of a card written `for` a pharm section places its card by title only in a system that has that section", () => {
      // Her depression notes on the atypical antidepressants card: on adult MDD, whose system has a
      // depression pharm section, but not on Peds MDD, whose system has none.
      const parts = new Map([[C(4), [["major depressive disorder", "MDD"]]]]);
      const atypicals = new CardMatcher(
        [{ id: C(1), file: "bh", aliases: ["mirtazapine"], home: {} }, { id: C(4), file: "ad", aliases: [], home: {}, in: C(1), for: ["depression"] }],
        parts,
      );
      const home = () => ({ system: "psychiatry", section: "depression" });
      const section = { id: "depression", title: "Depression", tables: [], overview: null, lo: null, also: [] };
      const cards = (st: StructureFile) => panelOf([], st, "Major Depressive Disorder (MDD)", "psychotherapy", atypicals, { home }).map((x) => x.card);
      expect(cards(structureOf({ pharmSections: [section] }))).toEqual([C(1)]);
      expect(cards(structureOf())).toEqual([]);
      expect(atypicals.partTitled("Major Depressive Disorder (MDD)", new Set(["depression"]))).toEqual([C(1)]);
      expect(atypicals.partTitled("Major Depressive Disorder (MDD)", new Set(["anxiety-disorders"]))).toEqual([]);
    });
  });

  it("class words match only her text, whole-word", () => {
    const m = new CardMatcher([{ id: C(3), file: "f", aliases: ["dobutamine"], home: {}, classWords: ["inotropes", "inotropic support"] }]);
    expect(m.named("▪︎inotropes, respiratory support")).toEqual([C(3)]);
    expect(m.named("ionotropes")).toEqual([]);
    expect(m.matching("Positive Inotropes in ADHF")).toEqual([]);
    expect(new CardMatcher([{ id: C(3), file: "f", aliases: [], home: {} }]).named("inotropes")).toEqual([]);
  });

  describe("her wording around a drug word that keeps it from naming its card", () => {
    const anticoag = { id: C(11), file: "f", aliases: ["heparin", "warfarin"], home: {}, classWords: ["anticoagulants", "anticoagulation"] };
    const iron = { id: C(12), file: "f", aliases: ["iron"], home: {} };
    const opioids = { id: C(13), file: "f", aliases: ["opioid", "opiate", "opiates"], home: {} };
    const antagonists = { id: C(14), file: "f", aliases: ["mu-opioid antagonists"], home: {} };
    const nsaids = { id: C(15), file: "f", aliases: ["NSAIDs"], home: {} };
    const antipsychotics = { id: C(16), file: "f", aliases: ["clozapine"], home: {} };
    const vasodilators = { id: C(17), file: "f", aliases: ["nitroprusside"], home: {} };
    const salicylates = { id: C(18), file: "f", aliases: ["salicylate", "ASA"], home: {} };
    const antiarrhythmics = { id: C(19), file: "f", aliases: ["amiodarone"], home: {} };
    const nmda = { id: C(20), file: "f", aliases: ["memantine"], home: {} };
    const dopamine = { id: C(21), file: "f", aliases: ["levodopa"], home: {} };
    const m = new CardMatcher([anticoag, iron, opioids, antagonists, nsaids, antipsychotics, vasodilators, salicylates, antiarrhythmics, nmda, dopamine]);

    it("a colon after an avoid opens her list only after her words for drugs that name none", () => {
      // FM GI, Cirrhosis: "avoid hepatotoxic drugs: NSAIDs, opiates, BDZs".
      expect(m.named("avoid hepatotoxic drugs: NSAIDs, opiates")).toEqual([]);
      expect(m.named("avoid triggers: NSAIDs")).toEqual([C(15)]);
      expect(m.named("avoid NSAIDs: opiates")).toEqual([C(13)]);
    });

    it("a drug word under her Ø or ∅ sign names nothing", () => {
      // Frontotemporal dementia: "Ø memantine, ineffective".
      expect(m.named("Ø memantine, ineffective")).toEqual([]);
      expect(m.named("∅memantine")).toEqual([]);
      expect(m.named("memantine")).toEqual([C(20)]);
    });

    it("a drug word hyphen-joined after non, low, high or a digit is another word; her combination names stay", () => {
      expect(m.namedBy("non-heparin anticoagulants").get(C(11))).toEqual(["anticoagulants"]);
      expect(m.named("low-iron diet")).toEqual([]);
      expect(m.named("5-ASA")).toEqual([]);
      expect(m.named("Levodopa-carbidopa")).toEqual([C(21)]);
    });

    it("a drug word right after an ordinal is a place, not the drug", () => {
      // Pneumothorax: "anterior to midaxillary line in 5th ICS (nipple line)"; COPD: "ICS + LABA if eosinophils ≥300".
      const ics = new CardMatcher([{ id: C(30), file: "f", aliases: ["ICS"], home: {} }]);
      expect(ics.named("anterior to midaxillary line in 5th ICS (nipple line)")).toEqual([]);
      expect(ics.named("superior rib margin in 2nd ICS, midclavicular line")).toEqual([]);
      expect(ics.named("ICS + LABA if eosinophils ≥300")).toEqual([C(30)]);
      expect(ics.named("add 2 ICS puffs")).toEqual([C(30)]);
    });

    it("a drug word her text makes the problem names nothing", () => {
      for (const text of ["iron deficiency anemia", "serum salicylate level", "opiate OD", "Opioid-induced constipation", "Iron TX: chelation therapy"]) {
        expect(m.named(text), text).toEqual([]);
      }
      expect(m.named("iron supplementation")).toEqual([C(12)]);
    });

    it("the drug her problem comes from names nothing", () => {
      // FM UC, Cyanide: "if from nitroprusside infusion".
      expect(m.named("if from nitroprusside infusion")).toEqual([]);
      expect(m.named("nitroprusside infusion")).toEqual([C(17)]);
    });

    it("her stop words rule out the drugs after them, but not a stop weighed against going on, nor DC cardioversion", () => {
      // PANCE ICH "stop all anticoagulants/antiplatelets"; DVT "DC anticoagulation vs continue indefinitely".
      expect(m.named("stop all anticoagulants")).toEqual([]);
      expect(m.named("DC/⇣ opioid")).toEqual([]);
      expect(m.named("discontinue warfarin")).toEqual([]);
      expect(m.named("DC anticoagulation vs continue indefinitely")).toEqual([C(11)]);
      expect(m.named("DC cardioversion or amiodarone")).toEqual([C(19)]);
    });

    it("her words for what to do instead end the stop's reach", () => {
      // HIT: "D/C of all heparin + initiation of non-heparin anticoagulants".
      expect(m.namedBy("D/C of all heparin + initiation of anticoagulants").get(C(11))).toEqual(["anticoagulants"]);
      expect(m.named("D/C of all heparin + anticoagulants")).toEqual([]);
      expect(m.named("D/C NSAIDs, switch to clozapine")).toEqual([C(16)]);
    });

    it("a drug heading her list in the possessive names nothing", () => {
      // FM UC, Anticoagulants: "Warfarin’s: Vit K, FFP, prothrombin complex concentrate".
      expect(m.named("Warfarin’s: Vit K, FFP")).toEqual([]);
      expect(m.named("Warfarin's: Vit K")).toEqual([]);
    });

    it("a drug name inside another drug's longer name names only the longer one's card", () => {
      expect(m.named("naloxone (mu-opioid antagonists)")).toEqual([C(14)]);
    });

    it("her avoid list goes on past a line she wraps after a comma", () => {
      // Cirrhosis: "avoid hepatotoxic drugs: NSAIDs, opiates,   ⏎ BDZs (HE)".
      expect(m.named("avoid hepatotoxic drugs: NSAIDs,   \n memantine (HE)")).toEqual([]);
      expect(m.named("avoid hepatotoxic drugs: NSAIDs\n memantine")).toEqual([C(20)]);
    });

    it("a drug word her text measures or lets accumulate names nothing", () => {
      // Beta thalassemia: "assess cardiac/liver iron concentrations"; Alpha: "when iron accumulates to toxic levels".
      expect(m.named("assess cardiac/liver iron concentrations & guide chelation therapy")).toEqual([]);
      expect(m.named("chelation therapy recommended when iron accumulates to toxic levels")).toEqual([]);
    });

    it("her words to be wary of or remove a drug rule it out", () => {
      // FM Cardio, Sick sinus: "cautious use of digoxin"; Perioral dermatitis: "Elimination of topical steroids".
      expect(m.named("cautious use of NSAIDs")).toEqual([]);
      expect(m.named("Elimination of NSAIDs, memantine")).toEqual([]);
      expect(m.named("NSAIDs")).toEqual([C(15)]);
    });

    it("her list under a heading of drugs to avoid or of causes names nothing, until a blank line", () => {
      // EM Vasospastic angina "AVOID:\n▪︎nonselective beta blockers"; IM Coma "Consider reversible causes:\n•opiate OD 🡪 naloxone".
      expect(m.named("AVOID:\n▪︎NSAIDs\n▪︎opiates")).toEqual([]);
      expect(m.named("AVOID:\n▪︎NSAIDs\n\n▪︎memantine")).toEqual([C(20)]);
      expect(m.named("Consider reversible causes:\n•NSAIDs\n•opiates 🡪 memantine")).toEqual([C(20)]);
      // A heading saying to treat them lists treatments.
      expect(m.named("Treat reversible causes:\n•NSAIDs")).toEqual([C(15)]);
    });

    it("a drug word her text makes the body's own, a lab value, a topical form or a lost substance names nothing", () => {
      for (const text of ["endogenous opioid release", "plasma salicylate", "topical NSAIDs", "ritual-eliciting memantine", "iron depletion", "Iron use: gradual taper"]) {
        expect(m.named(text), text).toEqual([]);
      }
    });

    it("the therapy her patient already needs, in parentheses, names nothing", () => {
      // PANCE RSV: palivizumab for "chronic lung disease … requiring medical therapy (O2, bronchodilator, diuretic, steroids)".
      expect(m.named("chronic lung disease requiring medical therapy (O2, \n   NSAIDs, opiates) within 6mo")).toEqual([]);
      expect(m.named("medical therapy (NSAIDs)")).toEqual([C(15)]);
    });

    it("her class word in parentheses right after a drug describes that drug and names nothing of its own", () => {
      // PANCE NMS: "Dantrolene (muscle relaxant), Bromocriptine (DA agonist)".
      expect(m.named("levodopa (anticoagulation)")).toEqual([C(21)]);
      expect(m.named("anticoagulation (warfarin)")).toEqual([C(11)]);
    });

    it("her qualified class word in those parentheses describes the drug too", () => {
      // PANCE Metabolic Acidosis: "▪RTA4: furosemide (K-wasting diuretic), fludrocortisone, low-K diet".
      expect(m.named("levodopa (long-term anticoagulation)")).toEqual([C(21)]);
      // Outside her parentheses, the class word names its cards.
      expect(m.named("levodopa (IV), anticoagulation")).toEqual([C(11), C(21)]);
    });

    it("a hyphen or slash inside her words does not keep a class word from heading her list", () => {
      // HIT: "Immediate D/C of all heparin + initiation of non-heparin anticoagulants:" then her bulleted agents.
      expect(m.namedBy("initiation of non-heparin anticoagulants:\n•warfarin").get(C(11))).toEqual(["warfarin"]);
    });
  });

  describe("a class word or drug word her list after it qualifies", () => {
    const vka = { id: C(1), file: "f", aliases: ["warfarin"], home: {}, classWords: ["anticoagulation"] };
    const heparin = { id: C(2), file: "f", aliases: ["enoxaparin"], home: {}, classWords: ["anticoagulation"] };
    const dti = { id: C(3), file: "f", aliases: ["Direct thrombin inhibitors", "dabigatran"], home: {} };
    const reversal = { id: C(4), file: "f", aliases: ["Reversal agents", "idarucizumab", "andexanet"], home: {} };
    const m = new CardMatcher([vka, heparin, dti, reversal]);

    it("her parenthetical naming her choice narrows the class word to the cards it names; her examples do not", () => {
      // Cirrhosis "PVT: anticoagulation (enoxaparin)"; APS "lifelong anticoagulation (warfarin)".
      expect(m.namedBy("PVT: anticoagulation (enoxaparin)")).toEqual(new Map([[C(2), ["enoxaparin", "anticoagulation"]]]));
      expect(m.named("lifelong anticoagulation (warfarin)")).toEqual([C(1)]);
      // APS "anticoagulate w/ Warfarin": her "w/" names her choice the same way.
      expect(m.named("anticoagulation w/ warfarin (INR 2-3)")).toEqual([C(1)]);
      expect(m.named("anticoagulation with enoxaparin")).toEqual([C(2)]);
      // Myocarditis "vasodilators (e.g., nitrates)"; a parenthetical naming no card of the class leaves it whole.
      expect(m.named("anticoagulation (e.g., warfarin)")).toEqual([C(1), C(2)]);
      expect(m.named("anticoagulation (indefinite)")).toEqual([C(1), C(2)]);
    });

    it("a drug word heading her list of its antidotes names nothing; the antidotes name their card", () => {
      // FM Urgent Care, Anticoagulants: "- Direct thrombin inhibitors: Idarucizumab ⏎ - Factor Xa inhibitors – Andexanet under investigation".
      expect(m.named("- Direct thrombin inhibitors: Idarucizumab")).toEqual([C(4)]);
      expect(m.named("dabigatran – andexanet")).toEqual([C(4)]);
      expect(m.named("Direct thrombin inhibitors: dabigatran")).toEqual([C(3)]);
    });
  });

  it("a card written for some diseases is written only for conditions whose title names one", () => {
    const m = new CardMatcher([
      { id: C(1), file: "f", aliases: ["natalizumab"], home: {}, diseases: ["multiple sclerosis"] },
      { id: C(2), file: "f", aliases: ["IVIG"], home: {} },
      // A group is written for a condition when any of its cards is.
      { id: C(3), file: "f", aliases: ["inebilizumab"], home: {}, in: C(1), diseases: ["neuromyelitis optica"] },
    ]);
    expect(m.writtenFor(C(1), "Multiple Sclerosis (MS)")).toBe(true);
    expect(m.writtenFor(C(1), "Neuromyelitis optica")).toBe(true);
    expect(m.writtenFor(C(1), "Immune thrombocytopenic purpura")).toBe(false);
    expect(m.writtenFor(C(2), "Immune thrombocytopenic purpura")).toBe(true);
    // Or a use her item naming the card names: systemic sclerosis "Pulmonary HTN: bosentan, sildenafil".
    expect(m.writtenFor(C(1), "Systemic Sclerosis", "Lung: cyclophosphamide\nMultiple sclerosis: natalizumab", ["natalizumab"])).toBe(true);
    expect(m.writtenFor(C(1), "Systemic Sclerosis", "Multiple sclerosis: steroids\nLung: natalizumab", ["natalizumab"])).toBe(false);
    // Titled for: a card of the group lists a disease the title names; a card without diseases is not.
    expect(m.titledFor(C(1), "Neuromyelitis optica")).toBe(true);
    expect(m.titledFor(C(2), "Immune thrombocytopenic purpura")).toBe(false);
  });

  it("a card is never written for a condition whose title names one of its group's `notDiseases`", () => {
    const m = new CardMatcher([
      { id: C(1), file: "f", aliases: ["spironolactone"], home: {} },
      { id: C(2), file: "f", aliases: ["eplerenone"], home: {}, in: C(1), notDiseases: ["acne", "PCOS"] },
    ]);
    expect(m.writtenFor(C(1), "Heart failure")).toBe(true);
    expect(m.writtenFor(C(1), "Acne Vulgaris")).toBe(false);
    expect(m.writtenFor(C(1), "Polycystic ovary syndrome (PCOS)")).toBe(false);
  });

  describe("a drug row's cards: its class, plus the agents in its drug-name columns from the class's med list", () => {
    const drugs = table(B(92), 4, [
      [R(920), "heading", "PHARM", "Drugs", "", "MOA"],
      // The agents sit under the column the "Drugs" heading spans; the MOA column names digoxin only in passing.
      [R(921), "content", "CCBs", "DHP:", "Amlodipine, nifedipine", "unlike digoxin"],
      [R(922), "content", "Tocolytics", "nifedipine", "", ""],
    ]);
    const cards = (over: Partial<Card>[] = []) =>
      new CardMatcher([
        { id: C(1), file: "cardio", aliases: ["CCBs"], home: {} },
        { id: C(2), file: "cardio", aliases: ["amlodipine", "nifedipine"], home: {}, ...over[0] },
        // Her OB list's tocolytic card: nifedipine for another use.
        { id: C(3), file: "ob", aliases: ["nifedipine"], home: {}, ...over[1] },
        { id: C(4), file: "cardio", aliases: ["digoxin"], home: {} },
      ]);
    const st = structureOf({ drugTables: [{ block: B(92), pharmSection: "x", conditionRows: [] }] });
    const t = deriveTopics([drugs], st);
    const row = (id: string) => {
      const r = tableOf(drugs)?.rows.find((x) => x.id === id);
      if (!r) throw new Error(`no row ${id}`);
      return r;
    };

    it("adds a same-list card its drug columns name, not another list's card nor a card named in another column", () => {
      expect(rowCards(cards(), t, row(R(921)), "x")).toEqual([C(1), C(2)]);
    });

    it("takes the cards its agents name when the first cell names no card; a drug they share goes to the class her row names", () => {
      const tocolytic = { classWords: ["tocolytics"] };
      expect(rowCards(cards([{}, tocolytic]), t, row(R(922)), "x")).toEqual([C(3)]);
      // No evidence for either class keeps neither.
      expect(rowCards(cards(), t, row(R(922)), "x")).toEqual([]);
    });

    it("reads a card shown inside a class card as that class card", () => {
      expect(rowCards(cards([{ in: C(1) }]), t, row(R(921)), "x")).toEqual([C(1)]);
      expect(rowCards(cards([{ in: C(1) }, { classWords: ["tocolytics"] }]), t, row(R(922)), "x")).toEqual([C(3)]);
    });

    it("leaves out a card written only for other pharm sections, and a group only when all of it is", () => {
      expect(rowCards(cards([{ for: ["y"] }]), t, row(R(921)), "x")).toEqual([C(1)]);
      expect(rowCards(cards([{ for: ["x", "y"] }]), t, row(R(921)), "x")).toEqual([C(1), C(2)]);
      // A member written for another section still lets its class card in: the class card is for any use.
      expect(rowCards(cards([{ in: C(1), for: ["y"] }]), t, row(R(921)), "x")).toEqual([C(1)]);
    });
  });

  describe("a drug row lists only the cards of the class it is about (`sectionRowCards`)", () => {
    const st = structureOf({ drugTables: [{ block: B(92), pharmSection: "x", conditionRows: [] }] });
    /** The cards of the first content row of a two-column drug table holding `first` and `second`. */
    const cardsOf = (m: CardMatcher, first: string, second = "", section: { title?: string; lists?: string[] } = {}) => {
      const drugs = table(B(92), 3, [[R(920), "heading", "PHARM", "Drugs", "MOA"], [R(921), "content", first, second, "MOA"]]);
      const t = deriveTopics([drugs], st);
      const r = tableOf(drugs)?.rows.find((x) => x.id === R(921));
      if (!r) throw new Error("no row");
      return sectionRowCards(m, t, [r], { id: "x", title: section.title ?? "", lists: new Set(section.lists ?? []) }).get(r.id);
    };

    it("a card that may not stay on the row contests none of its words", () => {
      // FM RA: her hemorrhoid steroid card, written for hemorrhoids, does not take her "Corticosteroids" row from her glucocorticoid card.
      const m = new CardMatcher([
        { id: C(1), file: "gi", aliases: ["Glucocorticoids", "corticosteroids"], home: {} },
        { id: C(2), file: "gi-hemorrhoids", aliases: ["corticosteroids"], home: {}, diseases: ["hemorrhoids"] },
      ]);
      expect(cardsOf(m, "Corticosteroids", "", { title: "RA & OA" })).toEqual([C(1)]);
      expect(cardsOf(m, "Corticosteroids", "", { title: "Hemorrhoids" })).toEqual([]);
    });

    it("an agent counts for its card only when the card's own class comes from the med list of the class the row names", () => {
      // FM Pulmonary: budesonide on her "Inhaled Corticosteroids (ICS)" row is not her IBD glucocorticoid card, though
      // that card holds a member from her multi-class review list, the list her ICS card comes from.
      const m = new CardMatcher([
        { id: C(1), file: "pharm-review", aliases: ["Inhaled Corticosteroids", "ICS", "fluticasone"], home: {} },
        { id: C(2), file: "gi", aliases: ["Glucocorticoids", "prednisone"], home: {} },
        { id: C(3), file: "pharm-review", aliases: ["budesonide"], home: {}, in: C(2) },
        { id: C(4), file: "pharm-review", aliases: ["salmeterol"], home: {} },
      ]);
      // Her asthma section's Overview comes from her pulmonary med list, so neither card is from the section's own list.
      const asthma = { lists: ["pulm-med-list"] };
      expect(cardsOf(m, "Inhaled Corticosteroids (ICS)", "budesonide, fluticasone", asthma)).toEqual([C(1)]);
      // A card whose own class comes from that list still counts.
      expect(cardsOf(m, "Inhaled Corticosteroids (ICS)", "fluticasone, salmeterol", asthma)).toEqual([C(1), C(4)]);
    });

    it("a drug name inside another card's longer name on the row is that card's", () => {
      // FM Heart failure: "ARNI: Sacubitril/Valsartan" is her ARNI card, not her ARB card.
      const m = new CardMatcher([
        { id: C(1), file: "cardio", aliases: ["ARBs", "valsartan"], home: {} },
        { id: C(2), file: "cardio", aliases: ["ARNI", "sacubitril/valsartan"], home: {} },
      ]);
      expect(cardsOf(m, "ARNI:\nSacubitril/Valsartan")).toEqual([C(2)]);
      expect(cardsOf(m, "ARBs: valsartan, losartan")).toEqual([C(1)]);
    });

    it("a drug her agents are combined with is not one of the row's agents", () => {
      // FM Hypertension: "Potassium-Sparing Diuretics ‖ Amiloride (combo w/ HCTZ → Moduretic)".
      const m = new CardMatcher([
        { id: C(1), file: "cardio", aliases: ["thiazide", "HCTZ"], home: {} },
        { id: C(2), file: "cardio", aliases: ["Potassium-Sparing Diuretics", "amiloride"], home: {} },
      ]);
      expect(cardsOf(m, "Potassium-Sparing Diuretics", "Amiloride (combo w/ HCTZ → Moduretic)\nTriamterene (combination with HCTZ)")).toEqual([C(2)]);
      expect(cardsOf(m, "Potassium-Sparing Diuretics", "Amiloride, HCTZ")).toEqual([C(1), C(2)]);
    });

    describe("a drug two classes share goes to the class the row is about", () => {
      // EM GI antiemetics "Dopamine Blockers ‖ Prochlorperazine": her GI phenothiazine card, not her typical antipsychotic card.
      const phenothiazine = { id: C(1), file: "gi", aliases: ["phenothiazines", "prochlorperazine"], home: {}, classWords: ["antiemetics"] };
      const typical = { id: C(2), file: "bh", aliases: ["typical antipsychotics", "prochlorperazine", "haloperidol"], home: {}, classWords: ["antipsychotics"] };
      const m = new CardMatcher([phenothiazine, typical]);

      it("by her class word in the row, its heading or the section title", () => {
        expect(cardsOf(m, "Dopamine Blockers", "Prochlorperazine", { title: "Anti-diarrheals & antiemetics" })).toEqual([C(1)]);
        expect(cardsOf(m, "Dopamine Blockers", "Prochlorperazine", { title: "Antipsychotics" })).toEqual([C(2)]);
        expect(cardsOf(m, "Dopamine Blockers", "Prochlorperazine")).toEqual([]);
      });

      it("by the section's own med list (its Overview and LO), above a class word", () => {
        expect(cardsOf(m, "Dopamine Blockers", "Prochlorperazine", { title: "Antipsychotics", lists: ["gi"] })).toEqual([C(1)]);
      });

      it("in a section without Overview or LO, by the med list a card of its rows comes from by an unshared drug", () => {
        const withPromethazine = new CardMatcher([{ ...phenothiazine, aliases: [...phenothiazine.aliases, "promethazine"] }, typical]);
        expect(cardsOf(withPromethazine, "Dopamine Blockers", "Prochlorperazine, promethazine")).toEqual([C(1)]);
      });
    });

    it("a row a card of the section's own list is about keeps only that list's cards and the cards its label names", () => {
      // IBD "Anti-TNF agents: Infliximab Adalimumab Golimumab": not her rheumatology biologics card;
      // heart failure "Hydralazine & Nitrates:" keeps her nitrate card.
      const antiTnf = { id: C(1), file: "gi", aliases: ["Anti-TNF agents", "infliximab", "adalimumab"], home: {} };
      const biologics = { id: C(2), file: "rheum", aliases: ["bDMARDs", "golimumab"], home: {} };
      const m = new CardMatcher([antiTnf, biologics]);
      expect(cardsOf(m, "Anti-TNF agents: Infliximab Adalimumab Golimumab", "", { lists: ["gi"] })).toEqual([C(1)]);
      const hydralazine = { id: C(3), file: "cardio", aliases: ["hydralazine"], home: {} };
      const nitrates = { id: C(4), file: "cardio-2", aliases: ["Nitrates", "isosorbide mononitrate"], home: {} };
      expect(cardsOf(new CardMatcher([hydralazine, nitrates]), "Hydralazine & Nitrates: hydralazine", "", { lists: ["cardio"] })).toEqual([C(3), C(4)]);
    });

    it("a card written for other diseases than the row, its heading or the section names never stays", () => {
      // IBD "S1P modulators: ozanimod" is not her MS card.
      const ms = new CardMatcher([{ id: C(1), file: "neuro", aliases: ["ozanimod"], home: {}, diseases: ["multiple sclerosis"] }]);
      expect(cardsOf(ms, "S1P modulators: ozanimod", "", { title: "Inflammatory bowel disease" })).toEqual([]);
      expect(cardsOf(ms, "S1P modulators: ozanimod", "", { title: "Multiple sclerosis" })).toEqual([C(1)]);
    });
  });

  it("a class card stands for its group: members' aliases match it, members list after it, its files are theirs", () => {
    const m = new CardMatcher([
      { id: C(5), file: "b", aliases: ["DHP"], home: {}, in: C(6) },
      { id: C(6), file: "a", aliases: ["CCB"], home: {} },
      { id: C(7), file: "c", aliases: ["Class IV"], home: {}, in: C(6) },
    ]);
    expect(m.cards.map((c) => c.id)).toEqual([C(6)]);
    expect(m.all.map((c) => c.id)).toEqual([C(5), C(6), C(7)]);
    expect(m.matching("Class IV agents")).toEqual([C(6)]);
    expect(m.named("start a DHP")).toEqual([C(6)]);
    expect(m.membersOf(C(6)).map((c) => c.id)).toEqual([C(6), C(5), C(7)]);
    expect([m.classOf(C(5)), m.classOf(C(6))]).toEqual([C(6), C(6)]);
    expect(m.filesOf(C(6))).toEqual(new Set(["a", "b", "c"]));
  });

  it("a card shown inside another publishes as one card: its notes stack after the class card's, wherever either was placed", () => {
    const c = mutated((x) => {
      const nitrates = x.cards.cards.find((k) => k.id === C(2));
      if (nitrates) nitrates.in = C(1);
    });
    const pub = publish(c);
    const fm = pub.files.get("g/fm/s/cardiovascular.json") as SystemJson;
    expect(fm.pharm?.sections[0]?.cards).toEqual([C(1), C(3)]);
    expect(fm.cards[C(2)]).toBeUndefined();
    expect(fm.cards[C(1)]?.parts).toEqual([
      { id: P(2), blocks: [B(71)], file: "cardio med list", basePt: 11 },
      { id: P(3), blocks: [B(72)], file: "cardio med list", basePt: 11 },
    ]);
    const hosts = pub.files.get("hosts.json") as HostsJson;
    expect(hosts[C(2)]?.route).toBe(hosts[C(1)]?.route);
    expect(hosts[B(72)]?.route).toBe(hosts[C(1)]?.route);
  });

  describe("a card written for one use (`for`)", () => {
    /** Nitrates (C2) shown inside the beta-blocker card (C3), its notes written for PANCE's Beta blockers section. */
    const forBeta = (use: string[]) =>
      mutated((x) => {
        const nitrates = x.cards.cards.find((k) => k.id === C(2));
        if (nitrates) Object.assign(nitrates, { in: C(3), for: use });
      });

    it("publishes the part's `for`, and hosts the part where it shows: the class card at its first section using that use", () => {
      const pub = publish(forBeta(["beta-blockers"]));
      const fm = pub.files.get("g/fm/s/cardiovascular.json") as SystemJson;
      expect(fm.cards[C(3)]?.parts.map((p) => [p.id, p.for])).toEqual([[P(4), undefined], [P(3), ["beta-blockers"]]]);
      const hosts = pub.files.get("hosts.json") as HostsJson;
      // The card's own home stays its first placement (FM Antianginals); the part's is PANCE Beta blockers.
      expect(hosts[C(3)]?.route).toBe(`#/eor/fm/pharm/cardiovascular/antianginals/${C(3)}`);
      expect([hosts[P(3)]?.route, hosts[B(72)]?.route, hosts[C(2)]?.route]).toEqual(Array(3).fill(`#/pance/pharm/cardiovascular/beta-blockers/${C(3)}`));
      expect(hosts[P(4)]?.route).toBe(hosts[C(3)]?.route);
      const unit = pub.units.find((u) => u.at === P(3));
      expect(unit).toMatchObject({ route: `#/pance/pharm/cardiovascular/beta-blockers/${C(3)}` });
    });

    it("fails the build naming the card for a section no guide has, and the part whose card is placed in none of its sections", () => {
      expect(buildError(() => publish(forBeta(["no-such-section"]))).id).toBe(C(2));
      const c = mutated((x) => {
        const nitrates = x.cards.cards.find((k) => k.id === C(2));
        // C1 (CCB) is placed only in FM Antianginals, never in PANCE Beta blockers.
        if (nitrates) Object.assign(nitrates, { in: C(1), for: ["beta-blockers"] });
      });
      expect(buildError(() => publish(c)).id).toBe(P(3));
    });
  });

  describe("condition sections and the pharm sections that treat them (uses.json conditions)", () => {
    it("publishes each system's map, sections without an entry key being the empty key", () => {
      expect(page("fm", "cardiovascular").panelSections).toEqual({ cad: ["antianginals"], other: ["antianginals"] });
      expect(page("pance", "cardiovascular").panelSections).toEqual({ "": ["beta-blockers"] });
      expect(page("fm", "renal").panelSections).toEqual({});
    });

    it.each([
      ["a missing condition section", (u: UsesFile) => u.conditions.splice(1, 1), /fm\/cardiovascular\/other has no entry/],
      ["an unknown condition section", (u: UsesFile) => u.conditions.push({ guide: "fm", system: "cardiovascular", section: "nope", for: [] }), /names no condition section/],
      ["a pharm section the system lacks", (u: UsesFile) => { u.conditions[0] = { ...(u.conditions[0] as UsesFile["conditions"][number]), for: ["beta-blockers"] }; }, /names pharm section "beta-blockers"/],
      ["a system without drug tables", (u: UsesFile) => u.conditions.push({ guide: "fm", system: "renal", section: null, for: [] }), /names no system with drug tables/],
    ])("fails the build on %s", (_name, change, message) => {
      const err = buildError(() => publish(mutated((x) => { change(x.uses); })));
      expect(err.id).toBe("content/pharm/uses.json");
      expect(err.message).toMatch(message);
    });
  });

  it("a page carries the line uses of the card notes it shows", () => {
    const c = mutated((x) => {
      x.uses.lines = [
        { block: B(73), text: "MOA: beta-1 blockade", for: ["beta-blockers"] },
        // Not a card block: an Overview part's.
        { block: B(70), text: "Antianginal overview", for: ["antianginals"] },
      ];
    });
    const pance = publish(c).files.get("g/pance/s/cardiovascular.json") as SystemJson;
    expect(pance.uses).toEqual({ [B(73)]: [{ text: "MOA: beta-1 blockade", for: ["beta-blockers"] }] });
  });

  it("card order follows table rows, then `also`", () => {
    const ps = page("fm", "cardiovascular").pharm?.sections[0];
    // Nitroglycerin → Nitrates (C2), Amlodipine → CCB (C1), Ranolazine → none; C3 is FM Antianginals' `also`.
    expect(ps).toMatchObject({ id: "antianginals", cards: [C(2), C(1), C(3)], alsoFrom: 2 });
    expect(page("pance", "cardiovascular").pharm?.sections[0]?.cards).toEqual([C(3)]);
  });

  it("a card unplaced in a home guide goes to that home system's pharm sections it is written for, never another class's", () => {
    const unplaced = (card: Partial<Card>) =>
      mutated((x) => {
        const ps = system(x, "fm", "cardiovascular").structure.pharmSections[0];
        if (ps) ps.also = [];
        const beta = x.cards.cards.find((k) => k.id === C(3));
        if (beta) Object.assign(beta, card);
      });
    // Beta blockers (C3, at home in FM Cardiovascular) is placed by PANCE's table only, so FM gets nothing.
    expect((publish(unplaced({})).files.get("g/fm/s/cardiovascular.json") as SystemJson).pharm?.sections[0]?.cards).toEqual([C(2), C(1)]);
    expect((publish(unplaced({ for: ["antianginals", "beta-blockers"] })).files.get("g/fm/s/cardiovascular.json") as SystemJson).pharm?.sections[0]?.cards).toEqual([C(2), C(1), C(3)]);
  });

  it("an explicit `also` card follows the table cards", () => {
    const c = mutated((x) => {
      const ps = system(x, "pance", "cardiovascular").structure.pharmSections[0];
      if (ps) ps.also = [C(2)];
    });
    expect((publish(c).files.get("g/pance/s/cardiovascular.json") as SystemJson).pharm?.sections[0]?.cards).toEqual([C(3), C(2)]);
  });

  it("a page carries its cards' judged lines with only the covering rows on that page", () => {
    const c = mutated((x) => {
      x.trims = {
        v: 1,
        rows: { [R(500)]: "Metoprolol | beta-1", [R(1)]: "elsewhere" },
        lines: [
          { block: B(73), text: "MOA: beta-1 blockade", label: false, rows: [R(500), R(1)] },
          { block: B(73), text: "Beta Blockers", label: true, rows: [] },
          // Covered only by a row of another page: dropped here.
          { block: B(73), text: "Other line", label: false, rows: [R(1)] },
          // Not a card block of this page.
          { block: B(70), text: "Antianginal overview", label: false, rows: [R(500)] },
        ],
      };
    });
    const pance = publish(c).files.get("g/pance/s/cardiovascular.json") as SystemJson;
    expect(pance.trims).toEqual({
      [B(73)]: [
        { text: "MOA: beta-1 blockade", label: false, rows: [{ id: R(500), text: "Metoprolol | beta-1" }] },
        { text: "Beta Blockers", label: true, rows: [] },
      ],
    });
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

  it("an Overview part and its blocks are hosted on a route that opens the Overview card", () => {
    const hosts = file<HostsJson>("hosts.json");
    const route = `#/eor/fm/pharm/cardiovascular/antianginals/${P(1)}`;
    expect(hosts[P(1)]?.route).toBe(route);
    expect(hosts[B(70)]?.route).toBe(route);
    expect(out.units.find((u) => u.title === "Overview")?.route).toBe(route);
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

  it("meds panel: her drug name names its card (diltiazem → the CCB card), not the card's row of another drug (Amlodipine)", () => {
    expect(meds(R(101))).toEqual([{ card: C(1), title: "Calcium Channel Blockers", rows: [], section: "antianginals", system: "cardiovascular", target: C(1) }]);
  });

  it("a condition-row topic has no following table: only same-system alias rows, and never a condition row", () => {
    expect(meds(R(123))).toEqual([{ card: C(1), title: "Calcium Channel Blockers", rows: [R(120), R(122)], section: "antianginals", system: "cardiovascular", target: C(1) }]);
  });

  it("a topic after the system's last drug table, naming no drug, has no meds", () => {
    expect(meds(R(131))).toEqual([]);
  });

  it("Treats lists the condition topics drawing on the section's tables, in guide order; the system pharm page lists sections then files", () => {
    const pharm = page("fm", "cardiovascular").pharm;
    expect(pharm?.sections.map((s) => [s.id, s.treats])).toEqual([["antianginals", [R(104), R(123)]]]);
    expect(pharm?.files).toEqual({ files: [{ id: D(1), name: "ACLS algorithms", kind: "pdf", route: `#/file/${D(1)}` }], removed: [], pending: [] });
  });

  describe("a pharm file made from her Word page (`page`), with parts cutting her table", () => {
    const PAGE = PHARM_PAGE;
    const where = "content/pharm/pharm-review/pharmfile.json";
    /** The fixture plus her page "pharm review", made into pharm notes (writePharmReviewPage). */
    let pc: Content;
    beforeAll(async () => {
      const r = await mkdtemp(join(tmpdir(), "pa-derive-page-"));
      try {
        await writeFixture(r);
        await writePharmReviewPage(r);
        pc = await loadContent(r);
      } finally {
        await rm(r, { recursive: true, force: true });
      }
    });
    const reviewFile = (c: Content) => {
      const pf = c.pharm.find((p) => p.file.id === "pharm-review");
      if (!pf) throw new Error("pharm-review");
      return pf;
    };
    const withReview = (f: (pf: Content["pharm"][number], c: Content) => void): Content => {
      const c = structuredClone(pc);
      f(reviewFile(c), c);
      return c;
    };

    it("loads its blocks from her page, where they are stored once", () => {
      const pageDoc = pc.docs.get(PAGE);
      expect(reviewFile(pc).blocks).toEqual(pageDoc?.kind === "word" ? pageDoc.blocks : null);
    });

    it("publishes each card part with its rows, her table once in the page's notes, and her page hosting her blocks", () => {
      const pub = publish(pc);
      const fm = pub.files.get("g/fm/s/cardiovascular.json") as SystemJson;
      expect(fm.cards[C(80)]?.parts).toEqual([{ id: P(81), blocks: [B(81)], rows: [R(810), R(811)], file: "pharm review", basePt: 11 }]);
      expect(fm.cards[C(81)]?.parts).toEqual([{ id: P(82), blocks: [B(81)], rows: [R(814), R(812), R(813)], file: "pharm review", basePt: 11 }]);
      expect(Object.keys(fm.notesBlocks)).toContain(B(81));
      const hosts = pub.files.get("hosts.json") as HostsJson;
      expect(hosts[B(81)]?.route).toBe(`#/file/${PAGE}`);
      expect(hosts[P(81)]?.route).toBe(`#/eor/fm/pharm/cardiovascular/antianginals/${C(80)}`);
    });

    it("hosts her blocks on the card showing them when her page is listed nowhere", () => {
      const unlisted = withReview((_pf, c) => { system(c, "fm", "renal").structure.pharmFiles = [D(2)]; });
      const hosts = publish(unlisted).files.get("hosts.json") as HostsJson;
      expect(hosts[PAGE]).toBeUndefined();
      expect(hosts[B(81)]?.route).toMatch(/^#\/eor\/fm\/pharm\/cardiovascular\/antianginals\//);
    });

    it("indexes a row part's search unit with only the rows it lists: its group's heading row and its own rows", () => {
      const units = publish(pc).units;
      const has = (at: string) => {
        const text = units.find((u) => u.at === at)?.text ?? "";
        return ["ANTICOAGULANTS", "Warfarin", "OTHER AGENTS", "Apixaban", "Heparin"].map((w) => text.includes(w));
      };
      expect(has(P(81))).toEqual([true, true, false, false, false]);
      // The table's first row heads the other group, so this part leaves it out.
      expect(has(P(82))).toEqual([false, false, true, true, true]);
    });

    it.each([
      ["a second pharm file made from the same page", (pf: Content["pharm"][number], c: Content) => c.pharm.push({ ...structuredClone(pf), file: { ...structuredClone(pf.file), id: "pharm-review-2" } }), PAGE, /pharm files pharm-review and pharm-review-2 are both made from Word page/],
      ["a page that is not a Word page", (pf: Content["pharm"][number]) => { pf.file.page = D(1); }, D(1), /is made from d_0000000001, which is not a Word page/],
      ["a block another page owns", (pf: Content["pharm"][number]) => { pf.file.blocks.push(B(60)); }, B(60), /lists b_0000000060, which is not a block of d_0000000008/],
      ["rows cut from a block that is not a table", (pf: Content["pharm"][number]) => { Object.assign(pf.file.parts[0] as object, { rows: [R(811)] }); }, P(80), /part p_0000000080 cuts b_0000000080, which is not a table/],
    ])("fails the build on %s", (_name, change, id, message) => {
      const err = buildError(() => publish(withReview(change)));
      expect([err.id, err.message]).toEqual([id, expect.stringMatching(message)]);
    });

    it("drops a row, or a block, gone from her page, and shows the rest", () => {
      const res = publish(withReview((pf) => {
        Object.assign(pf.file.parts[1] as object, { rows: [R(810), R(811), GONE] });
        pf.file.blocks.push(B(82));
        (pf.file.parts[2] as { blocks: string[] }).blocks = [B(81)];
      }));
      expect(res.dropped).toContainEqual({ file: where, id: GONE });
      expect((res.files.get("g/fm/s/cardiovascular.json") as SystemJson).cards[C(80)]?.parts[0]?.rows).toEqual([R(810), R(811)]);
      // Every row of a part gone: the part shows nothing, as when its block went, and indexes nothing.
      const emptied = publish(withReview((pf) => { Object.assign(pf.file.parts[2] as object, { rows: [GONE] }); }));
      expect((emptied.files.get("g/fm/s/cardiovascular.json") as SystemJson).cards[C(81)]?.parts).toEqual([{ id: P(82), blocks: [], file: "pharm review", basePt: 11 }]);
      expect(emptied.units.find((u) => u.at === P(82))?.text ?? "").toBe("");
      const gone = publish(withReview((pf) => {
        pf.file.blocks.splice(1, 0, B(82));
        (pf.file.parts[0] as { blocks: string[] }).blocks = [B(80), B(82)];
      }));
      expect(gone.dropped).toContainEqual({ file: where, id: B(82) });
    });

    it("publishes a card part's column range (`columns`) with its cut, and shows nothing once the range no longer fits her table", () => {
      const ranged = (column: number, columns: number) => withReview((pf) => { Object.assign(pf.file.parts[1] as object, { column, columns }); });
      const fm = publish(ranged(0, 2)).files.get("g/fm/s/cardiovascular.json") as SystemJson;
      expect(fm.cards[C(80)]?.parts).toEqual([{ id: P(81), blocks: [B(81)], rows: [R(810), R(811)], column: 0, columns: 2, file: "pharm review", basePt: 11 }]);
      // Her table has 3 columns: columns 1–3 run past it.
      const out = publish(ranged(1, 3));
      expect(out.dropped).toContainEqual({ file: where, id: P(81) });
      expect(out.units.find((u) => u.at === P(81))?.text ?? "").toBe("");
    });

    describe("a topic part, shown on the meds panels of the guide topics it names", () => {
      /** Her apixaban row's MOA cell becomes a topic part on Stable angina (R101); the card part keeps heparin. */
      const attach = (topics: string[], cut: { rows: string[]; column: number } = { rows: [R(814), R(812)], column: 2 }) => withReview((pf) => {
        Object.assign(pf.file.parts[2] as object, { rows: [R(814), R(813)] });
        pf.file.parts.push({ id: P(83), role: "topic", title: "Apixaban: MOA", card: null, blocks: [B(81)], ...cut, label: 1, topics });
      });

      it("follows the cards on each named topic's panel, with its part, cut and blocks in the system's notes", () => {
        const fm = publish(attach([R(101)])).files.get("g/fm/s/cardiovascular.json") as SystemJson;
        const panel = fm.topics.find((t) => t.id === R(101))?.meds ?? [];
        expect(panel.at(-1)).toEqual({ card: null, part: P(83), title: "Apixaban: MOA", rows: [], section: null, system: null, target: P(83) });
        expect(panel.slice(0, -1).every((m) => m.part === undefined && m.card !== null)).toBe(true);
        expect(fm.parts[P(83)]).toEqual({ title: "Apixaban: MOA", role: "topic", file: "pharm review", basePt: 11, blocks: [B(81)], rows: [R(814), R(812)], column: 2, label: 1 });
        expect(Object.keys(fm.notesBlocks)).toContain(B(81));
        // Only the topics it names show it.
        expect(fm.topics.filter((t) => t.meds.some((m) => m.part === P(83))).map((t) => t.id)).toEqual([R(101)]);
      });

      it("fails the build on a topic no guide has", () => {
        const err = buildError(() => publish(attach([R(101), GONE])));
        expect([err.id, err.message]).toEqual([P(83), `${P(83)}: pharm part is attached to topic ${GONE}, which no guide has`]);
      });

      it("is left off the panel once its rows have all gone from her table, or its column no longer fits", () => {
        const where = "content/pharm/pharm-review/pharmfile.json";
        for (const [cut, gone] of [
          [{ rows: [R(818), R(819)], column: 2 }, R(818)],
          [{ rows: [R(814), R(812)], column: 9 }, P(83)],
        ] as const) {
          const out = publish(attach([R(101)], { rows: [...cut.rows], column: cut.column }));
          const fm = out.files.get("g/fm/s/cardiovascular.json") as SystemJson;
          expect(fm.topics.find((t) => t.id === R(101))?.meds.some((m) => m.part === P(83))).toBe(false);
          expect(fm.parts[P(83)]).toBeUndefined();
          expect(out.dropped).toContainEqual({ file: where, id: gone });
        }
      });
    });
  });
});

describe("published data and invariants (40 §40.1, §40.8)", () => {
  it("shows a row recorded under a topic with that topic in every published view (ruling 04:44Z)", () => {
    // X is a blank row added above Heart failure (R131) from its topic page. Positionally it would
    // continue Stable angina (R104, section cad) like R130 above it.
    const X = R(132);
    const c = mutated((x) => {
      const s = system(x, "fm", "cardiovascular");
      const block = s.blocks.find((b) => b.id === B(13)) as BlockFile;
      const rowsOf = (block.doc as { content: { content: { attrs: { id: string } }[] }[] }).content[0]?.content ?? [];
      const at = rowsOf.findIndex((r) => r.attrs.id === R(131));
      const copy = structuredClone(rowsOf[at - 1]) as { attrs: { id: string } };
      copy.attrs.id = X;
      const retext = (n: { text?: string; content?: unknown[] }): void => {
        if (n.text === "angina continues here") n.text = "orthopnea clue";
        for (const k of n.content ?? []) retext(k as { text?: string; content?: unknown[] });
      };
      retext(copy as never);
      rowsOf.splice(at, 0, copy);
      s.structure.members[X] = R(131);
    });
    const res = publish(c);
    const sys = res.files.get("g/fm/s/cardiovascular.json") as SystemJson;
    const topicOf = (id: string) => sys.topics.find((t) => t.id === id);
    // topic page and system page
    expect(sys.rows[X]?.topic).toBe(R(131));
    expect(topicOf(R(131))?.rows).toEqual([X, R(131)]);
    expect(topicOf(R(104))?.rows).not.toContain(X);
    // section pages
    const items = (sec: string) => sys.sections.find((s) => s.id === sec)?.items.flatMap((i) => i.rows ?? []) ?? [];
    expect(items("other")).toContain(X);
    expect(items("cad")).not.toContain(X);
    // hosts (search results, links, the PDF's internal links)
    const hosts = res.files.get("hosts.json") as HostsJson;
    expect(hosts[X]).toEqual(hosts[R(131)]);
    // search units
    const unit = (title: string) => res.units.find((u) => u.title === title && u.label === "notes");
    expect(unit("Heart failure")?.text).toContain("orthopnea clue");
    expect(unit("Stable angina")?.text).not.toContain("orthopnea clue");
  });

  it("publishes a failed-replacement marker on the document it belongs to, Word or as-is", () => {
    const marker = { fileName: "chart2.png", at: "2026-10-04T20:00:00Z" };
    const c = mutated((x) => {
      for (const id of [D(1), D(5)]) {
        const d = x.docs.get(id);
        if (!d) throw new Error(`no document ${id}`);
        d.file.replaceFailed = marker;
      }
    });
    const res = publish(c);
    expect((res.files.get(docPath(D(1))) as DocJson).replaceFailed).toEqual(marker);
    expect((res.files.get(docPath(D(5))) as DocJson).replaceFailed).toEqual(marker);
    expect(file<DocJson>(docPath(D(1)))).not.toHaveProperty("replaceFailed");
  });

  // `home` is the route the app returns to after Remove (Leader approval, 2026-10-05).
  it("gives each placed document its first placement in site order as `home`, matching its hosts location", () => {
    const hosts = file<HostsJson>(HOSTS_PATH);
    const site = file<SiteJson>(SITE_PATH);
    const cases: [string, string][] = [
      // FM cardiovascular pharm, before Other › Guidelines
      [D(1), guideViewHash("fm", { kind: "pharm", system: "cardiovascular", section: null, target: null })],
      // FM general labs, before the Labs tab
      [D(5), guideViewHash("fm", { kind: "general", key: "labs" })],
      // the PANCE sidebar's end
      [D(3), guideBase("pance")],
    ];
    for (const [id, first] of cases) {
      const home = file<DocJson>(docPath(id)).home;
      expect(home, id).toBe(first);
      expect(fileLocation(site.index, home ?? null), id).toBe(hosts[id]?.loc);
    }
    // Their later placements are not `home`.
    expect(file<DocJson>(docPath(D(1))).home).not.toBe(otherHash("guidelines"));
    expect(file<DocJson>(docPath(D(5))).home).not.toBe(refHash("labs"));
  });

  it("gives a document listed nowhere no `home`", () => {
    const c = mutated((x) => {
      delete guide(x, "pance").file.sidebarEnd;
    });
    expect(publish(c).files.get(docPath(D(3)))).not.toHaveProperty("home");
  });

  it("addDoc lists a removed document as removed (whatever its state), a processing or failed upload as pending, else as a file", () => {
    const list = { files: [], removed: [], pending: [] };
    addDoc(list, D(91), { name: "Gone", kind: "pdf", removed: { at: "2026-10-01T00:00:00Z" }, state: "failed" });
    addDoc(list, D(92), { name: "Busy", kind: "pdf", removed: null, state: "processing" });
    addDoc(list, D(93), { name: "Broken", kind: "pdf", removed: null, state: "failed" });
    addDoc(list, D(94), { name: "Ready", kind: "pdf", removed: null, state: "ready" });
    addDoc(list, D(95), { name: "Word page", kind: "word", removed: null });
    expect(list).toEqual({
      removed: [{ id: D(91), name: "Gone", at: "2026-10-01T00:00:00Z" }],
      pending: [{ id: D(92), name: "Busy", state: "processing" }, { id: D(93), name: "Broken", state: "failed" }],
      files: [{ id: D(94), name: "Ready", kind: "pdf", route: `#/file/${D(94)}` }, { id: D(95), name: "Word page", kind: "word", route: `#/file/${D(95)}` }],
    });
  });

  // Orchestrator ruling 2026-10-04 04:45Z (adds to 60 §60.1).
  it("gives untitled rows and heading rows their own search units, routed to the page that shows them", () => {
    const unit = (at: string) => out.units.find((u) => u.at === at);
    const hosts = file<HostsJson>("hosts.json");
    expect(unit(R(200))).toMatchObject({ title: "Pulmonary", route: hosts[R(200)]?.route, label: "notes", text: " untitled lead" });
    expect(unit(R(100))).toMatchObject({ title: "ARRHYTHMIAS", route: "#/eor/fm/s/cardiovascular", text: "ARRHYTHMIAS Presentation Treatment" });
    // A drug table's heading row is shown on its pharm section.
    expect(unit(R(120))).toMatchObject({ title: "ANTIANGINALS", route: hosts[R(120)]?.route, loc: "EOR › Family Medicine › Cardiovascular pharm" });
    expect(hosts[R(120)]?.route).toMatch(/\/pharm\/cardiovascular\//);
  });

  it("puts every shown text block in at least one search unit, and reports any that is missing", () => {
    expect(uncoveredText(base, out.units, out.files)).toEqual([]);
    // Without the untitled-row and heading-row units, their text is reported.
    const without = out.units.filter((u) => u.at !== R(200) && u.at !== R(100));
    expect(uncoveredText(base, without, out.files)).toEqual([
      { id: R(100), text: "ARRHYTHMIAS" }, { id: R(100), text: "Presentation" }, { id: R(100), text: "Treatment" },
      { id: R(200), text: "untitled lead" },
    ]);
  });

  it("checks text inside text boxes too", () => {
    const c = mutated((x) => {
      const b = system(x, "fm", "cardiovascular").blocks.find((y) => y.id === B(11)) as BlockFile;
      const doc = b.doc as { content: unknown[] };
      // Built through the schema, so the stored form carries every default attribute.
      doc.content.push(schema.nodeFromJSON({
        type: "textbox", attrs: { widthPt: 100 }, content: [{ type: "paragraph", content: [{ type: "text", text: "boxed pearl" }] }],
      }).toJSON());
    });
    const res = publish(c);
    expect(uncoveredText(c, res.units, res.files)).toEqual([]);
    expect(uncoveredText(c, res.units.filter((u) => u.at !== B(11)), res.files)).toContainEqual({ id: B(11), text: "boxed pearl" });
  });

  it("fails naming a structure.json id that does not exist", () => {
    const c = mutated((x) => {
      system(x, "fm", "cardiovascular").structure.members[GONE] = "cad";
    });
    expect(buildError(() => publish(c)).id).toBe(GONE);
  });

  it("publishes a gap block's figures without their evidence, ships their files and makes the captions searchable", () => {
    const asset = `${"e1".repeat(16)}.png`;
    const figure = {
      asset, width: 900, height: 300, caption: "Atrial fibrillation rhythm strip",
      credit: { author: "Jane Roe", license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", page: "https://commons.wikimedia.org/wiki/File:AF.png", changes: null },
      evidence: { quote: "Atrial fibrillation", accessed: "2026-10-05" },
    };
    const c = mutated((x) => {
      const g = x.gaps.get(G(1));
      if (g) g.block.meta.figures = [figure];
    });
    const res = publish(c);
    const labs = res.files.get(refPath("labs")) as { subs: { gaps: { id: string; figures: unknown[] }[] }[] };
    const published = { asset, width: 900, height: 300, caption: figure.caption, credit: figure.credit };
    expect(labs.subs[0]?.gaps.find((g) => g.id === G(1))?.figures).toEqual([published]);
    expect(labs.subs[0]?.gaps.find((g) => g.id === G(1))?.figures[0]).not.toHaveProperty("evidence");
    expect(res.assets.has(asset)).toBe(true);
    expect(res.units.find((u) => u.at === G(1))?.text).toContain("Atrial fibrillation rhythm strip");
    // A block without figures publishes an empty list and ships nothing extra.
    expect(publish(base).assets.has(asset)).toBe(false);
  });

  it("publishes a figure's shown width when set, and a box shown as her notes with asNotes and a notes search label", () => {
    const asset = `${"e2".repeat(16)}.png`;
    const figure = {
      asset, width: 900, height: 300, caption: "Hexaxial", widthPt: 300,
      credit: { author: "Jane Roe", license: "Public domain", licenseUrl: null, page: "https://commons.wikimedia.org/wiki/File:H.png", changes: null },
      evidence: { quote: "Hexaxial", accessed: "2026-10-05" },
    };
    const c = mutated((x) => {
      const g = x.gaps.get(G(1));
      if (g) g.block.meta = { ...g.block.meta, figures: [figure], asNotes: true };
    });
    const res = publish(c);
    const labs = res.files.get(refPath("labs")) as { subs: { gaps: { id: string; asNotes: boolean; figures: { widthPt?: number }[] }[] }[] };
    const gaps = labs.subs[0]?.gaps ?? [];
    expect(gaps.find((g) => g.id === G(1))?.figures[0]?.widthPt).toBe(300);
    expect(gaps.find((g) => g.id === G(1))?.figures[0]).not.toHaveProperty("heightPt");
    expect(gaps.find((g) => g.id === G(1))?.asNotes).toBe(true);
    // A squished or stretched figure publishes its height too.
    const squished = publish(mutated((x) => {
      const g = x.gaps.get(G(1));
      if (g) g.block.meta = { ...g.block.meta, figures: [{ ...figure, heightPt: 40 }] };
    }));
    const squishedLabs = squished.files.get(refPath("labs")) as { subs: { gaps: { id: string; figures: { widthPt?: number; heightPt?: number }[] }[] }[] };
    expect(squishedLabs.subs[0]?.gaps.find((g) => g.id === G(1))?.figures[0]).toMatchObject({ widthPt: 300, heightPt: 40 });
    expect(res.units.find((u) => u.at === G(1))?.label).toBe("notes");
    // Unswitched boxes keep the gap label and publish asNotes false.
    const plain = publish(base);
    const plainLabs = plain.files.get(refPath("labs")) as { subs: { gaps: { id: string; asNotes: boolean }[] }[] };
    expect(plainLabs.subs[0]?.gaps.find((g) => g.id === G(1))?.asNotes).toBe(false);
    expect(plain.units.find((u) => u.at === G(1))?.label).toBe("gap");
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

  it("writes every published file at the path its shared builder gives, using every builder", () => {
    const expected = new Map<string, string>([[SITE_PATH, "site"], [HOSTS_PATH, "hosts"], [UPDATES_PATH, "updates"], [OTHER_PATH, "other"]]);
    for (const g of base.guides) {
      const gid = g.file.id;
      expected.set(homePath(gid), "home").set(navPath(gid), "nav").set(workupPath(gid), "workup").set(slidesPath(gid), "slides");
      for (const s of g.systems) expected.set(systemPath(gid, s.file.id), "system");
      for (const key of GENERAL_KEYS) expected.set(generalPath(gid, key), "general");
    }
    for (const tab of REF_TABS) expected.set(refPath(tab), "ref");
    for (const id of base.docs.keys()) expected.set(docPath(id), "doc");
    const kinds = new Set<string>();
    for (const path of out.files.keys()) {
      expect(expected.has(path), path).toBe(true);
      kinds.add(expected.get(path) as string);
    }
    expect([...kinds].sort()).toEqual(["doc", "general", "home", "hosts", "nav", "other", "ref", "site", "slides", "system", "updates", "workup"]);
  });

  it("REF_PATH_RE matches exactly the reference tab paths refPath builds", () => {
    for (const tab of REF_TABS) expect(REF_PATH_RE.exec(refPath(tab))?.groups?.tab).toBe(tab);
    const others = [...out.files.keys()].filter((p) => !REF_TABS.some((tab) => p === refPath(tab)));
    expect(others.length).toBeGreaterThan(10);
    for (const p of [...others, refPath("nope"), `x/${refPath("labs")}`, `${refPath("labs")}.bak`]) expect(REF_PATH_RE.test(p), p).toBe(false);
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

describe("her Word-page blocks shown as notes on place pages (PlaceNote)", () => {
  const CBC = refHash("labs", "cbc");
  const VITAMINS = otherHash("vitamins");
  /** The fixture with the Thyroid notes table on Labs › CBC (twice: whole, then its column 1) and its prose block on Other › Vitamins. */
  const withNotes = (): Content => mutated((x) => {
    const cbc = x.reftabs.labs.subs[0] as (typeof x.reftabs.labs.subs)[number];
    cbc.notes = [{ heading: "Thyroid" }, { block: B(61) }, { block: B(61), column: 1 }];
    const vitamins = x.other.sections.find((s) => s.id === "vitamins") as (typeof x.other.sections)[number];
    vitamins.notes = [{ block: B(60) }];
  });

  it("publishes each note in order with its block and its Word page's base size; a place without notes has none", () => {
    const res = publish(withNotes());
    const ref = res.files.get(refPath("labs")) as { subs: { notes: unknown[] }[] };
    const t61 = (out.files.get(docPath(D(5))) as DocJson).blocks?.[1];
    expect(t61?.id).toBe(B(61));
    expect(ref.subs[0]?.notes).toEqual([
      { heading: "Thyroid" },
      { block: t61, basePt: 11, column: null, rows: null },
      { block: t61, basePt: 11, column: 1, rows: null },
    ]);
    const other = res.files.get(OTHER_PATH) as OtherJson;
    expect(other.sections.find((s) => s.id === "vitamins")?.notes.map((n) => ("block" in n ? n.block.id : n))).toEqual([B(60)]);
    expect(other.sections.find((s) => s.id === "emergency")?.notes).toEqual([]);
    expect(file<OtherJson>(OTHER_PATH).sections.every((s) => s.notes.length === 0)).toBe(true);
  });

  it("opens a block shown as notes on its place page, and search finds it there instead of on the File page", () => {
    const c = withNotes();
    const res = publish(c);
    const hosts = res.files.get(HOSTS_PATH) as HostsJson;
    expect(hosts[B(61)]).toEqual({ route: CBC, loc: "Labs › CBC" });
    expect(hosts[B(60)]?.route).toBe(VITAMINS);
    expect(hosts[D(5)]?.route).toBe(`#/file/${D(5)}`);
    // The table's rows are found on Labs › CBC once (not once per note), the prose block on Vitamins.
    expect(res.units.filter((u) => u.route === CBC && u.label === "notes").map((u) => [u.at, u.title, u.tab])).toEqual([
      [R(600), "CBC", "labs"], [R(601), "CBC", "labs"],
    ]);
    expect(res.units.filter((u) => u.route === VITAMINS).map((u) => [u.at, u.title, u.tab])).toEqual([[B(60), "Vitamins", "other"]]);
    expect(res.units.filter((u) => u.route === `#/file/${D(5)}`)).toEqual([]);
    expect(uncoveredText(c, res.units, res.files)).toEqual([]);
  });

  it("publishes a sub's group and intro (null when it has none) and puts the group in its location", () => {
    expect((out.files.get(refPath("labs")) as RefTabJson).subs.every((s) => s.group === null && s.intro === null)).toBe(true);
    const res = publish(mutated((x) => {
      const cbc = x.reftabs.labs.subs[0] as (typeof x.reftabs.labs.subs)[number];
      cbc.notes = [{ block: B(61) }];
      cbc.group = "Blood";
      cbc.intro = cbc.gaps.slice(0, 1);
    }));
    const sub = (res.files.get(refPath("labs")) as RefTabJson).subs[0];
    expect([sub?.group, sub?.intro, sub?.gaps.slice(0, 1).map((g) => g.id)]).toEqual(["Blood", [G(1)], [G(1)]]);
    expect((res.files.get(HOSTS_PATH) as HostsJson)[B(61)]).toEqual({ route: CBC, loc: "Labs › Blood › CBC" });
  });

  describe("a note showing some rows of a table", () => {
    /** The Thyroid table's header row on Labs › CBC, and its content row R(601) (with a row no longer in it) on Other › Vitamins. */
    const split = (): Content => mutated((x) => {
      (x.reftabs.labs.subs[0] as (typeof x.reftabs.labs.subs)[number]).notes = [{ block: B(61), rows: [R(600)] }];
      (x.other.sections.find((s) => s.id === "vitamins") as (typeof x.other.sections)[number]).notes = [{ block: B(61), rows: [R(699), R(601)] }];
    });

    it("publishes its rows, dropping a listed row the table no longer has", () => {
      const res = publish(split());
      const vit = (res.files.get(OTHER_PATH) as OtherJson).sections.find((s) => s.id === "vitamins")?.notes[0];
      expect(vit && "block" in vit ? [vit.block.id, vit.column, vit.rows] : vit).toEqual([B(61), null, [R(601)]]);
      expect(res.dropped).toContainEqual({ file: "content/places/other.json", id: R(699) });
    });

    it("hosts and finds a row on the first page showing it, the block and its other rows where the block first shows", () => {
      const c = split();
      const res = publish(c);
      const hosts = res.files.get(HOSTS_PATH) as HostsJson;
      expect(hosts[B(61)]?.route).toBe(CBC);
      expect(hosts[R(601)]).toEqual({ route: VITAMINS, loc: "Other › Vitamins" });
      // A row hosted with its block gets no entry of its own.
      expect(hosts[R(600)]).toBeUndefined();
      expect(res.units.filter((u) => u.at === R(600) || u.at === R(601)).map((u) => [u.at, u.route, u.title, u.tab])).toEqual([
        [R(600), CBC, "CBC", "labs"], [R(601), VITAMINS, "Vitamins", "other"],
      ]);
      expect(uncoveredText(c, res.units, res.files)).toEqual([]);
    });
  });

  it("drops a note whose block is on no shown Word page, and hosts nothing for it", () => {
    const c = mutated((x) => {
      (x.reftabs.labs.subs[0] as (typeof x.reftabs.labs.subs)[number]).notes = [{ block: B(60) }, { block: GONE }];
      const d5 = x.docs.get(D(5));
      if (d5) d5.file.removed = { at: "2026-10-05T10:00:00Z", from: "b".repeat(40) };
    });
    const res = publish(c);
    expect((res.files.get(refPath("labs")) as { subs: { notes: unknown[] }[] }).subs[0]?.notes).toEqual([]);
    expect(res.dropped).toContainEqual({ file: "content/places/reftabs.json", id: B(60) });
    expect(res.dropped).toContainEqual({ file: "content/places/reftabs.json", id: GONE });
    expect((res.files.get(HOSTS_PATH) as HostsJson)[B(60)]).toBeUndefined();
  });
});

describe("an Other section's outline (parts, docs, gaps and links)", () => {
  type Sec = Content["other"]["sections"][number];
  const section = (x: Content, id: string): Sec => {
    const s = x.other.sections.find((v) => v.id === id);
    if (!s) throw new Error(`no ${id} section`);
    return s;
  };
  /** Physical exam with Thyroid notes (Word) and ACLS algorithms (PDF) under headings, a gap and a link. */
  const withOutline = (more: (x: Content) => void = () => {}): Content => mutated((x) => {
    Object.assign(section(x, "pe"), {
      files: [D(5), D(1)],
      gaps: [G(1)],
      links: [{ target: R(101), covers: "AF" }],
      notes: [
        { heading: "Cardiac" },
        { doc: D(5) },
        { heading: "Exam", sub: true },
        { gap: G(1) },
        { heading: "Pulmonary" },
        { heading: "Exam", sub: true },
        { doc: D(1) },
        { link: R(101) },
        { heading: "Pulmonary" },
      ],
    });
    more(x);
  });
  const notesOf = (res: ReturnType<typeof publish>, id: string): OtherJson["sections"][number]["notes"] =>
    (res.files.get(OTHER_PATH) as OtherJson).sections.find((s) => s.id === id)?.notes ?? [];
  /** Takes G(1) off the guide topic and the Labs sub that list it before Other, so its first home is Physical exam. */
  const gapOnlyOnOther = (x: Content): void => {
    for (const g of x.guides) for (const t of g.general?.topics ?? []) t.gaps = t.gaps.filter((id) => id !== G(1));
    for (const s of x.reftabs.labs.subs) s.gaps = s.gaps.filter((id) => id !== G(1));
  };

  it("gives each heading a part id unique in its section, a sub heading's prefixed with its top heading's", () => {
    const notes = notesOf(publish(withOutline()), "pe");
    expect(notes.filter((n) => "heading" in n)).toEqual([
      { heading: "Cardiac", sub: false, id: "cardiac" },
      { heading: "Exam", sub: true, id: "cardiac-exam" },
      { heading: "Pulmonary", sub: false, id: "pulmonary" },
      { heading: "Exam", sub: true, id: "pulmonary-exam" },
      { heading: "Pulmonary", sub: false, id: "pulmonary-2" },
    ]);
  });

  it("never gives Guidelines a part named `updates`: that is the Updated guidelines route", () => {
    const res = publish(withOutline((x) => {
      Object.assign(section(x, "guidelines"), { notes: [{ heading: "Updates" }, { doc: D(1) }] });
    }));
    expect(notesOf(res, "guidelines")[0]).toEqual({ heading: "Updates", sub: false, id: "updates-2" });
    expect(parseHash(otherHash("guidelines", "updates-2"))).toMatchObject({ kind: "other", section: "guidelines", part: "updates-2" });
    expect(parseHash("#/other/guidelines/updates").kind).toBe("updates");
    expect(parseHash("#/other/pe")).toMatchObject({ kind: "other", section: "pe", part: null });
    expect(parseHash("#/other")).toMatchObject({ kind: "other", section: null, part: null });
    expect(otherHash("pe", "cardiac-exam")).toBe("#/other/pe/cardiac-exam");
    expect(otherHash("pe", null)).toBe("#/other/pe");
  });

  it("publishes doc items as the section's file entries, gap items as gap blocks and link items as its links", () => {
    const res = publish(withOutline());
    const pe = (res.files.get(OTHER_PATH) as OtherJson).sections.find((s) => s.id === "pe");
    const items = notesOf(res, "pe").filter((n) => !("heading" in n));
    expect(items).toEqual([
      { doc: pe?.files.files.find((f) => f.id === D(5)) },
      { gap: pe?.gaps?.[0] },
      { doc: pe?.files.files.find((f) => f.id === D(1)) },
      { link: pe?.links[0] },
    ]);
    expect(items.map((n) => ("doc" in n ? n.doc.id : "gap" in n ? n.gap.id : "link" in n ? n.link.target : null))).toEqual([D(5), G(1), D(1), R(101)]);
  });

  it("publishes an original item as the section's file entry, and leaves it out when the file is removed", () => {
    const withOriginal = (more: (x: Content) => void = () => {}): Content => withOutline((x) => {
      const pe = section(x, "pe");
      pe.notes = [...(pe.notes ?? []), { original: D(5) }];
      more(x);
    });
    const res = publish(withOriginal());
    const files = (res.files.get(OTHER_PATH) as OtherJson).sections.find((s) => s.id === "pe")?.files;
    expect(notesOf(res, "pe").at(-1)).toEqual({ original: files?.files.find((f) => f.id === D(5)) });
    const removed = publish(withOriginal((x) => {
      const d5 = x.docs.get(D(5));
      if (d5) d5.file.removed = { at: "2026-10-05T10:00:00Z", from: "b".repeat(40) };
    }));
    expect(notesOf(removed, "pe").some((n) => "original" in n)).toBe(false);
  });

  it("leaves a removed doc out of the outline; it stays in the section's files", () => {
    const res = publish(withOutline((x) => {
      const d5 = x.docs.get(D(5));
      if (d5) d5.file.removed = { at: "2026-10-05T10:00:00Z", from: "b".repeat(40) };
    }));
    expect(notesOf(res, "pe").some((n) => "doc" in n && n.doc.id === D(5))).toBe(false);
    expect((res.files.get(OTHER_PATH) as OtherJson).sections.find((s) => s.id === "pe")?.files.removed.map((f) => f.id)).toContain(D(5));
  });

  it("opens a doc item's Word blocks and a gap item on their part's page, and search lands there", () => {
    const res = publish(withOutline(gapOnlyOnOther));
    const hosts = res.files.get(HOSTS_PATH) as HostsJson;
    const cardiac = otherHash("pe", "cardiac");
    expect(hosts[B(60)]).toEqual({ route: cardiac, loc: "Other › Physical exam" });
    expect(hosts[B(61)]?.route).toBe(cardiac);
    expect(hosts[G(1)]?.route).toBe(otherHash("pe", "cardiac-exam"));
    expect(res.units.filter((u) => u.route === cardiac).map((u) => u.at)).toEqual([B(60), R(600), R(601)]);
  });

  it("hosts an item recurring in several parts on its first part", () => {
    const res = publish(withOutline((x) => {
      gapOnlyOnOther(x);
      section(x, "pe").notes = [{ heading: "Psych EOR" }, { gap: G(1) }, { heading: "PANCE" }, { gap: G(1) }];
    }));
    expect((res.files.get(HOSTS_PATH) as HostsJson)[G(1)]?.route).toBe(otherHash("pe", "psych-eor"));
    expect(notesOf(res, "pe").filter((n) => "gap" in n)).toHaveLength(2);
  });
});
