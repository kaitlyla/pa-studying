// Save helpers (plan 50 §50.4): splicing edited rows back into the full table by row id, and the
// structure.json updates for added and deleted rows and blocks.
import { resolutionRows, type TableBlockLike } from "./tables.ts";
import type { StructureFile } from "./types.ts";

export interface SpliceResult<R> {
  rows: R[];
  added: string[];
  deleted: string[];
}

/**
 * Splice an edited partial table back into the full table.
 * - `full`: every row of the stored table, in order;
 * - `shown`: the ids of the rows the editor showed (the partial before editing);
 * - `edited`: the partial after editing.
 * An existing id replaces that row; a shown id missing from `edited` is deleted. New rows are
 * inserted directly before the existing row that follows them in `edited`, so rows hidden between
 * two shown rows stay above them; new rows after the last existing row go directly after it
 * (Orchestrator ruling 2026-10-04 03:16Z, replacing plan 50 §50.4's anchor-after rule). With no
 * existing row in `edited`, they take the place of the first shown row, or end the table.
 */
export function spliceRows<R>(full: readonly R[], shown: readonly string[], edited: readonly R[], idOf: (row: R) => string): SpliceResult<R> {
  const fullIds = new Set(full.map(idOf));
  const shownIds = new Set(shown);
  for (const id of shownIds) if (!fullIds.has(id)) throw new Error(`Row ${id} was shown but is not in the table`);
  const editedIds = new Set<string>();
  for (const row of edited) {
    const id = idOf(row);
    if (editedIds.has(id)) throw new Error(`Row ${id} appears twice in the edited table`);
    if (fullIds.has(id) && !shownIds.has(id)) throw new Error(`Row ${id} was not part of the edited table`);
    editedIds.add(id);
  }

  // Each run of new rows goes before the existing row that follows it; a trailing run goes after
  // the last existing row.
  const before = new Map<string, R[]>();
  const replacement = new Map<string, R>();
  let pending: R[] = [];
  let last: string | null = null;
  for (const row of edited) {
    const id = idOf(row);
    if (fullIds.has(id)) {
      replacement.set(id, row);
      if (pending.length > 0) before.set(id, pending);
      pending = [];
      last = id;
    } else {
      pending.push(row);
    }
  }
  const trailing = last === null ? [] : pending;
  const orphans = last === null ? pending : [];

  const rows: R[] = [];
  const deleted: string[] = [];
  const firstShown = full.map(idOf).find((id) => shownIds.has(id));
  for (const row of full) {
    const id = idOf(row);
    if (id === firstShown) rows.push(...orphans);
    rows.push(...(before.get(id) ?? []));
    if (!shownIds.has(id)) rows.push(row);
    else if (replacement.has(id)) rows.push(replacement.get(id) as R, ...(id === last ? trailing : []));
    else deleted.push(id);
  }
  if (firstShown === undefined) rows.push(...orphans);
  const added = edited.map(idOf).filter((id) => !fullIds.has(id));
  return { rows, added, deleted };
}

/**
 * Apply added and deleted rows/blocks to a system's structure.json (50 §50.4, operator ruling 2B).
 * - `order`: the system's row ids in 40 §40.2 resolution order (after the splice), so the nearest
 *   topic above a new row is the nearest earlier id carrying a `members` entry;
 * - `table`: the edited table block;
 * - `topic`: when saving a topic page, that topic's id. Each new row in the run directly above the
 *   topic's first row (rows already recorded as its members don't break the run) is recorded as
 *   `members[row] = topic`, so it shows with that topic in every view (Orchestrator ruling
 *   2026-10-04 04:44Z);
 * - any other new row in a system with sections joins the section of the topic above it, or the
 *   first section when no row above it has one; a new row of a drug table gets a `members` entry
 *   only when it is one of that table's `conditionRows`, since drug rows live only in Pharm;
 * - a deleted id leaves `members` (as a key and as a topic value), `listed` and every
 *   `drugTables[].conditionRows`.
 * Returns a new object; the input is not modified.
 */
export function updateStructure(
  structure: StructureFile,
  change: { order: readonly string[]; added?: readonly string[]; deleted?: readonly string[]; table: string; topic?: string },
): StructureFile {
  const drugTable = structure.drugTables.find((d) => d.block === change.table);
  const added = new Set(change.added ?? []);
  const deleted = new Set(change.deleted ?? []);
  const members: Record<string, string> = {};
  for (const [k, v] of Object.entries(structure.members)) if (!deleted.has(k) && !deleted.has(v)) members[k] = v;
  const listed: Record<string, string> = {};
  for (const [k, v] of Object.entries(structure.listed)) if (!deleted.has(k)) listed[k] = v;
  const drugTables = structure.drugTables.map((d) => ({ ...d, conditionRows: d.conditionRows.filter((r) => !deleted.has(r)) }));

  const joined = new Set<string>();
  if (change.topic !== undefined) {
    const topic = change.topic;
    const at = change.order.indexOf(topic);
    if (at === -1) throw new Error(`Topic ${topic} is not in the system's row order`);
    for (let i = at - 1; i >= 0; i--) {
      const id = change.order[i] as string;
      if (added.has(id)) {
        if (drugTable && !drugTable.conditionRows.includes(id)) break;
        members[id] = topic;
        joined.add(id);
      } else if (members[id] !== topic) break;
    }
  }

  const firstSection = structure.sections[0]?.id;
  if (firstSection !== undefined) {
    for (const id of added) {
      const at = change.order.indexOf(id);
      if (at === -1) throw new Error(`New row ${id} is not in the system's row order`);
      if (joined.has(id) || (drugTable && !drugTable.conditionRows.includes(id))) continue;
      const above = change.order.slice(0, at).reverse().find((prev) => !added.has(prev) && prev in members);
      members[id] = (above !== undefined ? members[above] : undefined) ?? firstSection;
    }
  }
  return { ...structure, members, listed, drugTables };
}

function rowIds(block: TableBlockLike, structure: StructureFile): string[] | null {
  return resolutionRows(block, structure)?.map((r) => String(r.attrs?.id)) ?? null;
}

/**
 * The row order `updateStructure` resolves against for an edit of table `tableId`: that drug table's
 * rows for a drug table; otherwise the resolution rows (40 §40.2) of every non-drug table of the
 * system, in `system.json` order. `blocks` are the system's blocks in `system.json` order.
 */
export function systemRowOrder(blocks: readonly TableBlockLike[], structure: StructureFile, tableId: string): string[] {
  const drug = new Set(structure.drugTables.map((d) => d.block));
  if (drug.has(tableId)) {
    const t = blocks.find((b) => b.id === tableId);
    return t ? (rowIds(t, structure) ?? []) : [];
  }
  const out: string[] = [];
  for (const b of blocks) {
    if (drug.has(b.id)) continue;
    const ids = rowIds(b, structure);
    if (ids) out.push(...ids);
  }
  return out;
}
