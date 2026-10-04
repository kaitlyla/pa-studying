// Where a document goes in a published DocList (40 §40.8) by its state. The build and the owner's
// post-save overlay (app/edit/overlay.ts) both classify through this, so they agree.
import type { DocList } from "./published.ts";
import { fileHash } from "./routes.ts";

/** The document facts the classification reads (from doc.json / file.json). */
export interface DocState {
  name: string;
  kind: DocList["files"][number]["kind"];
  removed: { at: string } | null;
  /** As-is files only: an upload still converting, or one whose conversion failed. */
  state?: string;
}

/** Adds document `id` to `list`: removed first, then processing/failed uploads as pending, else a listed file. */
export function addDoc(list: DocList, id: string, doc: DocState): void {
  if (doc.removed) list.removed.push({ id, name: doc.name, at: doc.removed.at });
  else if (doc.state === "processing" || doc.state === "failed") list.pending.push({ id, name: doc.name, state: doc.state });
  else list.files.push({ id, name: doc.name, kind: doc.kind, route: fileHash(id, null) });
}
