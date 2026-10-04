import { describe, expect, it } from "vitest";
import {
  buildIndex, clauses, conceptTerms, isWordToken, loadIndex, queryRuns, runSearch, tokenize, tokens, tokenSpans, Vocab,
  type SearchUnit,
} from "./index.ts";

const VS16 = String.fromCodePoint(0xfe0f);
const VS15 = String.fromCodePoint(0xfe0e);

const unit = (title: string, text: string, ord: number, tab = "eor"): SearchUnit => ({
  tab, title, loc: "EOR › Family Medicine › Cardiovascular", route: `#/eor/fm/t/r_${ord}`, at: `r_${ord}`, ord, label: "notes", text,
});

const vocab = new Vocab([
  { abbr: ["MI"], meanings: ["myocardial infarction"] },
  { abbr: ["HF", "CHF"], meanings: ["heart failure", "congestive heart failure"] },
  { abbr: ["↑"], meanings: ["increased"] },
]);

const units = [
  unit("Endocarditis", "Duke criteria; blood cultures x3", 0),
  unit("Acute coronary syndrome", "STEMI is an acute myocardial infarction with ST elevation", 1),
  unit("Post-MI care", "Cardiac rehab after MI", 2),
  unit("Infusions", "Run at 5 mi/min", 3),
  unit("Heart failure", "HFrEF: EF ≤ 40%", 4),
  unit("Hyperkalemia", "↑ K+ peaked T waves", 5, "pance"),
  unit("Murmurs", `▪${VS16} Systolic murmur at apex`, 6),
];
const ms = buildIndex(vocab, units);
const search = (q: string) => runSearch(ms, vocab, q);
const ords = (q: string): number[] => {
  const r = search(q);
  return r ? [...r.titles, ...r.mentions].map((h) => h.ord).sort((a, b) => a - b) : [];
};

describe("tokens (60 §60.2)", () => {
  it("lowercases word runs and splits symbols into their own tokens", () => {
    expect(tokens("Post-MI ↑K+ care")).toEqual(["post", "mi", "↑", "k", "+", "care"]);
    expect(isWordToken("mi")).toBe(true);
    expect(isWordToken("↑")).toBe(false);
  });

  it("removes variation selectors before tokenizing", () => {
    expect(tokens(`▪${VS16}Murmur${VS15}`)).toEqual(["▪", "murmur"]);
  });

  it("keeps concept fields and concept query terms whole", () => {
    expect(tokenize("~0 ~12", "concepts")).toEqual(["~0", "~12"]);
    expect(tokenize("~3")).toEqual(["~3"]);
    expect(tokenize("~3", "text")).toEqual(["~", "3"]);
  });

  it("gives each token's offsets in the original text, skipping lone variation selectors", () => {
    const text = `A▪${VS16} Murmur`;
    expect(tokenSpans(text)).toEqual([
      { token: "a", start: 0, end: 1 },
      { token: "▪", start: 1, end: 2 },
      { token: "murmur", start: 4, end: 10 },
    ]);
  });
});

describe("matching (60 §60.3)", () => {
  it("is case-insensitive", () => {
    expect(ords("ENDOCARDITIS")).toEqual([0]);
    expect(ords("duke CRITERIA")).toEqual([0]);
  });

  it("matches word beginnings only (partial-word prefix)", () => {
    expect(ords("endocard")).toEqual([0]);
    expect(ords("carditis")).toEqual([]);
  });

  it("requires every clause in the same unit", () => {
    expect(ords("blood cultures")).toEqual([0]);
    expect(ords("blood rehab")).toEqual([]);
  });

  it("does not run a one-character query", () => {
    expect(queryRuns("e")).toBe(false);
    expect(queryRuns("  e  ")).toBe(false);
    expect(search("e")).toBeNull();
    expect(queryRuns("st")).toBe(true);
    expect(search("st")).not.toBeNull();
  });

  it("finds a vocabulary meaning from its abbreviation", () => {
    // Unit 1 says "myocardial infarction" and never "MI"; unit 3's "mi/min" matches the plain prefix.
    expect(ords("MI")).toEqual([1, 2, 3]);
  });

  it("finds the abbreviation from its meaning", () => {
    expect(ords("myocardial infarction")).toEqual([1, 2]);
    expect(ords("heart failure")).toEqual([4]);
  });

  it("detects abbreviations case-sensitively and meanings case-insensitively in unit text", () => {
    expect(vocab.conceptsOf("Run at 5 mi/min")).toEqual([]);
    expect(vocab.conceptsOf("Post-MI care")).toEqual([0]);
    expect(vocab.conceptsOf("MYOCARDIAL INFARCTION")).toEqual([0]);
    expect(vocab.conceptsOf("MIs")).toEqual([]);
    expect(vocab.conceptsOf("CHF exacerbation")).toEqual([1]);
    expect(vocab.conceptsOf("K↑")).toEqual([2]);
    expect(conceptTerms(vocab, "MI with heart failure")).toBe("~0 ~1");
  });

  it("takes the longest vocabulary span as one clause", () => {
    expect(clauses(vocab, "acute congestive heart failure")).toEqual([
      { tokens: ["acute"], concepts: [] },
      { tokens: ["congestive", "heart", "failure"], concepts: [1] },
    ]);
    expect(clauses(vocab, "mi rehab")).toEqual([{ tokens: ["mi"], concepts: [0] }, { tokens: ["rehab"], concepts: [] }]);
  });

  it("matches symbol tokens exactly", () => {
    expect(ords("↑ k")).toEqual([5]);
    expect(ords("≤ 40")).toEqual([4]);
  });

  it("ignores variation selectors in queries and text", () => {
    expect(ords(`▪${VS16} systolic`)).toEqual([6]);
    expect(ords("▪ systolic")).toEqual([6]);
  });

  it("ranges every occurrence of the given entries in the original text", () => {
    const text = "MI then myocardial infarction; mi/min; Myocardial Infarction";
    expect(vocab.occurrences(text, [0])).toEqual([[0, 2], [8, 29], [39, 60]]);
    expect(vocab.occurrences("↑ and ↑", [2])).toEqual([[0, 1], [6, 7]]);
    expect(vocab.occurrences(text, [1])).toEqual([]);
  });
});

describe("groups and the serialized index (60 §60.4)", () => {
  it("puts units whose title satisfies every clause in group 1, the rest in group 2, each by ord", () => {
    const r = search("heart");
    expect(r?.titles.map((h) => h.ord)).toEqual([4]);
    const mi = search("MI");
    expect(mi?.titles.map((h) => h.ord)).toEqual([2]);
    expect(mi?.mentions.map((h) => h.ord)).toEqual([1, 3]);
    expect(mi?.mentions.map((h) => h.tab)).toEqual(["eor", "eor"]);
  });

  it("answers the same from the index loaded from its JSON", () => {
    const loaded = loadIndex(JSON.stringify(ms));
    for (const q of ["MI", "myocardial infarction", "endocard", "↑ k", "▪ systolic"]) {
      expect(runSearch(loaded, vocab, q)).toEqual(search(q));
    }
  });

  it("returns empty groups when the query has no tokens", () => {
    expect(search("--")).toEqual({ titles: [], mentions: [] });
  });
});
