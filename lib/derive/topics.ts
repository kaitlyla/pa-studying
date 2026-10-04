// Topics, heading rows and continuation rows (plan 40 §40.2), and section membership.
import type { BlockFile, StructureFile } from "../content/types.ts";
import { BuildError } from "./errors.ts";
import { resolutionRows } from "../content/tables.ts";
import { collapse, firstCell, readRows, tableOf, type Table } from "./text.ts";

export interface Topic {
  /** The first row's id. */
  id: string;
  title: string;
  /** The table block holding the first row. */
  block: string;
  /** Formed from a drug table's condition rows. */
  condition: boolean;
  /** The first row and its continuation rows, in order. */
  rows: string[];
  /** `members[id]`, or null in a system without sections. */
  section: string | null;
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
      const label = headingAbove === null ? "" : collapse(out.headings.get(headingAbove)?.label ?? "");
      headingAbove = null;
      if (conditions && !conditions.has(row.id)) {
        info.drug = true;
        continue;
      }
      const text = collapse(firstCell(row));
      let topic: Topic | null;
      if (text !== "") topic = start(row.id, text);
      else if (label !== "") topic = start(row.id, label);
      else if (last) topic = last;
      else if (!conditions && carry) topic = carry;
      else topic = null;
      if (topic === null) {
        out.untitled.push(row.id);
        continue;
      }
      if (topic.id !== row.id) topic.rows.push(row.id);
      info.topic = topic.id;
      last = topic;
    }
    if (!conditions && last) carry = last;
  }

  for (const topic of out.topics) topic.section = structure.sections.length > 0 ? (structure.members[topic.id] ?? null) : null;
  return out;
}

/**
 * The section a row is shown under: its topic's, or its own `members` entry. Drug rows have none,
 * whatever `members` says: they live only in Pharm.
 */
export function rowSection(t: SystemTopics, structure: StructureFile, rowId: string): string | null {
  const info = t.rows.get(rowId);
  if (!info || info.drug) return null;
  if (info.topic !== null) return t.topics.find((x) => x.id === info.topic)?.section ?? null;
  return structure.members[rowId] ?? null;
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
    if (!sections.has(section)) throw new BuildError(id, `members names section "${section}", which ${systemId} does not have`);
  }
  const need = (id: string, what: string): void => {
    if (structure.members[id] === undefined) throw new BuildError(id, `${what} in ${systemId} has no members entry`);
  };
  for (const topic of t.topics) need(topic.id, topic.condition ? "condition row" : "topic row");
  for (const id of t.untitled) need(id, "untitled row");
  for (const id of t.proseBlocks) need(id, "prose or one-column block");
}
