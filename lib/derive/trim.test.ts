// Which card lines a card leaves out where her guide table, shown beside it, says them.
import { describe, expect, it } from "vitest";
import { block, doc, para, row, table } from "../pdf/testing.ts";
import type { PubTrimLine } from "./published.ts";
import { allLinesHidden, hiddenLines, tableRows, withoutLines, type TrimSource } from "./trim.ts";

const T = "b_TTTTTTTTT1";
const N = "b_NNNNNNNNN1";
const HEAD = "r_HHHHHHHHH1";
const BB = "r_BBBBBBBBB1";
const CCB = "r_CCCCCCCCC1";
const BB_ROW = "Beta Blockers | ADRs: ↓ HR/BP, impotence, ↓ libido";

/** A guide table (a heading row and two drug rows) and a beta-blocker card's notes. */
function source(notes: string[][], trims: PubTrimLine[], bbCells = ["Beta Blockers", "ADRs: ↓ HR/BP, impotence, ↓ libido"]): TrimSource {
  const ind = (s: string): number => (s.startsWith("    ") ? 54 : s.startsWith("  ") ? 27 : 0);
  return {
    blocks: [block(T, "table", doc(table([100, 200], [row(HEAD, "heading", ["Drug", "About"]), row(BB, "content", bbCells), row(CCB, "content", ["CCBs", "ADRs: edema"])])))],
    rows: {
      [HEAD]: { block: T, kind: "heading", heading: null, topic: null },
      [BB]: { block: T, kind: "content", heading: HEAD, topic: null },
      [CCB]: { block: T, kind: "content", heading: HEAD, topic: null },
    },
    notesBlocks: { [N]: block(N, "prose", doc(...notes.map(([s]) => para((s ?? "").trim(), { indLeft: ind(s ?? "") })))) },
    trims: { [N]: trims },
  };
}

const covered = (text: string, rowText = BB_ROW): PubTrimLine => ({ text, label: false, rows: [{ id: BB, text: rowText }] });
const label = (text: string): PubTrimLine => ({ text, label: true, rows: [] });

const NOTES = [["Beta-blockers"], ["  Adverse Effects:"], ["    Brady, hypotension"], ["    Sex dysfunction: impotence, ED, ↓ libido"], ["  Monitoring:"], ["    EKG"]];
const JUDGED = [label("Beta-blockers"), label("Adverse Effects:"), covered("Brady, hypotension"), covered("Sex dysfunction: impotence, ED, ↓ libido"), label("Monitoring:")];

const hide = (s: TrimSource, shown: Iterable<string>): number[] => [...(hiddenLines(s, [N], new Set(shown)).get(N) ?? [])].sort((a, b) => a - b);

describe("hiddenLines", () => {
  it("leaves out covered lines and a label whose lines are all left out, keeping a label with a line left", () => {
    // Line 6 (EKG) is unjudged, so "Monitoring:" and the card heading above everything stay.
    expect(hide(source(NOTES, JUDGED), [HEAD, BB, CCB])).toEqual([1, 2, 3]);
  });

  it("leaves out a heading once every line under it is left out", () => {
    const s = source(NOTES.slice(0, 4), JUDGED);
    expect(hide(s, [BB])).toEqual([0, 1, 2, 3]);
    expect(allLinesHidden(s, [N], hiddenLines(s, [N], new Set([BB])))).toBe(true);
  });

  it("shows every line when the covering row is not shown with the card", () => {
    expect(hide(source(NOTES, JUDGED), [HEAD, CCB])).toEqual([]);
  });

  it("stops applying a judgment once she edits the covering row", () => {
    const s = source(NOTES, JUDGED, ["Beta Blockers", "ADRs: ↓ HR/BP, fatigue"]);
    expect(hide(s, [BB])).toEqual([]);
  });

  it("stops applying a judgment once she edits the line", () => {
    const edited = NOTES.map((l) => (l[0] === "    Brady, hypotension" ? ["    Brady, hypotension, AV block"] : l));
    // The edited line shows again, and so does its heading, which now has a line under it left in.
    expect(hide(source(edited, JUDGED), [BB])).toEqual([3]);
  });

  it("keeps a covered line that heads a line left in", () => {
    const notes = [["Clin Use: cardioselective"], ["  Effort induced angina"]];
    expect(hide(source(notes, [covered("Clin Use: cardioselective")]), [BB])).toEqual([]);
  });

  it("keeps a label with no lines under it", () => {
    expect(hide(source([["Bisoprolol"], ["Metoprolol"]], [label("Bisoprolol")]), [BB])).toEqual([]);
  });
});

describe("hiddenLines: a line the card already showed word for word", () => {
  const N2 = "b_NNNNNNNNN2";
  const ind = (s: string): number => (s.startsWith("      ") ? 81 : s.startsWith("    ") ? 54 : s.startsWith("  ") ? 27 : 0);
  /** A card stacking two of her files' notes on one class: block N, then block N2; nothing judged. */
  const card = (first: string[], second: string[]): TrimSource => ({
    blocks: [],
    rows: {},
    notesBlocks: {
      [N]: block(N, "prose", doc(...first.map((s) => para(s.trim(), { indLeft: ind(s) })))),
      [N2]: block(N2, "prose", doc(...second.map((s) => para(s.trim(), { indLeft: ind(s) })))),
    },
    trims: {},
  });
  const hidden = (s: TrimSource): [number[], number[]] => {
    const h = hiddenLines(s, [N, N2], new Set());
    return [[...(h.get(N) ?? [])].sort((a, b) => a - b), [...(h.get(N2) ?? [])].sort((a, b) => a - b)];
  };

  it("leaves out the later copy under the same headings, and a heading whose lines all repeat, keeping the first", () => {
    // Each file titles the class its own way; the title is no heading of the lines under it.
    const s = card(
      ["Calcium Channel Blockers", "  Adverse Effects: Dizzy, HA", "  Contraindications:", "    BB: sensitive to depressant effect", "    CHF"],
      ["Calcium Channel Blockers (CCBs)", "  MOA: bind L-type channel", "  Adverse Effects: Dizzy, HA", "  Contraindications:", "    BB: sensitive to depressant effect", "    CHF"],
    );
    expect(hidden(s)).toEqual([[], [2, 3, 4, 5]]);
  });

  it("keeps a repeated heading while a line under it is new", () => {
    const s = card(["CCB", "  Monitoring:", "    EKG"], ["CCBs", "  Monitoring:", "    EKG", "    Liver function"]);
    expect(hidden(s)).toEqual([[], [2]]);
  });

  it("keeps the same text under a different heading", () => {
    // "Mod lipid solubility" of carteolol is not that of carvedilol; "CHF" as a use is not a contraindication.
    const s = card(
      ["Beta-blockers", "  Carvedilol", "    Mod lipid solubility", "  Contraindications:", "    CHF"],
      ["Β-blockers", "  Carteolol", "    Mod lipid solubility", "  Clinical Use:", "    CHF"],
    );
    expect(hidden(s)).toEqual([[], []]);
  });

  it("leaves out a repeat within one file's notes too", () => {
    const s = card(["Nitrates", "  Adverse: headache", "  Adverse: headache"], ["Organic nitrates"]);
    expect(hidden(s)).toEqual([[2], []]);
  });
});

describe("tableRows and withoutLines", () => {
  it("lists the rows of the given tables", () => {
    expect([...tableRows(source(NOTES, []), [T])].sort()).toEqual([BB, CCB, HEAD].sort());
    expect([...tableRows(source(NOTES, []), ["b_OTHERTAB01"])]).toEqual([]);
  });

  it("drops only the given paragraphs, leaving the stored doc as it was", () => {
    const d = doc(para("a"), para("b"), para("c"));
    expect(withoutLines(d, new Set([1])).content).toEqual([para("a"), para("c")]);
    expect(d.content).toHaveLength(3);
    expect(withoutLines(d, undefined)).toBe(d);
  });
});
