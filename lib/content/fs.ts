// Node file-system access to a content tree (importer, curation, build, inbox and guideline jobs).
// Paths are repository-relative with `/` separators; `root` is the repository root on disk.
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ContentError } from "./check.ts";
import { GAP_FILE_RE, gapFilePath, parseFile, serializeFile } from "./files.ts";
import { assetName, isId } from "./ids.ts";
import type { BlockFile, GapFile, SystemFile } from "./types.ts";
import { checkTrackSeries } from "./validate.ts";

/**
 * A content tree with writes staged over it: each staged path reads as its text, or as absent when
 * it is null, and the directory listings include and exclude those files accordingly. Nothing staged
 * reaches the disk. Build one with `stagedTree`.
 */
export interface StagedTree {
  readonly root: string;
  readonly staged: ReadonlyMap<string, string | null>;
}

/** A tree to read from: the files under a root on disk, or those files with writes staged over them. */
export type TreeRoot = string | StagedTree;

/** A staged tree over `root`; staged paths are repository-relative, `\` separators taken as `/`. */
export function stagedTree(root: string, staged: Iterable<readonly [string, string | null]>): StagedTree {
  const map = new Map<string, string | null>();
  for (const [path, text] of staged) map.set(path.replaceAll("\\", "/"), text);
  return { root, staged: map };
}

const onDisk = (root: string, path: string): string => join(root, ...path.split("/"));
const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;
const diskRoot = (tree: TreeRoot): string => (typeof tree === "string" ? tree : tree.root);

async function readText(tree: TreeRoot, path: string): Promise<string | null> {
  if (typeof tree !== "string") {
    const text = tree.staged.get(path);
    if (text !== undefined) return text;
  }
  try {
    return await readFile(onDisk(diskRoot(tree), path), "utf8");
  } catch (e) {
    if (errCode(e) === "ENOENT") return null;
    throw e;
  }
}

/** Read and validate one content JSON file. */
export async function readContent<T>(tree: TreeRoot, path: string): Promise<T> {
  const text = await readText(tree, path);
  if (text === null) throw new ContentError(path, "file not found");
  return parseFile<T>(path, text);
}

/** Like readContent, but null when the file does not exist. */
export async function readContentIfExists<T>(tree: TreeRoot, path: string): Promise<T | null> {
  const text = await readText(tree, path);
  return text === null ? null : parseFile<T>(path, text);
}

/**
 * Validate and write one content JSON file in canonical form. A gap block is also checked against
 * every other stored gap block for consistent series tracks (20 §20.9). A file whose bytes would
 * not change is not written. Returns whether the file was written.
 */
export async function writeContent(root: string, path: string, value: unknown): Promise<boolean> {
  const text = serializeFile(path, value);
  const gapId = GAP_FILE_RE.exec(path)?.groups?.id;
  if (gapId !== undefined) {
    const others = (await listGapBlocks(root)).filter((g) => g.id !== gapId);
    checkTrackSeries([...others, JSON.parse(text) as GapFile]);
  }
  if ((await readText(root, path)) === text) return false;
  await mkdir(dirname(onDisk(root, path)), { recursive: true });
  await writeFile(onDisk(root, path), text, "utf8");
  return true;
}

/** Delete a content file or directory (recursive). Missing paths are ignored. */
export async function removeContent(root: string, path: string): Promise<void> {
  await rm(onDisk(root, path), { recursive: true, force: true });
}

async function readDiskDir(root: string, path: string): Promise<string[]> {
  try {
    return await readdir(onDisk(root, path));
  } catch (e) {
    if (errCode(e) === "ENOENT") return [];
    throw e;
  }
}

/**
 * Names of the entries in a content directory; [] when it does not exist. In a staged tree, a
 * deleted file is left out and the files and directories holding staged files are listed.
 */
export async function listDir(tree: TreeRoot, path: string): Promise<string[]> {
  const names = new Set(await readDiskDir(diskRoot(tree), path));
  if (typeof tree !== "string") {
    const prefix = `${path}/`;
    for (const [staged, text] of tree.staged) {
      if (!staged.startsWith(prefix)) continue;
      const rest = staged.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash >= 0) {
        if (text !== null) names.add(rest.slice(0, slash));
      } else if (text === null) names.delete(rest);
      else names.add(rest);
    }
  }
  return [...names].sort();
}

/** Every gap block in `content/gapfill/`. */
export async function listGapBlocks(tree: TreeRoot): Promise<GapFile[]> {
  const paths = (await listDir(tree, "content/gapfill"))
    .map((name) => GAP_FILE_RE.exec(`content/gapfill/${name}`)?.groups?.id)
    .filter((gapId): gapId is string => gapId !== undefined)
    .map(gapFilePath);
  return Promise.all(paths.map((p) => readContent<GapFile>(tree, p)));
}

/**
 * Check that a blocks directory holds exactly the listed block files, each once (20 §20.4).
 */
export async function checkBlockDir(tree: TreeRoot, dir: string, listed: readonly string[]): Promise<void> {
  const present = (await listDir(tree, dir)).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5));
  const want = new Set(listed);
  for (const id of present) if (!want.has(id)) throw new ContentError(`${dir}/${id}.json`, "block file is not listed by its owner");
  const have = new Set(present);
  for (const id of listed) if (!have.has(id)) throw new ContentError(`${dir}/${id}.json`, "listed block file is missing");
}

/** A system's `system.json` and its blocks in order, with the blocks directory checked against the list. */
export async function readSystem(tree: TreeRoot, guide: string, system: string): Promise<{ system: SystemFile; blocks: BlockFile[] }> {
  const base = `content/guides/${guide}/${system}`;
  const sys = await readContent<SystemFile>(tree, `${base}/system.json`);
  await checkBlockDir(tree, `${base}/blocks`, sys.blocks);
  const blocks = await Promise.all(sys.blocks.map((b) => readContent<BlockFile>(tree, `${base}/blocks/${b}.json`)));
  return { system: sys, blocks };
}

/**
 * Store an image under `content/assets/` by its content address; returns the asset path (its file
 * name). An asset that already exists has the same bytes by construction and is left as it is.
 */
export async function writeAsset(root: string, bytes: Uint8Array, ext: string): Promise<string> {
  const name = await assetName(bytes, ext);
  const path = `content/assets/${name}`;
  await mkdir(dirname(onDisk(root, path)), { recursive: true });
  try {
    await writeFile(onDisk(root, path), bytes, { flag: "wx" });
  } catch (e) {
    if (errCode(e) !== "EEXIST") throw e;
  }
  return name;
}

/** The repository path of a stored (as-is) file: `content/files/<d_id>/<name>`. */
function storedFilePath(docId: string, name: string): string {
  const path = `content/files/${docId}/${name}`;
  if (!isId("d", docId)) throw new ContentError(path, "not a document id");
  if (name === "" || name === "." || name === ".." || /[/\\]/.test(name)) throw new ContentError(path, "not a plain file name");
  return path;
}

/** Write a stored (as-is) file under `content/files/<d_id>/`. */
export async function writeStoredFile(root: string, docId: string, name: string, bytes: Uint8Array): Promise<void> {
  const path = storedFilePath(docId, name);
  await mkdir(dirname(onDisk(root, path)), { recursive: true });
  await writeFile(onDisk(root, path), bytes);
}

/** Read a stored (as-is) file under `content/files/<d_id>/`. */
export async function readStoredFile(root: string, docId: string, name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(onDisk(root, storedFilePath(docId, name))));
}
