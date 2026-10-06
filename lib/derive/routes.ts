// Hash routes (plan 10 §10.4): the one parser and builders shared by the build and the app (whose
// app/shell/route.ts adds only the live location), plus the location labels (40 §40.3, 60 §60.1).
// GitHub Pages has no SPA rewrites, so every page lives after `#`. React-free and browser-safe.
import { GENERAL_KEYS, type GeneralKey } from "../content/types.ts";

/** General-topic labels (the signed UI's GENERAL_LABELS). */
export const GENERAL_LABELS: Record<GeneralKey, string> = {
  labs: "Labs",
  ekg: "EKG",
  imaging: "Imaging",
  anatomy: "Anatomy",
  procedures: "Procedures & suturing",
  guidelines: "Guidelines",
  screenings: "Screenings",
  workup: "Initial workup of common presentations",
};

export const REF_TABS = ["labs", "imaging", "ekg", "anatomy"] as const;
export type RefTabId = (typeof REF_TABS)[number];

/** Reference tab labels. */
export const TAB_LABELS: Record<RefTabId, string> = { labs: "Labs", imaging: "Imaging", ekg: "EKG", anatomy: "Anatomy" };

export const PANCE = "pance";

export type GuideView =
  | { kind: "home" }
  | { kind: "system"; system: string }
  | { kind: "section"; system: string; section: string }
  | { kind: "topics"; ids: string[] }
  | { kind: "block"; id: string }
  | { kind: "pharm"; system: string; section: string | null; target: string | null }
  | { kind: "general"; key: GeneralKey }
  | { kind: "workup"; item: string | null }
  | { kind: "slides"; n: number };

export type RoutePage =
  | { kind: "picker" }
  | { kind: "guide"; guide: string; view: GuideView }
  | { kind: "ref"; tab: RefTabId; sub: string | null }
  /** `part`: one part of the section's outline (a heading's slug). */
  | { kind: "other"; section: string | null; part: string | null }
  | { kind: "updates" }
  | { kind: "file"; doc: string }
  | { kind: "versions"; pageKey: string }
  | { kind: "notfound" };

export interface RouteQuery {
  q: string | null;
  from: string | null;
  /** The element a search result lands on (its `data-anchor` id). */
  at: string | null;
}

export type Route = RoutePage & { query: RouteQuery; path: string };

export const isGeneralKey = (k: string): k is GeneralKey => (GENERAL_KEYS as readonly string[]).includes(k);
export const isRefTab = (k: string): k is RefTabId => (REF_TABS as readonly string[]).includes(k);
const NOT_FOUND: RoutePage = { kind: "notfound" };

function decode(seg: string): string | null {
  try {
    return decodeURIComponent(seg);
  } catch {
    return null;
  }
}

/** Parses the part of a guide route after `#/eor/<g>` or `#/pance`. */
function parseGuideView(guide: string, rest: string[]): RoutePage {
  const [head, a, b, c, ...extra] = rest;
  const page = (view: GuideView): RoutePage => ({ kind: "guide", guide, view });
  const isPance = guide === PANCE;
  if (head === undefined) return page({ kind: "home" });
  switch (head) {
    case "s":
      return a && b === undefined ? page({ kind: "system", system: a }) : NOT_FOUND;
    case "sec":
      return a && b && c === undefined ? page({ kind: "section", system: a, section: b }) : NOT_FOUND;
    case "t": {
      const ids = (a ?? "").split(",").filter((x) => x !== "");
      return ids.length > 0 && b === undefined ? page({ kind: "topics", ids }) : NOT_FOUND;
    }
    case "b":
      return a && b === undefined ? page({ kind: "block", id: a }) : NOT_FOUND;
    case "pharm":
      if (!a || extra.length > 0) return NOT_FOUND;
      return page({ kind: "pharm", system: a, section: b ?? null, target: b ? (c ?? null) : null });
    case "general":
      return !isPance && a && b === undefined && isGeneralKey(a) ? page({ kind: "general", key: a }) : NOT_FOUND;
    case "workup":
      return !isPance && b === undefined ? page({ kind: "workup", item: a ?? null }) : NOT_FOUND;
    case "slides": {
      if (isPance || b !== undefined) return NOT_FOUND;
      if (a === undefined) return page({ kind: "slides", n: 1 });
      const n = Number(a);
      return Number.isInteger(n) && n >= 1 ? page({ kind: "slides", n }) : NOT_FOUND;
    }
    default:
      return NOT_FOUND;
  }
}

function parsePath(segs: string[]): RoutePage {
  const [top, ...rest] = segs;
  if (top === undefined) return { kind: "picker" };
  if (top === "eor") {
    const [g, ...more] = rest;
    if (g === undefined) return { kind: "picker" };
    return parseGuideView(g, more);
  }
  if (top === PANCE) return parseGuideView(PANCE, rest);
  if (isRefTab(top)) {
    if (rest.length > 1) return NOT_FOUND;
    return { kind: "ref", tab: top, sub: rest[0] ?? null };
  }
  if (top === "other") {
    if (rest.length === 2 && rest[0] === "guidelines" && rest[1] === UPDATES_PART) return { kind: "updates" };
    if (rest.length > 2) return NOT_FOUND;
    return { kind: "other", section: rest[0] ?? null, part: rest[1] ?? null };
  }
  if (top === "file") return rest.length === 1 && rest[0] ? { kind: "file", doc: rest[0] } : NOT_FOUND;
  if (top === "versions") return rest.length === 1 && rest[0] ? { kind: "versions", pageKey: rest[0] } : NOT_FOUND;
  return NOT_FOUND;
}

/** Parses a location hash (`#/…?q=…&from=…&at=…`; the leading `#` is optional). */
export function parseHash(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const qi = raw.indexOf("?");
  const pathPart = qi < 0 ? raw : raw.slice(0, qi);
  const params = new URLSearchParams(qi < 0 ? "" : raw.slice(qi + 1));
  const query: RouteQuery = { q: params.get("q"), from: params.get("from"), at: params.get("at") };
  const segs: string[] = [];
  for (const s of pathPart.split("/")) {
    if (s === "") continue;
    const d = decode(s);
    if (d === null) return { kind: "notfound", query, path: `#${pathPart}` };
    segs.push(d);
  }
  return { ...parsePath(segs), query, path: `#/${segs.map(encodeURIComponent).join("/")}`.replace(/\/$/, "") || "#/" };
}

// ---- building routes ------------------------------------------------------------------------------

const enc = encodeURIComponent;

/** `#/eor/<g>` for an EOR guide, `#/pance` for PANCE. */
export function guideBase(guide: string): string {
  return guide === PANCE ? "#/pance" : `#/eor/${enc(guide)}`;
}

export function guideViewHash(guide: string, view: GuideView): string {
  const base = guideBase(guide);
  switch (view.kind) {
    case "home":
      return base;
    case "system":
      return `${base}/s/${enc(view.system)}`;
    case "section":
      return `${base}/sec/${enc(view.system)}/${enc(view.section)}`;
    case "topics":
      return `${base}/t/${view.ids.map(enc).join(",")}`;
    case "block":
      return `${base}/b/${enc(view.id)}`;
    case "pharm": {
      let h = `${base}/pharm/${enc(view.system)}`;
      if (view.section) h += `/${enc(view.section)}`;
      if (view.section && view.target) h += `/${enc(view.target)}`;
      return h;
    }
    case "general":
      return `${base}/general/${view.key}`;
    case "workup":
      return view.item ? `${base}/workup/${enc(view.item)}` : `${base}/workup`;
    case "slides":
      return `${base}/slides/${view.n}`;
  }
}

/** `#/<tab>` or `#/<tab>/<sub>` for a reference tab. */
export function refHash(tab: RefTabId, sub: string | null = null): string {
  return sub ? `#/${tab}/${enc(sub)}` : `#/${tab}`;
}

/** `#/other`, `#/other/<section>` or `#/other/<section>/<part>` (a part of the section's outline). */
export function otherHash(section: string | null = null, part: string | null = null): string {
  if (!section) return "#/other";
  return part ? `#/other/${enc(section)}/${enc(part)}` : `#/other/${enc(section)}`;
}

/** The second segment of the Updated guidelines route: no outline part of Guidelines may take it. */
export const UPDATES_PART = "updates";

/** The Updated guidelines list (Other › Guidelines). */
export const UPDATES_ROUTE = `#/other/guidelines/${UPDATES_PART}`;

/** `#/file/<d_id>?from=<route>` — every link that opens a document from a list carries `from` (40 §40.3). */
export function fileHash(doc: string, from: string | null): string {
  const h = `#/file/${enc(doc)}`;
  return from ? `${h}?from=${enc(from)}` : h;
}

export function versionsHash(pageKey: string): string {
  return `#/versions/${enc(pageKey)}`;
}

/** The route without its query (what `from` and Back use). */
export function stripQuery(hash: string): string {
  const i = hash.indexOf("?");
  return i < 0 ? hash : hash.slice(0, i);
}

// ---- location labels ------------------------------------------------------------------------------

export const UPDATES_LOC = "Other › Guidelines › Updated guidelines";

/** Names the site needs to label locations; published in `site.json` as `index`. */
export interface SiteIndex {
  pance: string;
  guideNames: Record<string, string>;
  /** guide → system id → title */
  systems: Record<string, Record<string, string>>;
  /** Other section id → title */
  other: Record<string, string>;
}

const isPanceGuide = (ix: SiteIndex, guide: string): boolean => guide === ix.pance;

/** "EOR › <Guide>" or "PANCE". */
export function guideLoc(ix: SiteIndex, guide: string): string {
  return isPanceGuide(ix, guide) ? "PANCE" : `EOR › ${ix.guideNames[guide] ?? guide}`;
}

/** "EOR › <Guide> › <System>[ › <Section>]" (PANCE: "PANCE › <System>…"). */
export function systemLoc(ix: SiteIndex, guide: string, system: string, section?: string | null): string {
  const base = `${guideLoc(ix, guide)} › ${ix.systems[guide]?.[system] ?? system}`;
  return section ? `${base} › ${section}` : base;
}

/** "EOR › <Guide> › <System> pharm" (PANCE: "PANCE › <System> pharm"). */
export function pharmLoc(ix: SiteIndex, guide: string, system: string): string {
  return `${systemLoc(ix, guide, system)} pharm`;
}

export function generalLoc(ix: SiteIndex, guide: string, key: GeneralKey): string {
  return `${guideLoc(ix, guide)} › ${GENERAL_LABELS[key]}`;
}

/** "EOR › <Guide> › Initial workup". */
export function workupLoc(ix: SiteIndex, guide: string): string {
  return `${guideLoc(ix, guide)} › Initial workup`;
}

/** "EOR › <Guide> › Review slides". */
export function slidesLoc(ix: SiteIndex, guide: string): string {
  return `${guideLoc(ix, guide)} › Review slides`;
}

/** "<Tab>" or "<Tab> › <Sub-tab>". */
export function refLoc(tab: RefTabId, subTitle: string | null = null): string {
  return subTitle ? `${TAB_LABELS[tab]} › ${subTitle}` : TAB_LABELS[tab];
}

/** "Other › <Section>". */
export function otherLoc(ix: SiteIndex, section: string): string {
  return `Other › ${ix.other[section] ?? section}`;
}

/**
 * The File page's location line for the route it was opened from (40 §40.3), or null when `from`
 * is absent or not a list route; the caller then uses the document's first placement.
 */
export function fileLocation(ix: SiteIndex, from: string | null): string | null {
  if (from === null) return null;
  const r = parseHash(from);
  switch (r.kind) {
    case "guide":
      if (r.view.kind === "pharm") return pharmLoc(ix, r.guide, r.view.system);
      if (r.view.kind === "general") return generalLoc(ix, r.guide, r.view.key);
      if (r.view.kind === "home" && isPanceGuide(ix, r.guide)) return guideLoc(ix, r.guide);
      if (r.view.kind === "slides") return slidesLoc(ix, r.guide);
      return null;
    case "ref":
      return refLoc(r.tab);
    case "other":
      return r.section !== null && ix.other[r.section] !== undefined ? otherLoc(ix, r.section) : null;
    default:
      return null;
  }
}
