// Pictures she adds while editing. Each is stored content-addressed (`content/assets/<name>`, the same
// name the importer gives a picture), kept on this device from the moment she picks it, committed by
// the save that first uses it, and dropped from the device once the deployed site serves it.
import { assetName, ASSET_EXTS } from "../../lib/content/index.ts";
import { assetsOf } from "../../lib/derive/text.ts";
import type { DocJSON } from "../../lib/content/index.ts";
import { DATA_BASE } from "../data/load.ts";
import { setLocalAssets, type LocalAsset } from "../render/index.ts";
import type { NewPicture } from "./editor/commands.ts";
import type { Git, TreeChange } from "./github.ts";
import { kvStore, type KvStore } from "./idb.ts";

/** The file picker's accept list for Add picture. */
export const PICTURE_ACCEPT = ASSET_EXTS.join(",");
/** The largest picture she can add (GitHub takes a file this size in one piece). */
export const MAX_PICTURE_BYTES = 20 * 1024 * 1024;

export const PICTURE_TYPE_REFUSED = "That picture can’t be added. Use a PNG, JPG or GIF picture.";
export const PICTURE_TOO_BIG = "That picture is too big to add (the limit is 20 MB).";
export const PICTURE_UNREADABLE = "That picture couldn’t be opened. Try saving it again as a PNG or JPG.";

/** The repository path of a stored picture. */
export const assetPath = (name: string): string => `content/assets/${name}`;

let store: KvStore<Blob> = kvStore<Blob>("pa-pictures");
const local = new Map<string, LocalAsset>();

/** Replaces the IndexedDB store (tests). */
export function setPictureStoreForTests(s: KvStore<Blob>): void {
  store = s;
  clearLocal();
}

function clearLocal(): void {
  for (const a of local.values()) URL.revokeObjectURL(a.url);
  local.clear();
}

function keep(name: string, blob: Blob): void {
  if (!local.has(name)) local.set(name, { blob, url: URL.createObjectURL(blob) });
}

/** The pixel size of a picture file (a seam: tests have no image decoder). */
export const pictureSize = {
  async of(blob: Blob): Promise<{ width: number; height: number }> {
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  },
};

/** "Add picture": checks the file and keeps it on this device. Resolves to the picture, or her message. */
export async function addPictureFile(file: File): Promise<NewPicture | string> {
  const ext = /\.[^.]+$/.exec(file.name)?.[0]?.toLowerCase() ?? "";
  if (!(ASSET_EXTS as readonly string[]).includes(ext)) return PICTURE_TYPE_REFUSED;
  if (file.size > MAX_PICTURE_BYTES) return PICTURE_TOO_BIG;
  let size: { width: number; height: number };
  try {
    size = await pictureSize.of(file);
  } catch {
    return PICTURE_UNREADABLE;
  }
  const name = await assetName(new Uint8Array(await file.arrayBuffer()), ext);
  keep(name, file);
  try {
    await store.put(name, file);
  } catch (e) {
    // Only this tab shows it until saved; the save still has the bytes.
    console.warn("Couldn’t keep the picture on this device", e);
  }
  return { asset: name, widthPx: size.width, heightPx: size.height };
}

/**
 * The tree entries a save adds for the pictures she added: those its docs use that the page did not
 * have when opened (`opened`) and main does not have yet — each picture's bytes as a new blob under
 * `content/assets/`. Throws when an added picture's bytes are not on this device (the save then fails
 * and nothing is written).
 */
export async function pictureChanges(
  git: Git,
  docs: Iterable<DocJSON>,
  opened: Iterable<DocJSON>,
  mainFiles: ReadonlyMap<string, string>,
): Promise<TreeChange[]> {
  const used = new Set<string>();
  for (const d of docs) assetsOf(d, used);
  const had = new Set<string>();
  for (const d of opened) assetsOf(d, had);
  const out: TreeChange[] = [];
  for (const name of [...used].sort()) {
    const path = assetPath(name);
    if (had.has(name) || mainFiles.has(path)) continue;
    const a = local.get(name) ?? (await fromStore(name));
    if (!a) throw new Error(`The picture ${name} is not on this device`);
    out.push({ path, sha: await git.createBlob(base64(new Uint8Array(await a.blob.arrayBuffer())), "base64") });
  }
  return out;
}

async function fromStore(name: string): Promise<LocalAsset | null> {
  const blob = await store.get(name);
  if (!blob) return null;
  keep(name, blob);
  return local.get(name) ?? null;
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Whether the deployed site serves the picture (a missing file can come back as the HTML app page). */
async function deployed(name: string): Promise<boolean> {
  try {
    const res = await fetch(`${DATA_BASE}assets/${name}`, { method: "HEAD", cache: "no-store" });
    return res.ok && (res.headers.get("content-type") ?? "").startsWith("image/");
  } catch {
    return false;
  }
}

/** The owner is signed in: show her kept pictures, and forget those the deployed site now serves. */
export async function startLocalPictures(): Promise<void> {
  try {
    for (const [name, blob] of await store.entries()) keep(name, blob);
  } catch (e) {
    console.warn("Couldn’t read the pictures kept on this device", e);
  }
  setLocalAssets((name) => local.get(name) ?? null);
  for (const name of [...local.keys()]) {
    if (!(await deployed(name))) continue;
    try {
      await store.delete(name);
    } catch {
      continue;
    }
  }
}

/** Visitors never see this device's pictures. */
export function stopLocalPictures(): void {
  setLocalAssets(null);
  clearLocal();
}
