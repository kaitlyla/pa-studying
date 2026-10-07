// The guideline check (80 §80.3) over a temporary content tree, with every source answered by
// synthetic responses shaped as recorded in 80 §80.1.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTrailers } from "../../lib/content/index.ts";
import type { ChecksFile, Flag, FlagsFile, GapFile } from "../../lib/content/index.ts";
import { readContent, readContentIfExists, removeContent, writeContent } from "../../lib/content/fs.ts";
import { initTestRepo } from "../testing/git.ts";
import { detectEdition, GINA_URL, GOLD_URL, PUBMED_SOURCES } from "./editions.ts";
import { EUTILS_SPACING_MS, EUTILS_TOOL, Http } from "./http.ts";
import { main, probe } from "./index.ts";
import { CHECKS_PATH, FLAGS_PATH, nextRunDate, runCheck } from "./run.ts";
import type { SeenRecommendation } from "./run.ts";
import { abPage, fakeNet, html, notFound, pubmedRoute, recommendationPage } from "./testing.ts";
import type { AbRow, PubmedFixture } from "./testing.ts";
import { assignUspstfKeys, parseAbRows, USPSTF_AB_URL, USPSTF_ORG } from "./uspstf.ts";

const CHLAMYDIA = "Chlamydia and Gonorrhea: Screening: sexually active women, including pregnant persons";
const BREAST = "Breast Cancer: Screening: women aged 40 to 74 years";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Release months of the generated rows 5–29: two per year from 2014, July then January (row 17 is 2020-07, row 20 2021-01). */
const generatedMonth = (i: number): { year: number; month: number } => ({ year: 2014 + Math.floor((i - 5) / 2), month: (i % 2) * 6 + 1 });

/** 30 rows: two share the Chlamydia link text, one has a spaced date with a `*` link, one a footnote, one an unclosed `<p>`. */
function baseRows(): AbRow[] {
  const rows: AbRow[] = [
    { subject: CHLAMYDIA, statement: "The USPSTF recommends screening for chlamydia in all sexually active women 24 years or younger.", grade: "B", date: "September 2021", href: "/uspstf/recommendation/chlamydia-and-gonorrhea-screening" },
    { subject: CHLAMYDIA, statement: "The USPSTF recommends screening for gonorrhea in all sexually active women 24 years or younger.", grade: "B", date: "September 2021", href: "/uspstf/recommendation/chlamydia-and-gonorrhea-screening" },
    { subject: "Hypertension in Adults: Screening: adults 18 years or older without known hypertension", statement: "The USPSTF recommends screening for hypertension in adults 18 years or older with office blood pressure measurement.", grade: "A", date: "April     2024  <a href='#more'>*</a> ", href: "/uspstf/recommendation/hypertension-in-adults-screening" },
    { subject: "Colorectal Cancer: Screening: adults aged 50 to 75 years", statement: "The USPSTF recommends screening for colorectal cancer in all adults aged 50 to 75 years.<sup><a href='#bcf'>†</a></sup>", grade: "A", date: "May 2021", href: "/uspstf/recommendation/colorectal-cancer-screening" },
    { subject: "Falls Prevention in Community-Dwelling Older Adults: Interventions: adults 65 years or older", statement: "<p>The USPSTF recommends exercise interventions to prevent falls.\n\n<p>See the Practice Considerations section.", grade: "B", date: "June 2024", href: "/uspstf/recommendation/falls-prevention-community-dwelling-older-adults-interventions" },
  ];
  for (let i = 5; i < 30; i++) {
    const { year, month } = generatedMonth(i);
    rows.push({ subject: `Topic ${i}: Screening: adults aged ${i} years`, statement: `The USPSTF recommends screening ${i}.`, grade: i % 3 === 0 ? "A" : "B", date: `${MONTHS[month - 1]} ${year}`, href: `/uspstf/recommendation/topic-${i}` });
  }
  return rows;
}

const PUBMED: Record<string, PubmedFixture[]> = {
  [PUBMED_SOURCES.ada.term]: [
    { pmid: 41358883, title: "Introduction and Methodology: Standards of Care in Diabetes-2026.", pubdate: "2026 Jan 1", doi: "10.2337/dc26-SINT" },
    { pmid: 39651984, title: "Introduction and Methodology: Standards of Care in Diabetes-2025.", pubdate: "2025 Jan 1", doi: "10.2337/dc25-SINT" },
  ],
  [PUBMED_SOURCES.hf.term]: [
    { pmid: 40000001, title: "Trends in Guideline-Directed Medical Therapy for Heart Failure: 2025 update.", pubdate: "2025 Mar" },
    { pmid: 36000001, title: "Correction to: 2022 AHA/ACC/HFSA Guideline for the Management of Heart Failure.", pubdate: "2022 Sep 6", doi: "10.1161/CIR.0000000000001099" },
    { pmid: 35363499, title: "2022 AHA/ACC/HFSA Guideline for the Management of Heart Failure: A Report of the American College of Cardiology/American Heart Association Joint Committee on Clinical Practice Guidelines.", pubdate: "2022 May 3", doi: "10.1161/CIR.0000000000001063" },
  ],
  [PUBMED_SOURCES.cpr.term]: [
    { pmid: 41122890, title: "Part 9: Adult Advanced Life Support: 2025 American Heart Association Guidelines for Cardiopulmonary Resuscitation and Emergency Cardiovascular Care.", pubdate: "2025 Oct 21", doi: "10.1161/CIR.0000000000001376" },
    { pmid: 41122893, title: "Part 1: Executive Summary: 2025 American Heart Association Guidelines for Cardiopulmonary Resuscitation and Emergency Cardiovascular Care.", pubdate: "2025 Oct 21", doi: "10.1161/CIR.0000000000001372" },
  ],
};

const GOLD_PAGE = `<html><body><a href="/2025-gold-report/">2025 GOLD Report</a><h2>2026 GOLD Report</h2>
<a href="https://goldcopd.org/2026-gold-report-and-pocket-guide/">Read it</a></body></html>`;
const GINA_PAGE = `<html><body><a href="/2026-gina-strategy-report/">2026 GINA Strategy Report</a> <a>2024 GINA Strategy Report</a></body></html>`;

interface World {
  ab: string | Response | null;
  /** Recommendation pages by URL; null is a network error. Any other URL answers 404. */
  recPages: Record<string, string | Response | null>;
  gold: string | null;
  gina: string | null;
  pubmed: Record<string, PubmedFixture[]>;
  pages: Record<string, string>;
}

function world(over: Partial<World> = {}): World {
  return { ab: abPage(baseRows()), recPages: {}, gold: GOLD_PAGE, gina: GINA_PAGE, pubmed: PUBMED, pages: {}, ...over };
}

function routeWorld(w: World): (url: URL) => Response | undefined {
  const pubmed = pubmedRoute(w.pubmed);
  const asResponse = (v: string | Response | null): Response | undefined => (v === null ? undefined : typeof v === "string" ? html(v) : v);
  return (url) => {
    const bare = `${url.origin}${url.pathname}`;
    if (bare === USPSTF_AB_URL) return asResponse(w.ab);
    if (Object.hasOwn(w.recPages, bare)) return asResponse(w.recPages[bare] ?? null);
    if (bare === GOLD_URL) return asResponse(w.gold);
    if (bare === GINA_URL) return asResponse(w.gina);
    if (url.hostname === "eutils.ncbi.nlm.nih.gov") return pubmed(url);
    if (Object.hasOwn(w.pages, url.href)) return html(w.pages[url.href]!);
    return notFound();
  };
}

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "pa-guidelines-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function run(w: World, today: string) {
  const fake = fakeNet(routeWorld(w));
  const log: string[] = [];
  const report = await runCheck(root, new Http(fake.net), today, (l) => log.push(l));
  const flags = (await readContent<FlagsFile>(root, FLAGS_PATH)).flags;
  const checks = await readContent<ChecksFile>(root, CHECKS_PATH);
  return { report, flags, checks, fake, log };
}

const status = (checks: ChecksFile, id: string) => checks.sources.find((s) => s.id === id);
const current = (flags: Flag[]) => flags.filter((f) => f.supersededBy === null);
const seenOf = (checks: ChecksFile) => checks.seen.uspstf as Record<string, SeenRecommendation>;
const keyOf = (path: string, n = 1) => `/uspstf/recommendation/${path}#${n}`;
const CHLAMYDIA_PATH = "chlamydia-and-gonorrhea-screening";

describe("USPSTF A and B page (80 §80.3.1)", () => {
  it("reads 30 records keyed on their page path and position, with the release month and the statement without footnote markers", () => {
    const records = assignUspstfKeys(parseAbRows(abPage(baseRows())));
    expect(records).toHaveLength(30);
    expect(records[0]).toEqual({
      key: keyOf(CHLAMYDIA_PATH, 1), subject: CHLAMYDIA, grade: "B", published: "2021-09",
      quote: "The USPSTF recommends screening for chlamydia in all sexually active women 24 years or younger.",
      url: "https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/chlamydia-and-gonorrhea-screening",
    });
    expect(records[1]!.key).toBe(keyOf(CHLAMYDIA_PATH, 2));
    expect(records[1]!.quote).toContain("gonorrhea");
    expect(records[2]!.published).toBe("2024-04");
    expect(records[3]!.quote).toBe("The USPSTF recommends screening for colorectal cancer in all adults aged 50 to 75 years.");
    expect(records[4]!.quote).toBe("The USPSTF recommends exercise interventions to prevent falls.\n\nSee the Practice Considerations section.");
    expect(records[5]).toMatchObject({ key: keyOf("topic-5"), subject: "Topic 5: Screening: adults aged 5 years", published: "2014-07", grade: "B" });
  });

  it("normalizes the identity path: case, host, query, fragment and trailing slash do not matter; different link texts on one page share it", () => {
    const rows = baseRows();
    rows[7] = { ...rows[7]!, href: "https://www.uspreventiveservicestaskforce.org/USPSTF/Recommendation/Topic-6/?tab=1#summary" };
    rows[8] = { ...rows[8]!, subject: "Something else entirely: Screening: adults" };
    const records = assignUspstfKeys(parseAbRows(abPage(rows)));
    expect(records[6]!.key).toBe(keyOf("topic-6", 1));
    expect(records[7]!.key).toBe(keyOf("topic-6", 2));
    expect(records[7]!.url).toBe("https://www.uspreventiveservicestaskforce.org/USPSTF/Recommendation/Topic-6/?tab=1#summary");
    expect(records[8]).toMatchObject({ key: keyOf("topic-8"), subject: "Something else entirely: Screening: adults" });
  });

  it("fails on header cells that differ, a short table, a row without a link or month, and a page with no table", () => {
    const rows = baseRows();
    expect(() => parseAbRows(abPage(rows, ["Topic", "Description", "Grade", "Release Date"]))).toThrow(/unexpected header cells/);
    expect(() => parseAbRows(abPage(rows.slice(0, 29)))).toThrow(/29 data rows, expected at least 30/);
    expect(() => parseAbRows(abPage(rows.map((r, i) => (i === 7 ? { ...r, date: "Pending" } : r))))).toThrow(/row 8 has no release month/);
    expect(() => parseAbRows(abPage(rows).replace("<td><a href='/uspstf/recommendation/topic-9'>", "<td><a>"))).toThrow(/row 10 has no topic link/);
    expect(() => parseAbRows(abPage(rows).replace("<td>B</td>", "<td>B</td><td>extra</td>"))).toThrow(/row 1 has 5 cells/);
    expect(() => parseAbRows(abPage(rows).replace("<td>B</td>", "<td> </td>"))).toThrow(/row 1 is incomplete/);
    expect(() => parseAbRows("<html><body><p>Maintenance</p></body></html>")).toThrow(/no table/);
  });

  it("baseline mode flags exactly the records released 2021-01 or later, and records every key in seen", async () => {
    const { flags, checks, report } = await run(world(), "2026-10-01");
    const expected = assignUspstfKeys(parseAbRows(abPage(baseRows()))).filter((r) => {
      const [y, m] = r.published.split("-").map(Number) as [number, number];
      return y > 2021 || (y === 2021 && m >= 1);
    });
    const uspstf = flags.filter((f) => f.source === "uspstf");
    expect(uspstf.map((f) => f.key).sort()).toEqual(expected.map((r) => r.key).sort());
    expect(uspstf.find((f) => f.key === keyOf("topic-20"))?.published).toBe("2021-01"); // the boundary
    expect(seenOf(checks)[keyOf("topic-17")]!.published).toBe("2020-07");
    expect(uspstf.map((f) => f.key)).not.toContain(keyOf("topic-17"));
    expect(uspstf.find((f) => f.key === keyOf(CHLAMYDIA_PATH, 2))).toMatchObject({
      kind: "rec", by: "check", subject: CHLAMYDIA, guideline: CHLAMYDIA, org: USPSTF_ORG, grade: "B", published: "2021-09",
      flagged: "2026-10-01", supersededBy: null,
    });
    expect(Object.keys(seenOf(checks))).toHaveLength(30);
    expect(seenOf(checks)[keyOf("topic-5")]).toEqual({ published: "2014-07", subject: "Topic 5: Screening: adults aged 5 years", quote: "The USPSTF recommends screening 5." });
    expect(checks.seenUrl[keyOf(CHLAMYDIA_PATH, 2)]).toBe("https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/chlamydia-and-gonorrhea-screening");
    expect(status(checks, "uspstf")).toEqual({ id: "uspstf", lastSuccess: "2026-10-01", lastAttempt: "2026-10-01", status: "ok" });
    expect(report.sources.find((s) => s.id === "uspstf")).toMatchObject({ ok: true, added: expected.length });
  });

  it("normal mode adds nothing on an unchanged page, and one superseding flag for a changed release month", async () => {
    const first = await run(world(), "2026-10-01");
    const again = await run(world(), "2026-11-01");
    expect(again.flags).toEqual(first.flags);

    const rows = baseRows();
    rows[2] = { ...rows[2]!, statement: "The USPSTF recommends screening for hypertension in adults 18 years or older.", date: "March 2026" };
    const changed = await run(world({ ab: abPage(rows) }), "2026-12-01");
    expect(changed.flags).toHaveLength(first.flags.length + 1);
    const added = changed.flags.at(-1)!;
    const key = keyOf("hypertension-in-adults-screening");
    expect(added).toMatchObject({ key, published: "2026-03", quote: "The USPSTF recommends screening for hypertension in adults 18 years or older.", flagged: "2026-12-01", supersededBy: null });
    const earlier = changed.flags.find((f) => f.key === key && f.id !== added.id)!;
    expect(earlier).toMatchObject({ published: "2024-04", supersededBy: added.id });
    expect(current(changed.flags).filter((f) => f.key === key)).toHaveLength(1);
    expect(seenOf(changed.checks)[key]!.published).toBe("2026-03");
  });

  it("a reworded population and statement on a single-row page is a revision: its flag supersedes the old one, even in the same release month", async () => {
    // Breast cancer screening, 2024: the population went from "women aged 50 to 74 years" to "women aged 40 to 74 years".
    const before: AbRow = { subject: "Breast Cancer: Screening: women aged 50 to 74 years", statement: "The USPSTF recommends biennial screening mammography for women aged 50 to 74 years.", grade: "B", date: "April 2024", href: "/uspstf/recommendation/breast-cancer-screening" };
    const first = await run(world({ ab: abPage([...baseRows(), before]) }), "2026-10-01");
    const reworded: AbRow = { ...before, subject: BREAST, statement: "The USPSTF recommends biennial screening mammography for women aged 40 to 74 years." };
    const second = await run(world({ ab: abPage([...baseRows(), reworded]) }), "2026-11-01");
    expect(second.flags).toHaveLength(first.flags.length + 1);
    const key = keyOf("breast-cancer-screening");
    const [old, revision] = second.flags.filter((f) => f.key === key);
    expect(revision).toMatchObject({
      subject: BREAST, guideline: BREAST, quote: "The USPSTF recommends biennial screening mammography for women aged 40 to 74 years.",
      published: "2024-04", flagged: "2026-11-01", supersededBy: null,
    });
    expect(second.log.some((l) => l.includes("retired"))).toBe(false);
    expect(old).toMatchObject({ subject: "Breast Cancer: Screening: women aged 50 to 74 years", supersededBy: revision!.id });
    expect(seenOf(second.checks)[key]!.subject).toBe(BREAST);
  });

  it("a changed statement at the same page and month is a revision too", async () => {
    const first = await run(world(), "2026-10-01");
    const rows = baseRows();
    rows[3] = { ...rows[3]!, statement: "The USPSTF recommends screening for colorectal cancer in all adults aged 45 to 75 years." };
    const second = await run(world({ ab: abPage(rows) }), "2026-11-01");
    expect(second.flags).toHaveLength(first.flags.length + 1);
    expect(current(second.flags).find((f) => f.key === keyOf("colorectal-cancer-screening"))).toMatchObject({
      quote: "The USPSTF recommends screening for colorectal cancer in all adults aged 45 to 75 years.", published: "2021-05", flagged: "2026-11-01",
    });
  });

  describe("keys stay bound to their rows (Orchestrator ruling 2026-10-04 04:40Z)", () => {
    const COLORECTAL_PATH = "colorectal-cancer-screening";
    const older: AbRow = {
      subject: "Colorectal Cancer: Screening: adults aged 45 to 49 years", statement: "The USPSTF recommends screening for colorectal cancer in adults aged 45 to 49 years.",
      grade: "B", date: "May 2021", href: `/uspstf/recommendation/${COLORECTAL_PATH}`,
    };
    /** baseRows with the 45–49 row inserted above the 50–75 row, as USPSTF did in 2021. */
    const withInsert = (): AbRow[] => { const rows = baseRows(); rows.splice(3, 0, older); return rows; };

    it("the colorectal insert: the 50–75 key keeps 50–75, and 45–49 gets a new ordinal", async () => {
      const first = await run(world(), "2026-10-01");
      const fiftyKey = keyOf(COLORECTAL_PATH, 1);
      const fifty = first.flags.find((f) => f.key === fiftyKey)!;
      expect(fifty.subject).toBe("Colorectal Cancer: Screening: adults aged 50 to 75 years");
      const second = await run(world({ ab: abPage(withInsert()) }), "2026-11-01");
      expect(second.flags.find((f) => f.id === fifty.id)).toEqual(fifty); // not superseded, not retired
      expect(second.flags.filter((f) => f.key === fiftyKey)).toHaveLength(1);
      expect(second.flags.at(-1)).toMatchObject({ key: keyOf(COLORECTAL_PATH, 2), subject: older.subject, supersededBy: null, flagged: "2026-11-01" });
      expect(second.flags).toHaveLength(first.flags.length + 1);
      expect(seenOf(second.checks)[fiftyKey]!.subject).toBe(fifty.subject);
      expect(seenOf(second.checks)[keyOf(COLORECTAL_PATH, 2)]!.subject).toBe(older.subject);
      expect(second.log.some((l) => l.includes("retired"))).toBe(false);
    });

    it("a removed row: the remaining row keeps its key and is not flagged again; the removed row's key retires", async () => {
      const first = await run(world({ ab: abPage(withInsert()) }), "2026-10-01");
      // Baseline keys in table order: 45–49 is #1, 50–75 is #2.
      const remaining = first.flags.find((f) => f.key === keyOf(COLORECTAL_PATH, 2))!;
      const removed = first.flags.find((f) => f.key === keyOf(COLORECTAL_PATH, 1))!;
      expect([removed.subject, remaining.subject]).toEqual([older.subject, "Colorectal Cancer: Screening: adults aged 50 to 75 years"]);
      const second = await run(world(), "2026-11-01"); // its page answers 404
      expect(second.flags).toHaveLength(first.flags.length);
      expect(second.flags.find((f) => f.id === remaining.id)).toEqual(remaining);
      expect(second.flags.find((f) => f.id === removed.id)).toEqual({ ...removed, retired: "2026-11-01" });
      expect(Object.keys(seenOf(second.checks)).filter((k) => k.includes(COLORECTAL_PATH))).toEqual([keyOf(COLORECTAL_PATH, 2)]);
    });

    it("unequal leftovers are not paired: the stored keys retire and every new row takes a new ordinal", async () => {
      const first = await run(world(), "2026-10-01");
      const rows = baseRows();
      const replacement = (n: number): AbRow => ({
        subject: `Chlamydia and Gonorrhea: Screening: group ${n}`, statement: `The USPSTF recommends screening group ${n}.`,
        grade: "B", date: "June 2026", href: `/uspstf/recommendation/${CHLAMYDIA_PATH}`,
      });
      rows.splice(0, 2, replacement(1), replacement(2), replacement(3));
      const second = await run(world({ ab: abPage(rows) }), "2026-11-01");
      for (const n of [1, 2]) {
        const old = first.flags.find((f) => f.key === keyOf(CHLAMYDIA_PATH, n))!;
        expect(second.flags.find((f) => f.id === old.id)).toEqual({ ...old, retired: "2026-11-01" });
      }
      const added = second.flags.slice(first.flags.length);
      expect(added.map((f) => [f.key, f.subject])).toEqual([3, 4, 5].map((n) => [keyOf(CHLAMYDIA_PATH, n), `Chlamydia and Gonorrhea: Screening: group ${n - 2}`]));
      expect(added.every((f) => f.supersededBy === null && f.retired === undefined)).toBe(true);
    });

    it("assignUspstfKeys: population first, then statement, then table order for equal leftovers; a new ordinal skips stored and reserved keys", () => {
      const url = "https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/p";
      const row = (subject: string, quote: string) => ({ url, subject, quote });
      const stored = { "/uspstf/recommendation/p#1": { subject: "A", quote: "a" }, "/uspstf/recommendation/p#2": { subject: "B", quote: "b" } };
      const keysOf = (rows: { url: string; subject: string; quote: string }[], reserved: string[] = []) =>
        assignUspstfKeys(rows, stored, reserved).map((r) => r.key.slice(r.key.indexOf("#")));
      expect(keysOf([row("B", "b2"), row("A2", "a")])).toEqual(["#2", "#1"]); // population, then statement
      expect(keysOf([row("Y", "y"), row("X", "x")])).toEqual(["#1", "#2"]); // two left over each side: table order
      expect(keysOf([row("Y", "y"), row("A", "a"), row("X", "x")], ["/uspstf/recommendation/p#7"])).toEqual(["#8", "#1", "#9"]);
      expect(assignUspstfKeys([row("A", "a"), row("A", "a")]).map((r) => r.key)).toEqual(["/uspstf/recommendation/p#1", "/uspstf/recommendation/p#2"]);
    });
  });

  it.each([
    ["header cells that differ", abPage(baseRows(), ["Topic", "Summary", "Grade", "Release Date of Current Recommendation"])],
    ["29 rows", abPage(baseRows().slice(0, 29))],
  ])("fails the source on %s: flags, seen and lastSuccess unchanged", async (_, page) => {
    const first = await run(world(), "2026-10-01");
    const failed = await run(world({ ab: page }), "2026-11-01");
    expect(failed.flags).toEqual(first.flags);
    expect(failed.checks.seen.uspstf).toEqual(first.checks.seen.uspstf);
    expect(failed.checks.seenUrl).toEqual(first.checks.seenUrl);
    expect(status(failed.checks, "uspstf")).toEqual({ id: "uspstf", lastSuccess: "2026-10-01", lastAttempt: "2026-11-01", status: "fail" });
    // The other sources were still checked.
    expect(status(failed.checks, "gold")).toMatchObject({ status: "ok", lastSuccess: "2026-11-01" });
  });

  it("fails the source on a non-2xx answer and on a network error", async () => {
    const first = await run(world(), "2026-10-01");
    for (const ab of [html("Forbidden", 403), null]) {
      const failed = await run(world({ ab }), "2026-11-01");
      expect(failed.flags).toEqual(first.flags);
      expect(status(failed.checks, "uspstf")).toMatchObject({ status: "fail", lastSuccess: "2026-10-01" });
    }
  });

  describe("a key that left the page", () => {
    const breastRow: AbRow = { subject: BREAST, statement: "The USPSTF recommends biennial screening mammography for women aged 50 to 74 years.", grade: "B", date: "January 2016", href: "/uspstf/recommendation/breast-cancer-screening" };
    const breastUrl = "https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/breast-cancer-screening";
    const summary = recommendationPage([
      { population: "Women 75 years or older", recommendation: "The USPSTF concludes that the current evidence is insufficient.", grade: "I" },
      { population: "Women   aged 40 to 74 years", recommendation: "The USPSTF recommends biennial screening mammography for women aged 40 to 74 years.<sup>1</sup>", grade: "B" },
    ], "April 30, 2024");

    const breastKey = keyOf("breast-cancer-screening");
    /** The breast row released in 2024, so the baseline flags it. */
    const flaggedBreastRow: AbRow = { ...breastRow, subject: BREAST, statement: "The USPSTF recommends biennial screening mammography for women aged 40 to 74 years.", date: "April 2024" };

    it("is flagged from the matching Recommendation Summary row, and leaves seen", async () => {
      const first = await run(world({ ab: abPage([...baseRows(), breastRow]) }), "2026-10-01");
      expect(first.flags.some((f) => f.subject === BREAST)).toBe(false); // released 2016
      const second = await run(world({ recPages: { [breastUrl]: summary } }), "2026-11-01");
      expect(second.flags).toHaveLength(first.flags.length + 1);
      expect(second.flags.at(-1)).toMatchObject({
        kind: "rec", source: "uspstf", key: breastKey, subject: BREAST, guideline: BREAST,
        quote: "The USPSTF recommends biennial screening mammography for women aged 40 to 74 years.", grade: "B",
        published: "2024-04", url: breastUrl, flagged: "2026-11-01", supersededBy: null,
      });
      expect(second.checks.seen.uspstf).not.toHaveProperty(breastKey);
      expect(second.checks.seenUrl).not.toHaveProperty(breastKey);
      expect(status(second.checks, "uspstf")).toMatchObject({ status: "ok" });
    });

    it("a matching row (the recommendation re-graded off the list) supersedes the identity's flag", async () => {
      const first = await run(world({ ab: abPage([...baseRows(), flaggedBreastRow]) }), "2026-10-01");
      const regraded = recommendationPage([{ population: "Women aged 40 to 74 years", recommendation: "The USPSTF concludes that the evidence is insufficient.", grade: "I" }], "May 1, 2026");
      const second = await run(world({ recPages: { [breastUrl]: regraded } }), "2026-11-01");
      const [old, now] = second.flags.filter((f) => f.key === breastKey);
      expect(now).toMatchObject({ grade: "I", published: "2026-05", supersededBy: null });
      expect(old).toMatchObject({ grade: "B", supersededBy: now!.id });
      expect(old!.retired).toBeUndefined();
      expect(first.flags.length + 1).toBe(second.flags.length);
    });

    it.each([
      ["its page answers 404", html("Not found", 404)],
      ["its page answers 410", html("Gone", 410)],
      ["its page has no Recommendation Summary table", "<html><body><h3>Recommendation Summary</h3><p>Moved.</p></body></html>"],
      ["no Population row matches", recommendationPage([{ population: "Women 75 years or older", recommendation: "Insufficient.", grade: "I" }], "April 30, 2024")],
    ])("retires the identity when %s: its flag stays listed with the retired date, the job log reports it, and the A and B comparison still lands", async (_, page) => {
      const first = await run(world({ ab: abPage([...baseRows(), flaggedBreastRow]) }), "2026-10-01");
      const before = first.flags.find((f) => f.key === breastKey)!;
      const rows = baseRows();
      rows[2] = { ...rows[2]!, date: "March 2026" }; // a change elsewhere on the page in the same run
      const second = await run(world({ ab: abPage(rows), recPages: { [breastUrl]: page } }), "2026-11-01");
      expect(second.flags.find((f) => f.id === before.id)).toEqual({ ...before, retired: "2026-11-01" });
      expect(second.flags.filter((f) => f.key === breastKey)).toHaveLength(1);
      expect(second.log).toContain(`uspstf: retired ${breastKey} (${BREAST}): no longer on the A and B list or its page`);
      expect(second.checks.seen.uspstf).not.toHaveProperty(breastKey);
      expect(second.checks.seenUrl).not.toHaveProperty(breastKey);
      expect(current(second.flags).find((f) => f.key === keyOf("hypertension-in-adults-screening"))!.published).toBe("2026-03");
      expect(status(second.checks, "uspstf")).toMatchObject({ status: "ok", lastSuccess: "2026-11-01" });
      // Retired once: the next run neither refetches nor re-reports it.
      const third = await run(world({ ab: abPage(rows) }), "2026-12-01");
      expect(third.flags).toEqual(second.flags);
      expect(third.log.some((l) => l.includes("retired"))).toBe(false);
      expect(third.fake.requests).not.toContain(breastUrl);
    });

    it("reports a retired identity that never had a flag in the job log only", async () => {
      await run(world({ ab: abPage([...baseRows(), breastRow]) }), "2026-10-01");
      const second = await run(world(), "2026-11-01");
      expect(second.flags.some((f) => f.key === breastKey)).toBe(false);
      expect(second.log).toContain(`uspstf: retired ${breastKey} (${BREAST}): no longer on the A and B list or its page`);
      expect(second.checks.seen.uspstf).not.toHaveProperty(breastKey);
    });

    it("a slug change: the old page answers 404 and a new page appears; the old flag is retired, the new identity gets its own flag", async () => {
      const first = await run(world({ ab: abPage([...baseRows(), flaggedBreastRow]) }), "2026-10-01");
      const moved: AbRow = { ...flaggedBreastRow, href: "/uspstf/recommendation/breast-cancer-screening-2026", date: "June 2026" };
      const second = await run(world({ ab: abPage([...baseRows(), moved]) }), "2026-11-01");
      const old = second.flags.find((f) => f.key === breastKey)!;
      const successor = second.flags.find((f) => f.key === keyOf("breast-cancer-screening-2026"))!;
      expect(old).toEqual({ ...first.flags.find((f) => f.key === breastKey)!, retired: "2026-11-01" });
      expect(successor).toMatchObject({ subject: BREAST, published: "2026-06", supersededBy: null, flagged: "2026-11-01" });
      expect(successor.retired).toBeUndefined();
      // No current, unretired flag of the departed identity remains to be placed.
      expect(second.flags.filter((f) => f.key === breastKey && f.supersededBy === null && f.retired === undefined)).toEqual([]);
      expect(Object.keys(seenOf(second.checks))).toContain(keyOf("breast-cancer-screening-2026"));
    });

    it.each([
      ["the page answers 503", html("Unavailable", 503)],
      ["the page answers 403", html("Forbidden", 403)],
      ["the network fails", null],
      [
        "the matched row's page has no release date",
        recommendationPage([{ population: "women aged 40 to 74 years", recommendation: "The USPSTF recommends mammography.", grade: "B" }], "Undated")
          .replace("Updated March 3, 2025", "Updated recently"),
      ],
    ])("fails the whole source when %s, so the identity is retried", async (_, page) => {
      const first = await run(world({ ab: abPage([...baseRows(), flaggedBreastRow]) }), "2026-10-01");
      const second = await run(world({ recPages: { [breastUrl]: page } }), "2026-11-01");
      expect(second.flags).toEqual(first.flags);
      expect(second.checks.seen.uspstf).toEqual(first.checks.seen.uspstf);
      expect(second.checks.seenUrl).toEqual(first.checks.seenUrl);
      expect(status(second.checks, "uspstf")).toMatchObject({ status: "fail", lastSuccess: "2026-10-01" });
    });
  });
});

describe("edition sources (80 §80.3.2)", () => {
  it("reads ADA, HF and CPR editions from PubMed summaries", async () => {
    const fake = fakeNet(pubmedRoute(PUBMED));
    const http = new Http(fake.net);
    expect(await detectEdition(http, "ada", "2026-10-01")).toEqual({
      year: 2026, label: "Standards of Care in Diabetes-2026", published: "2026-01", url: "https://doi.org/10.2337/dc26-SINT",
    });
    expect(await detectEdition(http, "hf", "2026-10-01")).toEqual({
      year: 2022, label: "2022 AHA/ACC/HFSA Guideline for the Management of Heart Failure", published: "2022-05",
      url: "https://doi.org/10.1161/CIR.0000000000001063",
    });
    // Part 9 has the lower PMID, but the Executive Summary represents the edition.
    expect(await detectEdition(http, "cpr", "2026-10-01")).toEqual({
      year: 2025, label: "2025 American Heart Association Guidelines for Cardiopulmonary Resuscitation and Emergency Cardiovascular Care",
      published: "2025-10", url: "https://doi.org/10.1161/CIR.0000000000001372",
    });
    // Six E-utilities requests, each after the last by at least the spacing, all with `tool` and no `email`.
    expect(fake.requests).toHaveLength(6);
    expect(fake.sleeps).toEqual([EUTILS_SPACING_MS, EUTILS_SPACING_MS, EUTILS_SPACING_MS, EUTILS_SPACING_MS, EUTILS_SPACING_MS]);
    for (const r of fake.requests.map((u) => new URL(u))) {
      expect(r.searchParams.get("tool")).toBe(EUTILS_TOOL);
      expect(r.searchParams.has("email")).toBe(false);
      expect(r.searchParams.get("db")).toBe("pubmed");
    }
    const search = new URL(fake.requests[0]!);
    expect(search.pathname).toBe("/entrez/eutils/esearch.fcgi");
    expect(Object.fromEntries(search.searchParams)).toMatchObject({ retmode: "json", sort: "pub_date", retmax: "20", term: PUBMED_SOURCES.ada.term });
    expect(new URL(fake.requests[1]!).searchParams.get("id")).toBe("41358883,39651984");
  });

  it("uses the PubMed page when the representative item has no DOI, and YYYY-01 for a pubdate with no month", async () => {
    const fake = fakeNet(pubmedRoute({ [PUBMED_SOURCES.ada.term]: [{ pmid: 31862745, title: "Standards of Medical Care in Diabetes-2020 Abridged for Primary Care Providers.", pubdate: "2020" }] }));
    expect(await detectEdition(new Http(fake.net), "ada", "2026-10-01")).toEqual({
      year: 2020, label: "Standards of Medical Care in Diabetes-2020", published: "2020-01", url: "https://pubmed.ncbi.nlm.nih.gov/31862745/",
    });
  });

  it("fails on no candidate, an empty search, and malformed E-utilities answers", async () => {
    const detect = (route: (url: URL) => Response | undefined) => detectEdition(new Http(fakeNet(route).net), "hf", "2026-10-01");
    await expect(detect(pubmedRoute({ [PUBMED_SOURCES.hf.term]: [{ pmid: 1, title: "Correction to: 2022 AHA/ACC/HFSA Guideline for Heart Failure.", pubdate: "2022" }] }))).rejects.toThrow(/no candidate/);
    await expect(detect(pubmedRoute({}))).rejects.toThrow(/no candidate/);
    await expect(detect(() => html("{not json"))).rejects.toThrow(/invalid JSON/);
    await expect(detect(() => html(JSON.stringify({ esearchresult: {} })))).rejects.toThrow(/no idlist/);
    await expect(detect((url) => (url.pathname.endsWith("esearch.fcgi") ? html(JSON.stringify({ esearchresult: { idlist: ["5"] } })) : html("{}")))).rejects.toThrow(/esummary: no result/);
    await expect(detect((url) => (url.pathname.endsWith("esearch.fcgi") ? html(JSON.stringify({ esearchresult: { idlist: ["5"] } })) : html(JSON.stringify({ result: { 5: { title: "x" } } }))))).rejects.toThrow(/no title and pubdate for PMID 5/);
    await expect(detect(pubmedRoute({ [PUBMED_SOURCES.hf.term]: [{ pmid: 1, title: "2022 Heart Failure guideline.", pubdate: "Spring" }] }))).rejects.toThrow(/unreadable pubdate/);
  });

  it("GOLD: the year and report link from the page; with seen.gold = 2026, no entry", async () => {
    const fake = fakeNet(routeWorld(world()));
    expect(await detectEdition(new Http(fake.net), "gold", "2026-10-04")).toEqual({
      year: 2026, label: "2026 GOLD Report", published: "2026-10", url: "https://goldcopd.org/2026-gold-report-and-pocket-guide/",
    });
    await writeContent(root, CHECKS_PATH, { v: 1, lastRun: "2026-09-01", nextRun: "2026-10-01", sources: [], seen: { gold: 2026 }, seenUrl: {} });
    const { flags, checks } = await run(world(), "2026-10-04");
    expect(flags.filter((f) => f.source === "gold")).toEqual([]);
    expect(checks.seen.gold).toBe(2026);
    expect(status(checks, "gold")).toMatchObject({ status: "ok", lastSuccess: "2026-10-04" });
  });

  it("GINA: a relative report link is made absolute; a page without the link gives the reports page", async () => {
    const http = (gina: string) => new Http(fakeNet(routeWorld(world({ gina }))).net);
    expect(await detectEdition(http(GINA_PAGE), "gina", "2026-10-04")).toMatchObject({ year: 2026, label: "2026 GINA Strategy Report", url: "https://ginasthma.org/2026-gina-strategy-report/" });
    expect((await detectEdition(http("<p>2027 GINA Strategy Report coming</p>"), "gina", "2026-10-04")).url).toBe(GINA_URL);
    await expect(detectEdition(http("<p>No reports</p>"), "gina", "2026-10-04")).rejects.toThrow(/no match/);
  });

  it("baseline mode makes one entry per source edition from 2021 on; a newer edition later supersedes it", async () => {
    const first = await run(world({ ab: null }), "2026-10-01");
    const editions = first.flags.filter((f) => f.kind === "edition");
    expect(editions.map((f) => [f.source, f.guideline])).toEqual([
      ["gold", "2026 GOLD Report"],
      ["gina", "2026 GINA Strategy Report"],
      ["ada", "Standards of Care in Diabetes-2026"],
      ["hf", "2022 AHA/ACC/HFSA Guideline for the Management of Heart Failure"],
      ["cpr", "2025 American Heart Association Guidelines for Cardiopulmonary Resuscitation and Emergency Cardiovascular Care"],
    ]);
    expect(editions[0]).toEqual({
      id: expect.stringMatching(/^u_[0-9A-HJKMNP-TV-Z]{10}$/), kind: "edition", source: "gold", by: "check", key: "gold", subject: null,
      guideline: "2026 GOLD Report", org: "Global Initiative for Chronic Obstructive Lung Disease (GOLD)", published: "2026-10", quote: null,
      grade: null, url: "https://goldcopd.org/2026-gold-report-and-pocket-guide/", flagged: "2026-10-01", supersededBy: null,
    });
    expect(editions.find((f) => f.source === "hf")!.org).toBe("American College of Cardiology / American Heart Association / Heart Failure Society of America");
    expect(first.checks.seen).toMatchObject({ gold: 2026, gina: 2026, ada: 2026, hf: 2022, cpr: 2025 });

    const later = await run(world({ ab: null, gold: GOLD_PAGE.replace("2026 GOLD Report", "2027 GOLD Report").replace("2026-gold-report", "2027-gold-report") }), "2027-01-01");
    const gold = later.flags.filter((f) => f.source === "gold");
    expect(gold).toHaveLength(2);
    expect(gold[0]!.supersededBy).toBe(gold[1]!.id);
    expect(gold[1]).toMatchObject({ guideline: "2027 GOLD Report", url: "https://goldcopd.org/2027-gold-report-and-pocket-guide/", supersededBy: null });
    expect(later.checks.seen.gold).toBe(2027);
    expect(later.flags.filter((f) => f.kind === "edition")).toHaveLength(6);
  });

  it("baseline mode makes no entry for an edition before 2021", async () => {
    const { flags, checks } = await run(world({ ab: null, gold: "<h2>2020 GOLD Report</h2>" }), "2026-10-01");
    expect(flags.filter((f) => f.source === "gold")).toEqual([]);
    expect(checks.seen.gold).toBe(2020);
  });

  it("one source's failure leaves the others' results in place", async () => {
    const { flags, checks } = await run(world({ gold: null, pubmed: {} }), "2026-10-01");
    expect(checks.sources.map((s) => [s.id, s.status])).toEqual([
      ["uspstf", "ok"], ["gold", "fail"], ["gina", "ok"], ["ada", "fail"], ["hf", "fail"], ["cpr", "fail"],
    ]);
    expect(status(checks, "gold")).toEqual({ id: "gold", lastSuccess: null, lastAttempt: "2026-10-01", status: "fail" });
    expect(checks.seen).not.toHaveProperty("gold");
    expect(flags.filter((f) => f.kind === "edition").map((f) => f.source)).toEqual(["gina"]);
  });
});

describe("cited guideline series (80 §80.3.3)", () => {
  const gid = (n: number) => `g_${String(n).padStart(10, "0")}`;
  const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
  const capTrack = (edition: number) => ({
    series: "idsa-cap", label: "IDSA/ATS community-acquired pneumonia guideline", org: "Infectious Diseases Society of America (IDSA) / American Thoracic Society (ATS)",
    edition, method: "pubmed" as const, term: "community-acquired pneumonia[ti] AND guideline[ti]", title: "(\\d{4}) .*Community-acquired Pneumonia",
  });
  const gap = (n: number, sources: unknown[]): GapFile => ({
    v: 1, id: gid(n), kind: "gap", doc: { type: "doc", content: [para("Treat outpatients with amoxicillin.")] } as GapFile["doc"],
    meta: { title: "CAP", relevantTo: "Pneumonia", written: "2026-10", differs: null, sources: sources as GapFile["meta"]["sources"], ownerEdits: [] },
  });
  const guideline = (track: unknown, org = "IDSA/ATS") => ({ name: "CAP guideline", org, year: "2019", url: "https://example.org/cap", type: "guideline", track });
  const capPubmed = {
    [capTrack(2019).term]: [
      { pmid: 31573350, title: "Diagnosis and Treatment of Adults with Community-acquired Pneumonia. An Official Clinical Practice Guideline: 2019 update.", pubdate: "2019 Oct 1" },
      { pmid: 42000001, title: "2026 Update: Treatment of Adults with Community-acquired Pneumonia: An Official IDSA/ATS Guideline.", pubdate: "2026 Aug 15", doi: "10.1164/rccm.2026-cap" },
    ],
  };

  it("tracks a series once, skips CDC sources, and enters a newer edition than the cited one", async () => {
    await writeContent(root, `content/gapfill/${gid(1)}.json`, gap(1, [guideline(capTrack(2019))]));
    await writeContent(root, `content/gapfill/${gid(2)}.json`, gap(2, [guideline(capTrack(2019)), guideline(null, "Centers for Disease Control and Prevention (CDC)")]));
    const { flags, checks, fake } = await run(world({ ab: null, pubmed: { ...PUBMED, ...capPubmed } }), "2026-10-01");
    expect(checks.sources.map((s) => s.id)).toEqual(["uspstf", "gold", "gina", "ada", "hf", "cpr", "cite:idsa-cap"]);
    expect(checks.sources.some((s) => /cdc/i.test(s.id))).toBe(false);
    const cited = flags.filter((f) => f.source === "cite:idsa-cap");
    expect(cited).toEqual([{
      id: expect.stringMatching(/^u_/), kind: "edition", source: "cite:idsa-cap", by: "check", key: "cite:idsa-cap", subject: null,
      guideline: "2026 Update", org: capTrack(2019).org, published: "2026-08", quote: null, grade: null,
      url: "https://doi.org/10.1164/rccm.2026-cap", flagged: "2026-10-01", supersededBy: null,
    }]);
    expect(checks.seen["cite:idsa-cap"]).toBe(2026);
    expect(status(checks, "cite:idsa-cap")).toMatchObject({ status: "ok", lastSuccess: "2026-10-01" });
    expect(fake.requests.filter((u) => u.includes("esearch.fcgi") && u.includes("community-acquired"))).toHaveLength(1);
  });

  it("starts a new series at its highest cited edition, with no entry while that is current", async () => {
    await writeContent(root, `content/gapfill/${gid(1)}.json`, gap(1, [guideline(capTrack(2019))]));
    await writeContent(root, `content/gapfill/${gid(2)}.json`, gap(2, [guideline(capTrack(2026))]));
    const { flags, checks } = await run(world({ ab: null, pubmed: { ...PUBMED, ...capPubmed } }), "2026-10-01");
    expect(flags.filter((f) => f.source === "cite:idsa-cap")).toEqual([]);
    expect(checks.seen["cite:idsa-cap"]).toBe(2026);
  });

  it("a series with method none couldn't be checked and makes no entry", async () => {
    const none = { series: "acog-pph", label: "ACOG postpartum hemorrhage bulletin", org: "ACOG", edition: 2017, method: "none" };
    await writeContent(root, `content/gapfill/${gid(1)}.json`, gap(1, [guideline(none, "ACOG")]));
    const { flags, checks, report } = await run(world({ ab: null }), "2026-10-01");
    expect(status(checks, "cite:acog-pph")).toEqual({ id: "cite:acog-pph", lastSuccess: null, lastAttempt: "2026-10-01", status: "fail" });
    expect(flags.filter((f) => f.source === "cite:acog-pph")).toEqual([]);
    expect(checks.seen["cite:acog-pph"]).toBe(2017);
    expect(report.sources.find((s) => s.id === "cite:acog-pph")).toMatchObject({ ok: false, error: expect.stringMatching(/no free edition signal/) });
  });

  it("a page series takes the newest year its pattern finds, labelled with the year", async () => {
    const page = { series: "aap-bili", label: "AAP hyperbilirubinemia guideline", org: "American Academy of Pediatrics (AAP)", edition: 2004, method: "page", url: "https://publications.aap.org/bili", pattern: "Revision (\\d{4})" };
    await writeContent(root, `content/gapfill/${gid(1)}.json`, gap(1, [guideline(page, "AAP")]));
    const { flags, checks } = await run(world({ ab: null, pages: { "https://publications.aap.org/bili": "<p>Revision 2004</p><p>Revision 2022</p><p>Revision 2009</p>" } }), "2026-10-04");
    expect(flags.filter((f) => f.source === "cite:aap-bili")).toEqual([expect.objectContaining({
      guideline: "AAP hyperbilirubinemia guideline (2022)", org: "American Academy of Pediatrics (AAP)", published: "2026-10", url: "https://publications.aap.org/bili",
    })]);
    expect(checks.seen["cite:aap-bili"]).toBe(2022);
  });

  it("orders cited series by label after the fixed sources", async () => {
    const none = (series: string, label: string) => ({ series, label, org: "Org", edition: 2020, method: "none" });
    await writeContent(root, `content/gapfill/${gid(1)}.json`, gap(1, [guideline(none("zeta", "Zeta guideline"), "Org"), guideline(none("alpha", "Alpha guideline"), "Org")]));
    const { checks } = await run(world({ ab: null }), "2026-10-01");
    expect(checks.sources.map((s) => s.id).slice(6)).toEqual(["cite:alpha", "cite:zeta"]);
  });

  it("drops a series no longer cited from sources and seen, and keeps its flags", async () => {
    await writeContent(root, `content/gapfill/${gid(1)}.json`, gap(1, [guideline(capTrack(2019))]));
    const first = await run(world({ ab: null, pubmed: { ...PUBMED, ...capPubmed } }), "2026-10-01");
    expect(first.flags.filter((f) => f.source === "cite:idsa-cap")).toHaveLength(1);
    await removeContent(root, `content/gapfill/${gid(1)}.json`);
    const second = await run(world({ ab: null, pubmed: { ...PUBMED, ...capPubmed } }), "2026-11-01");
    expect(second.checks.sources.map((s) => s.id)).not.toContain("cite:idsa-cap");
    expect(second.checks.seen).not.toHaveProperty("cite:idsa-cap");
    expect(second.flags.filter((f) => f.source === "cite:idsa-cap")).toEqual(first.flags.filter((f) => f.source === "cite:idsa-cap"));
  });

  it("lib/content refuses an untracked non-CDC guideline source, and a series whose method fields differ", async () => {
    await expect(writeContent(root, `content/gapfill/${gid(1)}.json`, gap(1, [guideline(null, "IDSA/ATS")]))).rejects.toThrow(/a track for a non-CDC guideline source/);
    await writeContent(root, `content/gapfill/${gid(1)}.json`, gap(1, [guideline(capTrack(2019))]));
    await expect(writeContent(root, `content/gapfill/${gid(2)}.json`, gap(2, [guideline({ ...capTrack(2019), term: "pneumonia" })]))).rejects.toThrow(/track for series "idsa-cap" differs/);
  });

  it("--probe prints {series, year} for each track of a gap block and writes nothing", async () => {
    const fixedGold = { series: "gold-copd", label: "GOLD report", org: "GOLD", edition: 2026, method: "fixed", source: "gold" };
    const fixedUspstf = { series: "uspstf-bc", label: "USPSTF breast cancer screening", org: "USPSTF", edition: 2024, method: "fixed", source: "uspstf" };
    const none = { series: "acog-pph", label: "ACOG PPH", org: "ACOG", edition: 2017, method: "none" };
    await writeContent(root, `content/gapfill/${gid(3)}.json`, gap(3, [
      guideline(capTrack(2019)), guideline(fixedGold, "GOLD"), guideline(fixedUspstf, "USPSTF"), guideline(none, "ACOG"),
      { name: "StatPearls", org: "NCBI Bookshelf", year: "2024", url: null, type: "reference", track: null },
    ]));
    const out: string[] = [];
    const fake = fakeNet(routeWorld(world({ pubmed: capPubmed })));
    expect(await main(["--probe", gid(3)], { root, net: fake.net, now: new Date("2026-10-04T12:00:00Z"), out: (l) => out.push(l) })).toBe(0);
    expect(out.map((l) => JSON.parse(l))).toEqual([
      { series: "idsa-cap", year: 2026 },
      { series: "gold-copd", year: 2026 },
      { series: "uspstf-bc", year: null, error: "USPSTF is checked per recommendation and has no edition year" },
      { series: "acog-pph", year: null, error: "the source has no free edition signal" },
    ]);
    expect(await readContentIfExists(root, FLAGS_PATH)).toBeNull();
    expect(await readContentIfExists(root, CHECKS_PATH)).toBeNull();
    await expect(probe(root, new Http(fake.net), "b_0000000001", "2026-10-04")).rejects.toThrow(/not a gap block id/);
  });
});

describe("a whole run (80 §80.3, §80.6)", () => {
  it("sets lastRun and nextRun, and adds no flag when run again on unchanged sources", async () => {
    const first = await run(world(), "2026-10-01");
    expect(first.checks.lastRun).toBe("2026-10-01");
    expect(first.checks.nextRun).toBe("2026-11-01");
    expect(first.checks.sources.every((s) => s.status === "ok")).toBe(true);
    const second = await run(world(), "2026-11-01");
    expect(second.flags).toEqual(first.flags);
    expect(second.checks).toMatchObject({ lastRun: "2026-11-01", nextRun: "2026-12-01" });
    expect(second.checks.sources.every((s) => s.lastSuccess === "2026-11-01")).toBe(true);
    expect(new Set(current(second.flags).map((f) => f.key)).size).toBe(current(second.flags).length);
  });

  it("keeps flags it did not make, superseding an agent flag with the same key", async () => {
    const agentFlag: Flag = {
      id: "u_0000000001", kind: "rec", source: "uspstf", by: "agent", key: keyOf(CHLAMYDIA_PATH, 1), subject: CHLAMYDIA, guideline: CHLAMYDIA,
      org: USPSTF_ORG, published: "2021-09", quote: "Agent-quoted text.", grade: "B", url: "https://www.uspreventiveservicestaskforce.org/x",
      flagged: "2026-10-02", supersededBy: null, locator: "Recommendation Summary", verification: { verifier: "vera", at: "2026-10-03", result: "pass" },
    };
    await writeContent(root, FLAGS_PATH, { v: 1, flags: [agentFlag] });
    const { flags } = await run(world(), "2026-10-04");
    const replacement = flags.find((f) => f.key === keyOf(CHLAMYDIA_PATH, 1) && f.by === "check")!;
    expect(flags[0]).toEqual({ ...agentFlag, supersededBy: replacement.id });
  });

  it("fails a source whose stored seen value has the wrong shape, changing nothing for it", async () => {
    await writeContent(root, CHECKS_PATH, { v: 1, lastRun: null, nextRun: null, sources: [], seen: { uspstf: 7, gold: { a: "b" } }, seenUrl: {} });
    const { checks, flags } = await run(world(), "2026-10-01");
    expect(status(checks, "uspstf")).toMatchObject({ status: "fail" });
    expect(status(checks, "gold")).toMatchObject({ status: "fail" });
    expect(checks.seen).toMatchObject({ uspstf: 7, gold: { a: "b" } });
    expect(flags.filter((f) => f.source === "uspstf" || f.source === "gold")).toEqual([]);
  });

  it("nextRun rolls over the year", () => {
    expect(nextRunDate("2026-12-01")).toBe("2027-01-01");
    expect(nextRunDate("2026-01-31")).toBe("2026-02-01");
  });
});

describe("the CLI", () => {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

  it("--commit commits only the two updates files with the guidelines trailer; an unchanged rerun makes no commit", async () => {
    initTestRepo(root);
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    git("commit", "-q", "--allow-empty", "-m", "start");
    await writeContent(root, "content/updates/concepts.json", { v: 1, concepts: [] });
    const out: string[] = [];
    const options = { root, net: fakeNet(routeWorld(world())).net, now: new Date("2026-10-01T09:05:00Z"), out: (l: string) => out.push(l) };
    expect(await main(["--commit"], options)).toBe(0);
    expect(out).toContain("uspstf: ok, 16 new flag(s)");
    expect(out).toContain("Checked 6 source(s), 0 couldn't be checked.");
    expect(out.at(-1)).toBe("Committed the updates.");
    const message = git("log", "-1", "--format=%B");
    expect(message.startsWith("Guideline check 2026-10-01\n")).toBe(true);
    expect(parseTrailers(message)).toEqual({ kind: "guidelines" });
    expect(git("show", "--name-only", "--format=", "HEAD").trim().split("\n").sort()).toEqual([CHECKS_PATH, FLAGS_PATH]);
    expect(git("status", "--porcelain")).toContain("content/updates/concepts.json"); // left uncommitted, untouched

    out.length = 0;
    expect(await main(["--commit"], { ...options, net: fakeNet(routeWorld(world())).net })).toBe(0);
    expect(out.at(-1)).toBe("Nothing changed; no commit.");
    expect(git("rev-list", "--count", "HEAD").trim()).toBe("2");
  });

  it("without --commit writes the files and commits nothing", async () => {
    const out: string[] = [];
    expect(await main([], { root, net: fakeNet(routeWorld(world({ gold: null }))).net, now: new Date("2026-10-01T09:05:00Z"), out: (l) => out.push(l) })).toBe(0);
    expect(out).toContain("Checked 6 source(s), 1 couldn't be checked.");
    expect(out.some((l) => l.startsWith("gold: couldn't be checked: fetch failed"))).toBe(true);
    expect(await readContentIfExists(root, CHECKS_PATH)).not.toBeNull();
  });

  it.each([[["--probe"]], [["--probe", "g_0000000001", "x"]], [["--commit", "x"]], [["--dry-run"]]])("rejects %j with usage", async (argv) => {
    const out: string[] = [];
    expect(await main(argv, { root, out: (l) => out.push(l) })).toBe(2);
    expect(out).toEqual(["usage: node tools/guidelines/index.ts [--commit] | --probe <g_id>"]);
  });
});
