// Which items of a place's notes and outline show. The build applies the rule while it
// publishes; the owner's overlay (app/edit/overlay.ts) applies it again to published data after her
// saves, so a Remove, Restore or Rename shows on the page at once the way the next build will show it.
import type { DocList, DocRef, PubNote, PubOtherNote } from "./published.ts";

/** What the rule reads for one place. */
export interface ShownItems {
  /** Whether a block of one of her Word pages shows: only while that page is visible. */
  block: (id: string) => boolean;
  /**
   * The listing of a document shown whole or as an original: only while the place lists it among its
   * files, under that listing's name. A removed or processing document is listed by the place's files instead.
   */
  doc: (id: string) => DocRef | undefined;
}

/** The rule for a place with document list `files` (null: the place lists no documents). */
export function shownItems(files: DocList | null, block: (id: string) => boolean): ShownItems {
  return { block, doc: (id) => files?.files.find((f) => f.id === id) };
}

/** Published notes or outline items with the rule applied: hidden items dropped, documents under their current listing. */
export function shownNotes<N extends PubNote | PubOtherNote>(notes: readonly N[], shown: ShownItems): N[] {
  const out: N[] = [];
  for (const n of notes) {
    if ("block" in n) {
      if (shown.block(n.block.id)) out.push(n);
    } else if ("doc" in n) {
      const d = shown.doc(n.doc.id);
      if (d) out.push({ ...n, doc: d });
    } else if ("original" in n) {
      const d = shown.doc(n.original.id);
      if (d) out.push({ ...n, original: d });
    } else {
      out.push(n);
    }
  }
  return out;
}
