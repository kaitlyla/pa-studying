// The owner's local overlay (plan 50 §50.5): files she saved, kept in IndexedDB `pa-overlay` until the
// deployed site contains them, and patched into every published data file her device reads so a page
// shows her save at once.
import {
  AS_IS_FILE_RE, BLOCK_FILE_RE, GAP_FILE_RE, WORD_DOC_RE, type AsIsFile, type BlockFile, type GapFile, type OtherFile, type RefTabsFile, type SlideMeta,
  type StructureFile, type SystemFile, type WordDocFile,
} from "../../lib/content/index.ts";
import { addDoc, type DocState } from "../../lib/derive/doclist.ts";
import {
  DOC_PATH_RE, NAV_PATH_RE, SYSTEM_PATH_RE, systemPath, type BuildJson, type DocList, type NavJson, type PubGap, type SystemJson,
} from "../../lib/derive/published.ts";
import { deriveTopics, navEntries, publishedRows, publishedTopics, sectionItems } from "../../lib/derive/topics.ts";
import { DATA_BASE, invalidateData, loadData, NotFoundError, setDataOverlay } from "../data/load.ts";
import type { Git } from "./github.ts";
import { kvStore, type KvStore } from "./idb.ts";

export interface OverlayEntry {
  /** The commit that saved the file. */
  commit: string;
  json: unknown;
}

type Files = ReadonlyMap<string, unknown>;

// ---- patching (pure) ------------------------------------------------------------------------------

interface Index {
  blocks: Map<string, BlockFile>;
  gaps: Map<string, GapFile>;
  docs: Map<string, DocState>;
}

function indexFiles(files: Files): Index {
  const ix: Index = { blocks: new Map(), gaps: new Map(), docs: new Map() };
  for (const [path, json] of files) {
    const block = BLOCK_FILE_RE.exec(path)?.groups?.id;
    if (block) ix.blocks.set(block, json as BlockFile);
    const gap = GAP_FILE_RE.exec(path)?.groups?.id;
    if (gap) ix.gaps.set(gap, json as GapFile);
    const word = WORD_DOC_RE.exec(path)?.groups?.id;
    if (word) {
      const d = json as WordDocFile;
      ix.docs.set(word, { name: d.name, removed: d.removed, kind: "word" });
    }
    const asIs = AS_IS_FILE_RE.exec(path)?.groups?.id;
    if (asIs) {
      const f = json as AsIsFile;
      ix.docs.set(asIs, { name: f.name, removed: f.removed, state: f.state, kind: f.kind });
    }
  }
  return ix;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isDocList(v: Record<string, unknown>): v is Record<string, unknown> & DocList {
  return Array.isArray(v.files) && Array.isArray(v.removed) && Array.isArray(v.pending);
}

/**
 * A DocList with each document the overlay holds moved to the list its saved state calls for, and
 * `append` ids (documents a saved place file added) placed the same way. Published entries the overlay
 * holds nothing for stay exactly as published.
 */
function patchDocList(list: DocList, ix: Index, append: readonly string[] = []): DocList {
  const out: DocList = { files: [], removed: [], pending: [] };
  const seen = new Set<string>();
  const keep = <K extends keyof DocList>(key: K): void => {
    for (const entry of list[key]) {
      seen.add(entry.id);
      const d = ix.docs.get(entry.id);
      if (d) addDoc(out, entry.id, d);
      else (out[key] as DocList[K][number][]).push(entry);
    }
  };
  keep("files");
  keep("pending");
  keep("removed");
  for (const id of append) {
    const d = ix.docs.get(id);
    if (d && !seen.has(id)) addDoc(out, id, d);
  }
  return out;
}

function patchGap(g: PubGap, gap: GapFile): PubGap {
  return { ...g, doc: gap.doc, differs: gap.meta.differs?.doc ?? null, ownerEdits: gap.meta.ownerEdits };
}

/** Walks published JSON, replacing overlaid block docs, gap blocks, slides and document lists. */
function walk(v: unknown, ix: Index): unknown {
  if (Array.isArray(v)) return v.map((x) => walk(x, ix));
  if (!isObj(v)) return v;
  if (isDocList(v)) return { ...v, ...patchDocList(v, ix) };
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = walk(x, ix);
  const id = typeof v.id === "string" ? v.id : null;
  if (id === null) return out;
  const gap = ix.gaps.get(id);
  if (gap && "relevantTo" in v && "written" in v) return patchGap(out as unknown as PubGap, gap);
  const block = ix.blocks.get(id);
  if (block && "doc" in v) {
    out.doc = block.doc;
    if ("ownerEdits" in v) out.ownerEdits = (block as BlockFile<SlideMeta>).meta.ownerEdits ?? [];
  }
  return out;
}

/** Re-derives a system page's rows, topics and sections from its (patched) blocks and structure. */
function rederiveSystem(sys: SystemJson, structure: StructureFile, order: readonly string[] | null, ix: Index): SystemJson {
  const byId = new Map(sys.blocks.map((b) => [b.id, b]));
  const ids = order ?? sys.blocks.map((b) => b.id);
  const blocks = ids.map((id) => {
    const o = ix.blocks.get(id);
    return o ? { id, kind: o.kind, doc: o.doc } : byId.get(id);
  }).filter((b): b is SystemJson["blocks"][number] => b !== undefined);
  const files: BlockFile[] = blocks.map((b) => ({ v: 1, id: b.id, kind: b.kind, doc: b.doc, meta: {} }));
  const t = deriveTopics(files, structure);
  const meds = new Map(sys.topics.map((x) => [x.id, x.meds]));
  const blockIds = blocks.map((b) => b.id);
  return {
    ...sys,
    blocks,
    ...publishedRows(t),
    topics: publishedTopics(t, (x) => meds.get(x.id) ?? []),
    sections: structure.sections.map((sec) => ({ id: sec.id, title: sec.title, items: sectionItems(t, structure, blockIds, sec.id) })),
  };
}

/** A system's patched page and structure, for re-deriving its sidebar entries. */
export interface SystemNavSource {
  sys: SystemJson;
  structure: StructureFile;
}

/** The overlaid systems' sidebar entries, re-derived from their patched pages (a save can add, drop or re-id a topic). */
function patchNav(nav: NavJson, systems: ReadonlyMap<string, SystemNavSource>): NavJson {
  return {
    ...nav,
    systems: nav.systems.map((s) => {
      const src = systems.get(s.id);
      if (!src) return s;
      const files: BlockFile[] = src.sys.blocks.map((b) => ({ v: 1, id: b.id, kind: b.kind, doc: b.doc, meta: {} }));
      return { ...s, ...navEntries(deriveTopics(files, src.structure), src.structure, files.map((b) => b.id)) };
    }),
  };
}

/**
 * One published data file (`path` under dist/data/) with the overlaid content files applied.
 * `structure` supplies a system's structure.json when a table of it is overlaid but the structure is not;
 * `systems` the overlaid systems' patched pages, by system id, for a guide's nav.json.
 */
export function patchPublished(
  path: string, json: unknown, files: Files, structure?: StructureFile | null, systems?: ReadonlyMap<string, SystemNavSource>,
): unknown {
  if (files.size === 0) return json;
  const ix = indexFiles(files);
  let out = walk(json, ix);
  if (systems && systems.size > 0 && NAV_PATH_RE.test(path)) out = patchNav(out as NavJson, systems);

  const sys = SYSTEM_PATH_RE.exec(path)?.groups;
  if (sys) {
    const dir = `content/guides/${sys.guide}/${sys.system}/`;
    const touched = [...files.keys()].some((p) => p.startsWith(dir));
    const st = (files.get(`${dir}structure.json`) as StructureFile | undefined) ?? structure ?? null;
    if (touched && st) out = rederiveSystem(out as SystemJson, st, (files.get(`${dir}system.json`) as SystemFile | undefined)?.blocks ?? null, ix);
  }
  if (path === "other.json") {
    const other = files.get("content/places/other.json") as OtherFile | undefined;
    if (other) {
      const o = out as { sections: { id: string; files: DocList }[] };
      o.sections = o.sections.map((s) => ({ ...s, files: patchDocList(s.files, ix, other.sections.find((x) => x.id === s.id)?.files ?? []) }));
    }
  }
  const ref = /^ref\/([a-z]+)\.json$/.exec(path);
  if (ref) {
    const tabs = files.get("content/places/reftabs.json") as RefTabsFile | undefined;
    const tab = tabs?.[ref[1] as keyof Omit<RefTabsFile, "v">] as RefTabsFile["labs"] | undefined;
    if (tab) {
      const r = out as { files: DocList };
      r.files = patchDocList(r.files, ix, tab.files);
    }
  }
  const docId = DOC_PATH_RE.exec(path)?.groups?.id;
  if (docId) {
    const d = ix.docs.get(docId);
    if (d) out = { ...(out as object), name: d.name };
  }
  return out;
}

// ---- the store and its lifecycle -----------------------------------------------------------------

let store: KvStore<OverlayEntry> = kvStore<OverlayEntry>("pa-overlay");
const entries = new Map<string, OverlayEntry>();
let git: Git | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/** Replaces the IndexedDB store (tests). */
export function setOverlayStoreForTests(s: KvStore<OverlayEntry>): void {
  store = s;
  entries.clear();
}

export function overlayEntries(): ReadonlyMap<string, OverlayEntry> {
  return entries;
}

const filesOf = (): Map<string, unknown> => new Map([...entries].map(([p, e]) => [p, e.json]));

async function structureFor(path: string): Promise<StructureFile | null> {
  const m = SYSTEM_PATH_RE.exec(path)?.groups;
  if (!m || !git) return null;
  const dir = `content/guides/${m.guide}/${m.system}/`;
  if (entries.has(`${dir}structure.json`) || ![...entries.keys()].some((p) => p.startsWith(dir))) return null;
  try {
    const { Snapshot } = await import("./snapshot.ts");
    return await (await Snapshot.at(git)).json<StructureFile>(`${dir}structure.json`);
  } catch {
    return null;
  }
}

/** The patched pages and structures of the guide's systems that have overlaid files. */
async function navSources(guide: string, files: Files): Promise<Map<string, SystemNavSource>> {
  const out = new Map<string, SystemNavSource>();
  const prefix = `content/guides/${guide}/`;
  const ids = new Set([...files.keys()].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length).split("/")).filter((s) => s.length > 1).map((s) => s[0] as string));
  for (const id of ids) {
    const page = systemPath(guide, id);
    const structure = (files.get(`${prefix}${id}/structure.json`) as StructureFile | undefined) ?? (await structureFor(page));
    if (!structure) continue;
    try {
      out.set(id, { sys: await loadData<SystemJson>(page), structure });
    } catch (e) {
      // A directory that is not a published system has no sidebar entries to patch.
      if (!(e instanceof NotFoundError)) throw e;
    }
  }
  return out;
}

async function overlay(path: string, json: unknown): Promise<unknown> {
  if (entries.size === 0) return json;
  const files = filesOf();
  const guide = NAV_PATH_RE.exec(path)?.groups?.guide;
  return patchPublished(path, json, files, await structureFor(path), guide === undefined ? undefined : await navSources(guide, files));
}

/** Drops every entry the deployed site already contains (compare status identical or ahead). */
export async function pruneOverlay(): Promise<void> {
  if (entries.size === 0 || !git) return;
  let build: BuildJson;
  try {
    const res = await fetch(`${DATA_BASE}build.json`, { cache: "no-store" });
    if (!res.ok) return;
    build = (await res.json()) as BuildJson;
  } catch {
    return;
  }
  const commits = new Set([...entries.values()].map((e) => e.commit));
  let dropped = false;
  for (const commit of commits) {
    let status: string;
    try {
      status = await git.compare(commit, build.commit);
    } catch {
      continue;
    }
    if (status !== "identical" && status !== "ahead") continue;
    for (const [path, e] of [...entries]) {
      if (e.commit !== commit) continue;
      entries.delete(path);
      await store.delete(path);
      dropped = true;
    }
  }
  if (dropped) invalidateData();
  schedule();
}

function schedule(): void {
  if (entries.size > 0 && timer === null) timer = setInterval(() => void pruneOverlay(), 60_000);
  if (entries.size === 0 && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** The owner is signed in: load the stored overlay, pass data reads through it, and prune it. */
export async function startOverlay(repoGit: Git): Promise<void> {
  git = repoGit;
  for (const [path, e] of await store.entries()) entries.set(path, e);
  setDataOverlay(overlay);
  await pruneOverlay();
  schedule();
}

/** Visitors never read the overlay. */
export function stopOverlay(): void {
  git = null;
  entries.clear();
  if (timer !== null) clearInterval(timer);
  timer = null;
  setDataOverlay(null);
}

/**
 * After a successful save: the saved files' contents enter the overlay. It is a cache: when IndexedDB
 * refuses the write, this session still shows the save and the failure is only logged. Never rejects.
 */
export async function recordSaved(files: ReadonlyMap<string, unknown>, commit: string): Promise<void> {
  for (const [path, json] of files) entries.set(path, { commit, json });
  // Installing the overlay also drops cached data, so every page reads through it again.
  setDataOverlay(overlay);
  schedule();
  try {
    for (const [path, json] of files) await store.put(path, { commit, json });
  } catch (e) {
    console.warn("Couldn’t keep the saved files on this device", e);
  }
}
