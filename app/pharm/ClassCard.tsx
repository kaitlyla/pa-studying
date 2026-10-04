// A collapsible drug-class card (pharm/by-class) and what goes inside one: rows from her guide and
// her pharm notes on the class (with the pharm-notes readability aids, pharm/notes-fidelity).
import type { ReactNode } from "react";
import type { PubBlock, SystemJson } from "../../lib/derive/published.ts";
import { RichDoc } from "../render/RichDoc.tsx";
import { Icon } from "../shell/Icon.tsx";
import { Voice } from "../shell/owner.tsx";
import { useStacked } from "../shell/Page.tsx";

export interface ClassCardProps {
  /** Scroll target id (the card id, or a row id for a card-less row). */
  anchor: string;
  title: ReactNode;
  sub?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children?: ReactNode;
}

export function ClassCard({ anchor, title, sub, open, onToggle, children }: ClassCardProps): ReactNode {
  return (
    <section className={`phc${open ? " open" : ""}`} data-anchor={anchor} id={`card-${anchor}`}>
      <h3 className="phc-h">
        <button type="button" aria-expanded={open} onClick={onToggle}>
          <Icon n="chev" size={12} />
          <span className="phc-t">{title}</span>
          {sub && <span className="phc-s">{sub}</span>}
        </button>
      </h3>
      {open && <div className="phc-b">{children}</div>}
    </section>
  );
}

export interface NotesPart {
  /** The part id (search lands on it); null when the card itself carries it. */
  id: string | null;
  blocks: readonly string[];
}

/** Her pharm notes for a card or part: the file label, then each part's blocks. */
export function CardNotes({ system, file, basePt, parts }: { system: SystemJson; file: string; basePt: number; parts: readonly NotesPart[] }): ReactNode {
  return (
    <div className="phn">
      <div className="ph-file">
        <span className="own-only">From your pharm notes · </span>
        {file}
      </div>
      {parts.map((p, i) => (
        <div key={p.id ?? i} className="ph-part" data-anchor={p.id ?? undefined}>
          {p.blocks.map((id) => {
            const b = system.notesBlocks[id];
            if (!b) return null;
            return (
              <div key={id} className="notes ph-course">
                <RichDoc doc={b.doc} basePt={basePt} pharmNotes />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Runs of consecutive rows from the same table block. */
export function rowRuns(system: SystemJson, rows: readonly string[]): { block: PubBlock; rows: string[] }[] {
  const blocks = new Map(system.blocks.map((b) => [b.id, b]));
  const out: { block: PubBlock; rows: string[] }[] = [];
  for (const id of rows) {
    const r = system.rows[id];
    const b = r ? blocks.get(r.block) : undefined;
    if (!b) continue;
    const last = out[out.length - 1];
    if (last && last.block.id === b.id) last.rows.push(id);
    else out.push({ block: b, rows: [id] });
  }
  return out;
}

/** Rows of her guide's drug tables shown inside a card, under "From your guide". */
export function GuideRows({ system, rows, basePt }: { system: SystemJson; rows: readonly string[]; basePt: number }): ReactNode {
  const stacked = useStacked();
  return rowRuns(system, rows).map((run, i) => (
    <div key={`${run.block.id}:${i}`} className="notes ph-rowblk">
      <div className="phn-k">
        <Voice owner="From your guide" visitor="From the guide" />
      </div>
      <RichDoc doc={run.block.doc} basePt={basePt} rows={run.rows} stacked={stacked} />
    </div>
  ));
}
