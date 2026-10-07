// Topics, heading rows and continuation rows (plan 40 §40.2), and section membership.
import type { BlockFile, StructureFile } from "../content/types.ts";
import { BuildError } from "./errors.ts";
import { listedHead, resolutionRows } from "../content/tables.ts";
import { memberTarget } from "../content/ids.ts";
import type { NavEntry, NavSystem, PubBlock, PubMedsCard, PubMedsEdit, PubRow, PubSectionItem, PubTopic, SystemJson } from "./published.ts";
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

function sectionOf(value: string | undefined): string | null {
  const target = value === undefined ? null : memberTarget(value);
  return target !== null && "section" in target ? target.section : null;
}

/**
 * The section a block (or untitled row) is shown under: its own `members` section, or for a block
 * shown under a listed entry, the section of that entry's listed block.
 */
export function blockSection(structure: StructureFile, id: string): string | null {
  return sectionOf(structure.members[listedHead(structure, id) ?? id]);
}

/** The section of an id's `members` entry: its section, or the section of the topic or listed block it is recorded under. */
function memberSection(t: SystemTopics, structure: StructureFile, id: string): string | null {
  const topic = recordedTopic(structure, id);
  if (topic === null) return blockSection(structure, id);
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

/**
 * Topics of one system's blocks in order (40 §40.2). Throws a BuildError for a `titled` or
 * `unlisted` entry that does not fit. A `titled` row must be a content row of a topic table; one
 * titled by a heading cell must sit directly below a heading row (rows recorded under it in between
 * aside) whose named cell is non-empty. An `unlisted` row must be a content row of a non-drug table
 * that would start a topic.
 */
export function deriveTopics(blocks: readonly BlockFile[], structure: StructureFile): SystemTopics {
  const { topics, unfit } = derive(blocks, structure, true);
  for (const [id, why] of unfit) throw new BuildError(id, why);
  return topics;
}

/**
 * `structure` without the `titled` and `unlisted` entries that no longer fit its blocks
 * (deriveTopics' rule): the editor's save applies this after splicing, so an edit that deletes the
 * row, or breaks the heading row a titled row takes its title from, drops the entry, and the row is
 * titled by 40 §40.2 again (Orchestrator rulings 2026-10-04 22:01Z and 2026-10-06). Returns
 * `structure` itself when every entry fits.
 */
export function fitTopicRows(blocks: readonly BlockFile[], structure: StructureFile): StructureFile {
  if (structure.titled === undefined && structure.unlisted === undefined) return structure;
  const { unfit } = derive(blocks, structure, false);
  if (unfit.size === 0) return structure;
  const out: StructureFile = { ...structure };
  const titled = Object.entries(structure.titled ?? {}).filter(([id]) => !unfit.has(id));
  if (titled.length > 0) out.titled = Object.fromEntries(titled);
  else delete out.titled;
  const unlisted = (structure.unlisted ?? []).filter((id) => !unfit.has(id));
  if (unlisted.length > 0) out.unlisted = unlisted;
  else delete out.unlisted;
  return out;
}

/** deriveTopics' derivation; `strict` also enforces recorded rows' targets. Unfit `titled` and `unlisted` entries are skipped and reported. */
function derive(blocks: readonly BlockFile[], structure: StructureFile, strict: boolean): { topics: SystemTopics; unfit: Map<string, string> } {
  const titled = structure.titled ?? {};
  const unlisted = new Set(structure.unlisted ?? []);
  const unfit = new Map<string, string>();
  const reached = new Set<string>();
  const drugTables = new Map(structure.drugTables.map((d) => [d.block, new Set(d.conditionRows)]));
  const out: SystemTopics = { topics: [], rows: new Map(), headings: new Map(), tables: new Map(), untitled: [], proseBlocks: [] };
  const byId = new Map<string, Topic>();
  /** The last topic of the preceding non-drug topic tables. */
  let carry: Topic | null = null;
  /** Since the last topic started, an `unlisted` row came: rows that would continue a topic stay untitled. */
  let afterUnlisted = false;
  /** The listed entry the previous block is shown under. */
  let prevHead: string | null = null;

  for (const block of blocks) {
    const head = listedHead(structure, block.id);
    // A run listed as one entry is its listed block and the blocks recorded under it, directly below it.
    if (strict && head !== null && head !== block.id && head !== prevHead) {
      throw new BuildError(block.id, `members records it under ${head}, which is not the listed block of the run directly above it`);
    }
    prevHead = head;
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
      const above = headingAbove === null ? undefined : out.headings.get(headingAbove);
      let title = text !== "" ? text : collapse(above?.label ?? "");
      const at = titled[row.id];
      if (typeof at === "string") {
        reached.add(row.id);
        title = at;
      } else if (at !== undefined) {
        reached.add(row.id);
        const cell = above === undefined ? "" : collapse((at === 0 ? above.label : above.columns[at - 1]) ?? "");
        if (cell !== "") title = cell;
        else unfit.set(row.id, above === undefined ? "titled, but no heading row is directly above it" : `titled by cell ${at} of heading row ${headingAbove}, which is empty or missing`);
      }
      headingAbove = null;
      let continued: Topic | null;
      if (afterUnlisted) continued = null;
      else if (last) continued = last;
      else if (!conditions && carry) continued = carry;
      else continued = null;
      // A heading label repeating the title of the topic the row would otherwise continue names that
      // topic again, so the row continues it (agent decision, Orchestrator 2026-10-06, amending 40 §40.2).
      if (text === "" && at === undefined && continued !== null && title === continued.title) title = "";
      const joining = attached.get(row.id) ?? [];
      attached.delete(row.id);
      if (unlisted.has(row.id)) {
        reached.add(row.id);
        if (title !== "" && !conditions) {
          out.untitled.push(...joining, row.id);
          afterUnlisted = true;
          continue;
        }
        unfit.set(row.id, conditions ? "unlisted, but it is a row of a drug table" : "unlisted, but it starts no topic");
      }
      let topic: Topic | null;
      if (title !== "") topic = start(row.id, title);
      else topic = continued;
      if (topic === null) {
        out.untitled.push(...joining, row.id);
        continue;
      }
      afterUnlisted = false;
      for (const id of joining) (out.rows.get(id) as RowInfo).topic = topic.id;
      if (topic.id === row.id) topic.rows.unshift(...joining);
      else topic.rows.push(...joining, row.id);
      info.topic = topic.id;
      last = topic;
    }
    for (const [target, ids] of attached) {
      if (strict) throw new BuildError(ids[0] as string, `members records it under ${target}, which is not a later topic or untitled row of the same table`);
    }
    if (!conditions && last) carry = last;
  }

  for (const id of Object.keys(titled)) {
    if (!reached.has(id)) unfit.set(id, "titled, but it is not a content row of a topic table that a heading row can title");
  }
  for (const id of unlisted) {
    if (!reached.has(id)) unfit.set(id, "unlisted, but it is not a content row of a topic table");
  }
  for (const topic of out.topics) topic.section = structure.sections.length > 0 ? memberSection(out, structure, topic.id) : null;
  return { topics: out, unfit };
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

/**
 * The system's topics as published in `SystemJson.topics`, each with its meds panel from `meds`, her
 * own panel for it from `medsEdit` (given the derived panel), and its block from `below` (topic id →
 * the block she added below it).
 */
export function publishedTopics(
  t: SystemTopics, meds: (topic: Topic) => PubMedsCard[], medsEdit: (topic: Topic, derived: PubMedsCard[]) => PubMedsEdit | null, below: ReadonlyMap<string, BlockFile>,
): PubTopic[] {
  return t.topics.map((topic) => {
    const b = below.get(topic.id);
    const derived = meds(topic);
    return {
      id: topic.id, title: topic.title, section: topic.section, condition: topic.condition, rows: withHeadings(t, topic.rows), meds: derived,
      medsEdit: medsEdit(topic, derived), below: b ? { id: b.id, kind: b.kind, doc: b.doc } : null,
    };
  });
}

/** The heading over a topic's below block wherever it is read, and its area's label while editing (her wording). */
export const BELOW_HEADING = "Additional info";

/**
 * Where a topic's below block shows besides its own page (her choice: section and system pages and
 * their PDFs too): right under the table holding the topic's last row, wherever that row is shown.
 * Of `topics`, those with a below block whose last row is among `shown` (one table's rows on a page),
 * in topic order.
 */
export function topicsBelow<T extends { rows: readonly string[] }>(topics: readonly T[], shown: readonly string[], hasBelow: (topic: T) => boolean): T[] {
  const set = new Set(shown);
  return topics.filter((t) => hasBelow(t) && t.rows.length > 0 && set.has(t.rows[t.rows.length - 1] as string));
}

/** The published below blocks under a table showing `shown` rows (topicsBelow over PubTopic). */
export function belowUnder(topics: readonly PubTopic[], shown: readonly string[]): PubBlock[] {
  return topicsBelow(topics, shown, (t) => t.below !== null && t.below !== undefined).map((t) => t.below as PubBlock);
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
      if (blockSection(structure, id) === section) items.push({ block: id, rows: null });
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
 * each listed block (with the blocks of its run, when it lists more than itself), and each topic at
 * its first row. A system without sections lists them flat.
 * The build and the owner's post-save view both read this, so a save that changes a topic shows at once.
 */
export function navEntries(t: SystemTopics, structure: StructureFile, blockIds: readonly string[]): Pick<NavSystem, "sections" | "entries"> {
  const entries: (NavEntry & { section: string | null })[] = [];
  for (const id of blockIds) {
    if (t.proseBlocks.includes(id)) {
      const title = structure.listed[id];
      if (title === undefined) continue;
      const run = blockIds.filter((b) => listedHead(structure, b) === id);
      entries.push({ kind: "block", id, title, ...(run.length > 1 ? { blocks: run } : {}), section: blockSection(structure, id) });
      continue;
    }
    for (const r of t.tables.get(id)?.rows ?? []) {
      const topic = t.topics.find((x) => x.id === r.id);
      if (topic) entries.push({ kind: "topic", id: topic.id, title: topic.title, section: topic.section });
    }
  }
  const strip = ({ kind, id, title, blocks }: NavEntry): NavEntry => ({ kind, id, title, ...(blocks ? { blocks } : {}) });
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
    // Recorded under a topic or a listed block; deriveTopics checks the target.
    if (!("section" in memberTarget(section))) continue;
    if (!sections.has(section)) throw new BuildError(id, `members names section "${section}", which ${systemId} does not have`);
  }
  const need = (id: string, what: string): void => {
    if (structure.members[id] === undefined) throw new BuildError(id, `${what} in ${systemId} has no members entry`);
  };
  for (const topic of t.topics) need(topic.id, topic.condition ? "condition row" : "topic row");
  for (const id of t.untitled) need(id, "untitled row");
  for (const id of t.proseBlocks) need(id, "prose or one-column block");
}
