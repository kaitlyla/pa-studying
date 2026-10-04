// Routes (plan 10 §10.4) and location labels (40 §40.3, 60 §60.1).
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

export const UPDATES_ROUTE = "#/other/guidelines/updates";
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

export const isPance = (ix: SiteIndex, guide: string): boolean => guide === ix.pance;

/** `#/eor/<g>` for an EOR guide, `#/pance` for PANCE. */
export function guideRoute(ix: SiteIndex, guide: string): string {
  return isPance(ix, guide) ? "#/pance" : `#/eor/${guide}`;
}

/** "EOR › <Guide>" or "PANCE". */
export function guideLoc(ix: SiteIndex, guide: string): string {
  return isPance(ix, guide) ? "PANCE" : `EOR › ${ix.guideNames[guide] ?? guide}`;
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

/** "Other › <Section>". */
export function otherLoc(ix: SiteIndex, section: string): string {
  return `Other › ${ix.other[section] ?? section}`;
}

const isGeneralKey = (k: string): k is GeneralKey => (GENERAL_KEYS as readonly string[]).includes(k);
const isRefTab = (k: string): k is RefTabId => (REF_TABS as readonly string[]).includes(k);

/**
 * The File page's location line for the route it was opened from (40 §40.3), or null when `from`
 * is absent or not a list route; the caller then uses the document's first placement.
 */
export function fileLocation(ix: SiteIndex, from: string | null): string | null {
  if (from === null) return null;
  const path = from.split("?")[0] ?? "";
  let m = /^#\/eor\/([^/]+)\/pharm\/([^/]+)/.exec(path);
  if (m?.[1] && m[2]) return pharmLoc(ix, m[1], m[2]);
  m = /^#\/pance\/pharm\/([^/]+)/.exec(path);
  if (m?.[1]) return pharmLoc(ix, ix.pance, m[1]);
  m = /^#\/other\/([^/]+)$/.exec(path);
  if (m?.[1] && ix.other[m[1]] !== undefined) return otherLoc(ix, m[1]);
  m = /^#\/([a-z]+)(?:\/[^/]+)?$/.exec(path);
  if (m?.[1] && isRefTab(m[1])) return TAB_LABELS[m[1]];
  m = /^#\/eor\/([^/]+)\/general\/([^/]+)$/.exec(path);
  if (m?.[1] && m[2] && isGeneralKey(m[2])) return generalLoc(ix, m[1], m[2]);
  if (path === "#/pance") return guideLoc(ix, ix.pance);
  return null;
}
