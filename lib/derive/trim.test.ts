// Which card lines a card leaves out where her guide table, shown beside it, says them.
import { describe, expect, it } from "vitest";
import { block, doc, para, row, table } from "../pdf/testing.ts";
import type { PubTrimLine } from "./published.ts";
import { allLinesHidden, hiddenLines, panelUses, shownParts, tableRows, withoutLines, type TrimSource } from "./trim.ts";

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
    uses: {},
  };
}

/** Where no line is written for one use, the pharm sections relevant do not matter. */
const ANY = new Set<string>();

const covered = (text: string, rowText = BB_ROW): PubTrimLine => ({ text, label: false, rows: [{ id: BB, text: rowText }] });
const label = (text: string): PubTrimLine => ({ text, label: true, rows: [] });

const NOTES = [["Beta-blockers"], ["  Adverse Effects:"], ["    Brady, hypotension"], ["    Sex dysfunction: impotence, ED, ↓ libido"], ["  Monitoring:"], ["    EKG"]];
const JUDGED = [label("Beta-blockers"), label("Adverse Effects:"), covered("Brady, hypotension"), covered("Sex dysfunction: impotence, ED, ↓ libido"), label("Monitoring:")];

const hide = (s: TrimSource, shown: Iterable<string>, at: ReadonlySet<string> = ANY): number[] => [...(hiddenLines(s, [N], new Set(shown), at).get(N) ?? [])].sort((a, b) => a - b);

describe("hiddenLines", () => {
  it("leaves out covered lines and a label whose lines are all left out, keeping a label with a line left", () => {
    // Line 6 (EKG) is unjudged, so "Monitoring:" and the card heading above everything stay.
    expect(hide(source(NOTES, JUDGED), [HEAD, BB, CCB])).toEqual([1, 2, 3]);
  });

  it("leaves out a heading once every line under it is left out", () => {
    const s = source(NOTES.slice(0, 4), JUDGED);
    expect(hide(s, [BB])).toEqual([0, 1, 2, 3]);
    expect(allLinesHidden(s, [N], hiddenLines(s, [N], new Set([BB]), ANY))).toBe(true);
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
    uses: {},
  });
  const hidden = (s: TrimSource, at: ReadonlySet<string> = ANY): [number[], number[]] => {
    const h = hiddenLines(s, [N, N2], new Set(), at);
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

  it("does not count a line left out as written for another use, so a later general copy still shows", () => {
    const s = card(["Beta-blockers", "  Clin Use:", "    Effort induced angina", "  Pt Ed: TAPER"], ["Β-blockers", "  Pt Ed: TAPER"]);
    s.uses[N] = [{ text: "Pt Ed: TAPER", for: ["antianginals"] }];
    // On Hypertension her angina-only line goes, and the other file's same line is no repeat of it.
    expect(hidden(s, new Set(["hypertension"]))).toEqual([[3], []]);
    // On Antianginals the angina line shows, so the other file's copy is the repeat.
    expect(hidden(s, new Set(["antianginals"]))).toEqual([[], [1]]);
  });
});

describe("hiddenLines: a line written for one use", () => {
  const notes = [["Beta-blockers"], ["  Clin Use:"], ["    Effort induced angina"], ["    Stable angina w nitrates"], ["  Adverse Effects:"], ["    Fatigue"]];
  const forAngina = (texts: string[], trims: PubTrimLine[] = []): TrimSource => {
    const s = source(notes, trims);
    s.uses[N] = texts.map((text) => ({ text, for: ["antianginals"] }));
    return s;
  };

  it("leaves out lines written for another use, and a judged label whose lines all go", () => {
    expect(hide(forAngina(["Effort induced angina", "Stable angina w nitrates"], [label("Clin Use:")]), [], new Set(["hypertension"]))).toEqual([1, 2, 3]);
  });

  it("keeps an unjudged heading over them, unless it is itself recorded for that use", () => {
    expect(hide(forAngina(["Effort induced angina", "Stable angina w nitrates"]), [], new Set(["hypertension"]))).toEqual([2, 3]);
    expect(hide(forAngina(["Clin Use:", "Effort induced angina", "Stable angina w nitrates"]), [], new Set(["hypertension"]))).toEqual([1, 2, 3]);
  });

  it("shows them where one of their uses is relevant", () => {
    const s = forAngina(["Effort induced angina", "Stable angina w nitrates"]);
    expect(hide(s, [], new Set(["antianginals"]))).toEqual([]);
    expect(hide(s, [], new Set(["hypertension", "antianginals"]))).toEqual([]);
  });

  it("keeps a heading while a line under it is general", () => {
    expect(hide(forAngina(["Effort induced angina"]), [], new Set(["hypertension"]))).toEqual([2]);
  });

  it("keeps a line written for another use while a general line sits under it", () => {
    // Her "Clin Use:" heading recorded for angina still heads the general lines left under it.
    expect(hide(forAngina(["Clin Use:", "Effort induced angina"]), [], new Set(["hypertension"]))).toEqual([2]);
  });

  it("stops applying once she edits the line", () => {
    expect(hide(forAngina(["Effort induced angina (edited before)"]), [], new Set(["hypertension"]))).toEqual([]);
  });
});

describe("shownParts and panelUses", () => {
  const p = (id: string, use?: string[]): { id: string; for?: string[] } => (use ? { id, for: use } : { id });

  it("keeps parts written for any use, and those written for a relevant section, in card order", () => {
    const card = { parts: [p("general"), p("angina", ["antianginals"]), p("rhythm", ["antiarrhythmics"]), p("both", ["antianginals", "antiarrhythmics"])] };
    expect(shownParts(card, new Set(["antiarrhythmics"])).map((x) => x.id)).toEqual(["general", "rhythm", "both"]);
    expect(shownParts(card, new Set()).map((x) => x.id)).toEqual(["general"]);
  });

  it("keeps a part written for some conditions only on the panel of a condition its title names, whatever the section", () => {
    const tourette = { id: "tourette", diseases: ["Tourette syndrome", "tic disorders"] };
    const card = { parts: [p("general"), tourette] };
    expect(shownParts(card, new Set(["antipsychotics"]), "Tic Disorders").map((x) => x.id)).toEqual(["general", "tourette"]);
    expect(shownParts(card, new Set(["antipsychotics"]), "Morning Sickness & Hyperemesis Gravidarum").map((x) => x.id)).toEqual(["general"]);
    // A pharm section page names no condition: a part written for no section shows on her file page only.
    expect(shownParts(card, new Set(["antipsychotics"])).map((x) => x.id)).toEqual(["general"]);
  });

  it("keeps a part written for some conditions and a section in that section, and on those conditions' panels only", () => {
    // Her IBD notes on the glucocorticoid card: her IBD section and Crohn's disease, not psoriasis.
    const ibd = { id: "ibd", diseases: ["Crohn's disease", "ulcerative colitis"], for: ["ibd"] };
    const card = { parts: [p("general"), ibd] };
    expect(shownParts(card, new Set(["ibd"])).map((x) => x.id)).toEqual(["general", "ibd"]);
    expect(shownParts(card, new Set(["dmards"])).map((x) => x.id)).toEqual(["general"]);
    expect(shownParts(card, new Set(["ibd"]), "Crohn's disease").map((x) => x.id)).toEqual(["general", "ibd"]);
    expect(shownParts(card, new Set(["ibd"]), "Psoriasis").map((x) => x.id)).toEqual(["general"]);
  });

  it("reads a topic's condition section, and the systems without sections under the empty key", () => {
    const system = { panelSections: { "coronary-artery-disease": ["antianginals", "antiplatelets"], "": ["beta-blockers"] } };
    expect([...panelUses(system, { section: "coronary-artery-disease" })]).toEqual(["antianginals", "antiplatelets"]);
    expect([...panelUses(system, { section: null })]).toEqual(["beta-blockers"]);
    expect([...panelUses(system, { section: "unmapped" })]).toEqual([]);
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
