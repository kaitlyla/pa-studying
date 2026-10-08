// Edit units (plan 50 §50.2): what a page key makes editable, read from Git at one commit, and the
// files a save writes (50 §50.4 Save). Pure apart from reading the snapshot and published nav data.
import {
  GAP_CONTENT_HEIGHT_PT, GAP_CONTENT_PT, gapFilePath, isId, listedHead, newId, serializeFile, systemRowOrder, tableNode, topicBelowPath, topicMedsPath, updateStructure, WORD_DOC_RE,
  type BlockFile, type CardsFile, type DeckFile, type DocJSON, type GapFile, type GapMeta, type GeneralFile, type GuideFile, type MedsFile, type MedsPiece, type OtherFile,
  type OtherNote, type PageSetup, type PharmFile, type PlaceNote, type RefTabsFile, type SlideMeta, type StructureFile, type SystemFile, type WordDocFile,
} from "../../lib/content/index.ts";
import { entryPieces, fileAdds, pageCard } from "../../lib/derive/panel.ts";
import { cardGroup, stubLabel } from "../../lib/derive/pharm.ts";
import { schema } from "../../lib/schema.ts";
import { checkMembers, deriveTopics, fitTopicRows, sectionItems, topicsBelow, withHeadings, type SystemTopics } from "../../lib/derive/topics.ts";
import { navPath, systemPath } from "../../lib/derive/published.ts";
import type { NavJson, PubMedsCard, SystemJson } from "../../lib/derive/published.ts";
import { loadData } from "../data/load.ts";
import { GAP_BASE_PT } from "../render/index.ts";
import type { FileScope } from "./commit.ts";
import type { ContentArea } from "./editor/commands.ts";
import type { TreeChange } from "./github.ts";
import { followMergedWidths, partialRows, spliceShown, type RowJSON as LayoutRow, type RowsLayout } from "./editor/rowLayout.ts";
import { parsePageKey, type PageKind } from "./pageKey.ts";
import type { Snapshot } from "./snapshot.ts";

/** The page area for pictures outside a guide or Word page (US Letter with 1-inch margins). */
const DEFAULT_AREA: ContentArea = { pageContentPt: GAP_CONTENT_PT, pageContentHeightPt: GAP_CONTENT_HEIGHT_PT };

/** The doc of a topic's below area before she adds anything: one empty paragraph, with its stored attributes. */
const EMPTY_DOC = schema.node("doc", null, [schema.node("paragraph")]).toJSON() as DocJSON;

/** A doc with nothing in it: only paragraphs, all empty. */
export function isBlankDoc(doc: DocJSON): boolean {
  return doc.content.every((n) => (n as { type: string }).type === "paragraph" && ((n as { content?: unknown[] }).content ?? []).length === 0);
}

/** One editor: a doc and the facts its toolbar needs. */
export interface Slot extends ContentArea {
  id: string;
  doc: DocJSON;
  basePt: number;
  /** A table block's rows editor: the table's layout facts (a dx's own column changes). */
  rows?: RowsLayout;
}

/** A system's stored files at the snapshot (guide and pharm keys). */
export interface SystemCtx {
  guide: string;
  system: string;
  structurePath: string;
  structure: StructureFile;
  blocks: BlockFile[];
}

/** The file whose block list holds a block: a system's `system.json`, a `pharmfile.json` part, or a Word page's `doc.json`. */
export type BlockOwner =
  | { kind: "system"; sys: SystemCtx }
  | { kind: "pharm"; path: string; part: string }
  | { kind: "doc"; path: string };

export type Part =
  /** Rows of one table block (a topic's, a section's or the whole table), spliced back by row id. */
  | { kind: "rows"; slot: Slot; path: string; block: BlockFile; shown: string[]; sys: SystemCtx }
  /** A whole prose block (or one-column table, or a Word page block). `owner`: the file whose list holds it. */
  | { kind: "block"; slot: Slot; path: string; block: BlockFile; owner: BlockOwner }
  /**
   * A gap block: its doc, and its differs doc when it has one. `meds`: the topic whose meds panel it is
   * a sourced card of (MedsFile `gaps`); it shows inside that panel, not on its own.
   */
  | { kind: "gap"; path: string; gap: GapFile; doc: Slot; differs: Slot | null; meds?: string }
  | { kind: "slide"; slot: Slot; path: string; block: BlockFile<SlideMeta> }
  /** A drug table on a system page: shown as its stub, edited on its pharm section. */
  | { kind: "stub"; block: string; label: string }
  /** A topic's below block (`path`): null `block` while she has added none; the slot then holds an empty doc. */
  | { kind: "below"; slot: Slot; path: string; block: BlockFile | null; topic: string; sys: SystemCtx }
  /**
   * A topic's meds panel: her own panel for it (`path`, null `file` while she has none), each entry it
   * shows or could show, and the cards she can add.
   */
  | MedsPart;

/** One editor of a meds panel entry: its slot and the piece it edits (labels, size, seed doc). */
export interface MedsSlot extends Slot {
  piece: MedsPiece;
}

/** An entry of a topic's meds panel in the editor. */
export interface MedsEntry {
  med: PubMedsCard;
  /** Worked out from her notes (`topic.meds`), not a card she added. */
  derived: boolean;
  /** The entry as its card shows it here: editing these makes her own version. */
  card: MedsSlot[];
  /** Her own version as stored, or null. */
  own: MedsSlot[] | null;
}

export interface MedsPart {
  kind: "meds";
  path: string;
  file: MedsFile | null;
  topic: string;
  sys: SystemCtx;
  entries: MedsEntry[];
  /** Cards she can add, by title. */
  catalog: { id: string; title: string }[];
}

/**
 * Her choices for a meds panel in the open edit: the cards she added and the entries she took off (in
 * the MedsFile's order), the entries whose own version she dropped ("Use the original"), and the boxes
 * she cut from the cards shown (slot ids; absent when none).
 */
export interface MedsChoice {
  add: string[];
  remove: string[];
  original: string[];
  cut?: string[];
}

/** The entries of `part` worked out from her notes. */
const derivedTargets = (part: Pick<MedsPart, "entries">): Set<string> => new Set(part.entries.filter((e) => e.derived).map((e) => e.med.target));

/** The choices a panel's stored file stands for (none dropped): its adds as the reader reads them (fileAdds). */
export const fileChoice = (part: Pick<MedsPart, "file" | "entries">): MedsChoice => ({
  add: part.file ? fileAdds(part.file, derivedTargets(part)) : [],
  remove: [...(part.file?.remove ?? [])],
  original: [],
});

export const sameChoice = (a: MedsChoice, b: MedsChoice): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Entries the panel shows under `choice`: the worked-out ones less those taken off, then the added cards the page has, in her order. */
export function shownEntries(part: MedsPart, choice: MedsChoice): MedsEntry[] {
  const kept = part.entries.filter((e) => e.derived && !choice.remove.includes(e.med.target));
  const added = choice.add.flatMap((id) => part.entries.filter((e) => !e.derived && e.med.target === id));
  return [...kept, ...added];
}

/** Whether `entry` shows her own version under `choice`. */
export const showsOwn = (entry: MedsEntry, choice: MedsChoice): boolean => entry.own !== null && !choice.original.includes(entry.med.target);

/** The boxes of the version `entry` shows under `choice` (her own or the card), those she cut included. */
const allBoxes = (entry: MedsEntry, choice: MedsChoice): MedsSlot[] => (showsOwn(entry, choice) ? (entry.own ?? []) : entry.card);

/** The editors `entry` shows under `choice`: its own version's or its card's, less the boxes she cut. */
export const entrySlots = (entry: MedsEntry, choice: MedsChoice): MedsSlot[] => allBoxes(entry, choice).filter((s) => !choice.cut?.includes(s.id));

/** The editors a meds panel shows under `choice`. */
export const shownMedsSlots = (part: MedsPart, choice: MedsChoice): MedsSlot[] => shownEntries(part, choice).flatMap((e) => entrySlots(e, choice));

/** `choice` with every box of entry `target` back (card and own version), so it shows whole again. */
export function uncut(part: MedsPart, choice: MedsChoice, target: string): MedsChoice {
  const entry = part.entries.find((e) => e.med.target === target);
  const ids = new Set([...(entry?.card ?? []), ...(entry?.own ?? [])].map((s) => s.id));
  const cut = (choice.cut ?? []).filter((id) => !ids.has(id));
  const out: MedsChoice = { ...choice, cut };
  if (cut.length === 0) delete out.cut;
  return out;
}

/**
 * `choice` with entry `target` off the panel ("Remove from this condition"): a worked-out one or a
 * sourced card (gap id) is removed, an added card no longer added.
 */
export function takeOff(part: MedsPart, choice: MedsChoice, target: string): MedsChoice {
  const c = uncut(part, choice, target);
  if (isId("g", target) || part.entries.some((e) => e.derived && e.med.target === target)) return { ...c, remove: [...c.remove, target] };
  return { ...c, add: c.add.filter((x) => x !== target) };
}

/** `choice` with card box `slot` cut from the entry showing it. Cutting the entry's last box takes the entry off (takeOff). */
export function cutBox(part: MedsPart, choice: MedsChoice, slot: string): MedsChoice {
  const entry = shownEntries(part, choice).find((e) => entrySlots(e, choice).some((s) => s.id === slot));
  if (!entry) return choice;
  if (entrySlots(entry, choice).length === 1) return takeOff(part, choice, entry.med.target);
  return { ...choice, cut: [...(choice.cut ?? []), slot] };
}

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
  /** Converted from her Word files (guide, pharm and Word pages): Original is labelled "converted from your Word file". */
  fromWord: boolean;
}

export class UnitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnitError";
  }
}

const contentArea = (page: PageSetup): ContentArea => ({
  pageContentPt: page.widthPt - page.margins.left - page.margins.right,
  pageContentHeightPt: page.heightPt - page.margins.top - page.margins.bottom,
});

/** The JSON of a row node, by its id. */
type RowJSON = { type: string; attrs?: Record<string, unknown>; content?: unknown[] };
const rowId = (r: RowJSON): string => String(r.attrs?.id);

function tableOrThrow(block: BlockFile): RowJSON & { content: RowJSON[] } {
  const t = tableNode(block);
  if (!t) throw new UnitError(`${block.id} is not a table block`);
  return { ...t, content: (t.content ?? []) as RowJSON[] } as RowJSON & { content: RowJSON[] };
}

/** The table a rows editor holds: its `shown` rows, with the cells the page draws in them (partialRows). */
function partialTable(block: BlockFile, shown: readonly string[]): DocJSON {
  const t = tableOrThrow(block);
  return { type: "doc", content: [{ ...t, content: partialRows(t.content as LayoutRow[], shown) }] };
}

// ---- loading ------------------------------------------------------------------------------------

async function guideFacts(snap: Snapshot, guide: string): Promise<{ basePt: number; area: ContentArea }> {
  const g = await snap.json<GuideFile>(`content/guides/${guide}/guide.json`);
  return { basePt: g.basePt, area: contentArea(g.page) };
}

/** A block file in a directory that keeps its blocks under `blocks/` (a system, a pharm file, a Word page). */
const blockFileIn = (dir: string, id: string): string => `${dir}/blocks/${id}.json`;
const systemDir = (guide: string, system: string): string => `content/guides/${guide}/${system}`;
/** The directory of a file path. */
const dirOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));

async function loadSystem(snap: Snapshot, guide: string, system: string): Promise<SystemCtx> {
  const dir = systemDir(guide, system);
  const file = await snap.json<SystemFile>(`${dir}/system.json`);
  const structurePath = `${dir}/structure.json`;
  const [structure, blocks] = await Promise.all([
    snap.json<StructureFile>(structurePath),
    snap.many<BlockFile>(file.blocks.map((b) => blockFileIn(dir, b))),
  ]);
  return { guide, system, structurePath, structure, blocks };
}

const blockPath = (sys: SystemCtx, id: string): string => blockFileIn(systemDir(sys.guide, sys.system), id);
const systemFilePath = (sys: SystemCtx): string => `${systemDir(sys.guide, sys.system)}/system.json`;
const ownerPath = (owner: BlockOwner): string => (owner.kind === "system" ? systemFilePath(owner.sys) : owner.path);

/** The system whose sidebar lists a topic (first row id) or listed block (published nav.json). */
async function systemOf(guide: string, kind: "topic" | "block", id: string): Promise<string> {
  const nav = await loadData<NavJson>(navPath(guide));
  for (const s of nav.systems) {
    const entries = [...s.entries, ...s.sections.flatMap((x) => x.entries)];
    if (entries.some((e) => e.kind === kind && e.id === id)) return s.id;
  }
  throw new UnitError(`${id} is not on ${guide}'s pages`);
}

/**
 * Where a table's rows are seen, for a rows editor showing `shown` of `block` on a topic page (`topic`)
 * or a table page (null): each row's topic pages (a heading row's, every topic under it) and their titles.
 */
function rowsLayout(t: SystemTopics, block: BlockFile, shown: string[], topic: string | null): RowsLayout {
  const stored = tableOrThrow(block).content as LayoutRow[];
  const ids = new Set(stored.map(rowId));
  const pages: Record<string, string[]> = {};
  const titles: Record<string, string> = {};
  for (const x of t.topics) {
    for (const id of withHeadings(t, x.rows)) {
      if (!ids.has(id)) continue;
      (pages[id] ??= []).push(x.id);
      titles[x.id] = x.title;
    }
  }
  return { page: topic === null ? "table" : "dx", topic, stored, shown, pages, titles };
}

function rowsPart(sys: SystemCtx, t: SystemTopics, block: BlockFile, shown: string[], basePt: number, area: ContentArea, topic: string | null = null): Part {
  return {
    kind: "rows", path: blockPath(sys, block.id), block, shown, sys,
    slot: { id: `${block.id}:rows`, doc: partialTable(block, shown), basePt, ...area, rows: rowsLayout(t, block, shown, topic) },
  };
}

function blockPart(path: string, block: BlockFile, owner: BlockOwner, basePt: number, area: ContentArea): Part {
  return { kind: "block", path, block, owner, slot: { id: block.id, doc: block.doc, basePt, ...area } };
}

const sysBlockPart = (sys: SystemCtx, block: BlockFile, basePt: number, area: ContentArea): Part =>
  blockPart(blockPath(sys, block.id), block, { kind: "system", sys }, basePt, area);

function belowPart(sys: SystemCtx, topic: string, block: BlockFile | null, basePt: number, area: ContentArea): Part {
  return {
    kind: "below", path: topicBelowPath(sys.guide, sys.system, topic), block, topic, sys,
    slot: { id: `${topic}:below`, doc: block?.doc ?? EMPTY_DOC, basePt, ...area },
  };
}

/** A piece as stored, without the pharm part the panel shows it from. */
const storedPiece = ({ kind, basePt, title, file, doc }: MedsPiece): MedsPiece => ({ kind, basePt, title, file, doc });

/**
 * Topic `topic`'s meds panel in the editor: each entry the published page has for it (worked out,
 * added) and every card the page can show, so a card she adds in this edit has its editors; her own
 * versions from `file`; and the cards she can add (the class cards of cards.json, never one shown inside
 * another).
 */
async function medsPart(snap: Snapshot, sys: SystemCtx, topic: string, basePt: number, area: ContentArea): Promise<MedsPart> {
  const path = topicMedsPath(sys.guide, sys.system, topic);
  const [file, published, cards, pharm] = await Promise.all([
    snap.jsonIfExists<MedsFile>(path),
    loadData<SystemJson>(systemPath(sys.guide, sys.system)),
    snap.json<CardsFile>("content/pharm/cards.json"),
    pharmFiles(snap),
  ]);
  const t = published.topics.find((x) => x.id === topic);
  const slots = (target: string, mark: string, pieces: readonly MedsPiece[]): MedsSlot[] =>
    pieces.map((p, i) => ({ id: `${topic}:meds:${target}:${mark}${i}`, doc: p.doc, basePt: p.basePt, ...area, piece: storedPiece(p) }));
  const entries: MedsEntry[] = [];
  const add = (med: PubMedsCard, derived: boolean): void => {
    if (entries.some((e) => e.med.target === med.target)) return;
    const own = file?.own.find((o) => o.target === med.target);
    entries.push({
      med, derived,
      card: t ? slots(med.target, "o", entryPieces(published, t, med, basePt)) : [],
      own: own ? slots(med.target, "", own.pieces) : null,
    });
  };
  for (const m of t?.meds ?? []) add(m, true);
  for (const m of t?.medsEdit?.add ?? []) add(m, false);
  for (const id of [...(file?.add ?? []), ...Object.keys(published.cards)]) {
    const m = pageCard(published, id);
    if (m) add(m, false);
  }
  const partTitle = new Map<string, string>();
  for (const { file: f } of pharm) for (const p of f.parts) if (p.role === "card" && p.card !== null && !partTitle.has(p.card)) partTitle.set(p.card, p.title);
  const catalog = cards.cards
    .filter((c) => c.in === undefined)
    .map((c) => ({ id: c.id, title: published.cards[c.id]?.title ?? partTitle.get(c.id) ?? c.aliases[0] ?? c.id }))
    .sort((a, b) => a.title.localeCompare(b.title));
  return { kind: "meds", path, file, topic, sys, entries, catalog };
}

/** The below blocks shown under a table whose `shown` rows a section or system page shows (topicsBelow). */
async function belowParts(snap: Snapshot, sys: SystemCtx, t: SystemTopics, shown: readonly string[], basePt: number, area: ContentArea): Promise<Part[]> {
  const topics = topicsBelow(t.topics, shown, (x) => snap.has(topicBelowPath(sys.guide, sys.system, x.id)));
  const blocks = await snap.many<BlockFile>(topics.map((x) => topicBelowPath(sys.guide, sys.system, x.id)));
  return topics.map((x, i) => belowPart(sys, x.id, blocks[i] as BlockFile, basePt, area));
}

/**
 * How a gap block is shown apart from its text: the width (pt) each figure is shown at, by asset,
 * for the figures that have one; the height (pt) of each she squished or stretched, by asset (absent
 * in drafts kept before heights existed); and whether she shows it as her own notes.
 */
export interface GapLook {
  widths: Readonly<Record<string, number>>;
  heights?: Readonly<Record<string, number>>;
  asNotes: boolean;
}

/** A gap block's look as stored. */
export function gapLook(gap: GapFile): GapLook {
  const widths: Record<string, number> = {};
  const heights: Record<string, number> = {};
  for (const f of gap.meta.figures ?? []) {
    if (f.widthPt !== undefined) widths[f.asset] = f.widthPt;
    if (f.heightPt !== undefined) heights[f.asset] = f.heightPt;
  }
  return { widths, heights, asNotes: gap.meta.asNotes === true };
}

/** A size map's entries in asset order, so two maps holding the same sizes compare equal however they were built. */
const sizesKey = (m: Readonly<Record<string, number>> | undefined): string =>
  JSON.stringify(Object.entries(m ?? {}).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));

/** Looks compare equal when they show the same: a missing heights map is an empty one. */
export const sameLook = (a: GapLook, b: GapLook): boolean =>
  a.asNotes === b.asNotes && sizesKey(a.widths) === sizesKey(b.widths) && sizesKey(a.heights) === sizesKey(b.heights);

/** `figures` showing `look`: each one's widthPt and heightPt from it (absent when it has none). */
export function figuresWithLook<F extends { asset: string; widthPt?: number; heightPt?: number }>(figures: readonly F[], look: GapLook): F[] {
  return figures.map((f) => {
    const shown = { ...f };
    const w = look.widths[f.asset];
    const h = look.heights?.[f.asset];
    if (w === undefined) delete shown.widthPt;
    else shown.widthPt = w;
    if (h === undefined) delete shown.heightPt;
    else shown.heightPt = h;
    return shown;
  });
}

/** `meta` showing `look`: each figure's widthPt and heightPt from it (absent when it has none), and asNotes. */
function withLook(meta: GapMeta, look: GapLook): GapMeta {
  const out: GapMeta = { ...meta };
  if (meta.figures) out.figures = figuresWithLook(meta.figures, look);
  if (look.asNotes) out.asNotes = true;
  else delete out.asNotes;
  return out;
}

function gapPart(gap: GapFile, meds?: string): GapPart {
  const slot = (id: string, doc: DocJSON): Slot => ({ id, doc, basePt: GAP_BASE_PT, ...DEFAULT_AREA });
  return {
    kind: "gap", path: gapFilePath(gap.id), gap, doc: slot(gap.id, gap.doc),
    differs: gap.meta.differs ? slot(`${gap.id}:differs`, gap.meta.differs.doc) : null,
    ...(meds !== undefined ? { meds } : {}),
  };
}

export type GapPart = Extract<Part, { kind: "gap" }>;

/** The sourced cards of a meds panel (MedsFile `gaps`) in `parts`, in her order. */
export const medsGapParts = (parts: readonly Part[], meds: Pick<MedsPart, "topic">): GapPart[] =>
  parts.filter((p): p is GapPart => p.kind === "gap" && p.meds === meds.topic);

async function gapParts(snap: Snapshot, ids: readonly (string | null | undefined)[]): Promise<Part[]> {
  const present = ids.filter((id): id is string => typeof id === "string");
  return (await snap.many<GapFile>(present.map(gapFilePath))).map((g) => gapPart(g));
}

/**
 * The Word-page blocks a place page shows as notes (PlaceNote), each once in order, edited whole as on
 * their File page. A block no longer on a page of hers that is shown is left out, as the page leaves it out.
 */
async function placeNoteParts(snap: Snapshot, notes: readonly PlaceNote[] | undefined): Promise<Part[]> {
  const ids = [...new Set((notes ?? []).flatMap((n) => ("block" in n ? [n.block] : [])))];
  const docFiles = [...snap.files.keys()].filter((p) => WORD_DOC_RE.test(p));
  const parts: Part[] = [];
  for (const id of ids) {
    const docFile = docFiles.find((p) => snap.has(blockFileIn(dirOf(p), id)));
    if (!docFile) continue;
    const word = await snap.json<WordDocFile>(docFile);
    if (word.removed !== null || !word.blocks.includes(id)) continue;
    const path = blockFileIn(dirOf(docFile), id);
    parts.push(blockPart(path, await snap.json<BlockFile>(path), { kind: "doc", path: docFile }, word.basePt, contentArea(word.page)));
  }
  return parts;
}

/** An Other section outline's Word blocks in page order: its block items, and every block of each Word doc item. */
async function otherOutlineNotes(snap: Snapshot, notes: readonly OtherNote[] | undefined): Promise<PlaceNote[]> {
  const out: PlaceNote[] = [];
  for (const n of notes ?? []) {
    if ("block" in n) out.push(n);
    if (!("doc" in n)) continue;
    const word = await snap.jsonIfExists<WordDocFile>(`content/docs/${n.doc}/doc.json`);
    if (word && word.removed === null) out.push(...word.blocks.map((block) => ({ block })));
  }
  return out;
}

/** All rows of a table that take part in resolution are its full content; one-column tables edit as blocks. */
function wholeBlockPart(sys: SystemCtx, t: SystemTopics, block: BlockFile, basePt: number, area: ContentArea): Part {
  if (block.kind === "table" && !t.proseBlocks.includes(block.id)) return rowsPart(sys, t, block, tableOrThrow(block).content.map(rowId), basePt, area);
  return sysBlockPart(sys, block, basePt, area);
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
    else if (p.kind === "below" && p.block) ids.push(p.block.id);
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

const WORD_KINDS: ReadonlySet<PageKind> = new Set<PageKind>(["topic", "section", "system", "listed", "pharm"]);

/** Read the edit unit of a page key at the snapshot's commit. */
export async function loadUnit(key: string, snap: Snapshot): Promise<EditUnit> {
  const k = parsePageKey(key);
  if (k === null) throw new UnitError(`Malformed page key: ${key}`);
  // Guide and pharm pages were converted from her Word guides and med lists; gap blocks and generated slides were not.
  const fromWord = WORD_KINDS.has(k.kind);
  const unit = (parts: Part[], scope = guideScope(parts), topic: string | null = null): EditUnit => ({
    key, snapshot: snap, scope, parts, ids: partIds(parts), docId: null, topic, fromWord,
  });

  switch (k.kind) {
    case "topic": {
      const { guide, row } = k;
      const sys = await loadSystem(snap, guide, await systemOf(guide, "topic", row));
      const { basePt, area } = await guideFacts(snap, guide);
      const t = deriveTopics(sys.blocks, sys.structure);
      const topic = t.topics.find((x) => x.id === row);
      if (!topic) throw new UnitError(`Topic ${row} is no longer in ${sys.system}`);
      // A topic continues into the next table when that table's first rows have no name: one rows editor per table.
      const byBlock = new Map<string, string[]>();
      for (const id of withHeadings(t, topic.rows)) {
        const b = t.rows.get(id)?.block ?? topic.block;
        byBlock.set(b, [...(byBlock.get(b) ?? []), id]);
      }
      const parts = [...byBlock].map(([id, shown]) => {
        const block = sys.blocks.find((b) => b.id === id);
        if (!block) throw new UnitError(`Topic ${row} is no longer in ${sys.system}`);
        return rowsPart(sys, t, block, shown, basePt, area, row);
      });
      // Its meds panel and the sourced cards placed in it, then her below area (an empty editor until she adds something).
      const meds = await medsPart(snap, sys, row, basePt, area);
      const gapIds = (meds.file?.gaps ?? []).filter((id) => snap.has(gapFilePath(id)));
      parts.push(meds, ...(await snap.many<GapFile>(gapIds.map(gapFilePath))).map((g) => gapPart(g, row)));
      parts.push(belowPart(sys, row, await snap.jsonIfExists<BlockFile>(topicBelowPath(guide, sys.system, row)), basePt, area));
      return unit(parts, guideScope(parts), row);
    }
    case "section": {
      const { guide, system, section } = k;
      const sys = await loadSystem(snap, guide, system);
      const { basePt, area } = await guideFacts(snap, guide);
      const t = deriveTopics(sys.blocks, sys.structure);
      const byId = new Map(sys.blocks.map((b) => [b.id, b]));
      const parts: Part[] = [];
      for (const item of sectionItems(t, sys.structure, sys.blocks.map((b) => b.id), section)) {
        const b = byId.get(item.block);
        if (!b) throw new UnitError(`Block ${item.block} is no longer in ${sys.system}`);
        if (item.rows === null) parts.push(sysBlockPart(sys, b, basePt, area));
        else parts.push(rowsPart(sys, t, b, item.rows, basePt, area), ...(await belowParts(snap, sys, t, item.rows, basePt, area)));
      }
      return unit(parts);
    }
    case "system": {
      const { guide, system } = k;
      const sys = await loadSystem(snap, guide, system);
      const { basePt, area } = await guideFacts(snap, guide);
      const t = deriveTopics(sys.blocks, sys.structure);
      const drug = new Map(sys.structure.drugTables.map((d) => [d.block, d]));
      const parts: Part[] = [];
      for (const b of sys.blocks) {
        const stored = t.tables.get(b.id);
        if (drug.has(b.id)) parts.push({ kind: "stub", block: b.id, label: stored ? stubLabel(stored) : "" });
        else parts.push(wholeBlockPart(sys, t, b, basePt, area));
        parts.push(...(await belowParts(snap, sys, t, (stored?.rows ?? []).map((r) => r.id), basePt, area)));
      }
      return unit(parts);
    }
    case "listed": {
      const { guide, block: blockId } = k;
      const sys = await loadSystem(snap, guide, await systemOf(guide, "block", blockId));
      const { basePt, area } = await guideFacts(snap, guide);
      if (!sys.blocks.some((b) => b.id === blockId)) throw new UnitError(`Block ${blockId} is no longer in ${sys.system}`);
      // The listed block and, for an entry listing a run, the blocks recorded under it, in order.
      const run = sys.blocks.filter((b) => b.id === blockId || listedHead(sys.structure, b.id) === blockId);
      return unit(run.map((b) => sysBlockPart(sys, b, basePt, area)));
    }
    case "pharm": {
      const { guide, system, section } = k;
      const sys = await loadSystem(snap, guide, system);
      const { basePt, area } = await guideFacts(snap, guide);
      const ps = sys.structure.pharmSections.find((s) => s.id === section);
      if (!ps) throw new UnitError(`Pharm section ${section} is no longer in ${system}`);
      const published = await loadData<SystemJson>(systemPath(guide, system));
      const cards = published.pharm?.sections.find((s) => s.id === section)?.cards ?? [];
      const files = await pharmFiles(snap);
      const parts: Part[] = [];
      const seen = new Set<string>();
      const addPharmPart = async (pred: (p: PharmFile["parts"][number]) => boolean): Promise<void> => {
        for (const { dir, file } of files) {
          // A file made from her Word page shows the page's own blocks: each saves to the page, so the
          // edit shows there and on every card cutting it, and is edited whole (as place notes are).
          const store = file.page === undefined ? dir : `content/docs/${file.page}`;
          for (const part of file.parts.filter(pred)) {
            const fresh = part.blocks.filter((b) => !seen.has(b) && snap.has(blockFileIn(store, b)));
            fresh.forEach((b) => seen.add(b));
            const blocks = await snap.many<BlockFile>(fresh.map((b) => blockFileIn(store, b)));
            const owner: BlockOwner = file.page === undefined ? { kind: "pharm", path: `${dir}/pharmfile.json`, part: part.id } : { kind: "doc", path: `${store}/doc.json` };
            blocks.forEach((b) => parts.push(blockPart(blockFileIn(store, b.id), b, owner, file.basePt, area)));
          }
        }
      };
      if (ps.overview) await addPharmPart((p) => p.id === ps.overview);
      const t = deriveTopics(sys.blocks, sys.structure);
      for (const id of ps.tables) {
        const b = sys.blocks.find((x) => x.id === id);
        if (b) parts.push(rowsPart(sys, t, b, tableOrThrow(b).content.map(rowId), basePt, area));
      }
      // A card shows its own parts, then those of the cards shown inside it (publish's card parts).
      const { cards: allCards } = await snap.json<CardsFile>("content/pharm/cards.json");
      for (const card of cards) {
        for (const member of cardGroup(allCards, card)) await addPharmPart((p) => p.role === "card" && p.card === member.id);
      }
      if (ps.lo) await addPharmPart((p) => p.id === ps.lo);
      return unit(parts, guideScope(parts, [sys.structurePath]));
    }
    case "general": {
      const { guide, key: gkey } = k;
      const general = await snap.json<GeneralFile>(`content/guides/${guide}/general.json`);
      return unit(await gapParts(snap, general.topics.find((t) => t.key === gkey)?.gaps ?? []));
    }
    case "workup": {
      const { guide, item } = k;
      const general = await snap.json<GeneralFile>(`content/guides/${guide}/general.json`);
      return unit(await gapParts(snap, [general.workup.find((w) => w.id === item)?.gap]));
    }
    case "visit": {
      const { guide, item } = k;
      const general = await snap.json<GeneralFile>(`content/guides/${guide}/general.json`);
      return unit(await gapParts(snap, general.visits?.find((v) => v.id === item)?.gaps ?? []));
    }
    case "ref": {
      const { tab, sub } = k;
      const tabs = await snap.json<RefTabsFile>("content/places/reftabs.json");
      const t = tabs[tab as keyof Omit<RefTabsFile, "v">] as RefTabsFile["labs"] | undefined;
      const s = t?.subs.find((x) => x.id === sub);
      return unit([...(await placeNoteParts(snap, s?.notes)), ...(await gapParts(snap, s?.gaps ?? []))]);
    }
    case "other": {
      const { section } = k;
      const other = await snap.json<OtherFile>("content/places/other.json");
      const s = other.sections.find((x) => x.id === section);
      const notes = await otherOutlineNotes(snap, s?.notes);
      return unit([...(await gapParts(snap, [s?.lead])), ...(await placeNoteParts(snap, notes)), ...(await gapParts(snap, s?.gaps ?? []))]);
    }
    case "slide": {
      const { guide, slide: slideId } = k;
      const path = `content/slides/${guide}/blocks/${slideId}.json`;
      const block = await snap.json<BlockFile<SlideMeta>>(path);
      return unit([{ kind: "slide", path, block, slot: { id: slideId, doc: block.doc, basePt: GAP_BASE_PT, ...DEFAULT_AREA } }]);
    }
    case "doc": {
      const docId = k.doc;
      const dirs = [`content/docs/${docId}/`, `content/files/${docId}/`];
      const deck = await snap.jsonIfExists<DeckFile>("content/slides/psy/deck.json");
      if (deck?.file === docId) dirs.push("content/slides/psy/");
      const scope = { files: [], dirs };
      const word = await snap.jsonIfExists<WordDocFile>(`content/docs/${docId}/doc.json`);
      const parts: Part[] = [];
      if (word && word.removed === null) {
        const dir = `content/docs/${docId}`;
        const blocks = await snap.many<BlockFile>(word.blocks.map((b) => blockFileIn(dir, b)));
        const owner: BlockOwner = { kind: "doc", path: `${dir}/doc.json` };
        blocks.forEach((b) => parts.push(blockPart(blockFileIn(dir, b.id), b, owner, word.basePt, contentArea(word.page))));
      }
      return { key, snapshot: snap, scope, parts, ids: [docId, ...partIds(parts)], docId, topic: null, fromWord: word !== null };
    }
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

/** Each slot's doc of a unit (the page as opened, or a version's content for a restore). */
export function slotDocs(unit: EditUnit): Map<string, DocJSON> {
  const out = new Map<string, DocJSON>();
  for (const p of unit.parts) {
    if (p.kind === "stub") continue;
    if (p.kind === "gap") {
      out.set(p.doc.id, p.doc.doc);
      if (p.differs) out.set(p.differs.id, p.differs.doc);
    } else if (p.kind === "meds") {
      for (const s of p.entries.flatMap((e) => [...e.card, ...(e.own ?? [])])) out.set(s.id, s.doc);
    } else out.set(p.slot.id, p.slot.doc);
  }
  return out;
}

/**
 * Her meds panel for a topic after the edit: `choice`'s cards and removals, and her own version of
 * each entry the panel shows — the pieces of the editors it shows (`docs`, slot id → edited doc) when
 * she edited or cut one of them, less the boxes she cut or emptied, else the stored version unless she
 * dropped it. A card whose every box she cut or emptied goes off the panel, as "Remove from this
 * condition" takes it. An entry she took off keeps its stored version for Put back; a card she no longer
 * adds drops it. Versions of entries the editor does not have are kept. Null when nothing is left.
 */
function medsAfter(part: MedsPart, chosen: MedsChoice, docs: ReadonlyMap<string, DocJSON>): MedsFile | null {
  // Emptied: she took out everything a box had. A box already blank in her notes stays.
  const emptied = (s: MedsSlot): boolean => {
    const doc = docs.get(s.id);
    return doc !== undefined && isBlankDoc(doc) && !isBlankDoc(s.piece.doc);
  };
  let choice = chosen;
  for (const e of shownEntries(part, chosen)) {
    if (allBoxes(e, chosen).length > 0 && entrySlots(e, chosen).every(emptied)) choice = takeOff(part, choice, e.med.target);
  }
  const own = new Map((part.file?.own ?? []).map((o) => [o.target, o.pieces]));
  const shown = new Set(shownEntries(part, choice).map((e) => e.med.target));
  for (const e of part.entries) {
    const target = e.med.target;
    if (choice.original.includes(target) || (!shown.has(target) && !choice.remove.includes(target))) own.delete(target);
    if (!shown.has(target)) continue;
    const slots = entrySlots(e, choice);
    const cut = allBoxes(e, choice).length > slots.length;
    if (cut || slots.some((s) => docs.has(s.id))) own.set(target, slots.filter((s) => !emptied(s)).map((s) => ({ ...s.piece, doc: docs.get(s.id) ?? s.piece.doc })));
  }
  // A card shown only because she edited it (fileAdds) stays implied by her version, as stored.
  const implied = new Set(fileChoice(part).add.filter((id) => !part.file?.add.includes(id)));
  const add = choice.add.filter((id) => !(implied.has(id) && own.has(id)));
  // The sourced cards placed in the panel and the role labels are kept as stored: the editor changes neither.
  const gaps = part.file?.gaps ?? [];
  const roles = part.file?.roles ?? [];
  if (add.length === 0 && choice.remove.length === 0 && own.size === 0 && gaps.length === 0 && roles.length === 0) return null;
  return {
    v: 1, add, remove: [...choice.remove], own: [...own].map(([target, pieces]) => ({ target, pieces })),
    ...(gaps.length > 0 ? { gaps: [...gaps] } : {}), ...(roles.length > 0 ? { roles: roles.map((r) => ({ ...r })) } : {}),
  };
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
 * Row `topic` no longer starts a topic but is still there, so it goes wherever the positional rule puts
 * it (40 §40.2). The rows recorded under it take its own `members` entry, as handOver gives them when
 * there is no heir: they then follow it and keep its section instead of naming a topic that is gone.
 */
function releaseRecorded(structure: StructureFile, topic: string): StructureFile {
  const entry = structure.members[topic];
  const members = Object.fromEntries(Object.entries(structure.members).flatMap(([k, v]): [string, string][] => {
    if (v !== topic) return [[k, v]];
    return entry === undefined ? [] : [[k, entry]];
  }));
  return { ...structure, members };
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

/**
 * `structure` with the `members`, `listed`, `titled`, `unlisted` and `conditionRows` entries `ids`
 * had in `old`. A restored `titled` entry whose heading is not back is dropped by fitTopicRows
 * before the checks.
 */
function withOldEntries(structure: StructureFile, old: StructureFile, ids: readonly string[]): StructureFile {
  if (ids.length === 0) return structure;
  const members = { ...structure.members };
  const listed = { ...structure.listed };
  const titled = { ...structure.titled };
  const unlisted = [...(structure.unlisted ?? [])];
  for (const id of ids) {
    const m = old.members[id];
    if (m !== undefined) members[id] = m;
    const l = old.listed[id];
    if (l !== undefined) listed[id] = l;
    const t = old.titled?.[id];
    if (t !== undefined) titled[id] = t;
    if (old.unlisted?.includes(id) && !unlisted.includes(id)) unlisted.push(id);
  }
  const drugTables = structure.drugTables.map((d) => {
    const before = old.drugTables.find((o) => o.block === d.block)?.conditionRows ?? [];
    const back = ids.filter((id) => before.includes(id) && !d.conditionRows.includes(id));
    return back.length > 0 ? { ...d, conditionRows: [...d.conditionRows, ...back] } : d;
  });
  return {
    ...structure, members, listed, drugTables,
    ...(Object.keys(titled).length > 0 ? { titled } : {}),
    ...(unlisted.length > 0 ? { unlisted } : {}),
  };
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
 * version's doc, differs and look. `looks` maps gap id → its edited look (GapLook); a gap missing
 * from it keeps its look. A differs doc she emptied is removed (null). `meds` maps topic id → her
 * choices for its meds panel (MedsChoice); a panel missing from it keeps the stored ones. A restore
 * puts back the version's meds file.
 */
export function buildSave(
  unit: EditUnit, edits: ReadonlyMap<string, DocJSON>, today = localDate(),
  { restore, looks = new Map(), meds = new Map() }: { restore?: EditUnit; looks?: ReadonlyMap<string, GapLook>; meds?: ReadonlyMap<string, MedsChoice> } = {},
): SaveBuild {
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
    // A topic's below block and meds panel are written once its topic's id after the save is known (below).
    if (part.kind === "stub" || part.kind === "below" || part.kind === "meds") continue;
    if (part.kind === "rows") {
      const full = rowsOf(part.block);
      const table = tableOrThrow(part.block);
      const old = restore ? oldRows(part.block.id) : undefined;
      let spliced: { rows: RowJSON[]; added: string[]; deleted: string[] };
      // The table's own attributes (column widths, cell margins) come with the edited or restored table.
      let attrs = table.attrs;
      if (restore) {
        spliced = restoreRows(full, part.shown, old ? rowsOf(old.block) : [], old?.shown ?? []);
        if (old) attrs = tableOrThrow(old.block).attrs;
      } else {
        const doc = docs.get(part.slot.id);
        if (!doc) continue;
        const editedTable = doc.content[0] as RowJSON | undefined;
        const edited = (editedTable?.content ?? []) as RowJSON[];
        spliced = spliceShown(full as LayoutRow[], part.shown, edited as LayoutRow[]);
        // Another dx's rows joined to an edited row by a merged cell take the widths she gave it (rowLayout).
        const held = new Set([...part.shown, ...edited.map(rowId)]);
        spliced = { ...spliced, rows: followMergedWidths(full as LayoutRow[], spliced.rows as LayoutRow[], held) };
        attrs = editedTable?.attrs ?? attrs;
      }
      const block: BlockFile = { ...part.block, doc: { type: "doc", content: [{ ...table, attrs, content: spliced.rows }] } };
      const normalized = JSON.parse(canonical(part.path, block)) as BlockFile;
      const before = new Map(full.map((r) => [rowId(r), JSON.stringify(r)]));
      // A change to the table's attributes changes how every one of its rows is drawn.
      const tableChanged = JSON.stringify(tableOrThrow(normalized).attrs) !== JSON.stringify(table.attrs);
      for (const r of rowsOf(normalized)) if (tableChanged || before.get(rowId(r)) !== JSON.stringify(r)) changed.add(rowId(r));
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
      // An edit that breaks a `titled` or `unlisted` row drops the entry (Orchestrator rulings 2026-10-04 22:01Z and 2026-10-06).
      s.structure = fitTopicRows(s.blocks, s.structure);
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
      const look = old ? gapLook(old.gap) : (looks.get(part.gap.id) ?? gapLook(part.gap));
      const meta: GapMeta = { ...part.gap.meta, differs: differs && !isBlankDoc(differs) ? { doc: differs } : null };
      const plain: GapFile = { ...part.gap, doc, meta: sameLook(look, gapLook(part.gap)) ? meta : withLook(meta, look) };
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
  if (lostTopic === null && unit.topic !== null) {
    // Her topic's first row stays but no longer starts a topic (its name was cleared): the page is gone
    // as surely as if the row were deleted.
    const topic = unit.topic;
    const part = unit.parts.find((p): p is RowsPart => p.kind === "rows" && rowsOf(p.block).some((r) => rowId(r) === topic));
    const s = part && systems.get(part.sys.structurePath);
    if (part && s && !deriveTopics(s.blocks, s.structure).topics.some((t) => t.id === topic)) {
      s.structure = releaseRecorded(s.structure, topic);
      lostTopic = { part, blocks: s.blocks, structure: s.structure };
    }
  }
  checkSystems(systems.values());
  for (const { sys, structure } of systems.values()) {
    if (structure !== sys.structure) put(sys.structurePath, sys.structure, structure);
  }

  const deleted: string[] = [];
  for (const part of unit.parts) {
    if (part.kind !== "below") continue;
    const edited = docs.get(part.slot.id);
    const doc = edited ?? part.block?.doc ?? null;
    if (doc === null || isBlankDoc(doc)) {
      // Emptied: the file goes (an untouched empty area has none).
      if (part.block && edited) {
        deleted.push(part.path);
        changed.add(part.block.id);
      }
      continue;
    }
    // It follows its topic when the save gives the topic a new id. With no topic left, or when the
    // topic it joins already has a below block, it stays where it is (kept in Git, not shown).
    const s = systems.get(part.sys.structurePath);
    const topic = s ? topicNow(part.sys, part.topic, s.blocks, s.structure) : part.topic;
    const dest = topic === null ? part.path : topicBelowPath(part.sys.guide, part.sys.system, topic);
    const path = dest !== part.path && (unit.snapshot.has(dest) || next.has(dest)) ? part.path : dest;
    const block: BlockFile = { ...(part.block ?? { v: 1, id: newId("b", new Set(part.sys.blocks.map((b) => b.id))), kind: "prose", meta: {} }), doc };
    const normalized = JSON.parse(canonical(path, block)) as BlockFile;
    if (!part.block || JSON.stringify(normalized.doc) !== JSON.stringify(part.block.doc)) changed.add(block.id);
    if (part.block && path === part.path) put(path, part.block, normalized);
    else next.set(path, normalized);
    if (part.block && path !== part.path) deleted.push(part.path);
  }

  for (const part of unit.parts) {
    if (part.kind !== "meds") continue;
    const file = restore
      ? (restore.parts.find((p): p is MedsPart => p.kind === "meds")?.file ?? null)
      : medsAfter(part, meds.get(part.topic) ?? fileChoice(part), docs);
    // Like the below block, it follows its topic to a new id unless that topic already has a panel of hers.
    const s = systems.get(part.sys.structurePath);
    const topic = s ? topicNow(part.sys, part.topic, s.blocks, s.structure) : part.topic;
    const dest = topic === null ? part.path : topicMedsPath(part.sys.guide, part.sys.system, topic);
    const path = dest !== part.path && (unit.snapshot.has(dest) || next.has(dest)) ? part.path : dest;
    const before = part.file ? canonical(part.path, part.file) : null;
    if (file === null) {
      if (part.file) {
        deleted.push(part.path);
        changed.add(topic ?? part.topic);
      }
      continue;
    }
    const after = JSON.parse(canonical(path, file)) as MedsFile;
    if (path !== part.path || canonical(path, after) !== before) changed.add(topic ?? part.topic);
    if (part.file && path === part.path) put(path, part.file, after);
    else next.set(path, after);
    if (part.file && path !== part.path) deleted.push(part.path);
  }

  const changes: TreeChange[] = [];
  const files = new Map<string, unknown>();
  for (const [path, value] of next) {
    const text = canonical(path, value);
    if (text === original.get(path)) continue;
    changes.push({ path, content: text });
    files.set(path, value);
  }
  for (const path of deleted) {
    changes.push({ path, sha: null });
    files.set(path, null);
  }
  if (unit.docId !== null && changes.length > 0) changed.add(unit.docId);
  const build: SaveBuild = { changes, files, changed: [...changed] };
  if (lostTopic && unit.topic !== null) {
    build.topicMoved = { guide: lostTopic.part.sys.guide, system: lostTopic.part.sys.system, topic: topicNow(lostTopic.part.sys, unit.topic, lostTopic.blocks, lostTopic.structure) };
  }
  return build;
}

type BlockPartT = Extract<Part, { kind: "block" }>;

/**
 * A restore of a guide, pharm, gap or slide page (50 §50.6): the version's content saved over the
 * current files as if she had typed it (buildSave in restore mode), plus each block of the version
 * whose file no longer exists re-created with its id, re-inserted into its owner list by the
 * nearest-neighbour rule, and given the structure.json entries it and its rows had at the version.
 * `unit` is the page at main's head, `version` the page at the chosen commit. Nothing outside the
 * page is written.
 */
export async function buildRestore(unit: EditUnit, version: EditUnit, today = localDate()): Promise<SaveBuild> {
  const build = buildSave(unit, new Map(), today, { restore: version });
  const lost = version.parts.filter((p): p is BlockPartT | RowsPart => (p.kind === "block" || p.kind === "rows") && !unit.snapshot.has(p.path));
  if (lost.length === 0) return build;

  const files = new Map(build.files);
  const now = async <T>(path: string): Promise<T> => (files.has(path) ? (files.get(path) as T) : unit.snapshot.json<T>(path));
  const changed = new Set(build.changed);
  /** Each system that got a block back, by its system.json path. */
  const systems = new Map<string, SystemCtx>();
  for (const p of lost) {
    const owner: BlockOwner = p.kind === "rows" ? { kind: "system", sys: p.sys } : p.owner;
    const path = ownerPath(owner);
    files.set(p.path, p.block);
    changed.add(p.block.id);
    const oldOwner = await version.snapshot.json<SystemFile | PharmFile | WordDocFile>(path);
    const list = await now<SystemFile | PharmFile | WordDocFile>(path);
    const put = (ids: string[], oldIds: readonly string[]): string[] =>
      ids.includes(p.block.id) ? ids : ids.toSpliced(insertAt(ids, oldIds, p.block.id), 0, p.block.id);
    let next: SystemFile | PharmFile | WordDocFile = { ...list, blocks: put(list.blocks, oldOwner.blocks) };
    switch (owner.kind) {
      case "pharm": {
        const pharm = next as PharmFile;
        const oldPart = (oldOwner as PharmFile).parts.find((x) => x.id === owner.part)?.blocks ?? [];
        next = { ...pharm, parts: pharm.parts.map((x) => (x.id === owner.part ? { ...x, blocks: put(x.blocks, oldPart) } : x)) };
        break;
      }
      case "system": {
        const { structurePath } = owner.sys;
        const ids = [p.block.id, ...(p.kind === "rows" ? p.shown : [])];
        if (p.kind === "rows") p.shown.forEach((id) => changed.add(id));
        const old = await version.snapshot.json<StructureFile>(structurePath);
        files.set(structurePath, withOldEntries(await now<StructureFile>(structurePath), old, ids));
        systems.set(path, owner.sys);
        break;
      }
      case "doc":
        break;
    }
    files.set(path, next);
  }
  // The build's own checks on each system that got a block back (40 §40.1/§40.2).
  for (const [path, ctx] of systems) {
    const sys = await now<SystemFile>(path);
    const blocks = await Promise.all(sys.blocks.map((b) => now<BlockFile>(blockPath(ctx, b))));
    const stored = await now<StructureFile>(ctx.structurePath);
    const structure = fitTopicRows(blocks, stored);
    if (structure !== stored) files.set(ctx.structurePath, structure);
    checkMembers(sys.id, deriveTopics(blocks, structure), structure);
  }

  const changes: TreeChange[] = [];
  const out = new Map<string, unknown>();
  for (const [path, value] of files) {
    if (value === null) {
      // A file the save deletes (an emptied below block).
      changes.push({ path, sha: null });
      out.set(path, null);
      continue;
    }
    const text = canonical(path, value);
    if (unit.snapshot.has(path) && text === (await unit.snapshot.text(path))) continue;
    changes.push({ path, content: text });
    out.set(path, value);
  }
  return { ...build, changes, files: out, changed: [...changed] };
}

/**
 * Topic `topic` of `sys` after a save leaves the system with `blocks` and `structure`: itself while it
 * still exists, else the topic its first remaining row belongs to, else null.
 */
function topicNow(sys: SystemCtx, topic: string, blocks: BlockFile[], structure: StructureFile): string | null {
  const after = deriveTopics(blocks, structure).topics;
  if (after.some((t) => t.id === topic)) return topic;
  const before = deriveTopics(sys.blocks, sys.structure).topics.find((t) => t.id === topic)?.rows ?? [];
  for (const row of before) {
    const t = after.find((x) => x.rows.includes(row));
    if (t) return t.id;
  }
  return null;
}
