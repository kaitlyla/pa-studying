// Her own notes on a place page (a reference-tab topic or an Other section; content PlaceNote): her
// Word-page blocks in her notes style, with headings for finding one's way, above the page's gap blocks.
import type { ReactNode } from "react";
import { noteView } from "../../lib/derive/columns.ts";
import type { PubNote } from "../../lib/derive/published.ts";
import { NotesBlock } from "../reader/blocks.tsx";
import { Txt } from "../render/Text.tsx";

export function PlaceNote({ note }: { note: PubNote }): ReactNode {
  if ("heading" in note) {
    return (
      <h2 className="pn-h">
        <Txt text={note.heading} />
      </h2>
    );
  }
  const view = noteView(note.block.doc, note, { firstRow: true });
  if (!view) return null;
  const block = <NotesBlock block={{ ...note.block, doc: view.doc }} basePt={note.basePt} />;
  if (view.title === null) return block;
  return (
    <>
      <h3 className="pn-col">
        <Txt text={view.title} />
      </h3>
      {block}
    </>
  );
}

export function PlaceNotes({ notes }: { notes: readonly PubNote[] }): ReactNode {
  if (notes.length === 0) return null;
  return (
    <div className="place-notes">
      {notes.map((n, i) => (
        <PlaceNote key={"heading" in n ? `h${i}` : `${n.block.id}:${n.column ?? ""}:${n.rows?.join(",") ?? ""}:${i}`} note={n} />
      ))}
    </div>
  );
}
