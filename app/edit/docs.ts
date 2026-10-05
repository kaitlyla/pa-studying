// The owner's document actions (plan 50 §50.7), written as commits on `main` through the 50 §50.4
// protocol. Dismissing a failed replacement's note is an owner edit of the document's record
// (Orchestrator ruling 2026-10-04 20:39Z, amending 50 §50.9 step 4).
import { commitMessage, serializeFile, type AsIsFile, type WordDocFile } from "../../lib/content/index.ts";
import { commitChanges, type CommitOutcome } from "./commit.ts";
import { deviceId } from "./format.ts";
import type { Git, Identity } from "./github.ts";
import { buildPageKey } from "./pageKey.ts";
import { Snapshot } from "./snapshot.ts";

/** A document action's result; on `saved`, the content files it wrote, for the local overlay. */
export type DocOutcome = (CommitOutcome & { kind: Exclude<CommitOutcome["kind"], "saved"> }) | { kind: "saved"; commit: string; files: Map<string, unknown> };

/** The record of a document at a snapshot: its Word page's doc.json, else its as-is file.json. */
export function docRecordPath(snap: Snapshot, docId: string): string {
  const word = `content/docs/${docId}/doc.json`;
  return snap.has(word) ? word : `content/files/${docId}/file.json`;
}

/** Removes the failed-replacement marker from the document's record. Nothing to remove: saved, no commit. */
export async function dismissReplaceFailed(req: { git: Git; author: Identity; docId: string }): Promise<DocOutcome> {
  const head = await Snapshot.at(req.git);
  const path = docRecordPath(head, req.docId);
  const record = await head.json<WordDocFile | AsIsFile>(path);
  if (!record.replaceFailed) return { kind: "saved", commit: head.commit, files: new Map() };
  const next: Record<string, unknown> = { ...record };
  delete next.replaceFailed;
  const outcome = await commitChanges({
    git: req.git,
    base: head.commit,
    baseFiles: head.files,
    scope: { files: [path], dirs: [] },
    changes: [{ path, content: serializeFile(path, next) }],
    message: commitMessage(`Dismiss: ${record.name}`, { kind: "edit", page: buildPageKey("doc", req.docId), changed: [req.docId], device: deviceId() }),
    author: req.author,
  });
  return outcome.kind === "saved" ? { ...outcome, files: new Map([[path, next]]) } : outcome;
}
