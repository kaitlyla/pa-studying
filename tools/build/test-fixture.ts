// Test-only: a small synthetic content tree written through lib/content (99 §99.1 unit fixtures),
// shared by lib/derive and tools/build tests. Not used by the build itself.
import { writeAsset, writeContent, writeStoredFile } from "../../lib/content/fs.ts";

export const id = (p: string, n: number): string => `${p}_${String(n).padStart(10, "0")}`;

export const para = (...content: unknown[]) => ({ type: "paragraph", content: content.map((c) => (typeof c === "string" ? { type: "text", text: c } : c)) });
export const doc = (...content: unknown[]) => ({ type: "doc", content });
const borders6 = { top: null, right: null, bottom: null, left: null, insideH: null, insideV: null };

/** A table doc: `rows` are [id, kind, ...cell texts]; the grid has `columns` columns. */
export function tableDoc(columns: number, rows: [string, "heading" | "content", ...string[]][]) {
  return doc({
    type: "table",
    attrs: { grid: Array.from({ length: columns }, () => 100), borders: borders6, cellMarginPt: { top: 0, right: 5.4, bottom: 0, left: 5.4 } },
    content: rows.map(([rid, kind, ...cells]) => ({
      type: "table_row", attrs: { id: rid, kind },
      content: cells.map((t) => ({ type: "table_cell", content: [t === "" ? { type: "paragraph" } : para(...t.split("\n").flatMap((line, i) => (i === 0 ? [line] : [{ type: "hard_break" }, line])).filter((x) => x !== ""))] })),
    })),
  });
}

const page = { widthPt: 792, heightPt: 612, margins: { top: 36, right: 36, bottom: 36, left: 36 } };
const block = (bid: string, kind: string, d: unknown, meta: unknown = {}) => ({ v: 1, id: bid, kind, doc: d, meta });

export const B = (n: number) => id("b", n);
export const R = (n: number) => id("r", n);
export const D = (n: number) => id("d", n);
export const G = (n: number) => id("g", n);
export const C = (n: number) => id("c", n);
export const P = (n: number) => id("p", n);
export const S = (n: number) => id("s", n);
export const U = (n: number) => id("u", n);
/** A row id no content holds (a deleted row). */
export const GONE = id("r", 9999);
/** A code point no vendored font covers. */
export const UNCOVERED = String.fromCodePoint(0xf0000);
export const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);

const SITE = {
  v: 1, name: "PA Studying",
  owner: { login: "kaitlyla", id: 337482200, commitName: "kaitlyla", commitEmail: "337482200+kaitlyla@users.noreply.github.com" },
  repo: "kaitlyla/pa-studying",
  tabs: ["eor", "pance", "labs", "imaging", "ekg", "anatomy", "other"],
  eors: ["fm", "psy"], pance: "pance",
  guideNames: { fm: "Family Medicine", psy: "Psychiatry", pance: "PANCE / EOC" },
};

const gapBlock = (gid: string, title: string, sentences: string[], extra: Record<string, unknown> = {}) => ({
  v: 1, id: gid, kind: "gap", doc: doc(...sentences.map((s) => para(s))),
  meta: {
    title, relevantTo: "Atrial fibrillation", written: "2026-10", differs: null,
    sources: [{ name: "AHA/ACC AF guideline", org: "American Heart Association", year: "2023", url: "https://www.ahajournals.org/x", type: "guideline",
      track: { series: "acc-af", label: "ACC/AHA atrial fibrillation guideline", org: "ACC/AHA", edition: 2023, method: "none" } }],
    ownerEdits: [], ...extra,
  },
});
const evidence = (gid: string, claims: string[], result = "pass") => ({
  v: 1, block: gid, author: "ann-1",
  claims: claims.map((text) => ({ text, source: 0, quote: text, locator: "s. 1", accessed: "2026-10-05" })),
  verification: { verifier: "bo-2", at: "2026-10-06", result, notes: [] },
});

/**
 * Writes the fixture tree under `root`:
 * - fm (EOR): cardiovascular (sections; topic, drug and one-column tables), pulmonary (flat, untitled
 *   lead rows), renal (Pharm by `pharmFiles` only); general topic labs with links, files and a gap;
 *   a workup item; a generated deck.
 * - psy (EOR): no systems; an own deck whose document is removed.
 * - pance: a drug table whose row matches a card; `sidebarEnd`.
 */
export async function writeFixture(root: string): Promise<void> {
  const w = (path: string, value: unknown) => writeContent(root, `content/${path}`, value);
  const asset = await writeAsset(root, PNG, ".png");

  await w("site.json", SITE);
  await w("vocab/abbreviations.json", { v: 1, entries: [{ abbr: ["AF"], meanings: ["atrial fibrillation"] }] });

  // ---- fm
  await w("guides/fm/guide.json", {
    v: 1, id: "fm", source: "Family Medicine EOR.docx", page, basePt: 10, preamble: [B(1)],
    systems: [{ id: "cardiovascular", title: "Cardiovascular", pct: "15%" }, { id: "pulmonary", title: "Pulmonary", pct: "12%" }, { id: "renal", title: "Urology/Renal", pct: "5%" }],
  });
  await w(`guides/fm/_preamble/blocks/${B(1)}.json`, block(B(1), "prose", doc(para("Family Medicine EOR"))));
  const cv = "guides/fm/cardiovascular";
  await w(`${cv}/system.json`, { v: 1, id: "cardiovascular", blocks: [B(10), B(11), B(12), B(13), B(14)] });
  await w(`${cv}/blocks/${B(10)}.json`, block(B(10), "table", tableDoc(3, [
    [R(100), "heading", "ARRHYTHMIAS", "Presentation", "Treatment"],
    [R(101), "content", "Atrial  fibrillation\n(AF)", "irregularly irregular", "rate control with diltiazem"],
    [R(102), "content", "", "more AF text", ""],
    [R(103), "heading", "Stable angina", "P", "T"],
    [R(104), "content", "", "chest pain on exertion", "nitrates; aspirin"],
  ])));
  await w(`${cv}/blocks/${B(11)}.json`, block(B(11), "prose", doc(para("Murmurs"), para("Systolic ⊕ ", {
    type: "image", attrs: { asset, widthPt: 10, heightPt: 10, rot: 0, flipH: false, flipV: false },
  }))));
  await w(`${cv}/blocks/${B(12)}.json`, block(B(12), "table", tableDoc(3, [
    [R(120), "heading", "ANTIANGINALS", "MOA", "Notes"],
    [R(121), "content", "Nitroglycerin", "venodilator", ""],
    [R(122), "content", "Amlodipine", "DHP", ""],
    [R(123), "content", "Prinzmetal angina", "vasospasm", "CCB first-line"],
    [R(124), "content", "Ranolazine", "late Na current", ""],
  ])));
  await w(`${cv}/blocks/${B(13)}.json`, block(B(13), "table", tableDoc(2, [
    [R(130), "content", "", "angina continues here"],
    [R(131), "content", "Heart failure", "HFrEF; loop diuretics"],
  ])));
  await w(`${cv}/blocks/${B(14)}.json`, block(B(14), "table", tableDoc(1, [[R(140), "content", "Mnemonic"]])));
  await w(`${cv}/structure.json`, {
    v: 1,
    sections: [{ id: "cad", title: "Coronary artery disease" }, { id: "other", title: "Cardiovascular — other" }],
    members: { [R(101)]: "other", [R(104)]: "cad", [R(123)]: "cad", [R(131)]: "other", [B(11)]: "other", [B(14)]: "other" },
    listed: { [B(11)]: "Murmurs" },
    drugTables: [{ block: B(12), pharmSection: "antianginals", conditionRows: [R(123)] }],
    pharmSections: [{ id: "antianginals", title: "Antianginals", tables: [B(12)], overview: P(1), lo: null, also: [] }],
    pharmFiles: [D(1)],
  });
  const pu = "guides/fm/pulmonary";
  await w(`${pu}/system.json`, { v: 1, id: "pulmonary", blocks: [B(20)] });
  await w(`${pu}/blocks/${B(20)}.json`, block(B(20), "table", tableDoc(2, [
    [R(200), "content", "", "untitled lead"],
    [R(201), "content", "Asthma", "wheeze; albuterol"],
  ])));
  const empty = { v: 1, sections: [], members: {}, listed: {}, drugTables: [], pharmSections: [], pharmFiles: [] };
  await w(`${pu}/structure.json`, empty);
  await w("guides/fm/renal/system.json", { v: 1, id: "renal", blocks: [] });
  await w("guides/fm/renal/structure.json", { ...empty, pharmFiles: [D(2)] });
  await w("guides/fm/general.json", {
    v: 1,
    topics: [{ key: "labs", howto: null, links: [{ target: R(101), covers: "AF labs" }, { target: GONE, covers: "deleted" }], files: [D(5), D(6), D(7)], gaps: [G(1)] }],
    workup: [{ id: "ams", title: "Altered mental status", conds: "Delirium", gap: G(2) }],
  });
  await w("slides/fm/deck.json", { v: 1, guide: "fm", kind: "generated", title: "High-yield review slides", file: null, slides: [S(1), S(2)] });
  await w(`slides/fm/blocks/${S(1)}.json`, block(S(1), "slide", doc({ type: "heading_line", content: [{ type: "text", text: "High-yield review slides" }] })));
  await w(`slides/fm/blocks/${S(2)}.json`, block(S(2), "slide", doc(
    { type: "heading_line", content: [{ type: "text", text: "Atrial fibrillation" }] },
    { type: "slide_card", content: [para("Presentation"), para("Irregularly irregular")] },
  ), {
    summarizes: [R(101), GONE],
    evidence: [{ item: "Irregularly irregular", row: R(101), quote: "irregularly irregular" }],
    verification: { verifier: "bo-2", at: "2026-10-06", result: "pass", notes: [] },
  }));

  // ---- psy
  await w("guides/psy/guide.json", { v: 1, id: "psy", source: "Psych EOR.docx", page, basePt: 11, preamble: [], systems: [] });
  await w("guides/psy/general.json", { v: 1, topics: [], workup: [] });
  await w("slides/psy/deck.json", { v: 1, guide: "psy", kind: "own", title: "Psych review slides", file: D(4), slides: [S(40)] });

  // ---- pance
  await w("guides/pance/guide.json", {
    v: 1, id: "pance", source: "PANCE.docx", page, basePt: 10, preamble: [], sidebarEnd: D(3),
    systems: [{ id: "cardiovascular", title: "Cardiovascular", pct: "13%" }],
  });
  await w("guides/pance/cardiovascular/system.json", { v: 1, id: "cardiovascular", blocks: [B(50)] });
  await w(`guides/pance/cardiovascular/blocks/${B(50)}.json`, block(B(50), "table", tableDoc(2, [[R(500), "content", "Metoprolol", "beta-1"], [R(501), "content", "Propranolol (non-selective)", "beta-1/2"]])));
  await w("guides/pance/cardiovascular/structure.json", {
    ...empty, drugTables: [{ block: B(50), pharmSection: "beta-blockers", conditionRows: [] }],
    pharmSections: [{ id: "beta-blockers", title: "Beta blockers", tables: [B(50)], overview: null, lo: null, also: [] }],
  });

  // ---- pharm notes and cards
  await w("pharm/cardio-med-list/pharmfile.json", {
    v: 1, id: "cardio-med-list", fileName: "cardio med list", basePt: 11, blocks: [B(70), B(71), B(72), B(73)],
    parts: [
      { id: P(1), role: "overview", title: "Overview", card: null, blocks: [B(70)] },
      { id: P(2), role: "card", title: "Calcium Channel Blockers", card: C(1), blocks: [B(71)] },
      { id: P(3), role: "card", title: "Nitrates", card: C(2), blocks: [B(72)] },
      { id: P(4), role: "card", title: "Beta Blockers", card: C(3), blocks: [B(73)] },
    ],
  });
  for (const [n, text] of [[70, "Antianginal overview"], [71, "MOA: block L-type channels"], [72, "MOA: venodilation"], [73, "MOA: beta-1 blockade"]] as const) {
    await w(`pharm/cardio-med-list/blocks/${B(n)}.json`, block(B(n), "prose", doc(para(text))));
  }
  await w("pharm/cards.json", {
    v: 1,
    cards: [
      { id: C(1), file: "cardio-med-list", aliases: ["calcium channel blocker", "CCB", "amlodipine", "diltiazem"], home: { fm: "cardiovascular" } },
      { id: C(2), file: "cardio-med-list", aliases: ["nitroglycerin", "nitrates"], home: {} },
      { id: C(3), file: "cardio-med-list", aliases: ["metoprolol", "beta-blocker", "propranolol (non-selective)"], home: { fm: "cardiovascular" } },
    ],
  });

  // ---- documents
  const pdf = (did: string, name: string, extra: Record<string, unknown> = {}) => ({
    v: 1, id: did, name, kind: "pdf", original: `${name}.pdf`, view: `${name}.pdf`, pages: 1, text: "text.json", removed: null, ...extra,
  });
  await w(`files/${D(1)}/file.json`, pdf(D(1), "ACLS algorithms"));
  await w(`files/${D(1)}/text.json`, { pages: ["Adenosine 6 mg rapid push"] });
  await writeStoredFile(root, D(1), "ACLS algorithms.pdf", new Uint8Array([37, 80, 68, 70]));
  const image = (did: string, name: string) => ({ v: 1, id: did, name, kind: "image", original: `${name}.png`, view: `${name}.png`, removed: null });
  await w(`files/${D(2)}/file.json`, image(D(2), "Renal chart"));
  await writeStoredFile(root, D(2), "Renal chart.png", PNG);
  await w(`files/${D(3)}/file.json`, image(D(3), "Receptor chart"));
  await writeStoredFile(root, D(3), "Receptor chart.png", PNG);
  const removed = { at: "2026-10-03T10:00:00Z", from: "a".repeat(40) };
  await w(`files/${D(4)}/file.json`, { v: 1, id: D(4), name: "Psych review slides", kind: "slides", original: "psych.pptx", view: null, pages: 3, text: null, removed });
  await w(`docs/${D(5)}/doc.json`, { v: 1, id: D(5), name: "Thyroid notes", kind: "word", source: "thyroid.docx", page, basePt: 11, blocks: [B(60), B(61)], removed: null });
  await w(`docs/${D(5)}/blocks/${B(60)}.json`, block(B(60), "prose", doc(para(`TSH first ${UNCOVERED}`))));
  await w(`docs/${D(5)}/blocks/${B(61)}.json`, block(B(61), "table", tableDoc(2, [[R(600), "content", "Free T4", "high"], [R(601), "content", "T3", "low"]])));
  await w(`files/${D(6)}/file.json`, pdf(D(6), "Old handout", { removed }));
  await w(`files/${D(7)}/file.json`, { v: 1, id: D(7), name: "New upload", kind: "word", original: "new.docx", view: null, pages: null, text: null, removed: null, state: "processing" });

  // ---- gap blocks
  await w(`gapfill/${G(1)}.json`, gapBlock(G(1), "TSH in AF", ["Check TSH.", "Repeat in 6 weeks."]));
  await w(`gapfill/${G(1)}.evidence.json`, evidence(G(1), ["Check TSH.", "Repeat in 6 weeks."]));
  await w(`gapfill/${G(2)}.json`, gapBlock(G(2), "AMS workup", ["Check glucose."]));
  await w(`gapfill/${G(2)}.evidence.json`, evidence(G(2), ["Check glucose."]));
  await w(`gapfill/${G(3)}.json`, gapBlock(G(3), "Vaccine schedule", ["Follow the schedule."]));
  await w(`gapfill/${G(3)}.evidence.json`, evidence(G(3), ["Follow the schedule."]));

  // ---- places
  const tab = { subs: [], files: [] };
  await w("places/reftabs.json", {
    v: 1, labs: { subs: [{ id: "cbc", title: "CBC", links: [{ target: R(201), covers: "Asthma CBC" }], gaps: [G(1)] }], files: [D(5)] },
    imaging: tab, ekg: tab, anatomy: tab,
  });
  const sec = (sid: string, title: string, extra: Record<string, unknown> = {}) => ({ id: sid, title, lead: null, files: [], links: [], ...extra });
  await w("places/other.json", {
    v: 1,
    sections: [
      sec("emergency", "Emergency"), sec("vaccines", "Vaccines", { lead: G(3) }), sec("guidelines", "Guidelines", { files: [D(1)] }),
      sec("screenings", "Screenings", { gaps: [] }), sec("legal", "Legal", { gaps: [] }), sec("pa", "PA profession"),
      sec("vitamins", "Vitamins"), sec("pe", "Physical exam"), sec("notes", "Notes", { files: [D(6)] }),
    ],
  });

  // ---- updates
  const flag = (n: number, extra: Record<string, unknown>) => ({
    id: U(n), kind: "rec", source: "gold", by: "check", key: `k${n}`, subject: `k${n}`, guideline: `Guideline ${n}`,
    org: "GOLD", published: "2024-04", quote: `Quote ${n}`, grade: null, url: "https://goldcopd.org/x", flagged: "2026-10-01", supersededBy: null, ...extra,
  });
  await w("updates/flags.json", {
    v: 1,
    flags: [
      flag(1, {}),
      flag(2, { by: "agent", locator: "p. 1", verification: { verifier: "bo-2", at: "2026-10-06", result: "fail" }, published: "2025-01" }),
      flag(3, { kind: "edition", subject: null, key: "gold", quote: null, flagged: "2026-10-02" }),
      flag(4, { supersededBy: U(1), published: "2019-01" }),
      flag(5, { by: "agent", locator: "p. 2", verification: { verifier: "bo-2", at: "2026-10-06", result: "pass" }, published: "2023-05" }),
    ],
  });
  await w("updates/concepts.json", {
    v: 1,
    concepts: [
      { id: "af", title: "AF", sourceKeys: { gold: ["k1", "k4"] }, targets: [R(101), G(1), GONE, D(6)] },
      { id: "copd", title: "COPD", sourceKeys: { gold: ["k2", "k5"] }, targets: [R(201), D(5)] },
    ],
  });
  await w("updates/checks.json", { v: 1, lastRun: "2026-10-01", nextRun: "2026-11-01", sources: [], seen: {}, seenUrl: {} });
}
