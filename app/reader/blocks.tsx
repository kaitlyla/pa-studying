// Pieces shared by the guide pages: her blocks rendered as notes, drug-table stubs (40 §40.5) and
// update-note placement by target id (40 §40.7).
import type { ReactNode } from "react";
import type { FlagNote, Notes, PubBlock, SystemJson } from "../../lib/derive/published.ts";
import { BELOW_HEADING, belowUnder } from "../../lib/derive/topics.ts";
import { RichDoc } from "../render/RichDoc.tsx";
import { UpdateNotes } from "../render/labels.tsx";
import { Link } from "../shell/Link.tsx";
import { useStacked } from "../shell/Page.tsx";
import { guideViewHash } from "../shell/route.ts";

/** The notes placed at any of `ids`, each flag once, in placement order. */
export function notesAt(notes: Notes, ids: Iterable<string>): FlagNote[] {
  const out: FlagNote[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    for (const n of notes[id] ?? []) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      out.push(n);
    }
  }
  return out;
}

/** Row ids of each table block of a system. */
export function rowsByBlock(system: SystemJson): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [row, r] of Object.entries(system.rows)) {
    const list = out.get(r.block);
    if (list) list.push(row);
    else out.set(r.block, [row]);
  }
  return out;
}

/** One of her blocks (or the given rows of a table block), in the notes style. */
export function NotesBlock({ block, basePt, rows = null }: { block: PubBlock; basePt: number; rows?: readonly string[] | null }): ReactNode {
  const stacked = useStacked();
  return (
    <div className="notes" data-anchor={block.id}>
      <RichDoc doc={block.doc} basePt={basePt} rows={rows} stacked={stacked} />
    </div>
  );
}

/** A topic's below block under its "Additional info" heading (shown only when she has added one). */
export function AdditionalInfo({ block, basePt }: { block: PubBlock; basePt: number }): ReactNode {
  return (
    <section className="addl" aria-label={BELOW_HEADING}>
      <h3 className="addl-h">{BELOW_HEADING}</h3>
      <NotesBlock block={block} basePt={basePt} />
    </section>
  );
}

/** The dashed link standing in for a drug table on the system page (pharm/no-repeat). */
export function DrugTableStub({ guide, system, label, section }: { guide: string; system: SystemJson; label: string; section: string }): ReactNode {
  return (
    <Link to={guideViewHash(guide, { kind: "pharm", system: system.id, section, target: null })} className="stub">
      <span className="stub-t">{label}</span> drug table — in {system.title} pharm ›
    </Link>
  );
}

/** The rows of the condition topics inside a drug table, in topic order, each heading row once. */
export function conditionRows(system: SystemJson, block: string): string[] {
  const out = new Set<string>();
  for (const t of system.topics) {
    if (!t.condition || system.rows[t.id]?.block !== block) continue;
    for (const r of t.rows) out.add(r);
  }
  return [...out];
}

/**
 * A block in place, as the system and section pages show it: the update notes for the block and its
 * rows above it, then the block. A drug table shows only its condition topics' rows (all of them on
 * the system page, the section's on a section page), then its stub (40 §40.5).
 */
export function PlacedBlock({
  guide,
  system,
  block,
  basePt,
  rows,
  blockRows,
}: {
  guide: string;
  system: SystemJson;
  block: PubBlock;
  basePt: number;
  /** The rows to show (section page), or null for the whole block. */
  rows: readonly string[] | null;
  /** Every row id of this block (for note placement). */
  blockRows: readonly string[];
}): ReactNode {
  const stub = system.stubs[block.id];
  // Her below blocks of the topics ending in the rows shown here follow the table.
  const below = (shown: readonly string[]): ReactNode =>
    belowUnder(system.topics, shown).map((b) => <NotesBlock key={b.id} block={b} basePt={basePt} />);
  if (stub) {
    const cond = rows ?? conditionRows(system, block.id);
    return (
      <>
        {cond.length > 0 && (
          <>
            <UpdateNotes notes={notesAt(system.notes, cond)} />
            <NotesBlock block={block} basePt={basePt} rows={cond} />
            {below(cond)}
          </>
        )}
        <DrugTableStub guide={guide} system={system} label={stub.label} section={stub.section} />
      </>
    );
  }
  const shown = rows ?? blockRows;
  return (
    <>
      <UpdateNotes notes={notesAt(system.notes, [block.id, ...shown])} />
      <NotesBlock block={block} basePt={basePt} rows={rows} />
      {below(shown)}
    </>
  );
}
