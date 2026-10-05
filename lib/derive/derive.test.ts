// Plan 99 §99.1 `lib/derive/derive.test.ts`: topics (40 §40.2), navigation and pages (§40.3), pharm
// (§40.4–§40.5), published data and invariants (§40.1, §40.8). Unit topics run on in-memory blocks;
// the rest publish the synthetic tree of tools/build/test-fixture.ts, written and read through lib/content.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeContent, writeContent } from "../content/fs.ts";
import { topicBelowPath } from "../content/files.ts";
import { systemRowOrder } from "../content/splice.ts";
import type { BlockFile, StructureFile, UsesFile } from "../content/types.ts";
import { schema } from "../schema.ts";
import { loadContent } from "../../tools/build/load.ts";
import { B, C, D, G, GONE, P, R, S, tableDoc, U, writeFixture } from "../../tools/build/test-fixture.ts";
import { uncoveredText } from "./coverage.ts";
import { BuildError } from "./errors.ts";
import type { Content, GuideData, SystemData } from "./model.ts";
import { type Card, CardMatcher, medsPanel, phraseMatcher, rowCards, stubLabel, topicText } from "./pharm.ts";
import { publish, type PublishResult } from "./publish.ts";
import {
  docPath, generalPath, homePath, HOSTS_PATH, navPath, OTHER_PATH, REF_PATH_RE, refPath, SITE_PATH, slidesPath, systemPath, UPDATES_PATH, workupPath,
  type DocJson, type DocList, type GeneralJson, type HostsJson, type NavJson, type OtherJson, type SiteJson, type SlidesJson, type SystemJson, type UpdatesJson,
} from "./published.ts";
import { GENERAL_KEYS } from "../content/types.ts";
import { fileLocation, guideBase, guideViewHash, otherHash, parseHash, REF_TABS, refHash } from "./routes.ts";
import { tableOf } from "./text.ts";
import { belowUnder, checkMembers, deriveTopics, fitTitled, publishedRows, publishedSections, sectionItems, topicsBelow, type Topic } from "./topics.ts";
import { addDoc } from "./doclist.ts";

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

    it("fitTitled keeps the structure itself when every entry fits", () => {
      const st = structureOf({ titled: { [AEN]: 1 } });
      expect(fitTitled([pulm()], st)).toBe(st);
      const none = structureOf();
      expect(fitTitled([pulm()], none)).toBe(none);
    });

    it("fitTitled drops only the entries that no longer fit, and the field when none is left", () => {
      const both = [pulm(), serotonin("heading")];
      const st = structureOf({ titled: { [AEN]: 1, [SSN]: 0 } });
      expect(fitTitled(both, st)).toBe(st);
      // The serotonin label row is a content row again: that entry no longer fits.
      const kept = fitTitled([pulm(), serotonin("content")], st);
      expect(kept.titled).toEqual({ [AEN]: 1 });
      expect(() => deriveTopics([pulm(), serotonin("content")], kept)).not.toThrow();
      const gone = fitTitled([serotonin("content")], structureOf({ titled: { [SSN]: 0, [AEN]: 1 } }));
      expect(gone).not.toHaveProperty("titled");
      expect(titles([serotonin("content")], gone)).toEqual([[SS, "Serotonin Syndrome", [SS]], [SSN, "Rapid onset, 2+ serotonin agents or dosage changes", [SSN]]]);
    });

    it("fitTitled ignores a recorded row the build would refuse, leaving that to the build's own check", () => {
      const b = table(B(95), 2, [[R(950), "heading", "Gout", "Tx"], [R(951), "content", "notes", "colchicine"], [R(952), "content", "", "stray"]]);
      const st = structureOf({ members: { [R(952)]: R(951) }, titled: { [R(951)]: 0 } });
      expect(fitTitled([b], st)).toBe(st);
      expect(buildError(() => deriveTopics([b], st)).id).toBe(R(952));
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
    // No heading row labels a treatment column, so all of the topic's text is searched.
    const panel = medsPanel(s, [B(92), B(91)], tremor, new CardMatcher([]), (c) => c, new Set(["x"]));
    expect(panel).toEqual([{ card: null, title: "Beta-blocker (non-selective)", rows: [R(920)], section: "x", target: R(920) }]);
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
    const s = { guide: "fm", system: "cardiovascular", structure: st, topics: t };
    const htn = t.topics.find((x) => x.id === R(910));
    if (!htn) throw new Error("no topic");
    const cards = new CardMatcher([{ id: C(1), file: "f", aliases: ["beta blockers"], home: {} }]);
    const rows = (relevant: string[]) => medsPanel(s, [B(91), B(92), B(93)], htn, cards, (c) => c, new Set(relevant)).map((m) => [m.card, m.rows]);
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
      return medsPanel({ guide: "em", system: "cardiovascular", structure: st, topics: t }, [B(91), B(92)], topic, new CardMatcher([]), (c) => c, new Set(["antiarrhythmics"])).map((m) => m.title);
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
    const s = { guide: "fm", system: "orthopedics-rheumatology", structure: st, topics: t };
    const panel = (id: string) => {
      const topic = t.topics.find((x) => x.id === id);
      if (!topic) throw new Error(`no topic ${id}`);
      return medsPanel(s, [B(91), B(92)], topic, cards, (c) => c, new Set(["gout"])).map((m) => [m.card, m.rows]);
    };
    expect(panel(R(911))).toEqual([[C(7), [R(920)]]]);
    expect(panel(R(912))).toEqual([[C(8), [R(920)]]]);
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
        { id: C(3), file: "ob", aliases: ["nifedipine"], home: {} },
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

    it("takes every card its agents name when the first cell names no card", () => {
      expect(rowCards(cards(), t, row(R(922)), "x")).toEqual([C(2), C(3)]);
    });

    it("reads a card shown inside a class card as that class card", () => {
      expect(rowCards(cards([{ in: C(1) }]), t, row(R(921)), "x")).toEqual([C(1)]);
      expect(rowCards(cards([{ in: C(1) }]), t, row(R(922)), "x")).toEqual([C(1), C(3)]);
    });

    it("leaves out a card written only for other pharm sections, and a group only when all of it is", () => {
      expect(rowCards(cards([{ for: ["y"] }]), t, row(R(921)), "x")).toEqual([C(1)]);
      expect(rowCards(cards([{ for: ["x", "y"] }]), t, row(R(921)), "x")).toEqual([C(1), C(2)]);
      // A member written for another section still lets its class card in: the class card is for any use.
      expect(rowCards(cards([{ in: C(1), for: ["y"] }]), t, row(R(921)), "x")).toEqual([C(1)]);
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
    expect(m.cardIn(C(6), "start a DHP")).toBe(true);
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

  it("meds panel: only the following table's rows its treatment names (diltiazem → the CCB card), not the whole table", () => {
    expect(meds(R(101))).toEqual([{ card: C(1), title: "Calcium Channel Blockers", rows: [R(120), R(122)], section: "antianginals", target: C(1) }]);
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
    const hosts = file<HostsJson>("hosts.json");
    expect(uncoveredText(base, out.units, hosts)).toEqual([]);
    // Without the untitled-row and heading-row units, their text is reported.
    const without = out.units.filter((u) => u.at !== R(200) && u.at !== R(100));
    expect(uncoveredText(base, without, hosts)).toEqual([
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
    const hosts = res.files.get("hosts.json") as HostsJson;
    expect(uncoveredText(c, res.units, hosts)).toEqual([]);
    expect(uncoveredText(c, res.units.filter((u) => u.at !== B(11)), hosts)).toContainEqual({ id: B(11), text: "boxed pearl" });
  });

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
      { block: t61, basePt: 11, column: null },
      { block: t61, basePt: 11, column: 1 },
    ]);
    const other = res.files.get(OTHER_PATH) as OtherJson;
    expect(other.sections.find((s) => s.id === "vitamins")?.notes.map((n) => ("block" in n ? n.block.id : n.heading))).toEqual([B(60)]);
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
    expect(uncoveredText(c, res.units, hosts)).toEqual([]);
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
