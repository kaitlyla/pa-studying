// Staged curation writes (plan 90 §90.1): every change is validated through lib/content, staged
// over the tree, read back by the build's own loader and checked with its 40 §40.1 invariants
// (lib/derive publish) before anything reaches the disk.
import { serializeFile } from "../../lib/content/index.ts";
import { removeContent, stagedTree, writeContent } from "../../lib/content/fs.ts";
import type { Content } from "../../lib/derive/model.ts";
import { publish } from "../../lib/derive/publish.ts";
import { loadContent } from "../build/load.ts";

/** One file to write (`value`) or delete (`null`), by repository path. */
export interface Change {
  path: string;
  value: unknown;
}

export class CurateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CurateError";
  }
}

/** Load the content tree a command works on. */
export function load(root: string): Promise<Content> {
  return loadContent(root);
}

/**
 * Validate every change for its path and return its canonical text (null for a deletion). A file
 * is listed at most once.
 */
function normalize(changes: readonly Change[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const ch of changes) {
    if (out.has(ch.path)) throw new CurateError(`${ch.path}: written twice in one command`);
    out.set(ch.path, ch.value === null ? null : serializeFile(ch.path, ch.value));
  }
  return out;
}

/** Order on disk: new and changed files first, then owner lists, then deletions. */
function writeOrder(a: [string, string | null], b: [string, string | null]): number {
  const rank = ([path, v]: [string, string | null]): number => (v === null ? 2 : /\/blocks\//.test(path) ? 0 : 1);
  return rank(a) - rank(b);
}

/**
 * Validate the changes, load the tree with them staged over it and check it with the build's
 * invariants, then write them. Returns the paths written or deleted. Nothing is written when any
 * check fails.
 */
export async function commitChanges(root: string, changes: readonly Change[]): Promise<string[]> {
  const staged = normalize(changes);
  publish(await loadContent(stagedTree(root, staged)));
  const done: string[] = [];
  for (const [path, text] of [...staged].sort(writeOrder)) {
    if (text === null) await removeContent(root, path);
    else await writeContent(root, path, JSON.parse(text));
    done.push(path);
  }
  return done;
}
