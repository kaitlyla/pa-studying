// Labels for content not from her notes (plan 40 §40.7; general-topic/gap-block, label-owner-only,
// guide-reader/update-note). Owner-only wording is rendered with the `own-only` class and hidden by
// CSS for visitors, so a page she saved still reads neutrally to visitors.
import type { ReactNode } from "react";
import type { FlagNote, PubFigure, PubGap } from "../../lib/derive/published.ts";
import { formatDate, latest } from "../shell/format.ts";
import { Icon } from "../shell/Icon.tsx";
import { assetUrl, RichDoc } from "./RichDoc.tsx";
import { Txt } from "./Text.tsx";

/** Site-written content is authored at this base size. */
export const GAP_BASE_PT = 11;

const isWebUrl = (u: string | null | undefined): u is string => typeof u === "string" && /^https?:\/\//.test(u);

/** The owner-only "Not from your notes" badge (dashed outline, icon and text). */
export function GapChip(): ReactNode {
  return (
    <span className="lab-chip gapc own-only" contentEditable={false} suppressContentEditableWarning>
      <Icon n="gap" size={13} />
      Not from your notes
    </span>
  );
}

/** The brown "Updated guideline" badge, for everyone. */
export function UpdChip(): ReactNode {
  return (
    <span className="lab-chip updc">
      <Icon n="upd" size={13} />
      Updated guideline
    </span>
  );
}

/** An Updated guideline note, shown open (guide-reader/update-note). Plain text only (10 §10.6). */
export function UpdateNote({ note }: { note: FlagNote }): ReactNode {
  return (
    <aside className="upd" aria-label="Updated guideline" data-anchor={note.id}>
      <div className="upd-h">
        <UpdChip />
        <span className="um own-only">— not from your notes</span>
        <span className="ut">
          <Txt text={note.guideline} />
        </span>
      </div>
      <div className="um">
        <Txt text={note.org} /> · Published {formatDate(note.published)}
        {note.flagged ? ` · Flagged ${formatDate(note.flagged)}` : ""}
        {note.grade ? ` · Grade ${note.grade}` : ""}
      </div>
      {note.quote && (
        <blockquote>
          “<Txt text={note.quote} />”
        </blockquote>
      )}
      {isWebUrl(note.url) && (
        <a href={note.url} target="_blank" rel="noopener noreferrer">
          Read the guideline <Icon n="ext" size={11} />
        </a>
      )}
    </aside>
  );
}

export function UpdateNotes({ notes }: { notes: readonly FlagNote[] | undefined }): ReactNode {
  if (!notes || notes.length === 0) return null;
  return notes.map((n) => <UpdateNote key={n.id} note={n} />);
}

/**
 * A gap block's example images, each opening full size, with its caption and its credit line: author,
 * license, a link to the source's file page and any change made. The same wording for everyone.
 */
export function GapFigures({ figures }: { figures: readonly PubFigure[] }): ReactNode {
  if (figures.length === 0) return null;
  return (
    <div className="gap-figs">
      {figures.map((f) => {
        const url = assetUrl(f.asset);
        const c = f.credit;
        return (
          <figure key={f.asset} className="gap-fig">
            <a href={url} target="_blank" rel="noopener noreferrer">
              <img src={url} width={f.width} height={f.height} alt={f.caption} loading="lazy" />
            </a>
            <figcaption>
              <span className="fig-cap">
                <Txt text={f.caption} />
              </span>
              <span className="fig-credit">
                Image: <Txt text={c.author} /> ·{" "}
                {isWebUrl(c.licenseUrl) ? (
                  <a href={c.licenseUrl} target="_blank" rel="noopener noreferrer license">
                    <Txt text={c.license} />
                  </a>
                ) : (
                  <Txt text={c.license} />
                )}{" "}
                ·{" "}
                <a href={c.page} target="_blank" rel="noopener noreferrer">
                  Source <Icon n="ext" size={11} />
                </a>
                {c.changes !== null && (
                  <>
                    {" "}
                    · Changes: <Txt text={c.changes} />
                  </>
                )}
              </span>
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}

/**
 * A gap-filled block (general-topic/gap-block). `titled` false: no title heading, for a block
 * whose title is already shown just above it (a collapsible's summary).
 */
export function GapBlock({ gap, titled = true }: { gap: PubGap; titled?: boolean }): ReactNode {
  const edited = latest(gap.ownerEdits);
  return (
    <section className="gap" aria-label={gap.title} data-anchor={gap.id}>
      <UpdateNotes notes={gap.notes} />
      <div className="gap-h">
        <GapChip />
        {titled && (
          <h3>
            <Txt text={gap.title} />
          </h3>
        )}
        {edited && <span className="gap-edited own-only">Edited by you · {formatDate(edited)}</span>}
      </div>
      <div className="gap-meta">
        Relevant to: <b><Txt text={gap.relevantTo} /></b> · Written {formatDate(gap.written)}
      </div>
      <GapFigures figures={gap.figures} />
      <div className="notes gap-body">
        <RichDoc doc={gap.doc} basePt={GAP_BASE_PT} />
      </div>
      {gap.differs && (
        <div className="gap-diff own-only">
          <b>Differs from your notes.</b>
          <RichDoc doc={gap.differs} basePt={GAP_BASE_PT} />
        </div>
      )}
      <div className="gap-src">
        <b>Sources</b>
        <ol>
          {gap.sources.map((s, i) => (
            <li key={i}>
              <Txt text={s.name} />. <Txt text={s.org} />. {s.year}.{" "}
              {isWebUrl(s.url) && (
                <a href={s.url} target="_blank" rel="noopener noreferrer">
                  Open source <Icon n="ext" size={11} />
                </a>
              )}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** The purple Review slides badge; "— made from your notes" only on generated decks, owner only. */
export function ReviewSlidesBadge({ generated }: { generated: boolean }): ReactNode {
  return (
    <div className="rs-label">
      <span className="lab-chip rsc">Review slides</span>
      {generated && <span className="own-only"> — made from your notes</span>}
      <span className="rs-pdf"> · Not included in PDF downloads</span>
    </div>
  );
}
