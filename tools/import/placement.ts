// Where each imported document is listed (30 §30.2 placements, 20 §20.7–§20.8), and the
// pre-curation curation files the build reads (30 §30.14).
import type { OtherFile, RefTab, RefTabsFile, StructureFile } from "../../lib/content/index.ts";
import { OTHER_GAP_SECTIONS, OTHER_SECTION_IDS } from "../../lib/content/index.ts";
import { REF_TABS } from "../../lib/derive/routes.ts";
import type { RefTabId } from "../../lib/derive/routes.ts";
import type { Category, Placement } from "./sources.ts";

/** A document already given its id, with its inventory placement. */
export interface PlacedDoc {
  id: string;
  placement: Placement;
}

/**
 * The `pharmFiles` of one system (its guides.json `category`): every document whose categories
 * cover it, in inventory order.
 */
export function pharmFilesFor(cat: Category | null, docs: readonly PlacedDoc[]): string[] {
  if (cat === null) return [];
  return docs.filter((d) => d.placement !== null && "pharm" in d.placement && d.placement.pharm.includes(cat)).map((d) => d.id);
}

/** A system's pre-curation `structure.json` (30 §30.14). */
export function initialStructure(pharmFiles: string[]): StructureFile {
  return { v: 1, sections: [], members: {}, listed: {}, drugTables: [], pharmSections: [], pharmFiles };
}

/** Other-tab section titles, in the signed order (other/rules/list; mockup `OTHER_SECTIONS`). */
export const OTHER_TITLES: Readonly<Record<(typeof OTHER_SECTION_IDS)[number], string>> = {
  emergency: "Emergency care",
  vaccines: "Vaccine schedules",
  guidelines: "Guidelines",
  screenings: "Screenings",
  legal: "Legal",
  pa: "PA professional",
  vitamins: "Vitamins",
  pe: "Physical exam",
  notes: "Note templates & documentation",
};

/** Each reference tab, keyed by its id, lists the documents placed on it in inventory order. */
export function buildRefTabs(docs: readonly PlacedDoc[]): RefTabsFile {
  const tab = (id: RefTabId): RefTab => ({
    subs: [],
    files: docs.filter((d) => d.placement !== null && "reftabs" in d.placement && d.placement.reftabs === id).map((d) => d.id),
  });
  const tabs = Object.fromEntries(REF_TABS.map((id) => [id, tab(id)])) as Record<RefTabId, RefTab>;
  return { v: 1, ...tabs };
}

/** `gaps: []` only on the OTHER_GAP_SECTIONS; `lead: null` everywhere (30 §30.14, 20 §20.8). */
export function buildOther(docs: readonly PlacedDoc[]): OtherFile {
  return {
    v: 1,
    sections: OTHER_SECTION_IDS.map((id) => ({
      id,
      title: OTHER_TITLES[id],
      lead: null,
      files: docs.filter((d) => d.placement !== null && "other" in d.placement && d.placement.other === id).map((d) => d.id),
      links: [],
      ...(OTHER_GAP_SECTIONS.includes(id) ? { gaps: [] } : {}),
    })),
  };
}

/** The PANCE guide's last sidebar item (20 §20.8), when the inventory names one. */
export function sidebarEndOf(docs: readonly PlacedDoc[]): string | undefined {
  return docs.find((d) => d.placement !== null && "sidebarEnd" in d.placement)?.id;
}
