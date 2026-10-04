// Edit units (plan 50 §50.2): what a page key makes editable, read from Git at one commit, and the
// files a save writes (50 §50.4 Save). Pure apart from reading the snapshot and published nav data.
import {
  gapFilePath, serializeFile, spliceRows, systemRowOrder, tableNode, updateStructure,
  type BlockFile, type DeckFile, type DocJSON, type GapFile, type GeneralFile, type GuideFile, type OtherFile,
  type PageSetup, type PharmFile, type RefTabsFile, type SlideMeta, type StructureFile, type SystemFile, type WordDocFile,
} from "../../lib/content/index.ts";
import { stubLabel } from "../../lib/derive/pharm.ts";
import { checkMembers, deriveTopics, sectionItems, withHeadings } from "../../lib/derive/topics.ts";
import type { NavJson, SystemJson } from "../../lib/derive/published.ts";
import { loadData } from "../data/load.ts";
import { GAP_BASE_PT } from "../render/index.ts";
import type { FileScope } from "./commit.ts";
import type { TreeChange } from "./github.ts";
import type { Snapshot } from "./snapshot.ts";

/** Content width for pictures outside a guide or Word page (US Letter with 1-inch margins). */
const DEFAULT_CONTENT_PT = 468;

/** One editor: a doc and the facts its toolbar needs. */
export interface Slot {
  id: string;
  doc: DocJSON;
  basePt: number;
  pageContentPt: number;
}

/** A system's stored files at the snapshot (guide and pharm keys). */
export interface SystemCtx {
  guide: string;
  system: string;
  structurePath: string;
  structure: StructureFile;
  blocks: BlockFile[];
}

export type Part =
  /** Rows of one table block (a topic's, a section's or the whole table), spliced back by row id. */
  | { kind: "rows"; slot: Slot; path: string; block: BlockFile; shown: string[]; sys: SystemCtx }
  /** A whole prose block (or one-column table, or a Word page block). */
  | { kind: "block"; slot: Slot; path: string; block: BlockFile }
  /** A gap block: its doc, and its differs doc when it has one. */
  | { kind: "gap"; path: string; gap: GapFile; doc: Slot; differs: Slot | null }
  | { kind: "slide"; slot: Slot; path: string; block: BlockFile<SlideMeta> }
  /** A drug table on a system page: shown as its stub, edited on its pharm section. */
  | { kind: "stub"; block: string; label: string };

export interface EditUnit {
  key: string;
  snapshot: Snapshot;
  scope: FileScope;
  parts: Part[];
  /** Row and block ids of the page (versions match commits by them, 50 §50.6). */
  ids: string[];
  /** The document of a `doc:` key. */
  docId: string | null;
  /** The topic id of a `topic:` key (its first stored row). */
  topic: string | null;
  /** A Word page: Original is labelled "converted from your Word file". */
  fromWord: boolean;
}

export class UnitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnitError";
  }
}

const contentWidth = (page: PageSetup): number => page.widthPt - page.margins.left - page.margins.right;

/** The JSON of a row node, by its id. */
type RowJSON = { type: string; attrs?: Record<string, unknown>; content?: unknown[] };
const rowId = (r: RowJSON): string => String(r.attrs?.id);

function tableOrThrow(block: BlockFile): RowJSON & { content: RowJSON[] } {
  const t = tableNode(block);
  if (!t) throw new UnitError(`${block.id} is not a table block`);
  return { ...t, content: (t.content ?? []) as RowJSON[] } as RowJSON & { content: RowJSON[] };
}

function partialTable(block: BlockFile, shown: readonly string[]): DocJSON {
  const t = tableOrThrow(block);
  const want = new Set(shown);
  return { type: "doc", content: [{ ...t, content: t.content.filter((r: RowJSON) => want.has(rowId(r))) }] };
}

// ---- loading ------------------------------------------------------------------------------------

async function guideFacts(snap: Snapshot, guide: string): Promise<{ basePt: number; width: number }> {
  const g = await snap.json<GuideFile>(`content/guides/${guide}/guide.json`);
  return { basePt: g.basePt, width: contentWidth(g.page) };
}

async function loadSystem(snap: Snapshot, guide: string, system: string): Promise<SystemCtx> {
  const dir = `content/guides/${guide}/${system}`;
  const file = await snap.json<SystemFile>(`${dir}/system.json`);
  const structurePath = `${dir}/structure.json`;
  const [structure, blocks] = await Promise.all([
    snap.json<StructureFile>(structurePath),
    snap.many<BlockFile>(file.blocks.map((b) => `${dir}/blocks/${b}.json`)),
  ]);
  return { guide, system, structurePath, structure, blocks };
}

const blockPath = (sys: SystemCtx, id: string): string => `content/guides/${sys.guide}/${sys.system}/blocks/${id}.json`;

/** The system whose sidebar lists a topic (first row id) or listed block (published nav.json). */
async function systemOf(guide: string, kind: "topic" | "block", id: string): Promise<string> {
  const nav = await loadData<NavJson>(`g/${guide}/nav.json`);
  for (const s of nav.systems) {
    const entries = [...s.entries, ...s.sections.flatMap((x) => x.entries)];
    if (entries.some((e) => e.kind === kind && e.id === id)) return s.id;
  }
  throw new UnitError(`${id} is not on ${guide}'s pages`);
}

function rowsPart(sys: SystemCtx, block: BlockFile, shown: string[], basePt: number, width: number): Part {
  return {
    kind: "rows", path: blockPath(sys, block.id), block, shown, sys,
    slot: { id: `${block.id}:rows`, doc: partialTable(block, shown), basePt, pageContentPt: width },
  };
}

function blockPart(path: string, block: BlockFile, basePt: number, width: number): Part {
  return { kind: "block", path, block, slot: { id: block.id, doc: block.doc, basePt, pageContentPt: width } };
}

function gapPart(gap: GapFile): Part {
  const slot = (id: string, doc: DocJSON): Slot => ({ id, doc, basePt: GAP_BASE_PT, pageContentPt: DEFAULT_CONTENT_PT });
  return {
    kind: "gap", path: gapFilePath(gap.id), gap, doc: slot(gap.id, gap.doc),
    differs: gap.meta.differs ? slot(`${gap.id}:differs`, gap.meta.differs.doc) : null,
  };
}

async function gapParts(snap: Snapshot, ids: readonly (string | null | undefined)[]): Promise<Part[]> {
  const present = ids.filter((id): id is string => typeof id === "string");
  return (await snap.many<GapFile>(present.map(gapFilePath))).map(gapPart);
}

/** All rows of a table that take part in resolution are its full content; one-column tables edit as blocks. */
function wholeBlockPart(sys: SystemCtx, block: BlockFile, basePt: number, width: number, proseLike: boolean): Part {
  if (block.kind === "table" && !proseLike) return rowsPart(sys, block, tableOrThrow(block).content.map(rowId), basePt, width);
  return blockPart(blockPath(sys, block.id), block, basePt, width);
}

async function pharmFiles(snap: Snapshot): Promise<{ dir: string; file: PharmFile }[]> {
  const paths = [...snap.files.keys()].filter((p) => /^content\/pharm\/[^/]+\/pharmfile\.json$/.test(p)).sort();
  const files = await snap.many<PharmFile>(paths);
  return files.map((file, i) => ({ dir: (paths[i] as string).replace(/\/pharmfile\.json$/, ""), file }));
}

function partIds(parts: readonly Part[]): string[] {
  const ids: string[] = [];
  for (const p of parts) {
    if (p.kind === "rows") ids.push(...p.shown);
    else if (p.kind === "block" || p.kind === "slide") ids.push(p.block.id);
    else if (p.kind === "gap") ids.push(p.gap.id);
  }
  return ids;
}

function guideScope(parts: readonly Part[], extra: readonly string[] = []): FileScope {
  const files = new Set<string>(extra);
  for (const p of parts) {
    if (p.kind === "stub") continue;
    files.add(p.path);
    if (p.kind === "rows") files.add(p.sys.structurePath);
  }
  return { files: [...files].sort(), dirs: [] };
}

/** Read the edit unit of a page key at the snapshot's commit. */
export async function loadUnit(key: string, snap: Snapshot): Promise<EditUnit> {
  const [kind, ...rest] = key.split(":");
  const unit = (parts: Part[], scope = guideScope(parts), topic: string | null = null): EditUnit => ({
    key, snapshot: snap, scope, parts, ids: partIds(parts), docId: null, topic, fromWord: false,
  });
  const arg = (i: number): string => {
    const v = rest[i];
    if (v === undefined || v === "") throw new UnitError(`Malformed page key: ${key}`);
    return v;
  };

  switch (kind) {
    case "topic": {
      const [guide, row] = [arg(0), arg(1)];
      const sys = await loadSystem(snap, guide, await systemOf(guide, "topic", row));
      const { basePt, width } = await guideFacts(snap, guide);
      const t = deriveTopics(sys.blocks, sys.structure);
      const topic = t.topics.find((x) => x.id === row);
      const block = sys.blocks.find((b) => b.id === topic?.block);
      if (!topic || !block) throw new UnitError(`Topic ${row} is no longer in ${sys.system}`);
      const parts = [rowsPart(sys, block, withHeadings(t, topic.rows), basePt, width)];
      return unit(parts, guideScope(parts), row);
    }
    case "section": {
      const [guide, system, section] = [arg(0), arg(1), arg(2)];
      const sys = await loadSystem(snap, guide, system);
      const { basePt, width } = await guideFacts(snap, guide);
      const t = deriveTopics(sys.blocks, sys.structure);
      const byId = new Map(sys.blocks.map((b) => [b.id, b]));
      const parts = sectionItems(t, sys.structure, sys.blocks.map((b) => b.id), section).map((item): Part => {
        const b = byId.get(item.block);
        if (!b) throw new UnitError(`Block ${item.block} is no longer in ${sys.system}`);
        return item.rows === null ? blockPart(blockPath(sys, b.id), b, basePt, width) : rowsPart(sys, b, item.rows, basePt, width);
      });
      return unit(parts);
    }
    case "system": {
      const [guide, system] = [arg(0), arg(1)];
      const sys = await loadSystem(snap, guide, system);
      const { basePt, width } = await guideFacts(snap, guide);
      const t = deriveTopics(sys.blocks, sys.structure);
      const drug = new Map(sys.structure.drugTables.map((d) => [d.block, d]));
      const parts = sys.blocks.map((b): Part => {
        if (drug.has(b.id)) {
          const stored = t.tables.get(b.id);
          return { kind: "stub", block: b.id, label: stored ? stubLabel(stored) : "" };
        }
        return wholeBlockPart(sys, b, basePt, width, t.proseBlocks.includes(b.id));
      });
      return unit(parts);
    }
    case "listed": {
      const [guide, blockId] = [arg(0), arg(1)];
      const sys = await loadSystem(snap, guide, await systemOf(guide, "block", blockId));
      const { basePt, width } = await guideFacts(snap, guide);
      const block = sys.blocks.find((b) => b.id === blockId);
      if (!block) throw new UnitError(`Block ${blockId} is no longer in ${sys.system}`);
      return unit([blockPart(blockPath(sys, block.id), block, basePt, width)]);
    }
    case "pharm": {
      const [guide, system, section] = [arg(0), arg(1), arg(2)];
      const sys = await loadSystem(snap, guide, system);
      const { basePt, width } = await guideFacts(snap, guide);
      const ps = sys.structure.pharmSections.find((s) => s.id === section);
      if (!ps) throw new UnitError(`Pharm section ${section} is no longer in ${system}`);
      const published = await loadData<SystemJson>(`g/${guide}/s/${system}.json`);
      const cards = published.pharm?.sections.find((s) => s.id === section)?.cards ?? [];
      const files = await pharmFiles(snap);
      const parts: Part[] = [];
      const seen = new Set<string>();
      const addPharmPart = async (pred: (p: PharmFile["parts"][number]) => boolean): Promise<void> => {
        for (const { dir, file } of files) {
          for (const part of file.parts.filter(pred)) {
            const fresh = part.blocks.filter((b) => !seen.has(b));
            fresh.forEach((b) => seen.add(b));
            const blocks = await snap.many<BlockFile>(fresh.map((b) => `${dir}/blocks/${b}.json`));
            blocks.forEach((b) => parts.push(blockPart(`${dir}/blocks/${b.id}.json`, b, file.basePt, width)));
          }
        }
      };
      if (ps.overview) await addPharmPart((p) => p.id === ps.overview);
      for (const id of ps.tables) {
        const b = sys.blocks.find((x) => x.id === id);
        if (b) parts.push(rowsPart(sys, b, tableOrThrow(b).content.map(rowId), basePt, width));
      }
      for (const card of cards) await addPharmPart((p) => p.role === "card" && p.card === card);
      if (ps.lo) await addPharmPart((p) => p.id === ps.lo);
      return unit(parts, guideScope(parts, [sys.structurePath]));
    }
    case "general": {
      const [guide, gkey] = [arg(0), arg(1)];
      const general = await snap.json<GeneralFile>(`content/guides/${guide}/general.json`);
      return unit(await gapParts(snap, general.topics.find((t) => t.key === gkey)?.gaps ?? []));
    }
    case "workup": {
      const [guide, item] = [arg(0), arg(1)];
      const general = await snap.json<GeneralFile>(`content/guides/${guide}/general.json`);
      return unit(await gapParts(snap, [general.workup.find((w) => w.id === item)?.gap]));
    }
    case "ref": {
      const [tab, sub] = [arg(0), arg(1)];
      const tabs = await snap.json<RefTabsFile>("content/places/reftabs.json");
      const t = tabs[tab as keyof Omit<RefTabsFile, "v">] as RefTabsFile["labs"] | undefined;
      return unit(await gapParts(snap, t?.subs.find((s) => s.id === sub)?.gaps ?? []));
    }
    case "other": {
      const section = arg(0);
      const other = await snap.json<OtherFile>("content/places/other.json");
      const s = other.sections.find((x) => x.id === section);
      return unit(await gapParts(snap, [s?.lead, ...(s?.gaps ?? [])]));
    }
    case "slide": {
      const [guide, slideId] = [arg(0), arg(1)];
      const path = `content/slides/${guide}/blocks/${slideId}.json`;
      const block = await snap.json<BlockFile<SlideMeta>>(path);
      return unit([{ kind: "slide", path, block, slot: { id: slideId, doc: block.doc, basePt: GAP_BASE_PT, pageContentPt: DEFAULT_CONTENT_PT } }]);
    }
    case "doc": {
      const docId = arg(0);
      const dirs = [`content/docs/${docId}/`, `content/files/${docId}/`];
      const deck = await snap.jsonIfExists<DeckFile>("content/slides/psy/deck.json");
      if (deck?.file === docId) dirs.push("content/slides/psy/");
      const scope = { files: [], dirs };
      const word = await snap.jsonIfExists<WordDocFile>(`content/docs/${docId}/doc.json`);
      const parts: Part[] = [];
      if (word && word.removed === null) {
        const blocks = await snap.many<BlockFile>(word.blocks.map((b) => `content/docs/${docId}/blocks/${b}.json`));
        blocks.forEach((b) => parts.push(blockPart(`content/docs/${docId}/blocks/${b.id}.json`, b, word.basePt, contentWidth(word.page))));
      }
      return { key, snapshot: snap, scope, parts, ids: [docId, ...partIds(parts)], docId, topic: null, fromWord: word !== null };
    }
    default:
      throw new UnitError(`Unknown page key: ${key}`);
  }
}

// ---- saving -------------------------------------------------------------------------------------

export interface SaveBuild {
  /** Files whose bytes change (paths and new text). Unchanged files are left out. */
  changes: TreeChange[];
  /** Parsed new contents by path (for the local overlay, 50 §50.5). */
  files: Map<string, unknown>;
  /** Ids of the rows and blocks whose content changed (the Changed trailer). */
  changed: string[];
  /**
   * A topic page whose topic id (its first stored row) the save deletes: the topic its remaining rows
   * belong to afterwards, or null when none of them is in a topic.
   */
  topicMoved?: { guide: string; system: string; topic: string | null };
}

type RowsPart = Extract<Part, { kind: "rows" }>;

/** Each slot's doc of a unit (a version's content, for a restore). */
function slotDocs(unit: EditUnit): Map<string, DocJSON> {
  const out = new Map<string, DocJSON>();
  for (const p of unit.parts) {
    if (p.kind === "stub") continue;
    if (p.kind === "gap") {
      out.set(p.doc.id, p.doc.doc);
      if (p.differs) out.set(p.differs.id, p.differs.doc);
    } else out.set(p.slot.id, p.slot.doc);
  }
  return out;
}

/**
 * A restore's rows of one table (50 §50.6): the version's page rows replace the current rows with
 * their ids; the page's current rows absent from the version are deleted; a version row that no
 * longer exists is re-inserted after the nearest row preceding it in the version that still exists,
 * or before the nearest following one.
 */
function restoreRows(full: readonly RowJSON[], shown: readonly string[], oldFull: readonly RowJSON[], oldShown: readonly string[]): { rows: RowJSON[]; added: string[]; deleted: string[] } {
  const keep = new Map(oldFull.filter((r) => oldShown.includes(rowId(r))).map((r) => [rowId(r), r]));
  const deleted = shown.filter((id) => !keep.has(id));
  const rows = full.filter((r) => !deleted.includes(rowId(r))).map((r) => keep.get(rowId(r)) ?? r);
  const added: string[] = [];
  const oldIds = oldFull.map(rowId);
  for (const id of oldShown) {
    const row = keep.get(id);
    if (!row || full.some((r) => rowId(r) === id)) continue;
    const ids = rows.map(rowId);
    rows.splice(insertAt(ids, oldIds, id), 0, row);
    added.push(id);
  }
  return { rows, added, deleted };
}

/** Where `id` goes in `list`: after the nearest item preceding it in `oldList` that `list` has, else before the nearest following one, else at the end. */
function insertAt(list: readonly string[], oldList: readonly string[], id: string): number {
  const at = oldList.indexOf(id);
  for (let i = at - 1; i >= 0; i--) {
    const j = list.indexOf(oldList[i] as string);
    if (j !== -1) return j + 1;
  }
  for (let i = at + 1; i < oldList.length; i++) {
    const j = list.indexOf(oldList[i] as string);
    if (j !== -1) return j;
  }
  return list.length;
}

/**
 * A deleted topic's first row hands its `members` entry to the topic's next remaining row below it, and
 * the rows recorded under the deleted id (all above it) are recorded under that row instead, so they stay
 * with the rest of the topic. With no remaining row below, the recorded rows take the entry themselves.
 * Otherwise the rest of the topic would lose its section, or name a target the build can't place.
 * `before` is the structure the deletion applied to and `topics` its derivation.
 */
function handOver(structure: StructureFile, before: StructureFile, topics: ReturnType<typeof deriveTopics>, deleted: readonly string[]): StructureFile {
  let members: Record<string, string> | null = null;
  for (const id of deleted) {
    const topic = topics.topics.find((t) => t.id === id);
    const entry = before.members[id];
    if (!topic || entry === undefined) continue;
    const heir = topic.rows.slice(topic.rows.indexOf(id) + 1).find((r) => !deleted.includes(r));
    const recorded = Object.keys(before.members).filter((k) => before.members[k] === id && !deleted.includes(k));
    if (heir === undefined && recorded.length === 0) continue;
    members ??= { ...structure.members };
    if (heir !== undefined) members[heir] = entry;
    for (const k of recorded) members[k] = heir ?? entry;
  }
  return members === null ? structure : { ...structure, members };
}

/**
 * The build's own checks on each system a save changes (40 §40.1/§40.2): a save never commits a tree
 * the next publish would reject. Throws the build's error.
 */
function checkSystems(systems: Iterable<{ sys: SystemCtx; structure: StructureFile; blocks: BlockFile[] }>): void {
  for (const { sys, structure, blocks } of systems) {
    checkMembers(sys.system, deriveTopics(blocks, structure), structure);
  }
}

/** `structure` with the `members`, `listed` and `conditionRows` entries `ids` had in `old`. */
function withOldEntries(structure: StructureFile, old: StructureFile, ids: readonly string[]): StructureFile {
  if (ids.length === 0) return structure;
  const members = { ...structure.members };
  const listed = { ...structure.listed };
  for (const id of ids) {
    const m = old.members[id];
    if (m !== undefined) members[id] = m;
    const l = old.listed[id];
    if (l !== undefined) listed[id] = l;
  }
  const drugTables = structure.drugTables.map((d) => {
    const before = old.drugTables.find((o) => o.block === d.block)?.conditionRows ?? [];
    const back = ids.filter((id) => before.includes(id) && !d.conditionRows.includes(id));
    return back.length > 0 ? { ...d, conditionRows: [...d.conditionRows, ...back] } : d;
  });
  return { ...structure, members, listed, drugTables };
}

/** Today's local date as ISO `YYYY-MM-DD`. */
export function localDate(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

const canonical = (path: string, value: unknown): string => serializeFile(path, value);

function rowsOf(block: BlockFile): RowJSON[] {
  return tableOrThrow(block).content;
}

/**
 * The files a save writes: each edited doc put back into its file (rows spliced by id, 50 §50.4),
 * structure.json updated for added and deleted rows, gap and slide `ownerEdits` stamped, every file
 * serialized canonically and left out when its bytes are unchanged. `docs` maps slot id → edited doc;
 * a slot missing from it is unchanged. With `restore` (the unit at a chosen version, 50 §50.6) the
 * docs are the version's: rows are restored by id with their old structure.json entries, gaps get the
 * version's doc and differs.
 */
export function buildSave(unit: EditUnit, edits: ReadonlyMap<string, DocJSON>, today = localDate(), restore?: EditUnit): SaveBuild {
  const docs = restore ? slotDocs(restore) : edits;
  const oldRows = (id: string): RowsPart | undefined => restore?.parts.find((p): p is RowsPart => p.kind === "rows" && p.block.id === id);
  let lostTopic: { part: RowsPart; blocks: BlockFile[]; structure: StructureFile } | null = null;
  const original = new Map<string, string>();
  const next = new Map<string, unknown>();
  const changed = new Set<string>();
  const systems = new Map<string, { sys: SystemCtx; structure: StructureFile; blocks: BlockFile[] }>();
  const sysState = (sys: SystemCtx): { sys: SystemCtx; structure: StructureFile; blocks: BlockFile[] } => {
    let s = systems.get(sys.structurePath);
    if (!s) {
      s = { sys, structure: sys.structure, blocks: [...sys.blocks] };
      systems.set(sys.structurePath, s);
    }
    return s;
  };
  const put = (path: string, before: unknown, after: unknown): void => {
    if (!original.has(path)) original.set(path, canonical(path, before));
    next.set(path, after);
  };

  for (const part of unit.parts) {
    if (part.kind === "stub") continue;
    if (part.kind === "rows") {
      const full = rowsOf(part.block);
      const old = restore ? oldRows(part.block.id) : undefined;
      let spliced: { rows: RowJSON[]; added: string[]; deleted: string[] };
      if (restore) {
        spliced = restoreRows(full, part.shown, old ? rowsOf(old.block) : [], old?.shown ?? []);
      } else {
        const doc = docs.get(part.slot.id);
        if (!doc) continue;
        const edited = ((doc.content[0] as RowJSON | undefined)?.content ?? []) as RowJSON[];
        spliced = spliceRows(full, part.shown, edited, rowId);
      }
      const table = tableOrThrow(part.block);
      const block: BlockFile = { ...part.block, doc: { type: "doc", content: [{ ...table, content: spliced.rows }] } };
      const normalized = JSON.parse(canonical(part.path, block)) as BlockFile;
      const before = new Map(full.map((r) => [rowId(r), JSON.stringify(r)]));
      for (const r of rowsOf(normalized)) if (before.get(rowId(r)) !== JSON.stringify(r)) changed.add(rowId(r));
      spliced.deleted.forEach((id) => changed.add(id));
      put(part.path, part.block, normalized);
      const s = sysState(part.sys);
      s.blocks = s.blocks.map((b) => (b.id === block.id ? normalized : b));
      if (spliced.added.length > 0 || spliced.deleted.length > 0) {
        const order = systemRowOrder(s.blocks, s.structure, block.id);
        if (restore) {
          // Restored rows get exactly the entries they had at the version (absent there → absent).
          const cleared = updateStructure(s.structure, { order, deleted: spliced.deleted, table: block.id });
          s.structure = old ? withOldEntries(cleared, old.sys.structure, spliced.added) : cleared;
        } else {
          // A topic page's new rows above its first row stay with that topic (Orchestrator ruling 04:44Z),
          // while that row is still there: with it deleted there is no topic to join.
          const topic = unit.topic !== null && order.includes(unit.topic) ? unit.topic : undefined;
          const before = s.structure;
          s.structure = handOver(updateStructure(s.structure, {
            order, added: spliced.added, deleted: spliced.deleted, table: block.id, ...(topic !== undefined ? { topic } : {}),
          }), before, deriveTopics(part.sys.blocks, before), spliced.deleted);
        }
      }
      if (unit.topic !== null && spliced.deleted.includes(unit.topic)) lostTopic = { part, blocks: s.blocks, structure: s.structure };
      continue;
    }
    if (part.kind === "block") {
      const doc = docs.get(part.slot.id);
      if (!doc) continue;
      const block = JSON.parse(canonical(part.path, { ...part.block, doc })) as BlockFile;
      if (JSON.stringify(block.doc) !== JSON.stringify(part.block.doc)) changed.add(part.block.id);
      put(part.path, part.block, block);
      continue;
    }
    if (part.kind === "gap") {
      const old = restore?.parts.find((p): p is Extract<Part, { kind: "gap" }> => p.kind === "gap" && p.gap.id === part.gap.id);
      const doc = old ? old.gap.doc : (docs.get(part.doc.id) ?? part.gap.doc);
      const differs = old ? (old.gap.meta.differs?.doc ?? null) : part.differs ? (docs.get(part.differs.id) ?? part.differs.doc) : null;
      const plain: GapFile = { ...part.gap, doc, meta: { ...part.gap.meta, differs: differs ? { doc: differs } : null } };
      const edited = canonical(part.path, plain) !== canonical(part.path, part.gap);
      const gap: GapFile = edited ? { ...plain, meta: { ...plain.meta, ownerEdits: [...part.gap.meta.ownerEdits, today] } } : part.gap;
      if (edited) changed.add(part.gap.id);
      put(part.path, part.gap, JSON.parse(canonical(part.path, gap)));
      continue;
    }
    const doc = docs.get(part.slot.id);
    if (!doc) continue;
    const plain = { ...part.block, doc };
    if (canonical(part.path, plain) !== canonical(part.path, part.block)) {
      changed.add(part.block.id);
      put(part.path, part.block, JSON.parse(canonical(part.path, { ...plain, meta: { ...part.block.meta, ownerEdits: [...(part.block.meta.ownerEdits ?? []), today] } })));
    }
  }
  checkSystems(systems.values());
  for (const { sys, structure } of systems.values()) {
    if (structure !== sys.structure) put(sys.structurePath, sys.structure, structure);
  }

  const changes: TreeChange[] = [];
  const files = new Map<string, unknown>();
  for (const [path, value] of next) {
    const text = canonical(path, value);
    if (text === original.get(path)) continue;
    changes.push({ path, content: text });
    files.set(path, value);
  }
  if (unit.docId !== null && changes.length > 0) changed.add(unit.docId);
  const build: SaveBuild = { changes, files, changed: [...changed] };
  if (lostTopic) build.topicMoved = { guide: lostTopic.part.sys.guide, system: lostTopic.part.sys.system, topic: topicAfter(unit, lostTopic) };
  return build;
}

/** The topic that the first remaining row of a topic page's deleted topic belongs to after the save. */
function topicAfter(unit: EditUnit, lost: { part: RowsPart; blocks: BlockFile[]; structure: StructureFile }): string | null {
  const before = deriveTopics(lost.part.sys.blocks, lost.part.sys.structure).topics.find((t) => t.id === unit.topic)?.rows ?? [];
  const after = deriveTopics(lost.blocks, lost.structure).topics;
  for (const row of before) {
    const t = after.find((x) => x.rows.includes(row));
    if (t) return t.id;
  }
  return null;
}
