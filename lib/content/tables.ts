// Which stored tables take part in row resolution (plan 40 §40.2). Shared by the save helpers
// (splice.ts) and the build derivations (lib/derive/topics.ts) so both resolve the same rows.
import type { StructureFile } from "./types.ts";
import { memberTarget } from "./ids.ts";

export interface RowNodeLike {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: unknown[];
}

export interface TableNodeLike {
  type: string;
  attrs?: Record<string, unknown>;
  content?: RowNodeLike[];
}

export interface TableBlockLike {
  id: string;
  doc: { content: unknown[] };
}

/** The table node of a table block (its doc's only child), or null. */
export function tableNode(block: TableBlockLike): TableNodeLike | null {
  const [table, ...rest] = block.doc.content as TableNodeLike[];
  return rest.length === 0 && table?.type === "table" ? table : null;
}

/** Number of grid columns of a table node. */
export function columnCount(table: TableNodeLike): number {
  const grid = table.attrs?.grid;
  return Array.isArray(grid) ? grid.length : 0;
}

/**
 * The listed block whose sidebar entry shows block `blockId`: the block itself when the structure
 * lists it by name, the listed block it is recorded under (`members[block] = <listed block>`: a run
 * of consecutive blocks listed as one entry), or null.
 */
export function listedHead(structure: StructureFile, blockId: string): string | null {
  if (structure.listed[blockId] !== undefined) return blockId;
  const value = structure.members[blockId];
  const target = value === undefined ? null : memberTarget(value);
  return target !== null && "listed" in target ? target.listed : null;
}

/**
 * The rows of a block that take part in row resolution (40 §40.2), or null when it takes none:
 * a drug table's rows (its condition rows form topics whatever its column count), and the rows of
 * a non-drug table with more than one column. One-column non-drug tables, and any table shown under
 * a listed entry (`listedHead`), behave as prose blocks: a listed table is one sidebar entry shown
 * whole under its listed title, not one topic per row.
 */
export function resolutionRows(block: TableBlockLike, structure: StructureFile): RowNodeLike[] | null {
  const table = tableNode(block);
  if (!table || listedHead(structure, block.id) !== null) return null;
  const drug = structure.drugTables.some((d) => d.block === block.id);
  if (!drug && columnCount(table) < 2) return null;
  return table.content ?? [];
}
