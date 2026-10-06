// An Other section's outline on its page (UI other-tab): her documents shown whole, her Word blocks,
// gap blocks and links into her notes, in the outline's order, under its headings; then whatever
// the section lists that the outline does not show.
import { Suspense, type ReactNode } from "react";
import { docPath, type DocJson, type OtherJson, type PubLink } from "../../lib/derive/published.ts";
import { useData } from "../data/load.ts";
import { FileBody } from "../files/FilePage.tsx";
import { FileChips } from "../files/FileChip.tsx";
import { GapBlock, UpdateNotes } from "../render/labels.tsx";
import { Txt } from "../render/Text.tsx";
import { Link } from "../shell/Link.tsx";
import { Voice } from "../shell/owner.tsx";
import { fileHash } from "../shell/route.ts";
import { columnAnchor, leftovers, type OutlineItem, type OutlinePart } from "./outline.ts";
import { PlaceNote } from "./PlaceNotes.tsx";
import { NoteLinks } from "./ThreeParts.tsx";

export const OPEN_FILE = "Open file";
/** An empty sub heading's part: her document for it is still to come. */
export const COMING_SOON = "Coming soon.";
export const ORIGINAL_PDF = "Original PDF:";

function DocContent({ id }: { id: string }): ReactNode {
  const doc = useData<DocJson>(docPath(id));
  return (
    <>
      <UpdateNotes notes={doc.notes[doc.id]} />
      <FileBody doc={doc} />
    </>
  );
}

/** One of her documents shown whole, under its name, with a link to its File page (download, rename, versions). */
function OtherDoc({ id, name, from }: { id: string; name: string; from: string }): ReactNode {
  return (
    <section className="odoc" data-anchor={id} aria-label={name}>
      <div className="odoc-h">
        <h3>
          <Txt text={name} />
        </h3>
        <Link to={fileHash(id, from)}>{OPEN_FILE}</Link>
      </div>
      <Suspense fallback={<div className="loading">Loading…</div>}>
        <DocContent id={id} />
      </Suspense>
    </section>
  );
}

function Item({ item, from }: { item: Exclude<OutlineItem, { link: PubLink }>; from: string }): ReactNode {
  if ("doc" in item) return <OtherDoc id={item.doc.id} name={item.doc.name} from={from} />;
  if ("original" in item) {
    return (
      <p className="oorig" data-anchor={item.original.id}>
        {ORIGINAL_PDF} <Link to={fileHash(item.original.id, from)}>
          <Txt text={item.original.name} />
        </Link>
      </p>
    );
  }
  if ("gap" in item) return <GapBlock gap={item.gap} />;
  if (item.column === null) return <PlaceNote note={item} />;
  return (
    <div data-anchor={columnAnchor(item.block.id, item.column)}>
      <PlaceNote note={item} />
    </div>
  );
}

/** A run of items in order; consecutive links share one list. */
export function OutlineItems({ items, from }: { items: readonly OutlineItem[]; from: string }): ReactNode {
  const groups = items.reduce<(PubLink[] | Exclude<OutlineItem, { link: PubLink }>)[]>((acc, item) => {
    const last = acc.at(-1);
    if (!("link" in item)) return [...acc, item];
    return Array.isArray(last) ? [...acc.slice(0, -1), [...last, item.link]] : [...acc, [item.link]];
  }, []);
  return groups.map((g, i) => (Array.isArray(g) ? <NoteLinks key={i} links={g} /> : <Item key={i} item={g} from={from} />));
}

/** A part's items; a sub heading with none shows that its document is still to come. */
export function PartItems({ part, from }: { part: OutlinePart; from: string }): ReactNode {
  if (part.sub && part.items.length === 0) return <p className="osoon">{COMING_SOON}</p>;
  return <OutlineItems items={part.items} from={from} />;
}

export function OutlinePartView({ part, from }: { part: OutlinePart; from: string }): ReactNode {
  const H = part.sub ? "h3" : "h2";
  return (
    <div className={`opart${part.sub ? " sub" : ""}`}>
      <H className="opart-h" data-anchor={part.id} id={`part-${part.id}`}>
        <Txt text={part.title} />
      </H>
      <PartItems part={part} from={from} />
    </div>
  );
}

/** What the section lists that its outline does not show: links, files (with removed and pending ones), gap blocks. */
export function Leftovers({ section }: { section: OtherJson["sections"][number] }): ReactNode {
  const rest = leftovers(section);
  const hasFiles = rest.files.files.length + rest.files.removed.length + rest.files.pending.length > 0;
  return (
    <>
      {rest.links.length > 0 && (
        <div className="gsec">
          <h2>
            <Voice owner="Also in your notes" visitor="Also in the notes" />
          </h2>
          <NoteLinks links={rest.links} />
        </div>
      )}
      {hasFiles && (
        <div className="gsec">
          {rest.files.files.length > 0 && (
            <h2>
              <Voice owner="Your files" visitor="Files" /> <span className="n">{rest.files.files.length}</span>
            </h2>
          )}
          <FileChips list={rest.files} />
        </div>
      )}
      {rest.gaps && rest.gaps.length > 0 && (
        <div className="gsec">
          <h2 className="own-only">Not covered by your notes</h2>
          {rest.gaps.map((g) => (
            <GapBlock key={g.id} gap={g} />
          ))}
        </div>
      )}
    </>
  );
}
