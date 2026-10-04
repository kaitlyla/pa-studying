// One guideline check run (80 §80.3): every tracked source is checked independently; results land
// only in content/updates/flags.json and content/updates/checks.json.
import { FIXED_SOURCES, newId } from "../../lib/content/index.ts";
import type { ChecksFile, FixedSource, Flag, FlagsFile, GapFile, Track } from "../../lib/content/index.ts";
import { listGapBlocks, readContentIfExists, writeContent } from "../../lib/content/fs.ts";
import { detectCited, detectEdition } from "./editions.ts";
import type { Edition, EditionSource } from "./editions.ts";
import type { Http } from "./http.ts";
import { parseAbPage, parseRecommendationPage, USPSTF_AB_URL, USPSTF_ORG } from "./uspstf.ts";

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
export type FlagDraft = Omit<Flag, "id" | "supersededBy" | "locator" | "verification">;

/** What a successful detector changes: flags to add and the source's new `seen` value. */
interface Outcome {
  drafts: FlagDraft[];
  seen: unknown;
  /** USPSTF only: the replacement `seenUrl`. */
  seenUrl?: Record<string, string>;
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

const isMonthMap = (v: unknown): v is Record<string, string> =>
  typeof v === "object" && v !== null && Object.values(v).every((x) => typeof x === "string");

async function checkUspstf(http: Http, seen: unknown, seenUrl: Record<string, string>, today: string): Promise<Outcome> {
  const records = parseAbPage(await http.text(USPSTF_AB_URL));
  const draft = (r: { key: string; subject: string; quote: string; grade: string; published: string; url: string }): FlagDraft => ({
    kind: "rec", source: "uspstf", by: "check", key: r.key, subject: r.subject, guideline: r.subject, org: USPSTF_ORG,
    published: r.published, quote: r.quote, grade: r.grade, url: r.url, flagged: today,
  });
  const nextSeen = Object.fromEntries(records.map((r) => [r.key, r.published]));
  const nextSeenUrl = Object.fromEntries(records.map((r) => [r.key, r.url]));
  if (seen === undefined) {
    return { drafts: records.filter((r) => r.published >= BASELINE_MONTH).map(draft), seen: nextSeen, seenUrl: nextSeenUrl };
  }
  if (!isMonthMap(seen)) throw new Error("checks.json seen.uspstf is not a key → month map");
  const drafts = records.filter((r) => seen[r.key] !== r.published).map(draft);
  // A key that left the page left the A and B list: its own page gives the new statement.
  for (const key of Object.keys(seen).filter((k) => !Object.hasOwn(nextSeen, k))) {
    const url = seenUrl[key];
    if (url === undefined) throw new Error(`no stored URL for ${key}`);
    const subject = key.slice(0, key.lastIndexOf("#"));
    const row = parseRecommendationPage(await http.text(url), subject);
    if (row) drafts.push(draft({ key, subject, url, ...row }));
  }
  return { drafts, seen: nextSeen, seenUrl: nextSeenUrl };
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
    if (!Object.hasOwn(checks.seen, `cite:${series}`)) checks.seen[`cite:${series}`] = edition;
  }
  for (const key of Object.keys(checks.seen)) {
    if (key.startsWith("cite:") && !cited.has(key.slice(5))) delete checks.seen[key];
  }

  const order = [...FIXED_ORDER, ...[...cited.keys()].map((s) => `cite:${s}`)];
  const previous = new Map(checks.sources.map((s) => [s.id, s]));
  const reports: SourceReport[] = [];
  checks.sources = [];
  for (const id of order) {
    const row = { id, lastSuccess: previous.get(id)?.lastSuccess ?? null, lastAttempt: today, status: "fail" as "ok" | "fail" };
    checks.sources.push(row);
    try {
      const outcome = await detect(http, id, checks, cited, today);
      for (const d of outcome.drafts) addFlag(flagsFile.flags, d);
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

async function detect(http: Http, id: string, checks: ChecksFile, cited: Map<string, CitedSeries>, today: string): Promise<Outcome> {
  const seen = checks.seen[id];
  if (isFixedSource(id)) {
    if (id === "uspstf") return checkUspstf(http, seen, checks.seenUrl, today);
    return editionOutcome(id, await detectEdition(http, id, today), seen, SOURCE_ORGS[id], today);
  }
  const series = cited.get(id.slice(5))!;
  return editionOutcome(id, await detectCited(http, series.track, today), seen, series.track.org, today);
}
