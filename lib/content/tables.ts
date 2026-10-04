// Which stored tables take part in row resolution (plan 40 §40.2). Shared by the save helpers
// (splice.ts) and the build derivations (lib/derive/topics.ts) so both resolve the same rows.
import type { StructureFile } from "./types.ts";

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
 * The rows of a block that take part in row resolution (40 §40.2), or null when it takes none:
 * a drug table's rows (its condition rows form topics whatever its column count), and the rows of
 * a non-drug table with more than one column. One-column non-drug tables behave as prose blocks.
 */
export function resolutionRows(block: TableBlockLike, structure: StructureFile): RowNodeLike[] | null {
  const table = tableNode(block);
  if (!table) return null;
  const drug = structure.drugTables.some((d) => d.block === block.id);
  if (!drug && columnCount(table) < 2) return null;
  return table.content ?? [];
}
