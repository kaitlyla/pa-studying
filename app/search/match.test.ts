import { describe, expect, it } from "vitest";
import { Vocab } from "../../lib/search/index.ts";
import { createMatcher, excerpt, segments, type Matcher, type Range } from "./match.ts";

const vocab = new Vocab([
  { abbr: ["MI"], meanings: ["myocardial infarction"] },
  { abbr: ["HTN"], meanings: ["hypertension"] },
  { abbr: ["↑"], meanings: ["increased"] },
]);

function matcher(q: string): Matcher {
  const m = createMatcher(vocab, q);
  if (!m) throw new Error(`query ${q} did not run`);
  return m;
}

/** The highlighted substrings, in order. */
function hits(m: Matcher, text: string): string[] {
  return m.ranges(text).map(([a, b]) => text.slice(a, b));
}

describe("createMatcher", () => {
  it("does not run a query shorter than 2 characters", () => {
    expect(createMatcher(vocab, "e")).toBeNull();
    expect(createMatcher(vocab, "  e ")).toBeNull();
    expect(createMatcher(vocab, "en")).not.toBeNull();
    expect(createMatcher(vocab, "↑")).toBeNull();
    expect(createMatcher(vocab, " ⊕ ")).toBeNull();
  });

  it("highlights the matched word beginning, case-insensitively", () => {
    const text = "Infective Endocarditis; ENDOCARDIUM";
    expect(hits(matcher("endocard"), text)).toEqual(["Endocard", "ENDOCARD"]);
    expect(matcher("endocard").ranges(text)).toEqual([[10, 18], [24, 32]]);
  });

  it("matches only at word beginnings", () => {
    expect(hits(matcher("card"), "Endocarditis and cardiac")).toEqual(["card"]);
  });

  it("highlights each query word wherever it occurs", () => {
    expect(hits(matcher("chest pain"), "Pain in the chest; painful")).toEqual(["Pain", "chest", "pain"]);
  });

  it("matches a symbol token only as the identical symbol", () => {
    const text = "↑↑ BP and ↓ HR";
    expect(hits(matcher("↑ BP"), text)).toEqual(["↑↑", "BP"]);
  });

  it("highlights a vocabulary meaning when the abbreviation is searched, and the reverse", () => {
    const text = "Acute myocardial infarction (MI) workup";
    expect(hits(matcher("MI"), text)).toEqual(["myocardial infarction", "MI"]);
    expect(hits(matcher("myocardial infarction"), "Rule out MI first")).toEqual(["MI"]);
  });

  it("matches the abbreviation case-sensitively through the concept but still as a plain word prefix", () => {
    const m = matcher("mi");
    // "mi" and "min" begin with the typed token (the matched beginning is highlighted); the
    // concept's "MI" is case-sensitive and does not occur.
    expect(m.ranges("titrate 1 mi/min")).toEqual([[10, 12], [13, 15]]);
    expect(m.via("titrate 1 mi/min")).toEqual([]);
    expect(m.via("Post-MI care")).toEqual(["MI = myocardial infarction"]);
  });

  it("gives the 'abbr = meaning' line only when a concept occurs in the text", () => {
    expect(matcher("HTN").via("Treat hypertension early")).toEqual(["HTN = hypertension"]);
    expect(matcher("HTN").via("Treat it early")).toEqual([]);
    expect(matcher("endocard").via("Endocarditis")).toEqual([]);
  });

  it("ignores variation selectors between and inside tokens", () => {
    const text = "▪︎pneu️monia";
    // The word token is "pneu️monia": the selector is part of the run but not of the normalized token.
    expect(hits(matcher("pneum"), text)).toEqual(["pneu️m"]);
    expect(hits(matcher("pneumonia"), "▪︎pneumonia")).toEqual(["pneumonia"]);
  });

  it("merges overlapping matches into one range", () => {
    // "myocardial" is both a word-prefix match and part of the meaning occurrence.
    expect(matcher("myocardial infarction").ranges("myocardial infarction")).toEqual([[0, 21]]);
  });
});

describe("excerpt", () => {
  const words = (prefix: string, n: number): string => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, "0")}`).join(" ");

  it("takes 60 characters before and 120 after the first match, cut at word boundaries", () => {
    const before = words("word", 30); // 30 × "wordNN" joined by spaces: 209 characters
    const after = words("tail", 30);
    const text = `${before} Target ${after}`;
    const start = text.indexOf("Target");
    const ranges: Range[] = [[start, start + 6]];
    const ex = excerpt(text, ranges);
    // 60 before lands inside word21, so the window starts at word22; 120 after the match ends
    // exactly before tail17, so the window ends after tail16.
    expect(ex.text).toBe(`${words("word", 30).split(" ").slice(22).join(" ")} Target ${words("tail", 17)}`);
    expect(ex.cutStart).toBe(true);
    expect(ex.cutEnd).toBe(true);
    expect(ex.ranges).toEqual([[ex.text.indexOf("Target"), ex.text.indexOf("Target") + 6]]);
  });

  it("keeps the whole text when it is short", () => {
    const ex = excerpt("Short text with match", [[16, 21]]);
    expect(ex).toEqual({ text: "Short text with match", ranges: [[16, 21]], cutStart: false, cutEnd: false });
  });

  it("starts at the beginning when the text has no match", () => {
    const text = words("w", 60);
    const ex = excerpt(text, []);
    expect(ex.cutStart).toBe(false);
    expect(text.startsWith(ex.text)).toBe(true);
    expect(ex.text.length).toBeLessThanOrEqual(120);
    expect(ex.cutEnd).toBe(true);
  });

  it("drops ranges outside the window", () => {
    const text = `${words("a", 40)} hit ${words("b", 60)} late`;
    const first = text.indexOf("hit");
    const late = text.indexOf("late");
    const ex = excerpt(text, [[first, first + 3], [late, late + 4]]);
    expect(ex.ranges).toHaveLength(1);
  });
});

describe("segments", () => {
  it("splits text into plain and highlighted pieces", () => {
    expect(segments("abcdef", [[1, 3], [4, 5]])).toEqual([
      { text: "a", hit: false },
      { text: "bc", hit: true },
      { text: "d", hit: false },
      { text: "e", hit: true },
      { text: "f", hit: false },
    ]);
    expect(segments("abc", [])).toEqual([{ text: "abc", hit: false }]);
    expect(segments("abc", [[0, 3]])).toEqual([{ text: "abc", hit: true }]);
  });
});
