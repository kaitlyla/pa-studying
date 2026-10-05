// The curation commands (plan 90 §90.1). Each builds the file changes for one curation step from
// the loaded content and a curator-authored draft; tree.ts validates, checks and writes them.
import { addFlag, isId, newId } from "../../lib/content/index.ts";
import type { IdPrefix } from "../../lib/content/index.ts";
import { tableNode } from "../../lib/content/tables.ts";
import type {
  BlockFile, CardsFile, ConceptsFile, DeckFile, DocJSON, EvidenceFile, Flag, FlagsFile, GapFile, GeneralFile, GuideId, Link,
  OtherFile, PharmFile, PharmPart, PlaceNote, RefTabsFile, SlideMeta, StructureFile,
} from "../../lib/content/types.ts";
import type { Content } from "../../lib/derive/model.ts";
import { collapse, nodeText, type PMNode } from "../../lib/derive/text.ts";
import { deriveTopics, rowSection } from "../../lib/derive/topics.ts";
import { CurateError, type Change } from "./tree.ts";

export interface Planned {
  changes: Change[];
  /** Lines reported to the curator (ids assigned, etc.). */
  notes: string[];
}

// ---- where things live -------------------------------------------------------------------------

/** A block's owner list: the file listing it and the directory holding its block file. */
interface Owner {
  /** Repository path of the owner list file. */
  listPath: string;
  list: { blocks: string[] } | { preamble: string[] };
  dir: string;
  block: BlockFile;
  /** Set for a block of a guide system; `blocks` are the system's. */
  structure?: { path: string; value: StructureFile; blocks: BlockFile[] };
  /** Set for a block of a pharm notes file. */
  pharm?: PharmFile;
}

function findBlock(c: Content, blockId: string): Owner {
  for (const g of c.guides) {
    const base = `content/guides/${g.file.id}`;
    const pre = g.preamble.find((b) => b.id === blockId);
    if (pre) return { listPath: `${base}/guide.json`, list: g.file, dir: `${base}/_preamble/blocks`, block: pre };
    for (const s of g.systems) {
      const b = s.blocks.find((x) => x.id === blockId);
      if (b) {
        const sb = `${base}/${s.file.id}`;
        return { listPath: `${sb}/system.json`, list: s.file, dir: `${sb}/blocks`, block: b, structure: { path: `${sb}/structure.json`, value: s.structure, blocks: s.blocks } };
      }
    }
  }
  for (const p of c.pharm) {
    const b = p.blocks.find((x) => x.id === blockId);
    if (b) return { listPath: `content/pharm/${p.file.id}/pharmfile.json`, list: p.file, dir: `content/pharm/${p.file.id}/blocks`, block: b, pharm: p.file };
  }
  for (const [d, doc] of c.docs) {
    if (doc.kind !== "word") continue;
    const b = doc.blocks.find((x) => x.id === blockId);
    if (b) return { listPath: `content/docs/${d}/doc.json`, list: doc.file, dir: `content/docs/${d}/blocks`, block: b };
  }
  throw new CurateError(`${blockId}: no such block in any guide, pharm notes file or Word page`);
}

/** Every id the content holds, so new ids never collide with one in use. */
function takenIds(c: Content): Set<string> {
  const ids = new Set<string>();
  const addDoc = (doc: DocJSON): void => {
    const walk = (n: PMNode): void => {
      if (n.type === "table_row" && typeof n.attrs?.id === "string") ids.add(n.attrs.id);
      for (const k of n.content ?? []) walk(k);
    };
    walk(doc as PMNode);
  };
  const addBlocks = (bs: readonly BlockFile<unknown>[]): void => {
    for (const b of bs) {
      ids.add(b.id);
      addDoc(b.doc);
    }
  };
  for (const g of c.guides) {
    addBlocks(g.preamble);
    for (const s of g.systems) addBlocks(s.blocks);
  }
  for (const p of c.pharm) {
    addBlocks(p.blocks);
    for (const part of p.file.parts) ids.add(part.id);
  }
  for (const card of c.cards.cards) ids.add(card.id);
  for (const [d, doc] of c.docs) {
    ids.add(d);
    if (doc.kind === "word") addBlocks(doc.blocks);
  }
  for (const id of c.gaps.keys()) ids.add(id);
  for (const deck of c.decks.values()) addBlocks(deck.slides);
  for (const f of c.flags.flags) ids.add(f.id);
  return ids;
}

/** Row ids and block ids of every guide, Word page and pharm notes file: link and concept targets. */
function targetIds(c: Content): Set<string> {
  const ids = takenIds(c);
  for (const id of [...ids]) if (!isId("r", id) && !isId("b", id) && !isId("g", id) && !isId("d", id)) ids.delete(id);
  return ids;
}

function minter(c: Content): (prefix: IdPrefix) => string {
  const taken = takenIds(c);
  return (prefix) => {
    const id = newId(prefix, taken);
    taken.add(id);
    return id;
  };
}

function requireIds(ids: Iterable<string>, known: ReadonlySet<string>, where: string): void {
  for (const id of ids) if (!known.has(id)) throw new CurateError(`${where}: ${id} names nothing in the content`);
}

const clone = <T>(v: T): T => structuredClone(v);

// ---- split ---------------------------------------------------------------------------------

/**
 * `split <blockId> <paragraphIndex>`: the prose block's top-level nodes from `index` on become a
 * new block placed right after it in its owner list (and in its pharm part, and in its section).
 */
export function split(c: Content, blockId: string, index: number): Planned {
  const owner = findBlock(c, blockId);
  const { block } = owner;
  if (block.kind !== "prose") throw new CurateError(`${blockId}: only a prose block can be split (this one is ${block.kind})`);
  const nodes = block.doc.content;
  if (!Number.isInteger(index) || index < 1 || index >= nodes.length) {
    throw new CurateError(`${blockId}: paragraph index must be between 1 and ${nodes.length - 1}, got ${index}`);
  }
  const id = minter(c)("b");
  const first: BlockFile = { ...clone(block), doc: { type: "doc", content: clone(nodes.slice(0, index)) } };
  const second: BlockFile = { v: 1, id, kind: "prose", doc: { type: "doc", content: clone(nodes.slice(index)) }, meta: clone(block.meta) };
  if (JSON.stringify([...first.doc.content, ...second.doc.content]) !== JSON.stringify(nodes)) {
    throw new CurateError(`${blockId}: split would not reproduce the block`);
  }
  const insertAfter = (list: readonly string[]): string[] => {
    const at = list.indexOf(blockId);
    return [...list.slice(0, at + 1), id, ...list.slice(at + 1)];
  };
  const list = clone(owner.list) as unknown as Record<string, unknown>;
  const key = "preamble" in owner.list ? "preamble" : "blocks";
  list[key] = insertAfter(list[key] as string[]);
  if (owner.pharm) {
    (list as unknown as PharmFile).parts = owner.pharm.parts.map((p) => (p.blocks.includes(blockId) ? { ...p, blocks: insertAfter(p.blocks) } : p));
  }
  const changes: Change[] = [
    { path: `${owner.dir}/${blockId}.json`, value: first },
    { path: `${owner.dir}/${id}.json`, value: second },
    { path: owner.listPath, value: list },
  ];
  const st = owner.structure;
  if (st && st.value.members[blockId] !== undefined) {
    changes.push({ path: st.path, value: { ...st.value, members: { ...st.value.members, [id]: st.value.members[blockId] } } });
  }
  return { changes, notes: [`${blockId} split at ${index}; the second part is ${id}`] };
}

// ---- rows ----------------------------------------------------------------------------------

/** `rows <tableBlockId> <rowId>=heading|content …`: sets row kinds. */
export function rows(c: Content, blockId: string, assignments: readonly string[]): Planned {
  const owner = findBlock(c, blockId);
  if (owner.block.kind !== "table") throw new CurateError(`${blockId}: not a table block`);
  if (assignments.length === 0) throw new CurateError("rows: give at least one <rowId>=heading|content");
  const block = clone(owner.block);
  const table = tableNode(block);
  const byId = new Map((table?.content ?? []).map((r) => [String(r.attrs?.id), r]));
  for (const a of assignments) {
    const m = /^(?<row>r_[0-9A-Z]{10})=(?<kind>heading|content)$/.exec(a)?.groups;
    if (m?.row === undefined || m.kind === undefined) throw new CurateError(`rows: "${a}" is not <rowId>=heading|content`);
    const row = byId.get(m.row);
    if (!row?.attrs) throw new CurateError(`rows: ${m.row} is not a row of ${blockId}`);
    row.attrs.kind = m.kind;
  }
  return { changes: [{ path: `${owner.dir}/${blockId}.json`, value: block }], notes: [`${assignments.length} row kind(s) set in ${blockId}`] };
}

// ---- titled --------------------------------------------------------------------------------

/**
 * `titled <tableBlockId> <rowId>[=<cell>|=off] …`: the topic the row starts takes its title from
 * cell `cell` (default 0, the label) of the row directly above it (Orchestrator rulings 2026-10-04
 * 21:02Z and 22:01Z). That row becomes a heading row if it is not one, and drops its own `members`
 * entry; a titled row with no `members` entry takes the section it was shown under. `=off` removes
 * the row's entry. The build refuses an entry whose heading cell is empty.
 */
export function titled(c: Content, blockId: string, assignments: readonly string[]): Planned {
  const owner = findBlock(c, blockId);
  const st = owner.structure;
  if (owner.block.kind !== "table" || !st) throw new CurateError(`${blockId}: not a table block of a guide system`);
  if (assignments.length === 0) throw new CurateError("titled: give at least one <rowId>[=<cell>|=off]");
  const block = clone(owner.block);
  const rows = tableNode(block)?.content ?? [];
  const before = deriveTopics(st.blocks, st.value);
  const members = { ...st.value.members };
  const entries = { ...st.value.titled };
  const notes: string[] = [];
  let kinds = false;
  for (const a of assignments) {
    const m = /^(?<row>r_[0-9A-Z]{10})(?:=(?<cell>\d+|off))?$/.exec(a)?.groups;
    if (m?.row === undefined) throw new CurateError(`titled: "${a}" is not <rowId>[=<cell>|=off]`);
    const rowId = m.row;
    const at = rows.findIndex((r) => r.attrs?.id === rowId);
    if (at === -1) throw new CurateError(`titled: ${rowId} is not a row of ${blockId}`);
    if (m.cell === "off") {
      delete entries[rowId];
      notes.push(`${rowId}: titled removed`);
      continue;
    }
    const above = rows[at - 1]?.attrs;
    if (!above) throw new CurateError(`titled: ${rowId} is the first row of ${blockId}; no row above it can title it`);
    const aboveId = String(above.id);
    if (above.kind !== "heading") {
      above.kind = "heading";
      kinds = true;
      delete members[aboveId];
      notes.push(`${aboveId} is now a heading row`);
    }
    const cell = Number(m.cell ?? 0);
    entries[rowId] = cell;
    if (st.value.sections.length > 0 && members[rowId] === undefined) {
      const section = rowSection(before, st.value, rowId);
      if (section !== null) members[rowId] = section;
    }
    notes.push(`${rowId}: titled by cell ${cell} of ${aboveId}`);
  }
  const structure: StructureFile = { ...st.value, members, titled: entries };
  if (Object.keys(entries).length === 0) delete structure.titled;
  const changes: Change[] = [{ path: st.path, value: structure }];
  if (kinds) changes.push({ path: `${owner.dir}/${blockId}.json`, value: block });
  return { changes, notes };
}

// ---- structure -----------------------------------------------------------------------------

/** `structure <guide> <system> <file.json>`: the system's `structure.json`. */
export function structure(c: Content, guide: string, system: string, draft: unknown): Planned {
  const g = c.guides.find((x) => x.file.id === guide);
  if (!g?.systems.some((s) => s.file.id === system)) throw new CurateError(`structure: no system ${guide}/${system}`);
  return { changes: [{ path: `content/guides/${guide}/${system}/structure.json`, value: draft }], notes: [] };
}

// ---- pharm parts and cards -----------------------------------------------------------------

interface DraftCard {
  id?: string;
  key?: string;
  aliases: string[];
  home: Partial<Record<GuideId, string>>;
  /** The class card it shows inside; omitted, an existing card keeps its own. */
  in?: string;
  /** The pharm sections its notes are written for; omitted, an existing card keeps its own. */
  for?: string[];
  /** Her words for its wider drug class; omitted, an existing card keeps its own. */
  classWords?: string[];
}
interface DraftPart {
  id?: string;
  role: PharmPart["role"];
  title: string;
  /** A card id, or the `key` of a draft card that has no id yet. */
  card: string | null;
  blocks: string[];
}

/**
 * `pharm-parts <file-slug> <file.json>` with `{ parts, cards }`: the file's parts, and the cards of
 * that file (replacing the file's earlier cards in `cards.json`). Missing part and card ids are
 * assigned. Parts must cover the file's blocks exactly once; every card has at least one part.
 */
export function pharmParts(c: Content, fileSlug: string, draft: { parts?: unknown; cards?: unknown }): Planned {
  const pf = c.pharm.find((p) => p.file.id === fileSlug);
  if (!pf) throw new CurateError(`pharm-parts: no pharm notes file ${fileSlug}`);
  if (!Array.isArray(draft.parts) || !Array.isArray(draft.cards)) throw new CurateError("pharm-parts: the draft needs parts and cards arrays");
  const mint = minter(c);
  const notes: string[] = [];
  const keys = new Map<string, string>();
  const cards = (draft.cards as DraftCard[]).map((d) => {
    const id = d.id ?? mint("c");
    if (d.id === undefined) notes.push(`card ${d.key ?? d.aliases?.[0] ?? "?"} → ${id}`);
    if (d.key !== undefined) {
      if (keys.has(d.key)) throw new CurateError(`pharm-parts: card key "${d.key}" used twice`);
      keys.set(d.key, id);
    }
    const had = c.cards.cards.find((x) => x.id === id);
    const within = d.in ?? had?.in;
    const use = d.for ?? had?.for;
    const words = d.classWords ?? had?.classWords;
    return {
      id, file: fileSlug, aliases: d.aliases, home: d.home,
      ...(within === undefined ? {} : { in: within }), ...(use === undefined ? {} : { for: use }), ...(words === undefined ? {} : { classWords: words }),
    };
  });
  const cardIds = new Set(cards.map((x) => x.id));
  const parts: PharmPart[] = (draft.parts as DraftPart[]).map((d) => {
    const id = d.id ?? mint("p");
    if (d.id === undefined) notes.push(`part ${d.title} → ${id}`);
    const card = d.card === null ? null : (keys.get(d.card) ?? d.card);
    if (card !== null && !cardIds.has(card)) throw new CurateError(`pharm-parts: part "${d.title}" names card ${d.card}, which is not a card of this file`);
    return { id, role: d.role, title: d.title, card, blocks: d.blocks };
  });
  for (const card of cardIds) {
    if (!parts.some((p) => p.card === card)) throw new CurateError(`pharm-parts: card ${card} has no part`);
  }
  const allCards: CardsFile = { v: 1, cards: [...c.cards.cards.filter((x) => x.file !== fileSlug), ...cards] };
  return {
    changes: [
      { path: `content/pharm/${fileSlug}/pharmfile.json`, value: { ...pf.file, parts } },
      { path: "content/pharm/cards.json", value: allCards },
    ],
    notes,
  };
}

/** `cards <file.json>`: the whole `cards.json`. Each card's file must exist and hold a part for it. */
export function cards(c: Content, draft: unknown): Planned {
  const file = draft as CardsFile;
  for (const card of Array.isArray(file?.cards) ? file.cards : []) {
    const pf = c.pharm.find((p) => p.file.id === card.file);
    if (!pf) throw new CurateError(`cards: ${card.id} names pharm notes file ${card.file}, which does not exist`);
    if (!pf.file.parts.some((p) => p.card === card.id)) throw new CurateError(`cards: ${card.id} has no part in ${card.file}`);
  }
  return { changes: [{ path: "content/pharm/cards.json", value: draft }], notes: [] };
}

// ---- general topics and places -------------------------------------------------------------

function checkLinks(links: readonly Link[] | undefined, targets: ReadonlySet<string>, where: string): void {
  requireIds((links ?? []).map((l) => l.target), targets, `${where} links`);
}

/** `general <guide> <file.json>`: an EOR guide's `general.json`. */
export function general(c: Content, guide: string, draft: unknown): Planned {
  const g = c.guides.find((x) => x.file.id === guide);
  if (!g) throw new CurateError(`general: no guide ${guide}`);
  const file = draft as GeneralFile;
  const targets = targetIds(c);
  for (const t of Array.isArray(file?.topics) ? file.topics : []) {
    checkLinks(t.links, targets, `general ${t.key}`);
    requireIds(t.files ?? [], new Set(c.docs.keys()), `general ${t.key} files`);
    requireIds(t.gaps ?? [], new Set(c.gaps.keys()), `general ${t.key} gaps`);
  }
  requireIds((Array.isArray(file?.workup) ? file.workup : []).map((w) => w.gap), new Set(c.gaps.keys()), "general workup");
  return { changes: [{ path: `content/guides/${guide}/general.json`, value: draft }], notes: [] };
}

/** `places <file.json>` with `{ reftabs?, other? }`: `places/reftabs.json` and/or `places/other.json`. */
export function places(c: Content, draft: { reftabs?: RefTabsFile; other?: OtherFile }): Planned {
  if (draft.reftabs === undefined && draft.other === undefined) throw new CurateError("places: the draft needs reftabs and/or other");
  const targets = targetIds(c);
  const docs = new Set(c.docs.keys());
  const gaps = new Set(c.gaps.keys());
  const wordBlocks = new Set([...c.docs.values()].flatMap((d) => (d.kind === "word" && d.file.removed === null ? d.blocks.map((b) => b.id) : [])));
  const checkNotes = (notes: readonly PlaceNote[] | undefined, where: string): void =>
    requireIds((notes ?? []).flatMap((n) => ("block" in n ? [n.block] : [])), wordBlocks, `${where} notes`);
  const changes: Change[] = [];
  if (draft.reftabs !== undefined) {
    for (const tab of ["labs", "imaging", "ekg", "anatomy"] as const) {
      const t = draft.reftabs[tab];
      for (const s of t?.subs ?? []) {
        checkNotes(s.notes, `reftabs ${tab}/${s.id}`);
        checkLinks(s.links, targets, `reftabs ${tab}/${s.id}`);
        requireIds(s.gaps ?? [], gaps, `reftabs ${tab}/${s.id} gaps`);
      }
      requireIds(t?.files ?? [], docs, `reftabs ${tab} files`);
    }
    changes.push({ path: "content/places/reftabs.json", value: draft.reftabs });
  }
  if (draft.other !== undefined) {
    for (const s of draft.other.sections ?? []) {
      checkNotes(s.notes, `other ${s.id}`);
      checkLinks(s.links, targets, `other ${s.id}`);
      requireIds(s.files ?? [], docs, `other ${s.id} files`);
      requireIds([...(s.gaps ?? []), ...(s.lead ? [s.lead] : [])], gaps, `other ${s.id} gaps`);
    }
    changes.push({ path: "content/places/other.json", value: draft.other });
  }
  return { changes, notes: [] };
}

// ---- gap blocks ----------------------------------------------------------------------------

/** Number tokens of a text (digits with any decimal or thousands separators). */
const numbers = (text: string): string[] => text.match(/\d+(?:[.,]\d+)*/g) ?? [];

/**
 * `gap <g_id> <file.json>` with `{ block, evidence }`: a gap block and its evidence file (90 §90.4).
 * `<g_id>` is the block's id, or `new` to assign one.
 */
export function gap(c: Content, gapId: string, draft: { block?: GapFile; evidence?: EvidenceFile }): Planned {
  const { block, evidence } = draft;
  if (!block || !evidence) throw new CurateError("gap: the draft needs block and evidence");
  const notes: string[] = [];
  let id = gapId;
  if (gapId === "new") {
    id = minter(c)("g");
    notes.push(`gap block → ${id}`);
  } else if (!isId("g", gapId)) {
    throw new CurateError(`gap: ${gapId} is not a g_ id or "new"`);
  } else if (block.id !== undefined && block.id !== gapId) {
    throw new CurateError(`gap: block.id ${block.id} differs from ${gapId}`);
  }
  if (evidence.author === evidence.verification?.verifier) throw new CurateError("gap: the verifier must be a different session from the author");
  const sources = block.meta?.sources ?? [];
  (evidence.claims ?? []).forEach((cl, i) => {
    if (!Number.isInteger(cl.source) || cl.source < 0 || cl.source >= sources.length) throw new CurateError(`gap: claim ${i} names source ${cl.source}, which the block does not have`);
    for (const n of numbers(cl.text)) if (!numbers(cl.quote).includes(n)) throw new CurateError(`gap: claim ${i} has the number ${n}, which its quote lacks`);
  });
  return {
    changes: [
      { path: `content/gapfill/${id}.json`, value: { ...block, id } },
      { path: `content/gapfill/${id}.evidence.json`, value: { ...evidence, block: id } },
    ],
    notes,
  };
}

// ---- generated slides ----------------------------------------------------------------------

interface DraftSlide {
  id?: string;
  doc: DocJSON;
  meta: SlideMeta;
}

/** Each row's stored text by row id, over every guide. */
function rowTexts(c: Content): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (n: PMNode): void => {
    if (n.type === "table_row" && typeof n.attrs?.id === "string") out.set(n.attrs.id, nodeText(n));
    else for (const k of n.content ?? []) walk(k);
  };
  for (const g of c.guides) for (const s of g.systems) for (const b of s.blocks) walk(b.doc as PMNode);
  return out;
}

/**
 * `slides <guide> <file.json>` with `{ title, slides }`: the guide's generated deck and its slide
 * blocks (90 §90.5). Slide 1 is the contents slide, holding only the deck title. Missing slide ids
 * are assigned; slide blocks no longer listed are deleted.
 */
export function slides(c: Content, guide: string, draft: { title?: string; slides?: DraftSlide[] }): Planned {
  if (!c.guides.some((g) => g.file.id === guide)) throw new CurateError(`slides: no guide ${guide}`);
  const old = c.decks.get(guide);
  if (old && old.file.kind !== "generated") throw new CurateError(`slides: ${guide} has her own deck; only generated decks are written here`);
  const { title, slides: list } = draft;
  const contents = Array.isArray(list) ? list[0] : undefined;
  if (typeof title !== "string" || !Array.isArray(list) || contents === undefined) throw new CurateError("slides: the draft needs a title and at least the contents slide");
  const only = contents.doc?.content as PMNode[] | undefined;
  const line = only?.length === 1 ? only[0] : undefined;
  if (line?.type !== "heading_line" || collapse(nodeText(line)) !== collapse(title)) {
    throw new CurateError("slides: slide 1 is the contents slide and holds only the deck title");
  }
  const rowsById = rowTexts(c);
  const mint = minter(c);
  const notes: string[] = [];
  const dir = `content/slides/${guide}/blocks`;
  const changes: Change[] = [];
  const ids = list.map((s, i) => {
    const id = s.id ?? mint("s");
    if (s.id === undefined) notes.push(`slide ${i + 1} → ${id}`);
    requireIds(s.meta?.summarizes ?? [], new Set(rowsById.keys()), `slide ${i + 1} summarizes`);
    (s.meta?.evidence ?? []).forEach((e, j) => {
      const text = rowsById.get(e.row);
      if (text === undefined) throw new CurateError(`slide ${i + 1} evidence ${j}: ${e.row} names no row`);
      if (!text.includes(e.quote)) throw new CurateError(`slide ${i + 1} evidence ${j}: the quote is not in ${e.row}'s text`);
    });
    changes.push({ path: `${dir}/${id}.json`, value: { v: 1, id, kind: "slide", doc: s.doc, meta: s.meta ?? {} } });
    return id;
  });
  const deck: DeckFile = { v: 1, guide: guide as GuideId, kind: "generated", title, file: null, slides: ids };
  changes.push({ path: `content/slides/${guide}/deck.json`, value: deck });
  for (const s of old?.slides ?? []) if (!ids.includes(s.id)) changes.push({ path: `${dir}/${s.id}.json`, value: null });
  return { changes, notes };
}

// ---- guideline flags and concepts ----------------------------------------------------------

/**
 * `flags <file.json>` with `{ flags }`: appends researched (`by: "agent"`) flags, assigning `u_` ids;
 * each new flag supersedes the earlier current flag with the same key (90 §90.6).
 */
export function flags(c: Content, draft: { flags?: Omit<Flag, "id" | "supersededBy">[] }): Planned {
  if (!Array.isArray(draft.flags) || draft.flags.length === 0) throw new CurateError("flags: the draft needs a non-empty flags array");
  const taken = takenIds(c);
  const all: Flag[] = clone(c.flags.flags);
  const notes: string[] = [];
  for (const f of draft.flags) {
    if (f.by !== "agent") throw new CurateError(`flags: "${f.key}" must be by "agent"`);
    if ("id" in f || "supersededBy" in f) throw new CurateError(`flags: "${f.key}" must not carry id or supersededBy; they are assigned`);
    const { id, superseded } = addFlag(all, f, taken);
    for (const prev of superseded) notes.push(`${prev} superseded by ${id}`);
    notes.push(`flag ${f.key} → ${id}`);
  }
  const file: FlagsFile = { v: 1, flags: all };
  return { changes: [{ path: "content/updates/flags.json", value: file }], notes };
}

/**
 * `concepts <file.json>`: the whole `updates/concepts.json`. Refuses targets that name nothing and
 * source keys no flag of that source carries (the build places flags by key).
 */
export function concepts(c: Content, draft: unknown): Planned {
  const file = draft as ConceptsFile;
  const targets = targetIds(c);
  for (const k of Array.isArray(file?.concepts) ? file.concepts : []) {
    requireIds(k.targets ?? [], targets, `concept ${k.id} targets`);
    for (const [source, keys] of Object.entries(k.sourceKeys ?? {})) {
      for (const key of keys) {
        if (!c.flags.flags.some((f) => f.source === source && f.key === key)) {
          throw new CurateError(`concept ${k.id}: no ${source} flag carries "${key}"`);
        }
      }
    }
  }
  return { changes: [{ path: "content/updates/concepts.json", value: draft }], notes: [] };
}
