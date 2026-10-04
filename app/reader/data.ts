// Data paths and shared lookups for the guide reader (40 §40.8).
import { navPath, SITE_PATH, systemPath, type NavJson, type SiteJson, type SystemJson } from "../../lib/derive/published.ts";
import { useData } from "../data/load.ts";
import type { Crumb } from "../shell/Page.tsx";
import { guideBase, guideViewHash, PANCE } from "../shell/route.ts";

export const useSite = (): SiteJson => useData<SiteJson>(SITE_PATH);
export const useNav = (g: string): NavJson => useData<NavJson>(navPath(g));
export const useSystem = (g: string, s: string): SystemJson => useData<SystemJson>(systemPath(g, s));

/** Guides whose top-level groups are called sections rather than systems (the signed mockup). */
const SECTION_WORD = new Set(["psy", "ob"]);
export const systemsWord = (g: string, n: number): string =>
  SECTION_WORD.has(g) ? (n === 1 ? "section" : "sections") : n === 1 ? "system" : "systems";
export const systemsHeading = (g: string): string => (SECTION_WORD.has(g) ? "Sections" : "Systems");

export function guideName(site: SiteJson, g: string): string {
  return site.guideNames[g] ?? g;
}

/** "EOR › <Guide>" crumbs (PANCE: "PANCE"), each linking to its page. */
export function guideCrumbs(site: SiteJson, g: string): Crumb[] {
  if (g === PANCE) return [{ label: "PANCE", to: guideBase(g) }];
  return [
    { label: "EOR", to: "#/eor" },
    { label: guideName(site, g), to: guideBase(g) },
  ];
}

export function systemCrumb(g: string, system: { id: string; title: string }): Crumb {
  return { label: system.title, to: guideViewHash(g, { kind: "system", system: system.id }) };
}

/** The guide file's name without its extension, as the PDF menu shows it. */
export function guideFile(nav: NavJson): string {
  return nav.source.replace(/\.[A-Za-z0-9]+$/, "");
}

/** Topic route. */
export const topicHash = (g: string, ids: readonly string[]): string => guideViewHash(g, { kind: "topics", ids: [...ids] });
