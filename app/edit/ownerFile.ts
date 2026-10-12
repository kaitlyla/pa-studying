// The owner's own per-guide content files (favorites.json, comparisons.json; 20 §20.7): one read per
// session per file, and every change re-reads the file first, so a save that raced another device's
// merges into what is there instead of losing it (50 §50.4).
import { useEffect, useRef, useSyncExternalStore } from "react";
import { commitMessage, serializeFile, type CommitKind } from "../../lib/content/index.ts";
import { commitChanges } from "./commit.ts";
import { repo } from "./session.ts";
import { Snapshot } from "./snapshot.ts";

export interface FileState<T> {
  state: "idle" | "loading" | "ready" | "error";
  value: T;
}

const states = new Map<string, FileState<unknown>>();
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The file's state, made once per key so a render's snapshot is stable. */
function stateOf<T>(key: string, none: T): FileState<T> {
  const now = states.get(key) as FileState<T> | undefined;
  if (now) return now;
  const fresh: FileState<T> = { state: "idle", value: none };
  states.set(key, fresh as FileState<unknown>);
  return fresh;
}

function set<T>(key: string, next: FileState<T>): void {
  states.set(key, next as FileState<unknown>);
  for (const l of listeners) l();
}

/** The file's value as last read (its `none` before then). */
export function ownerFileValue<T>(key: string, none: T): T {
  return (states.get(key) as FileState<T> | undefined)?.value ?? none;
}

/** Records a value the app already has (after a save), so every menu showing it follows. */
export function setOwnerFileValue<T>(key: string, value: T): void {
  set(key, { state: "ready", value });
}

/** Clears the session's cache (tests). */
export function resetOwnerFiles(): void {
  states.clear();
  for (const l of listeners) l();
}

/**
 * The file at `key`, read once per session through Git. `enabled` false leaves it untouched (a visitor
 * has no Git read); it reads when the owner signs in.
 */
export function useOwnerFile<T>(key: string, none: T, enabled: boolean, load: (snapshot: Snapshot) => Promise<T>): FileState<T> {
  const state = useSyncExternalStore(subscribe, () => stateOf(key, none), () => stateOf(key, none));
  // The read is once per key, so its inputs come from a ref: a fresh `load` or `none` in the deps would
  // re-run it (and re-try a failed read) on every render, and a caller writes both inline.
  const read = useRef({ load, none });
  useEffect(() => {
    read.current = { load, none };
  });
  useEffect(() => {
    if (!enabled) return;
    const { load, none } = read.current;
    const now = stateOf(key, none);
    if (now.state === "loading" || now.state === "ready") return;
    set(key, { state: "loading", value: now.value });
    void (async () => {
      try {
        const { git } = await repo();
        const snapshot = await Snapshot.at(git);
        set(key, { state: "ready", value: await load(snapshot) });
      } catch (e) {
        console.warn("Couldn’t read your saved file", e);
        set(key, { state: "error", value: none });
      }
    })();
  }, [key, enabled]);
  return state;
}

export interface WriteOutcome<F> {
  kind: "saved" | "unchanged" | "failed";
  /** The file as committed, or as read when there was nothing to change; null when the save failed. */
  file: F | null;
}

/**
 * Writes `change`'s result to the file at `path` as one commit (`subject`, `kind`). A `null` result
 * means there is nothing to change. A commit another device made meanwhile is retried once against a
 * fresh read, so a change applies to what is there rather than overwriting it.
 */
export async function writeOwnerFile<F>(path: string, kind: CommitKind, subject: string, change: (file: F | null) => F | null): Promise<WriteOutcome<F>> {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { git, site } = await repo();
      const snapshot = await Snapshot.at(git);
      const current = (await snapshot.jsonIfExists<F>(path)) ?? null;
      const next = change(current);
      if (next === null) return { kind: "unchanged", file: current };
      const outcome = await commitChanges({
        git,
        base: snapshot.commit,
        baseFiles: snapshot.files,
        scope: { files: [path], dirs: [] },
        changes: [{ path, content: serializeFile(path, next) }],
        message: commitMessage(subject, { kind }),
        author: { name: site.owner.commitName, email: site.owner.commitEmail },
      });
      if (outcome.kind === "saved") return { kind: "saved", file: next };
      if (outcome.kind !== "conflict") {
        console.warn("Couldn’t save your change", outcome.kind);
        return { kind: "failed", file: null };
      }
    }
    return { kind: "failed", file: null };
  } catch (e) {
    console.warn("Couldn’t save your change", e);
    return { kind: "failed", file: null };
  }
}
