import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeContent } from "../../lib/content/fs.ts";
import { buildDocx, para, run, tbl } from "../../lib/docx/fixtures.ts";
import { runVerify, verifySource } from "./index.ts";
import { compareVocab, vocabEntries } from "./vocab.ts";

const cell = (text: string) => ({ content: text ? para(run(text)) : para("") });
const row = (...texts: string[]) => ({ cells: texts.map(cell) });

/** One vocabulary table, one unrelated table, and a section-label row with an empty meaning. */
const docx = (): Uint8Array => buildDocx({
  body: tbl([row("Abbreviation", "Meaning", "Notes"), row("BP / B/P", "blood pressure", ""), row("Cardio", "", ""), row("HR", "heart rate / pulse", "bpm")], "", 3) +
    para(run("between")) +
    tbl([row("Drug", "Dose"), row("ASA", "81 mg")]),
});

const stored = (entries: { abbr: string[]; meanings: string[] }[]) => ({ v: 1 as const, entries });
const GOOD = [{ abbr: ["BP", "B/P"], meanings: ["blood pressure"] }, { abbr: ["HR"], meanings: ["heart rate", "pulse"] }];

describe("vocabEntries (30 §30.11)", () => {
  it("reads only Abbreviation/Meaning/Notes tables, splits on ' / ', and names each skipped row", () => {
    const v = vocabEntries(docx());
    expect(v.tables).toBe(1);
    expect(v.entries).toEqual([
      { abbr: ["BP", "B/P"], meanings: ["blood pressure"], table: 1, row: 2 },
      { abbr: ["HR"], meanings: ["heart rate", "pulse"], table: 1, row: 4 },
    ]);
    expect(v.skipped).toEqual([{ table: 1, row: 3, cells: ["Cardio", "", ""] }]);
  });
});

describe("compareVocab", () => {
  const { entries } = vocabEntries(docx());

  it("passes when every row matches its stored entry", () => {
    expect(compareVocab(entries, stored(GOOD))).toEqual([]);
  });

  it("reports a missing, an altered and an extra entry", () => {
    expect(compareVocab(entries, stored([GOOD[0]!]))).toEqual([
      { kind: "vocab", story: "table 1 row 4", index: 1, expected: GOOD[1], actual: null },
    ]);
    const altered = { abbr: ["HR"], meanings: ["heart rate"] };
    expect(compareVocab(entries, stored([GOOD[0]!, altered]))).toEqual([
      { kind: "vocab", story: "table 1 row 4", index: 1, expected: GOOD[1], actual: altered },
    ]);
    const extra = { abbr: ["RR"], meanings: ["respiratory rate"] };
    expect(compareVocab(entries, stored([...GOOD, extra]))).toEqual([
      { kind: "vocab", story: "stored", index: 2, expected: null, actual: extra },
    ]);
  });

  it("reports a missing vocabulary file", () => {
    expect(compareVocab(entries, null)).toEqual([{ kind: "file", story: "vocab", index: -1, expected: "content/vocab/abbreviations.json", actual: null }]);
  });
});

describe("vocab and duplicate rows in runVerify", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pa-vocab-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reports the vocabulary with its skipped rows and lists the duplicate as skipped", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "vocab.docx"), docx());
    await writeContent(root, "content/vocab/abbreviations.json", stored(GOOD));
    await mkdir(join(root, "tools", "import"), { recursive: true });
    await writeFile(join(root, "tools", "import", "sources.json"), JSON.stringify({ v: 1, sources: [
      { path: "src/vocab.docx", kind: "vocab", name: "Vocabulary", placement: null },
      { path: "src/copy(1).docx", kind: "duplicate", name: "Copy", placement: null },
    ] }));
    const report = (await verifySource(root, { path: "src/vocab.docx", kind: "vocab", name: "Vocabulary", placement: null }))!;
    expect(report.counts).toEqual({ tables: 1, rows: 3 });
    expect(report.discrepancies).toEqual([]);
    expect(report.info).toEqual([{ kind: "vocabRowSkipped", table: 1, row: 3, reason: "empty first or second cell", cells: ["Cardio", "", ""] }]);

    const lines: string[] = [];
    expect(await runVerify(root, { log: (l) => lines.push(l) })).toBe(0);
    const summary = JSON.parse(await readFile(join(root, "tools", "import", "reports", "summary.json"), "utf8")) as unknown;
    expect(summary).toEqual({ sources: [{ source: "vocab.docx", discrepancies: 0 }, { source: "copy(1).docx", skipped: "proven duplicate" }] });
    expect(lines).toEqual(["ok   vocab.docx", "skip copy(1).docx — proven duplicate", "all 1 sources complete"]);

    await writeContent(root, "content/vocab/abbreviations.json", stored([GOOD[0]!]));
    expect(await runVerify(root, { log: () => undefined })).toBe(1);
  });
});
