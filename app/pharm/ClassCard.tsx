// A collapsible drug-class card (pharm/by-class) and what goes inside one: rows from her guide and
// her pharm notes on the class (with the pharm-notes readability aids, pharm/notes-fidelity).
import { Fragment, type ReactNode } from "react";
import { noteView } from "../../lib/derive/columns.ts";
import type { PanelPiece } from "../../lib/derive/panel.ts";
import type { PartCut, SystemJson } from "../../lib/derive/published.ts";
import { withoutLines } from "../../lib/derive/trim.ts";
import { RichDoc } from "../render/RichDoc.tsx";
import { Txt } from "../render/Text.tsx";
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

export interface NotesPart extends PartCut {
  /** The part id (search lands on it); null when the card itself carries it. */
  id: string | null;
  blocks: readonly string[];
  /** The part's pharm file name and base size, when not the card's own. */
  file?: string;
  basePt?: number;
}

/**
 * Her pharm notes for a card or part: each run of parts from one of her files under that file's
 * label, without the lines in `hidden` (block id → paragraph indexes left out: lines her guide table,
 * shown with the card, already says, and lines the card already showed word for word).
 */
export function CardNotes({ system, file, basePt, parts, hidden }: {
  system: SystemJson; file: string; basePt: number; parts: readonly NotesPart[]; hidden?: ReadonlyMap<string, ReadonlySet<number>>;
}): ReactNode {
  return (
    <div className="phn">
      {parts.map((p, i) => {
        const from = p.file ?? file;
        const label = i === 0 || from !== (parts[i - 1]?.file ?? file);
        return (
          <Fragment key={p.id ?? i}>
            {label && (
              <div className="ph-file">
                <span className="own-only">From your pharm notes · </span>
                {from}
              </div>
            )}
            <div className="ph-part" data-anchor={p.id ?? undefined}>
              {p.blocks.map((id) => {
                const b = system.notesBlocks[id];
                const view = b ? noteView(withoutLines(b.doc, hidden?.get(id)), p, { firstRow: false }) : null;
                if (!view) return null;
                return (
                  <div key={id} className="notes ph-course">
                    {view.title !== null && (
                      <h4 className="pn-col">
                        <Txt text={view.title} />
                      </h4>
                    )}
                    <RichDoc doc={view.doc} basePt={p.basePt ?? basePt} pharmNotes />
                  </div>
                );
              })}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * A meds-panel entry's pieces (lib/derive/panel.ts): each rows piece (rows of her guide's drug
 * tables) under "From your guide", then her notes under their files' labels, a part's pieces in one
 * part container (search lands on it). `body` draws the piece at an index of `pieces` in place of its
 * text (the editors of edit mode).
 */
export function CardPieces({ pieces, body }: { pieces: readonly PanelPiece[]; body?: (index: number) => ReactNode }): ReactNode {
  const stacked = useStacked();
  const indexed = pieces.map((p, i) => ({ ...p, i }));
  const rows = indexed.filter((p) => p.kind === "rows");
  const notes = indexed.filter((p) => p.kind === "notes");
  // Consecutive notes pieces of one part share its container.
  const groups: (typeof indexed)[] = [];
  for (const p of notes) {
    const last = groups[groups.length - 1];
    if (last && last[0]?.part === p.part && last[0]?.file === p.file) last.push(p);
    else groups.push([p]);
  }
  return (
    <>
      {rows.map((p) => (
        <div key={`r${p.i}`} className="notes ph-rowblk">
          <div className="phn-k">
            <Voice owner="From your guide" visitor="From the guide" />
          </div>
          {body ? body(p.i) : <RichDoc doc={p.doc} basePt={p.basePt} stacked={stacked} />}
        </div>
      ))}
      {groups.length > 0 && (
        <div className="phn">
          {groups.map((g, i) => {
            const file = g[0]?.file ?? null;
            const label = file !== null && (i === 0 || file !== groups[i - 1]?.[0]?.file);
            return (
              <Fragment key={i}>
                {label && (
                  <div className="ph-file">
                    <span className="own-only">From your pharm notes · </span>
                    {file}
                  </div>
                )}
                <div className="ph-part" data-anchor={g[0]?.part ?? undefined}>
                  {g.map((p) => (
                    <div key={p.i} className="notes ph-course">
                      {p.title !== null && (
                        <h4 className="pn-col">
                          <Txt text={p.title} />
                        </h4>
                      )}
                      {body ? body(p.i) : <RichDoc doc={p.doc} basePt={p.basePt} pharmNotes />}
                    </div>
                  ))}
                </div>
              </Fragment>
            );
          })}
        </div>
      )}
    </>
  );
}
