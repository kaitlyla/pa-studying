// The owner's document actions (plan 50 §50.7–§50.9), written as commits on `main` through the 50 §50.4
// protocol. A document's `replacing` and `replaceFailed` markers are written as `doc-marker` commits,
// which are neither versions nor an Original (Orchestrator ruling 2026-10-05 00:55Z, amending 50 §50.4
// and §50.6; dismissing a failed replacement's note per the ruling of 2026-10-04 20:39Z).
import {
  commitMessage, serializeFile, type AsIsFile, type DeckFile, type FileKind, type OtherFile, type RefTabsFile, type Trailers,
  type WordDocFile,
} from "../../lib/content/index.ts";
import { commitChanges, type CommitOutcome, type FileScope } from "./commit.ts";
import type { Git, Identity, TreeChange } from "./github.ts";
import { Snapshot } from "./snapshot.ts";

/** A document action's result; on `saved`, the content files it wrote, for the local overlay. */
export type DocOutcome = (CommitOutcome & { kind: Exclude<CommitOutcome["kind"], "saved"> }) | { kind: "saved"; commit: string; files: Map<string, unknown> };

/** A list she can add a document to (50 §50.7): an Other section, or a reference tab. */
export type DocPlace = { kind: "other"; section: string } | { kind: "ref"; tab: string };

export interface DocRequest {
  git: Git;
  author: Identity;
  docId: string;
}

type DocRecord = WordDocFile | AsIsFile;

export const OTHER_PLACES = "content/places/other.json";
export const REF_PLACES = "content/places/reftabs.json";

/** The record of a document at a snapshot: its Word page's doc.json, else its as-is file.json. */
export function docRecordPath(snap: Snapshot, docId: string): string {
  const word = `content/docs/${docId}/doc.json`;
  return snap.has(word) ? word : `content/files/${docId}/file.json`;
}

/** The directory holding a record (`content/docs/<d>/` or `content/files/<d>/`). */
const dirOf = (path: string): string => path.slice(0, path.lastIndexOf("/") + 1);

/** The slide blocks directory of the review deck whose own document is `docId` (the psych deck), if any. */
async function ownDeckBlocks(snap: Snapshot, docId: string): Promise<string | null> {
  const decks = [...snap.files.keys()].filter((p) => /^content\/slides\/[^/]+\/deck\.json$/.test(p)).sort();
  for (const path of decks) {
    if ((await snap.json<DeckFile>(path)).file === docId) return `${dirOf(path)}blocks/`;
  }
  return null;
}

interface DocCommit {
  scope: FileScope;
  changes: TreeChange[];
  subject: string;
  trailers: Trailers;
  /** The content files written, for the overlay. */
  files: Map<string, unknown>;
}

/** Times a document commit is rebuilt on a newer head after another device changed its files. */
const CONFLICT_ROUNDS = 3;

/**
 * Builds a commit from main's head and writes it; when another device changed the commit's files
 * meanwhile, rebuilds it on the new head. `build` returning null means there is nothing to write.
 */
async function commitDoc(git: Git, author: Identity, build: (head: Snapshot) => Promise<DocCommit | null>): Promise<DocOutcome> {
  let last: DocOutcome | null = null;
  for (let round = 0; round < CONFLICT_ROUNDS; round++) {
    const head = await Snapshot.at(git);
    const c = await build(head);
    if (c === null) return { kind: "saved", commit: head.commit, files: new Map() };
    const outcome = await commitChanges({
      git, base: head.commit, baseFiles: head.files, scope: c.scope, changes: c.changes, message: commitMessage(c.subject, c.trailers), author,
    });
    if (outcome.kind === "saved") return { ...outcome, files: c.files };
    last = outcome;
    if (outcome.kind !== "conflict") return outcome;
  }
  return last ?? { kind: "refused" };
}

/** One record rewritten. */
function recordCommit(path: string, next: object, subject: string, trailers: Trailers): DocCommit {
  return { scope: { files: [path], dirs: [] }, changes: [{ path, content: serializeFile(path, next) }], subject, trailers, files: new Map([[path, next]]) };
}

const marker = (docId: string): Trailers => ({ kind: "doc-marker", changed: [docId] });

/** Removes the failed-replacement marker from the document's record. Nothing to remove: saved, no commit. */
export function dismissReplaceFailed(req: DocRequest): Promise<DocOutcome> {
  return commitDoc(req.git, req.author, async (head) => {
    const path = docRecordPath(head, req.docId);
    const record = await head.json<DocRecord>(path);
    if (!record.replaceFailed) return null;
    const next: Record<string, unknown> = { ...record };
    delete next.replaceFailed;
    return recordCommit(path, next, `Dismiss: ${record.name}`, marker(req.docId));
  });
}

/** Marks the document as being replaced by `fileName` (50 §50.7 Replace, §50.9 step 8). */
export function markReplacing(req: DocRequest & { fileName: string; at: string }): Promise<DocOutcome> {
  return commitDoc(req.git, req.author, async (head) => {
    const path = docRecordPath(head, req.docId);
    const record = await head.json<DocRecord>(path);
    const next = { ...record, replacing: { fileName: req.fileName, at: req.at } };
    return recordCommit(path, next, `Replacing: ${record.name}`, marker(req.docId));
  });
}

/** Renames the document; the name is stored trimmed. The same name: saved, no commit. */
export function renameDoc(req: DocRequest & { name: string }): Promise<DocOutcome> {
  const name = req.name.trim();
  return commitDoc(req.git, req.author, async (head) => {
    const path = docRecordPath(head, req.docId);
    const record = await head.json<DocRecord>(path);
    if (record.name === name) return null;
    return recordCommit(path, { ...record, name }, `Rename: ${name}`, { kind: "doc-rename", changed: [req.docId] });
  });
}

/** The places file holding `place`'s list, and that file with `docId` appended to the list. */
function appendTo(place: DocPlace, docId: string, file: OtherFile | RefTabsFile): OtherFile | RefTabsFile {
  if (place.kind === "other") {
    const other = file as OtherFile;
    if (!other.sections.some((s) => s.id === place.section)) throw new Error(`No Other section ${place.section}`);
    return { ...other, sections: other.sections.map((s) => (s.id === place.section && !s.files.includes(docId) ? { ...s, files: [...s.files, docId] } : s)) };
  }
  const tabs = file as RefTabsFile;
  const key = place.tab as keyof Omit<RefTabsFile, "v">;
  const tab = tabs[key] as RefTabsFile["labs"] | undefined;
  if (!tab || typeof tab !== "object") throw new Error(`No reference tab ${place.tab}`);
  return tab.files.includes(docId) ? tabs : { ...tabs, [key]: { ...tab, files: [...tab.files, docId] } };
}

export const placesPath = (place: DocPlace): string => (place.kind === "other" ? OTHER_PLACES : REF_PLACES);

/** The record of an added document while it is processing (20 §20.5); `original` is her file's name. */
export function processingRecord(docId: string, name: string, kind: FileKind, fileName: string): AsIsFile {
  return { v: 1, id: docId, name, kind, original: fileName, view: null, pages: null, text: null, removed: null, state: "processing" };
}

/** The files that show an added document at the end of `place`'s list, from the places file at `head`. */
export async function addedFiles(head: Snapshot, place: DocPlace, record: AsIsFile): Promise<Map<string, unknown>> {
  const places = placesPath(place);
  const next = appendTo(place, record.id, await head.json<OtherFile | RefTabsFile>(places));
  return new Map<string, unknown>([[`content/files/${record.id}/file.json`, record], [places, next]]);
}

/** The added document's `doc-add` commit (50 §50.9 step 8): its processing record, and its id at the end of the list. */
export function addDocRecord(req: { git: Git; author: Identity; place: DocPlace; record: AsIsFile }): Promise<DocOutcome> {
  return commitDoc(req.git, req.author, async (head) => {
    const files = await addedFiles(head, req.place, req.record);
    return {
      scope: { files: [...files.keys()], dirs: [] },
      changes: [...files].map(([path, json]) => ({ path, content: serializeFile(path, json) })),
      subject: `Add: ${req.record.name}`,
      trailers: { kind: "doc-add", changed: [req.record.id] },
      files,
    };
  });
}

/**
 * Removes the document (50 §50.7 Remove): sets `removed` (with the head it was removed from) and
 * deletes its blocks or stored files, and for the psych deck's document its slide blocks. Its ids
 * stay in every list, so Restore puts it back everywhere. Already removed: saved, no commit.
 */
export function removeDoc(req: DocRequest & { at?: string }): Promise<DocOutcome> {
  return commitDoc(req.git, req.author, async (head) => {
    const path = docRecordPath(head, req.docId);
    const record = await head.json<DocRecord>(path);
    if (record.removed) return null;
    const dir = dirOf(path);
    const deck = await ownDeckBlocks(head, req.docId);
    const gone = [...head.under(dir).filter((p) => p !== path), ...(deck ? head.under(deck) : [])];
    const next = { ...record, removed: { at: req.at ?? new Date().toISOString(), from: head.commit } };
    return {
      scope: { files: [path], dirs: [dir, ...(deck ? [deck] : [])] },
      changes: [{ path, content: serializeFile(path, next) }, ...gone.map((p): TreeChange => ({ path: p, sha: null }))],
      subject: `Remove: ${record.name}`,
      trailers: { kind: "doc-remove", changed: [req.docId] },
      files: new Map([[path, next]]),
    };
  });
}

/**
 * Restores a removed document (50 §50.8): every file its directory (and the psych deck's slide blocks)
 * held at `removed.from`, re-added by blob sha, and `removed: null`. Not removed: saved, no commit.
 */
export function restoreDoc(req: DocRequest): Promise<DocOutcome> {
  return commitDoc(req.git, req.author, async (head) => {
    const path = docRecordPath(head, req.docId);
    const record = await head.json<DocRecord>(path);
    if (!record.removed) return null;
    const before = await req.git.files(record.removed.from);
    const dir = dirOf(path);
    const deck = await ownDeckBlocks(head, req.docId);
    const dirs = [dir, ...(deck ? [deck] : [])];
    const back = [...before].filter(([p]) => p !== path && dirs.some((d) => p.startsWith(d))).map(([p, sha]): TreeChange => ({ path: p, sha }));
    const next = { ...record, removed: null };
    return {
      scope: { files: [path], dirs },
      changes: [{ path, content: serializeFile(path, next) }, ...back],
      subject: `Restore: ${record.name}`,
      trailers: { kind: "doc-restore", changed: [req.docId] },
      files: new Map([[path, next]]),
    };
  });
}

/** Bytes the document's stored files take at main's head (subtracted from the site space on Replace). */
export async function storedBytes(git: Git, docId: string): Promise<number> {
  const sizes = await git.sizes(await git.ref());
  let total = 0;
  for (const [path, size] of sizes) if (path.startsWith(`content/docs/${docId}/`) || path.startsWith(`content/files/${docId}/`)) total += size;
  return total;
}
