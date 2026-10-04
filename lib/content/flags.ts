// Adding a guideline flag (80 §80.3, 90 §90.6): the one place the supersede rule lives, shared by
// the monthly check (tools/guidelines) and curation (tools/curate).
import { newId } from "./ids.ts";
import type { Flag } from "./types.ts";

/** A flag before it gets its id and before anything supersedes it. */
export type NewFlag = Omit<Flag, "id" | "supersededBy">;

/**
 * Append `draft` to `flags` with a fresh `u_` id, which is in neither `taken` nor `flags` and is
 * added to `taken`. Every current flag (`supersededBy: null`, retired or not) with the same `key` is
 * superseded by it, so at most one flag per key stays current (80 §80.6). For USPSTF, the key is
 * the row-bound identity of the Orchestrator rulings of 2026-10-04 03:06Z, 03:07Z and 04:40Z
 * (tools/guidelines `assignUspstfKeys`). It returns the new id and the ids it superseded.
 */
export function addFlag(flags: Flag[], draft: NewFlag, taken: Set<string>): { id: string; superseded: string[] } {
  const id = newId("u", { has: (x) => taken.has(x) || flags.some((f) => f.id === x) });
  taken.add(id);
  const superseded: string[] = [];
  for (const f of flags) {
    if (f.key === draft.key && f.supersededBy === null) {
      f.supersededBy = id;
      superseded.push(f.id);
    }
  }
  flags.push({ ...draft, id, supersededBy: null });
  return { id, superseded };
}
