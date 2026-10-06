// An Other section's outline (published PubOtherNote list) cut into the page's parts and the
// sidebar's entries: one part per heading, holding the items up to the next heading of either level.
import { columnView } from "../../lib/derive/columns.ts";
import type { OtherJson, PubOtherNote } from "../../lib/derive/published.ts";
import { otherHash } from "../../lib/derive/routes.ts";

export type OutlineItem = Exclude<PubOtherNote, { heading: string }>;

export interface OutlinePart {
  /** The heading's part slug: its anchor and route. */
  id: string;
  title: string;
  sub: boolean;
  items: OutlineItem[];
}

export interface Outline {
  /** Items before the first heading. */
  intro: OutlineItem[];
  parts: OutlinePart[];
}

export function splitOutline(notes: readonly PubOtherNote[]): Outline {
  const out: Outline = { intro: [], parts: [] };
  for (const n of notes) {
    if ("heading" in n) out.parts.push({ id: n.id, title: n.heading, sub: n.sub, items: [] });
    else (out.parts.at(-1)?.items ?? out.intro).push(n);
  }
  return out;
}

/** The anchor an item's sidebar entry lands on, with its title; null for items no entry names. */
export function itemEntry(item: OutlineItem): { id: string; title: string } | null {
  if ("doc" in item) return { id: item.doc.id, title: item.doc.name };
  if ("gap" in item) return { id: item.gap.id, title: item.gap.title };
  if ("block" in item && item.column !== null) {
    const view = columnView(item.block.doc, item.column);
    return view ? { id: columnAnchor(item.block.id, item.column), title: view.title } : null;
  }
  return null;
}

export const columnAnchor = (block: string, column: number): string => `${block}-c${column}`;

export interface SidebarChild {
  id: string;
  title: string;
  /** A sub heading's part (its own page) rather than an item anchored in the parent's part. */
  part: boolean;
}

export interface SidebarEntry {
  id: string;
  title: string;
  children: SidebarChild[];
}

/** The route a sidebar entry opens: the part's page, landing on `at` when given. */
export function entryHash(section: string, part: string, at: string | null = null): string {
  const h = otherHash(section, part);
  return at === null ? h : `${h}?at=${encodeURIComponent(at)}`;
}

/**
 * The sidebar entries: one per top heading. Its children are its sub headings; without any, the
 * named items of its part (docs, gaps, table columns) when there are two or more. A sub heading
 * before any top heading is not valid content and never occurs.
 */
export function sidebarEntries(outline: Outline): SidebarEntry[] {
  const out: SidebarEntry[] = [];
  const subs = new Map<SidebarEntry, OutlinePart[]>();
  for (const p of outline.parts) {
    const top = out.at(-1);
    if (p.sub && top) {
      subs.get(top)?.push(p);
      continue;
    }
    const e: SidebarEntry = { id: p.id, title: p.title, children: [] };
    out.push(e);
    subs.set(e, []);
    const named = p.items.map(itemEntry).filter((x) => x !== null);
    if (named.length >= 2) e.children = named.map((x) => ({ ...x, part: false }));
  }
  for (const [e, ps] of subs) if (ps.length > 0) e.children = ps.map((p) => ({ id: p.id, title: p.title, part: true }));
  return out;
}

type OtherSection = OtherJson["sections"][number];

/** The section's links, files and gaps that its outline does not show: listed after the outline. */
export function leftovers(s: OtherSection): { links: OtherSection["links"]; files: OtherSection["files"]; gaps: OtherSection["gaps"] } {
  const shown = new Set(s.notes.flatMap((n) => ("doc" in n ? [n.doc.id] : "gap" in n ? [n.gap.id] : "link" in n ? [n.link.target] : [])));
  return {
    links: s.links.filter((l) => !shown.has(l.target)),
    files: { ...s.files, files: s.files.files.filter((f) => !shown.has(f.id)) },
    gaps: s.gaps?.filter((g) => !shown.has(g.id)),
  };
}
