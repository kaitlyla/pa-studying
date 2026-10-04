// Edition detectors (80 §80.3.2, §80.3.3): each yields the newest edition a source publishes, or
// throws when the source cannot be read or shows no edition.
import type { FixedSource, Track } from "../../lib/content/index.ts";
import { hrefs, parseHtml } from "./html.ts";
import type { Http } from "./http.ts";

export interface Edition {
  year: number;
  label: string;
  /** YYYY-MM */
  published: string;
  url: string;
}

/** The fixed sources tracked by edition: every fixed source but USPSTF. */
export type EditionSource = Exclude<FixedSource, "uspstf">;

/** `YYYY-MM` of an ISO date. */
export const month = (isoDate: string): string => isoDate.slice(0, 7);

// ---- PubMed ------------------------------------------------------------------------------------

export interface PubmedItem {
  pmid: number;
  title: string;
  pubdate: string;
  doi: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** esearch (newest first, 20 ids) then esummary of the ids found. */
export async function pubmedSearch(http: Http, term: string): Promise<PubmedItem[]> {
  const search = await http.eutils("esearch.fcgi", { sort: "pub_date", retmax: "20", term });
  const idlist = isObj(search) && isObj(search.esearchresult) ? search.esearchresult.idlist : undefined;
  if (!Array.isArray(idlist) || !idlist.every((id) => typeof id === "string" && /^\d+$/.test(id))) {
    throw new Error("esearch: no idlist in the response");
  }
  if (idlist.length === 0) return [];
  const summary = await http.eutils("esummary.fcgi", { id: idlist.join(",") });
  const result = isObj(summary) && isObj(summary.result) ? summary.result : undefined;
  if (!result) throw new Error("esummary: no result in the response");
  return (idlist as string[]).map((id) => {
    const item = result[id];
    if (!isObj(item) || typeof item.title !== "string" || typeof item.pubdate !== "string") {
      throw new Error(`esummary: no title and pubdate for PMID ${id}`);
    }
    const ids = Array.isArray(item.articleids) ? item.articleids : [];
    const doi = ids.find((a): a is { idtype: string; value: string } => isObj(a) && a.idtype === "doi" && typeof a.value === "string");
    return { pmid: Number(id), title: item.title, pubdate: item.pubdate, doi: doi?.value ?? null };
  });
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** `YYYY-MM` of a PubMed pubdate ("2026 Jan 1"); a pubdate with no month gives `YYYY-01`. */
export function pubdateMonth(pubdate: string): string {
  const m = /^(\d{4})(?:\s+([A-Za-z]{3}))?/.exec(pubdate);
  if (!m) throw new Error(`unreadable pubdate: ${pubdate}`);
  const index = m[2] ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
  return `${m[1]}-${String(index === -1 ? 1 : index + 1).padStart(2, "0")}`;
}

const dropTrailingDot = (s: string): string => s.trim().replace(/\.+$/, "");
const upToColon = (s: string): string => {
  const at = s.indexOf(": ");
  return at === -1 ? s : s.slice(0, at);
};

type Candidate = { year: number; label: string };

/**
 * The newest edition among the items `candidate` accepts. Its representative item is the one titled
 * "Executive Summary" (lowest PMID if several), else the lowest PMID of that year.
 */
export function newestPubmedEdition(items: readonly PubmedItem[], candidate: (title: string) => Candidate | null): Edition {
  const found = items.flatMap((item) => {
    const c = candidate(item.title);
    return c && Number.isInteger(c.year) ? [{ item, ...c }] : [];
  });
  if (found.length === 0) throw new Error("no candidate edition in the PubMed results");
  const year = Math.max(...found.map((f) => f.year));
  const ofYear = found.filter((f) => f.year === year).sort((a, b) => a.item.pmid - b.item.pmid);
  const rep = ofYear.find((f) => f.item.title.includes("Executive Summary")) ?? ofYear[0]!;
  return {
    year,
    label: dropTrailingDot(rep.label),
    published: pubdateMonth(rep.item.pubdate),
    url: rep.item.doi ? `https://doi.org/${rep.item.doi}` : `https://pubmed.ncbi.nlm.nih.gov/${rep.item.pmid}/`,
  };
}

/** The PubMed terms and candidate rules of the fixed PubMed sources (80 §80.1, §80.3.2). */
export const PUBMED_SOURCES: Record<"ada" | "hf" | "cpr", { term: string; candidate: (title: string) => Candidate | null }> = {
  ada: {
    term: 'introduction[ti] AND standards[ti] AND care[ti] AND diabetes[ti] AND "Diabetes care"[ta]',
    candidate: (title) => {
      const m = /Standards of (?:Medical )?Care in Diabetes[-–—](\d{4})/.exec(title);
      return m ? { year: Number(m[1]), label: m[0] } : null;
    },
  },
  hf: {
    term: '"heart failure"[ti] AND guideline[ti] AND management[ti] AND (Circulation[ta] OR "J Am Coll Cardiol"[ta])',
    candidate: (title) => {
      const m = /^(\d{4}) /.exec(title);
      if (!m || title.startsWith("Correction") || !title.includes("Heart Failure")) return null;
      return { year: Number(m[1]), label: upToColon(title) };
    },
  },
  cpr: {
    term: 'cardiopulmonary[ti] AND resuscitation[ti] AND "emergency cardiovascular care"[ti] AND guidelines[ti] AND Circulation[ta]',
    candidate: (title) => {
      const m = /(\d{4}) American Heart Association/.exec(title);
      return m ? { year: Number(m[1]), label: upToColon(title.slice(m.index)) } : null;
    },
  },
};

// ---- publisher pages ---------------------------------------------------------------------------

/** The maximum year captured by `pattern` (one `(\d{4})` group) anywhere in `html`. */
function maxYear(html: string, pattern: RegExp): number {
  const years = [...html.matchAll(new RegExp(pattern.source, "g"))].map((m) => Number(m[1])).filter(Number.isInteger);
  if (years.length === 0) throw new Error(`no match for ${pattern.source}`);
  return Math.max(...years);
}

/** The first `href` containing `fragment`, made absolute against `page`; else `page`. */
function linkContaining(html: string, fragment: string, page: string): string {
  const href = hrefs(parseHtml(html)).find((h) => h.includes(fragment));
  return href === undefined ? page : new URL(href, page).href;
}

async function pageEdition(http: Http, page: string, pattern: RegExp, label: (year: number) => string, slug: (year: number) => string, today: string): Promise<Edition> {
  const html = await http.text(page);
  const year = maxYear(html, pattern);
  return { year, label: label(year), published: month(today), url: linkContaining(html, slug(year), page) };
}

export const GOLD_URL = "https://goldcopd.org/";
export const GINA_URL = "https://ginasthma.org/reports/";

/** The newest edition of a fixed edition source. `today` is the run's ISO date. */
export async function detectEdition(http: Http, source: EditionSource, today: string): Promise<Edition> {
  switch (source) {
    case "gold":
      return pageEdition(http, GOLD_URL, /\b(20\d\d) GOLD Report\b/, (y) => `${y} GOLD Report`, (y) => `${y}-gold-report`, today);
    case "gina":
      return pageEdition(http, GINA_URL, /\b(20\d\d) GINA Strategy Report\b/, (y) => `${y} GINA Strategy Report`, (y) => `${y}-gina-strategy-report`, today);
    default: {
      const { term, candidate } = PUBMED_SOURCES[source];
      return newestPubmedEdition(await pubmedSearch(http, term), candidate);
    }
  }
}

/** The newest edition of a cited series, by its track's method (80 §80.3.3). */
export async function detectCited(http: Http, track: Exclude<Track, { method: "fixed" }>, today: string): Promise<Edition> {
  switch (track.method) {
    case "pubmed": {
      const title = new RegExp(track.title);
      const items = await pubmedSearch(http, track.term);
      return newestPubmedEdition(items, (t) => {
        const m = title.exec(t);
        return m ? { year: Number(m[1]), label: upToColon(t) } : null;
      });
    }
    case "page": {
      const html = await http.text(track.url);
      const year = maxYear(html, new RegExp(track.pattern));
      return { year, label: `${track.label} (${year})`, published: month(today), url: track.url };
    }
    case "none":
      throw new Error("the source has no free edition signal");
  }
}
