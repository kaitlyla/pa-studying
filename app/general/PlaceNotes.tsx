// Her own notes on a place page (a reference-tab topic or an Other section; content PlaceNote): her
// Word-page blocks in her notes style, with headings for finding one's way, above the page's gap blocks.
import type { ReactNode } from "react";
import { columnView } from "../../lib/derive/columns.ts";
import type { PubNote } from "../../lib/derive/published.ts";
import { NotesBlock } from "../reader/blocks.tsx";
import { Txt } from "../render/Text.tsx";

function PlaceNote({ note }: { note: PubNote }): ReactNode {
  if ("heading" in note) {
    return (
      <h2 className="pn-h">
        <Txt text={note.heading} />
      </h2>
    );
  }
  if (note.column === null) return <NotesBlock block={note.block} basePt={note.basePt} />;
  const view = columnView(note.block.doc, note.column);
  if (!view) return null;
  return (
    <>
      <h3 className="pn-col">
        <Txt text={view.title} />
      </h3>
      <NotesBlock block={{ ...note.block, doc: view.doc }} basePt={note.basePt} />
    </>
  );
}

export function PlaceNotes({ notes }: { notes: readonly PubNote[] }): ReactNode {
  if (notes.length === 0) return null;
  return (
    <div className="place-notes">
      {notes.map((n, i) => (
        <PlaceNote key={"heading" in n ? `h${i}` : `${n.block.id}:${n.column ?? ""}:${i}`} note={n} />
      ))}
    </div>
  );
}
