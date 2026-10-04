// One guideline check run (80 §80.3): every tracked source is checked independently; results land
// only in content/updates/flags.json and content/updates/checks.json.
import { citeKey, FIXED_SOURCES, newId, seriesOfCiteKey } from "../../lib/content/index.ts";
import type { ChecksFile, FixedSource, Flag, FlagsFile, GapFile, Track } from "../../lib/content/index.ts";
import { listGapBlocks, readContentIfExists, writeContent } from "../../lib/content/fs.ts";
import { detectCited, detectEdition } from "./editions.ts";
import type { Edition, EditionSource } from "./editions.ts";
import { HttpStatusError } from "./http.ts";
import type { Http } from "./http.ts";
import { assignUspstfKeys, parseAbRows, parseRecommendationPage, USPSTF_AB_URL, USPSTF_ORG } from "./uspstf.ts";
import type { StoredRecommendation } from "./uspstf.ts";

export const FLAGS_PATH = "content/updates/flags.json";
export const CHECKS_PATH = "content/updates/checks.json";

/** Baseline mode flags changes since her guides' era (~2020–2021). */
export const BASELINE_MONTH = "2021-01";
export const BASELINE_YEAR = 2021;

/** The org shown on each fixed source's entries (80 §80.5). */
export const SOURCE_ORGS: Record<EditionSource, string> = {
  cpr: "American Heart Association (AHA)",
  hf: "American College of Cardiology / American Heart Association / Heart Failure Society of America",
  ada: "American Diabetes Association (ADA)",
  gold: "Global Initiative for Chronic Obstructive Lung Disease (GOLD)",
  gina: "Global Initiative for Asthma (GINA)",
};

/** The fixed sources in check order (80 §80.3): USPSTF, then the edition sources. */
export const FIXED_ORDER: readonly FixedSource[] = ["uspstf", ...FIXED_SOURCES.filter((s) => s !== "uspstf")];

const isFixedSource = (id: string): id is FixedSource => (FIXED_SOURCES as readonly string[]).includes(id);

export type CitedTrack = Exclude<Track, { method: "fixed" }>;

export interface CitedSeries {
  track: CitedTrack;
  /** The highest cited edition among the series' tracks. */
  edition: number;
}

/** A flag before it gets its id and supersedes anything. */
export type FlagDraft = Omit<Flag, "id" | "supersededBy" | "locator" | "verification" | "retired">;

/** What a successful detector changes: flags to add and the source's new `seen` value. */
interface Outcome {
  drafts: FlagDraft[];
  seen: unknown;
  /** USPSTF only: the replacement `seenUrl`. */
  seenUrl?: Record<string, string>;
  /** USPSTF only: keys whose recommendation is permanently gone; their current flags are retired. */
  retired?: string[];
}

/** The cited series of the gap blocks (method other than `fixed`), by series id, in `label` order. */
export function citedSeries(gaps: readonly GapFile[]): Map<string, CitedSeries> {
  const bySeries = new Map<string, CitedSeries>();
  for (const gap of gaps) {
    for (const source of gap.meta.sources) {
      const track = source.track;
      if (!track || track.method === "fixed") continue;
      const known = bySeries.get(track.series);
      if (!known) bySeries.set(track.series, { track, edition: track.edition });
      else known.edition = Math.max(known.edition, track.edition);
    }
  }
  return new Map([...bySeries].sort(([, a], [, b]) => a.track.label.localeCompare(b.track.label, "en")));
}

/** The 1st of the month after `today` (ISO date). */
export function nextRunDate(today: string): string {
  const [y, m] = today.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

/** What the check remembers of a USPSTF recommendation, to tell a revision from no change. */
export interface SeenRecommendation extends StoredRecommendation {
  published: string;
}

const isSeenMap = (v: unknown): v is Record<string, SeenRecommendation> =>
  typeof v === "object" && v !== null && !Array.isArray(v) &&
  Object.values(v).every((x: unknown) => {
    const r = x as Partial<Record<keyof SeenRecommendation, unknown>> | null;
    return typeof r === "object" && r !== null && typeof r.published === "string" && typeof r.subject === "string" && typeof r.quote === "string";
  });

/** A recommendation page answered 404 or 410: it was removed, not unreachable. */
const isRemovedPage = (e: unknown): boolean => e instanceof HttpStatusError && (e.status === 404 || e.status === 410);

/**
 * USPSTF (80 §80.3.1 as amended by the Orchestrator rulings of 2026-10-04 03:06Z, 03:07Z and 04:40Z):
 * - identity is the recommendation page's path plus `#n`, bound to its row by `assignUspstfKeys`;
 * - a new identity, or a changed release month, population (subject) or statement, makes a flag
 *   that supersedes the identity's current flag;
 * - an identity that left the A and B list is read from its own page: a matching Recommendation
 *   Summary row makes a flag; a removed page (404/410), no summary table or no matching row retires
 *   the identity. Only an unreachable page (network error, timeout, any other non-2xx) fails the source.
 */
async function checkUspstf(http: Http, seen: unknown, seenUrl: Record<string, string>, flagKeys: readonly string[], today: string, log: (line: string) => void): Promise<Outcome> {
  const rows = parseAbRows(await http.text(USPSTF_AB_URL));
  if (seen !== undefined && !isSeenMap(seen)) throw new Error("checks.json seen.uspstf is not a key → {published, subject, quote} map");
  // Normal mode keeps every key ever flagged out of reach of a new row, so a new row never supersedes a retired flag.
  const records = seen === undefined ? assignUspstfKeys(rows) : assignUspstfKeys(rows, seen, flagKeys);
  const draft = (r: { key: string; subject: string; quote: string; grade: string; published: string; url: string }): FlagDraft => ({
    kind: "rec", source: "uspstf", by: "check", key: r.key, subject: r.subject, guideline: r.subject, org: USPSTF_ORG,
    published: r.published, quote: r.quote, grade: r.grade, url: r.url, flagged: today,
  });
  const nextSeen: Record<string, SeenRecommendation> = Object.fromEntries(
    records.map((r) => [r.key, { published: r.published, subject: r.subject, quote: r.quote }]),
  );
  const nextSeenUrl = Object.fromEntries(records.map((r) => [r.key, r.url]));
  if (seen === undefined) {
    return { drafts: records.filter((r) => r.published >= BASELINE_MONTH).map(draft), seen: nextSeen, seenUrl: nextSeenUrl };
  }
  const drafts = records
    .filter((r) => {
      const was = seen[r.key];
      return !was || was.published !== r.published || was.subject !== r.subject || was.quote !== r.quote;
    })
    .map(draft);
  const retired: string[] = [];
  for (const [key, was] of Object.entries(seen).filter(([k]) => !Object.hasOwn(nextSeen, k))) {
    const url = seenUrl[key];
    let row = null;
    if (url !== undefined) {
      try {
        row = parseRecommendationPage(await http.text(url), was.subject);
      } catch (e) {
        if (!isRemovedPage(e)) throw e;
      }
    }
    if (row) drafts.push(draft({ key, subject: was.subject, url: url!, ...row }));
    else {
      retired.push(key);
      log(`uspstf: retired ${key} (${was.subject}): no longer on the A and B list or its page`);
    }
  }
  return { drafts, seen: nextSeen, seenUrl: nextSeenUrl, retired };
}

function editionOutcome(source: string, edition: Edition, seen: unknown, org: string, today: string): Outcome {
  if (seen !== undefined && !Number.isInteger(seen)) throw new Error(`checks.json seen["${source}"] is not a year`);
  const isNew = seen === undefined ? edition.year >= BASELINE_YEAR : edition.year > (seen as number);
  const drafts: FlagDraft[] = isNew
    ? [{
        kind: "edition", source, by: "check", key: source, subject: null, guideline: edition.label, org,
        published: edition.published, quote: null, grade: null, url: edition.url, flagged: today,
      }]
    : [];
  return { drafts, seen: isNew || seen === undefined ? edition.year : seen };
}

/** Add a flag; the current flag with the same key (if any) is superseded by it. */
function addFlag(flags: Flag[], draft: FlagDraft): void {
  const id = newId("u", new Set(flags.map((f) => f.id)));
  for (const f of flags) if (f.key === draft.key && f.supersededBy === null) f.supersededBy = id;
  flags.push({ id, ...draft, supersededBy: null });
}

/** Retire the current flag of `key`: it stays listed, and the build no longer places it. */
function retireFlags(flags: Flag[], key: string, today: string): void {
  for (const f of flags) if (f.key === key && f.supersededBy === null && f.retired === undefined) f.retired = today;
}

export interface SourceReport {
  id: string;
  ok: boolean;
  added: number;
  error?: string;
}

export interface RunReport {
  today: string;
  sources: SourceReport[];
}

/** Run every detector and write flags.json and checks.json. `today` is the run's UTC ISO date. */
export async function runCheck(root: string, http: Http, today: string, log: (line: string) => void = () => undefined): Promise<RunReport> {
  const flagsFile = (await readContentIfExists<FlagsFile>(root, FLAGS_PATH)) ?? { v: 1, flags: [] };
  const checks = (await readContentIfExists<ChecksFile>(root, CHECKS_PATH))
    ?? { v: 1, lastRun: null, nextRun: null, sources: [], seen: {}, seenUrl: {} };
  const cited = citedSeries(await listGapBlocks(root));

  // A newly cited series starts at its cited edition; a series no longer cited is dropped.
  for (const [series, { edition }] of cited) {
    if (!Object.hasOwn(checks.seen, citeKey(series))) checks.seen[citeKey(series)] = edition;
  }
  for (const key of Object.keys(checks.seen)) {
    const series = seriesOfCiteKey(key);
    if (series !== null && !cited.has(series)) delete checks.seen[key];
  }

  const order = [...FIXED_ORDER, ...[...cited.keys()].map(citeKey)];
  const previous = new Map(checks.sources.map((s) => [s.id, s]));
  const reports: SourceReport[] = [];
  checks.sources = [];
  for (const id of order) {
    const row = { id, lastSuccess: previous.get(id)?.lastSuccess ?? null, lastAttempt: today, status: "fail" as "ok" | "fail" };
    checks.sources.push(row);
    try {
      const flagKeys = flagsFile.flags.filter((f) => f.source === id).map((f) => f.key);
      const outcome = await detect(http, id, checks, flagKeys, cited, today, log);
      for (const d of outcome.drafts) addFlag(flagsFile.flags, d);
      for (const key of outcome.retired ?? []) retireFlags(flagsFile.flags, key, today);
      checks.seen[id] = outcome.seen;
      if (outcome.seenUrl) checks.seenUrl = outcome.seenUrl;
      row.status = "ok";
      row.lastSuccess = today;
      reports.push({ id, ok: true, added: outcome.drafts.length });
      log(`${id}: ok, ${outcome.drafts.length} new flag(s)`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      reports.push({ id, ok: false, added: 0, error });
      log(`${id}: couldn't be checked: ${error}`);
    }
  }
  checks.lastRun = today;
  checks.nextRun = nextRunDate(today);
  await writeContent(root, FLAGS_PATH, flagsFile);
  await writeContent(root, CHECKS_PATH, checks);
  return { today, sources: reports };
}

async function detect(http: Http, id: string, checks: ChecksFile, flagKeys: readonly string[], cited: Map<string, CitedSeries>, today: string, log: (line: string) => void): Promise<Outcome> {
  const seen = checks.seen[id];
  if (isFixedSource(id)) {
    if (id === "uspstf") return checkUspstf(http, seen, checks.seenUrl, flagKeys, today, log);
    return editionOutcome(id, await detectEdition(http, id, today), seen, SOURCE_ORGS[id], today);
  }
  const series = cited.get(seriesOfCiteKey(id)!)!;
  return editionOutcome(id, await detectCited(http, series.track, today), seen, series.track.org, today);
}
