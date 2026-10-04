// The commit protocol of plan 50 §50.4: write a page's changed files as one commit on `main`, never
// over a change another device made to the same file set since `base`.
import { NetworkError, type Git, type Identity, type TreeChange } from "./github.ts";

/** The files whose changes conflict with a save (50 §50.2 file set): whole files, and directories (prefix ending in `/`). */
export interface FileScope {
  files: readonly string[];
  dirs: readonly string[];
}

export type CommitOutcome =
  | { kind: "saved"; commit: string }
  /** Another device changed the file set; `at` is that save's author date (ISO). Nothing was written. */
  | { kind: "conflict"; at: string; path: string }
  /** Network failure, GitHub kept failing, or the ref update failed without a race: the offline banner. */
  | { kind: "failed" };

export interface CommitRequest {
  git: Git;
  /** The commit the editors started from. */
  base: string;
  /** Every blob path → sha at `base` (from `Git.files(base)`). */
  baseFiles: ReadonlyMap<string, string>;
  scope: FileScope;
  changes: readonly TreeChange[];
  message: string;
  author: Identity;
}

const MAX_ROUNDS = 3;

/** Paths of the scope in a tree listing. */
function scoped(files: ReadonlyMap<string, string>, scope: FileScope): Map<string, string> {
  const out = new Map<string, string>();
  const want = new Set(scope.files);
  for (const [path, sha] of files) {
    if (want.has(path) || scope.dirs.some((d) => path.startsWith(d))) out.set(path, sha);
  }
  return out;
}

/** The first path of the scope whose blob differs between the two listings (added, changed or deleted), or null. */
export function firstChanged(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>, scope: FileScope): string | null {
  const a = scoped(before, scope);
  const b = scoped(after, scope);
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  return paths.find((p) => a.get(p) !== b.get(p)) ?? null;
}

/**
 * Run the protocol: re-read `main`; if it moved, a change in the file set since `base` is a conflict;
 * otherwise blobs, a tree on head's tree, a commit with parent head, and a fast-forward PATCH. A
 * PATCH that fails is classified by re-reading the ref: unchanged → failed; moved → another round
 * against the new head (at most 3). SignedOutError propagates (the save waits for sign-in).
 */
export async function commitChanges(req: CommitRequest): Promise<CommitOutcome> {
  const { git } = req;
  const blobs = new Map<string, string>();
  try {
    let head = await git.ref();
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (head !== req.base) {
        const path = firstChanged(req.baseFiles, await git.files(head), req.scope);
        if (path !== null) {
          const [latest] = await git.commits(path, { perPage: 1 });
          return { kind: "conflict", at: latest?.date ?? new Date().toISOString(), path };
        }
      }
      const entries: TreeChange[] = [];
      for (const c of req.changes) {
        if (!("content" in c)) {
          entries.push(c);
          continue;
        }
        const key = `${c.path}\n${c.content}`;
        let sha = blobs.get(key);
        if (sha === undefined) {
          sha = await git.createBlob(c.content);
          blobs.set(key, sha);
        }
        entries.push({ path: c.path, sha });
      }
      const tree = await git.createTree(entries, await git.treeOf(head));
      const commit = await git.createCommit(req.message, tree, [head], req.author);
      if ((await git.moveRef(commit)) === 200) return { kind: "saved", commit };
      const now = await git.ref();
      // The PATCH was applied but its answer was lost or an error: the save is on main.
      if (now === commit) return { kind: "saved", commit };
      if (now === head) return { kind: "failed" };
      head = now;
    }
    return { kind: "failed" };
  } catch (e) {
    if (e instanceof NetworkError) return { kind: "failed" };
    throw e;
  }
}
