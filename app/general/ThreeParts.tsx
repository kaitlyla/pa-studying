// The three-part layout of general-topic, reference-tab and Other pages (40 §40.7,
// general-topic/three-parts): (1) links into her notes, (2) her files, (3) content not from her notes.
import type { ReactNode } from "react";
import type { DocList, PubGap, PubLink } from "../../lib/derive/published.ts";
import { FileChips } from "../files/FileChip.tsx";
import { GapBlock, UpdChip } from "../render/labels.tsx";
import { Txt } from "../render/Text.tsx";
import { Link } from "../shell/Link.tsx";
import { Voice } from "../shell/owner.tsx";

export function NoteLinks({ links }: { links: readonly PubLink[] }): ReactNode {
  return (
    <ul className="lnk">
      {links.map((l) => (
        <li key={l.target}>
          <Link to={l.route}>
            <span className="lt">
              <Txt text={l.title} />
            </span>
            <span className="ll">
              {l.loc}
              {l.covers ? ` — ${l.covers}` : ""}
            </span>
            {l.flagged && <UpdChip />}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export interface ThreePartsProps {
  links: readonly PubLink[];
  files: DocList;
  /** Absent for an Other section whose record has no `gaps` (parts 1 and 2 only). */
  gaps?: readonly PubGap[];
  /** An Other section's lead gap block, above part (1). */
  lead?: PubGap | null;
  /** Ends "Your notes and files cover this topic for …"; absent on reference tabs ("cover this."). */
  coveredFor?: string;
  /** The gray how-to pointer (general-topic/howto), above part (1). */
  howto?: ReactNode;
}

export function ThreeParts({ links, files, gaps, lead = null, coveredFor, howto }: ThreePartsProps): ReactNode {
  const hasFiles = files.files.length + files.removed.length + files.pending.length > 0;
  return (
    <>
      {lead && <GapBlock gap={lead} />}
      {howto}
      <div className="gsec">
        <h2>
          <Voice owner="In your notes" visitor="In the notes" /> <span className="n">{links.length}</span>
        </h2>
        <NoteLinks links={links} />
      </div>
      {hasFiles && (
        <div className="gsec">
          {files.files.length > 0 && (
            <h2>
              <Voice owner="Your files" visitor="Files" /> <span className="n">{files.files.length}</span>
            </h2>
          )}
          <FileChips list={files} />
        </div>
      )}
      {gaps && (
        <div className="gsec">
          <h2 className="own-only">Not covered by your notes</h2>
          {gaps.length === 0 && !lead && (
            <div className="covered own-only">
              {coveredFor ? `Your notes and files cover this topic for ${coveredFor}.` : "Your notes and files cover this."} Nothing was added.
            </div>
          )}
          {gaps.map((g) => (
            <GapBlock key={g.id} gap={g} />
          ))}
        </div>
      )}
    </>
  );
}
