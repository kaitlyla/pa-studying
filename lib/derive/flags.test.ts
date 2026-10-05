// Flag placement by identity key, and retired flags listed but never placed (40 §40.7, 80 §80.4 as
// amended by the Orchestrator rulings of 2026-10-04 03:06Z and 03:07Z).
import { describe, expect, it } from "vitest";
import type { AsIsFile, Flag } from "../content/types.ts";
import type { Content } from "./model.ts";
import { publish } from "./publish.ts";
import type { DocJson, UpdatesJson } from "./published.ts";

const DOC = "d_0000000001";
const KEY = "/uspstf/recommendation/breast-cancer-screening#1";
const SUBJECT = "Breast Cancer: Screening: women aged 40 to 74 years";

const flag = (n: number, over: Partial<Flag> = {}): Flag => ({
  id: `u_000000000${n}`, kind: "rec", source: "uspstf", by: "check", key: KEY, subject: SUBJECT, guideline: SUBJECT,
  org: "U.S. Preventive Services Task Force (USPSTF)", published: "2024-04", quote: "The USPSTF recommends biennial screening mammography.",
  grade: "B", url: "https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/breast-cancer-screening", flagged: "2026-10-01",
  supersededBy: null, ...over,
});

function content(flags: Flag[], sourceKeys: string[]): Content {
  const file: AsIsFile = { v: 1, id: DOC, name: "Screening chart.pdf", kind: "pdf", original: "chart.pdf", view: "chart.pdf", pages: 1, text: null, removed: null };
  const tab = { subs: [], files: [] };
  return {
    site: { v: 1, name: "PA Studying", owner: { login: "kaitlyla", id: 1, commitName: "k", commitEmail: "k@example.invalid" }, repo: "kaitlyla/pa-studying", tabs: [], eors: [], guideNames: {} } as unknown as Content["site"],
    vocab: { v: 1, entries: [] },
    guides: [],
    cards: { v: 1, cards: [] },
    trims: { v: 1, rows: {}, lines: [] },
    uses: { v: 1, lines: [], conditions: [] },
    pharm: [],
    docs: new Map([[DOC, { kind: "file", file, text: null }]]),
    gaps: new Map(),
    decks: new Map(),
    reftabs: { v: 1, labs: tab, imaging: tab, ekg: tab, anatomy: tab },
    other: { v: 1, sections: [] },
    flags: { v: 1, flags },
    concepts: { v: 1, concepts: [{ id: "breast-cancer-screening", title: "Breast cancer screening", sourceKeys: { uspstf: sourceKeys }, targets: [DOC] }] },
    checks: { v: 1, lastRun: "2026-11-01", nextRun: "2026-12-01", sources: [], seen: {}, seenUrl: {} },
  };
}

const notesOn = (c: Content): string[] => ((publish(c).files.get(`docs/${DOC}.json`) as DocJson).notes[DOC] ?? []).map((n) => n.id);
const listed = (c: Content): UpdatesJson["flags"] => (publish(c).files.get("updates.json") as UpdatesJson).flags;

describe("placing flags by identity key", () => {
  it("places a current flag whose key a concept lists; a concept listing the subject places nothing", () => {
    expect(notesOn(content([flag(1)], [KEY]))).toEqual(["u_0000000001"]);
    expect(notesOn(content([flag(1)], [SUBJECT]))).toEqual([]);
  });

  it("places the revision, not the superseded flag, when a population is reworded at the same identity", () => {
    const old = flag(1, { subject: "Breast Cancer: Screening: women aged 50 to 74 years", supersededBy: "u_0000000002", published: "2016-01" });
    const revision = flag(2, { published: "2024-04" });
    expect(notesOn(content([old, revision], [KEY]))).toEqual(["u_0000000002"]);
  });

  it("never places a retired flag, but still lists it with no Added to", () => {
    const retired = flag(1, { retired: "2026-11-01" });
    const c = content([retired], [KEY]);
    expect(notesOn(c)).toEqual([]);
    expect(listed(c)).toEqual([expect.objectContaining({ id: "u_0000000001", key: KEY, addedTo: [] })]);
  });
});
