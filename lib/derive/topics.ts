// Topics, heading rows and continuation rows (plan 40 §40.2), and section membership.
import type { BlockFile, StructureFile } from "../content/types.ts";
import { BuildError } from "./errors.ts";
import { resolutionRows } from "../content/tables.ts";
import { memberTarget } from "../content/ids.ts";
import type { NavEntry, NavSystem, PubMedsCard, PubRow, PubSectionItem, PubTopic, SystemJson } from "./published.ts";
import { collapse, firstCell, readRows, tableOf, type Table } from "./text.ts";

export interface Topic {
  /** The id of the row that starts the topic (40 §40.2). */
  id: string;
  title: string;
  /** The table block holding the first row. */
  block: string;
  /** Formed from a drug table's condition rows. */
  condition: boolean;
  /**
   * The topic's rows in table order: rows recorded under it in `members` (which sit above its
   * starting row), the starting row, and its continuation rows.
   */
  rows: string[];
  /** The section of its starting row's `members` entry, or null in a system without sections. */
  section: string | null;
}

/**
 * The topic a row is recorded under (Orchestrator ruling 2026-10-04 04:44Z, a blank row added above
 * a topic's first row from its page), or null.
 */
function recordedTopic(structure: StructureFile, rowId: string): string | null {
  const v = structure.members[rowId];
  const target = v === undefined ? null : memberTarget(v);
  return target !== null && "topic" in target ? target.topic : null;
}

/** The section of an id's `members` entry: its section, or the section of the topic it is recorded under. */
function memberSection(t: SystemTopics, structure: StructureFile, id: string): string | null {
  const sectionOf = (v: string | undefined): string | null => {
    const target = v === undefined ? null : memberTarget(v);
    return target !== null && "section" in target ? target.section : null;
  };
  const topic = recordedTopic(structure, id);
  if (topic === null) return sectionOf(structure.members[id]);
  return sectionOf(structure.members[t.rows.get(topic)?.topic ?? topic]);
}

export interface RowInfo {
  block: string;
  kind: "heading" | "content";
  /** The nearest heading row above in the same table. */
  heading: string | null;
  /** The topic the row belongs to; null for heading rows, drug rows and untitled material. */
  topic: string | null;
  /** A content row of a drug table that is not a condition row. */
  drug: boolean;
}

export interface HeadingRow {
  label: string;
  columns: string[];
}

export interface SystemTopics {
  topics: Topic[];
  rows: Map<string, RowInfo>;
  headings: Map<string, HeadingRow>;
  /** Every table block of the system. */
  tables: Map<string, Table>;
  /** Content rows of topic tables that belong to no topic (shown in place only). */
  untitled: string[];
  /** Blocks that behave as prose: prose blocks and one-column non-drug tables. */
  proseBlocks: string[];
}

/** Topics of one system's blocks in order (40 §40.2). */
export function deriveTopics(blocks: readonly BlockFile[], structure: StructureFile): SystemTopics {
  const drugTables = new Map(structure.drugTables.map((d) => [d.block, new Set(d.conditionRows)]));
  const out: SystemTopics = { topics: [], rows: new Map(), headings: new Map(), tables: new Map(), untitled: [], proseBlocks: [] };
  const byId = new Map<string, Topic>();
  /** The last topic of the preceding non-drug topic tables. */
  let carry: Topic | null = null;

  for (const block of blocks) {
    const stored = tableOf(block);
    if (stored) out.tables.set(block.id, stored);
    const rows = resolutionRows(block, structure);
    if (rows === null) {
      out.proseBlocks.push(block.id);
      continue;
    }
    const table = { block: block.id, rows: readRows(rows) };
    const conditions = drugTables.get(block.id);
    let heading: string | null = null;
    let headingAbove: string | null = null;
    let last: Topic | null = null;
    /** Rows recorded under a topic row not yet reached, by that row's id. */
    const attached = new Map<string, string[]>();
    const start = (rowId: string, title: string): Topic => {
      const topic: Topic = { id: rowId, title, block: block.id, condition: conditions !== undefined, rows: [rowId], section: null };
      out.topics.push(topic);
      byId.set(rowId, topic);
      return topic;
    };
    for (const row of table.rows) {
      if (row.kind === "heading") {
        heading = row.id;
        headingAbove = row.id;
        out.headings.set(row.id, { label: firstCell(row), columns: row.cells.slice(1) });
        out.rows.set(row.id, { block: block.id, kind: "heading", heading: row.id, topic: null, drug: false });
        continue;
      }
      const info: RowInfo = { block: block.id, kind: "content", heading, topic: null, drug: false };
      out.rows.set(row.id, info);
      if (conditions && !conditions.has(row.id)) {
        headingAbove = null;
        info.drug = true;
        continue;
      }
      const text = collapse(firstCell(row));
      const recorded = recordedTopic(structure, row.id);
      if (text === "" && recorded !== null) {
        // Shown with the topic of a later row, so it neither starts nor continues one here, and a
        // labeled heading row above it still applies to the row it was added above.
        attached.set(recorded, [...(attached.get(recorded) ?? []), row.id]);
        continue;
      }
      const label = headingAbove === null ? "" : collapse(out.headings.get(headingAbove)?.label ?? "");
      headingAbove = null;
      let topic: Topic | null;
      if (text !== "") topic = start(row.id, text);
      else if (label !== "") topic = start(row.id, label);
      else if (last) topic = last;
      else if (!conditions && carry) topic = carry;
      else topic = null;
      const joining = attached.get(row.id) ?? [];
      attached.delete(row.id);
      if (topic === null) {
        out.untitled.push(...joining, row.id);
        continue;
      }
      for (const id of joining) (out.rows.get(id) as RowInfo).topic = topic.id;
      if (topic.id === row.id) topic.rows.unshift(...joining);
      else topic.rows.push(...joining, row.id);
      info.topic = topic.id;
      last = topic;
    }
    for (const [target, ids] of attached) {
      throw new BuildError(ids[0] as string, `members records it under ${target}, which is not a later topic or untitled row of the same table`);
    }
    if (!conditions && last) carry = last;
  }

  for (const topic of out.topics) topic.section = structure.sections.length > 0 ? memberSection(out, structure, topic.id) : null;
  return out;
}

/**
 * The section a row is shown under: its topic's, or its own `members` entry. Drug rows have none,
 * whatever `members` says: they live only in Pharm.
 */
export function rowSection(t: SystemTopics, structure: StructureFile, rowId: string): string | null {
  const info = t.rows.get(rowId);
  if (!info || info.drug || structure.sections.length === 0) return null;
  if (info.topic !== null) return t.topics.find((x) => x.id === info.topic)?.section ?? null;
  return memberSection(t, structure, rowId);
}

/** The system's rows and heading rows as published in `SystemJson.rows` / `.headings` (40 §40.8). */
export function publishedRows(t: SystemTopics): { rows: Record<string, PubRow>; headings: Record<string, HeadingRow> } {
  return {
    rows: Object.fromEntries([...t.rows].map(([id, r]) => [id, { block: r.block, kind: r.kind, heading: r.kind === "heading" ? null : r.heading, topic: r.topic }])),
    headings: Object.fromEntries(t.headings),
  };
}

/** The system's topics as published in `SystemJson.topics`, each with its meds panel from `meds`. */
export function publishedTopics(t: SystemTopics, meds: (topic: Topic) => PubMedsCard[]): PubTopic[] {
  return t.topics.map((topic) => ({
    id: topic.id, title: topic.title, section: topic.section, condition: topic.condition, rows: withHeadings(t, topic.rows), meds: meds(topic),
  }));
}

/**
 * A section page's items (40 §40.3), in the order of `blockIds` (the system's blocks): each
 * prose/one-column block that `members` puts in the section, whole (`rows: null`); for each table,
 * its content rows shown under the section, each run preceded once by its heading row. The build,
 * the owner's post-save view and the editor's section unit all read this, so they match.
 */
export function sectionItems(t: SystemTopics, structure: StructureFile, blockIds: readonly string[], section: string): PubSectionItem[] {
  const items: PubSectionItem[] = [];
  for (const id of blockIds) {
    if (t.proseBlocks.includes(id)) {
      if (structure.members[id] === section) items.push({ block: id, rows: null });
      continue;
    }
    const rows = (t.tables.get(id)?.rows ?? []).filter((r) => r.kind === "content" && rowSection(t, structure, r.id) === section).map((r) => r.id);
    if (rows.length > 0) items.push({ block: id, rows: withHeadings(t, rows) });
  }
  return items;
}

/** A system page's `sections`: each structure section in order, with its sectionItems. */
export function publishedSections(t: SystemTopics, structure: StructureFile, blockIds: readonly string[]): SystemJson["sections"] {
  return structure.sections.map((sec) => ({ id: sec.id, title: sec.title, items: sectionItems(t, structure, blockIds, sec.id) }));
}

/**
 * A system's sidebar (NavJson `systems[]` sections and entries, 40 §40.3) in the order of `blockIds`:
 * each listed prose block, and each topic at its first row. A system without sections lists them flat.
 * The build and the owner's post-save view both read this, so a save that changes a topic shows at once.
 */
export function navEntries(t: SystemTopics, structure: StructureFile, blockIds: readonly string[]): Pick<NavSystem, "sections" | "entries"> {
  const entries: (NavEntry & { section: string | null })[] = [];
  for (const id of blockIds) {
    if (t.proseBlocks.includes(id)) {
      const title = structure.listed[id];
      if (title !== undefined) entries.push({ kind: "block", id, title, section: structure.members[id] ?? null });
      continue;
    }
    for (const r of t.tables.get(id)?.rows ?? []) {
      const topic = t.topics.find((x) => x.id === r.id);
      if (topic) entries.push({ kind: "topic", id: topic.id, title: topic.title, section: topic.section });
    }
  }
  const strip = ({ kind, id, title }: NavEntry): NavEntry => ({ kind, id, title });
  return {
    sections: structure.sections.map((sec) => ({ id: sec.id, title: sec.title, entries: entries.filter((e) => e.section === sec.id).map(strip) })),
    entries: structure.sections.length === 0 ? entries.map(strip) : [],
  };
}

/** Rows with each run's applicable heading row inserted once before the run. */
export function withHeadings(t: SystemTopics, rowIds: readonly string[]): string[] {
  const out: string[] = [];
  let prev: string | null = null;
  for (const id of rowIds) {
    const h = t.rows.get(id)?.heading ?? null;
    if (h !== null && h !== prev && h !== id) out.push(h);
    prev = h;
    out.push(id);
  }
  return out;
}

/**
 * Section coverage (40 §40.1): in a system with sections, every topic's first row, every untitled
 * row and every prose/one-column block has a `members` entry naming one of the sections.
 */
export function checkMembers(systemId: string, t: SystemTopics, structure: StructureFile): void {
  if (structure.sections.length === 0) return;
  const sections = new Set(structure.sections.map((s) => s.id));
  for (const [id, section] of Object.entries(structure.members)) {
    if ("topic" in memberTarget(section)) continue; // recorded under a topic; deriveTopics checks the topic row
    if (!sections.has(section)) throw new BuildError(id, `members names section "${section}", which ${systemId} does not have`);
  }
  const need = (id: string, what: string): void => {
    if (structure.members[id] === undefined) throw new BuildError(id, `${what} in ${systemId} has no members entry`);
  };
  for (const topic of t.topics) need(topic.id, topic.condition ? "condition row" : "topic row");
  for (const id of t.untitled) need(id, "untitled row");
  for (const id of t.proseBlocks) need(id, "prose or one-column block");
}
