// The detectors over responses recorded live on 2026-10-04 (fixtures/) from the job's own Http
// client: the USPSTF A and B page and the breast cancer recommendation page, the GOLD home page,
// the GINA reports page, and the E-utilities esearch/esummary answers for the ADA, HF and CPR terms.
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChecksFile, FlagsFile } from "../../lib/content/index.ts";
import { readContent } from "../../lib/content/fs.ts";
import { GINA_URL, GOLD_URL, PUBMED_SOURCES } from "./editions.ts";
import { Http } from "./http.ts";
import { CHECKS_PATH, FLAGS_PATH, runCheck } from "./run.ts";
import { fakeNet, html, json, notFound } from "./testing.ts";
import { parseAbPage, parseRecommendationPage, USPSTF_AB_URL } from "./uspstf.ts";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

function recordedRoute(url: URL): Response {
  const bare = `${url.origin}${url.pathname}`;
  if (bare === USPSTF_AB_URL) return html(fixture("uspstf-ab.html"));
  if (bare === GOLD_URL) return html(fixture("gold.html"));
  if (bare === GINA_URL) return html(fixture("gina.html"));
  if (url.hostname === "eutils.ncbi.nlm.nih.gov") {
    const source = (["ada", "hf", "cpr"] as const).find((s) => {
      const search = JSON.parse(fixture(`${s}-esearch.json`)) as { esearchresult: { idlist: string[] } };
      return url.searchParams.get("term") === PUBMED_SOURCES[s].term || url.searchParams.get("id") === search.esearchresult.idlist.join(",");
    });
    if (!source) return notFound();
    return json(JSON.parse(fixture(`${source}-${url.pathname.endsWith("esearch.fcgi") ? "esearch" : "esummary"}.json`)));
  }
  return notFound();
}

describe("recorded USPSTF pages", () => {
  it("the A and B page: 54 records on 47 recommendation pages; the 7 pages with two rows key their second row #2", () => {
    const records = parseAbPage(fixture("uspstf-ab.html"));
    expect(records).toHaveLength(54);
    expect(new Set(records.map((r) => r.subject)).size).toBe(52);
    // Counted from the recorded page's own hrefs: these seven pages each hold two rows.
    expect(records.filter((r) => r.key.endsWith("#2")).map((r) => r.key)).toEqual([
      "/uspstf/recommendation/chlamydia-and-gonorrhea-screening#2",
      "/uspstf/recommendation/colorectal-cancer-screening#2",
      "/uspstf/recommendation/human-immunodeficiency-virus-hiv-infection-screening#2",
      "/uspstf/recommendation/osteoporosis-screening#2",
      "/uspstf/recommendation/prevention-of-dental-caries-in-children-younger-than-age-5-years-screening-and-interventions1#2",
      "/uspstf/recommendation/rh-d-incompatibility-screening#2",
      "/uspstf/recommendation/tobacco-use-in-adults-and-pregnant-women-counseling-and-interventions#2",
    ]);
    expect(new Set(records.map((r) => r.key.slice(0, r.key.lastIndexOf("#")))).size).toBe(47);
    expect(new Set(records.map((r) => r.key)).size).toBe(54);
    expect(records[0]).toEqual({
      key: "/uspstf/recommendation/abdominal-aortic-aneurysm-screening#1",
      subject: "Abdominal Aortic Aneurysm: Screening: men aged 65 to 75 years who have ever smoked",
      quote: "The USPSTF recommends 1-time screening for abdominal aortic aneurysm (AAA) with ultrasonography in men aged 65 to 75 years who have ever smoked.",
      grade: "B", published: "2019-12",
      url: "https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/abdominal-aortic-aneurysm-screening",
    });
    const aspirin = records.find((r) => r.subject.startsWith("Aspirin Use to Prevent Preeclampsia"))!;
    expect(aspirin.quote).toBe("The USPSTF recommends the use of low-dose aspirin (81 mg/day) as preventive medication after 12 weeks of gestation in persons who are at high risk for preeclampsia.\n\nSee the Practice Considerations section for information on high risk and aspirin dose.");
    expect(aspirin.published).toBe("2021-09");
    expect(records.every((r) => /^\d{4}-\d{2}$/.test(r.published) && (r.grade === "A" || r.grade === "B") && !r.quote.includes("†"))).toBe(true);
  });

  it("the breast cancer page: the Recommendation Summary row and its April 30, 2024 release", () => {
    const page = fixture("uspstf-breast-cancer.html");
    expect(parseRecommendationPage(page, "Breast Cancer: Screening: women aged 40 to 74 years")).toEqual({
      quote: "The USPSTF recommends biennial screening mammography for women aged 40 to 74 years.", grade: "B", published: "2024-04",
    });
    expect(parseRecommendationPage(page, "Breast Cancer: Screening: women 75 years or older")).toMatchObject({ grade: "I", published: "2024-04" });
    expect(parseRecommendationPage(page, "Breast Cancer: Screening: men")).toBeNull();
  });
});

describe("a baseline run over the recorded responses", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "pa-guidelines-rec-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("matches the outcome verified during planning (80 §80.3.3)", async () => {
    const report = await runCheck(root, new Http(fakeNet(recordedRoute).net), "2026-10-04");
    expect(report.sources.map((s) => [s.id, s.ok])).toEqual([["uspstf", true], ["gold", true], ["gina", true], ["ada", true], ["hf", true], ["cpr", true]]);
    const { flags } = await readContent<FlagsFile>(root, FLAGS_PATH);
    const recorded = parseAbPage(fixture("uspstf-ab.html"));
    expect(flags.filter((f) => f.kind === "rec").map((f) => f.key)).toEqual(recorded.filter((r) => r.published >= "2021-01").map((r) => r.key));
    expect(flags.filter((f) => f.kind === "edition").map((f) => [f.guideline, f.url])).toEqual([
      ["2026 GOLD Report", "https://goldcopd.org/2026-gold-report-and-pocket-guide/"],
      ["2026 GINA Strategy Report", "https://ginasthma.org/2026-gina-strategy-report/"],
      ["Standards of Care in Diabetes-2026", "https://doi.org/10.2337/dc26-SINT"],
      ["2022 AHA/ACC/HFSA Guideline for the Management of Heart Failure", expect.stringMatching(/^https:\/\/doi\.org\/10\.1161\//)],
      ["2025 American Heart Association Guidelines for Cardiopulmonary Resuscitation and Emergency Cardiovascular Care", "https://doi.org/10.1161/CIR.0000000000001372"],
    ]);
    const checks = await readContent<ChecksFile>(root, CHECKS_PATH);
    expect(checks.seen).toMatchObject({ gold: 2026, gina: 2026, ada: 2026, hf: 2022, cpr: 2025 });
    expect(Object.keys(checks.seen.uspstf as object)).toHaveLength(54);
  });
});
