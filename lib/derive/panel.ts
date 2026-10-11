// What a condition topic's meds panel shows (40 §40.5, pharm/meds-panel), read the same way by the
// reader and the editor: its entries with her own panel for the topic applied (content MedsFile), and
// each entry's content as pieces — her guide rows and her pharm notes, cut and trimmed as published,
// or her own version of them. Browser-safe.
import { isId } from "../content/ids.ts";
import { MEDS_ROLES, type DocJSON, type MedsClassGroup, type MedsFile, type MedsPiece, type MedsRoleTag } from "../content/types.ts";
import { placeCells } from "../wordFormat.ts";
import { keepTableRows, noteView, rowsView } from "./columns.ts";
import type { PartCut, PubBlock, PubGap, PubMedsCard, PubMedsClass, PubMedsEdit, PubTopic, SystemJson } from "./published.ts";
import { collapse, nodeText, type PMNode } from "./text.ts";
import { allLinesHidden, hiddenLines, panelUses, repeatedLines, shownParts, withoutLines } from "./trim.ts";

/** A piece as the panel shows it: the stored piece, and the pharm part it shows (search lands on it), if any. */
export interface PanelPiece extends MedsPiece {
  part: string | null;
}

/**
 * One entry of a panel and, when she edited it for this topic, her version of it, with the gap block
 * her version shows under its pieces (null when it has none, and always when the entry is not hers).
 */
export interface PanelEntry {
  med: PubMedsCard;
  own: MedsPiece[] | null;
  gap: PubGap | null;
}

/** The entries a topic's meds panel shows: its own less those she took off, then the cards she added. */
export function panelEntries(topic: Pick<PubTopic, "meds" | "medsEdit">): PanelEntry[] {
  const e = topic.medsEdit;
  if (!e) return topic.meds.map((med) => ({ med, own: null, gap: null }));
  const kept = topic.meds.filter((m) => !e.remove.includes(m.target));
  const shown = new Set(kept.map((m) => m.target));
  return [...kept, ...e.add.filter((m) => !shown.has(m.target))].map((med) => {
    const own = e.own[med.target] ?? null;
    return { med, own, gap: own ? (e.ownGaps[med.target] ?? null) : null };
  });
}

/**
 * The cards her file adds to a panel that works out the entries `derived`: those she added, then each
 * card she edited that the panel no longer works out and she did not take off, so a later change to
 * her notes never loses her version. The reader and the editor both read the file's adds this way.
 */
export function fileAdds(file: MedsFile, derived: ReadonlySet<string>): string[] {
  const add: string[] = [];
  for (const id of file.add) if (!add.includes(id)) add.push(id);
  for (const o of file.own) {
    const t = o.target;
    if (isId("c", t) && !derived.has(t) && !file.remove.includes(t) && !add.includes(t)) add.push(t);
  }
  return add;
}

/**
 * Her versions in a file of entries she did not take off: only these can show, with their gap blocks.
 * The published panel and the gap block's placement on the dx page both read them this way.
 */
export function keptOwn(file: MedsFile): MedsFile["own"] {
  return file.own.filter((o) => !file.remove.includes(o.target));
}

/**
 * Her own panel for a topic as published: `derived` is the panel worked out from her notes, `card`
 * the entry a card she added shows as (null when the site has no such card). Her versions of entries
 * the panel does not show are left out. `missing` gets each target that names nothing the panel could
 * show.
 */
export function publishedEdit(
  file: MedsFile, derived: readonly PubMedsCard[], card: (id: string) => PubMedsClass | null, missing: (target: string) => void = () => undefined,
  gap: (id: string) => PubGap | null = () => null,
): PubMedsEdit {
  const has = new Set(derived.map((m) => m.target));
  const add: PubMedsClass[] = [];
  for (const id of fileAdds(file, has)) {
    if (has.has(id) || file.remove.includes(id)) continue;
    const entry = card(id);
    if (entry) add.push(entry);
    else if (file.add.includes(id)) missing(id);
  }
  const own: Record<string, MedsPiece[]> = {};
  const ownGaps: Record<string, PubGap> = {};
  for (const o of keptOwn(file)) {
    if (!has.has(o.target) && !add.some((m) => m.target === o.target)) {
      missing(o.target);
      continue;
    }
    own[o.target] = o.pieces;
    if (o.gap === undefined) continue;
    const g = gap(o.gap);
    if (g) ownGaps[o.target] = g;
    else missing(o.gap);
  }
  const gaps: PubGap[] = [];
  for (const id of file.gaps ?? []) {
    const g = gap(id);
    if (g) gaps.push(g);
    else missing(id);
  }
  const shows = (t: string): boolean => has.has(t) || add.some((m) => m.target === t) || gaps.some((g) => g.id === t);
  for (const t of file.remove) if (!isId("g", t) && !has.has(t)) missing(t);
  const roles: Record<string, MedsRoleTag[]> = {};
  for (const r of file.roles ?? []) {
    if (shows(r.target)) roles[r.target] = r.roles;
    else missing(r.target);
  }
  const classes: MedsClassGroup[] = [];
  for (const c of file.classes ?? []) {
    const members = c.members.filter(shows);
    for (const t of c.members) if (!shows(t)) missing(t);
    if (members.length > 1) classes.push({ title: c.title, members });
  }
  return { remove: [...file.remove], add, own, ownGaps, gaps, roles, classes };
}

/** One entry of a meds panel: a card (as `panelEntries` gives it) or a sourced card she placed (a gap block), with its role labels. */
export type PanelEntryItem =
  | { kind: "card"; entry: PanelEntry; roles: MedsRoleTag[] }
  | { kind: "gap"; gap: PubGap; roles: MedsRoleTag[] };

/**
 * What a meds panel shows under one header: an entry, or one of her drug classes — its entries
 * (`members`, in her order, each with its own title and role labels) under the class's title, labeled
 * with every role of its members, each role once.
 */
export type PanelItem = PanelEntryItem | ({ kind: "class" } & ClassOf<PanelEntryItem>);

/** The target an entry item shows (its card, row or part target, or its gap block's id). */
export function itemTarget(item: PanelEntryItem): string {
  return item.kind === "card" ? item.entry.med.target : item.gap.id;
}

/** Each role label of `tags` once, in order (labels alike in role, drugs and note are one label). */
function rolesOnce(tags: readonly MedsRoleTag[]): MedsRoleTag[] {
  const out: MedsRoleTag[] = [];
  for (const r of tags) {
    if (!out.some((o) => o.role === r.role && o.drugs === r.drugs && o.note === r.note)) out.push(r);
  }
  return out;
}

/** One of her drug classes as a panel shows it: its title, its entries shown (in her order), and their roles, each once. */
export interface ClassOf<T> {
  title: string;
  members: T[];
  roles: MedsRoleTag[];
}

/**
 * A panel's entries `entries` (in panel order) under one header each: an entry, or each of her drug
 * `classes` with two or more of its members shown, where its first shown member would be; ordered by
 * role. The reader and the editor both group their entries this way.
 */
export function withClasses<T>(
  entries: readonly T[], target: (item: T) => string, roles: (item: T) => readonly MedsRoleTag[], classes: readonly MedsClassGroup[],
): (T | ClassOf<T>)[] {
  const byTarget = new Map(entries.map((x) => [target(x), x]));
  const classOf = new Map<string, ClassOf<T>>();
  for (const c of classes) {
    const members = c.members.flatMap((t) => byTarget.get(t) ?? []);
    if (members.length < 2) continue;
    const cls: ClassOf<T> = { title: c.title, members, roles: rolesOnce(members.flatMap(roles)) };
    for (const m of members) classOf.set(target(m), cls);
  }
  const items: { item: T | ClassOf<T>; roles: readonly MedsRoleTag[] }[] = [];
  for (const x of entries) {
    const cls = classOf.get(target(x));
    if (!cls) items.push({ item: x, roles: roles(x) });
    else if (!items.some((i) => i.item === cls)) items.push({ item: cls, roles: cls.roles });
  }
  return byRole(items, (x) => x.roles).map((x) => x.item);
}

/** Where entries with these role labels go: by their first-ranked role (1st → 2nd → alt → adjunct), unlabeled last. */
export function roleRank(roles: readonly MedsRoleTag[]): number {
  return Math.min(MEDS_ROLES.length, ...roles.map((r) => MEDS_ROLES.indexOf(r.role)));
}

/** `items` ordered by their roles' rank, keeping her order within a rank. */
export function byRole<T>(items: readonly T[], roles: (item: T) => readonly MedsRoleTag[]): T[] {
  return items.map((item, i) => ({ item, i, rank: roleRank(roles(item)) })).sort((a, b) => a.rank - b.rank || a.i - b.i).map((x) => x.item);
}

/**
 * What a topic's meds panel shows, in order: its entries, then the sourced cards she did not take off,
 * each of her drug classes under one header where its first member would be, ordered by role.
 */
export function panelItems(topic: Pick<PubTopic, "meds" | "medsEdit">): PanelItem[] {
  const e = topic.medsEdit;
  const roles = e?.roles ?? {};
  const cards = panelEntries(topic).map((entry): PanelEntryItem => ({ kind: "card", entry, roles: roles[entry.med.target] ?? [] }));
  const gaps = (e?.gaps ?? []).filter((g) => !e?.remove.includes(g.id)).map((gap): PanelEntryItem => ({ kind: "gap", gap, roles: roles[gap.id] ?? [] }));
  return withClasses([...cards, ...gaps], itemTarget, (x) => x.roles, e?.classes ?? []).map((x): PanelItem => ("kind" in x ? x : { kind: "class", ...x }));
}

/**
 * A card she added to a topic's panel as a system page `sys` can show it: as the build added it to a
 * panel of the page, else from its Pharm section here, else from another panel entry of it. Null when
 * the page has none of the card's notes (the overlay and the editor read one page; the card shows once
 * the site is rebuilt).
 */
export function pageCard(sys: Pick<SystemJson, "id" | "topics" | "cards" | "pharm">, id: string): PubMedsClass | null {
  const added = sys.topics.flatMap((x) => x.medsEdit?.add ?? []).find((e) => e.card === id);
  if (added) return added;
  const card = sys.cards[id];
  if (!card) return null;
  const section = sys.pharm?.sections.find((s) => s.cards.includes(id));
  if (section) return { card: id, title: card.title, rows: [], section: section.id, system: sys.id, target: id };
  const listed = sys.topics.flatMap((x) => x.meds).find((e): e is PubMedsClass => e.part === undefined && e.card === id);
  return { card: id, title: card.title, rows: [], section: listed?.section ?? "", system: listed?.system ?? null, target: id };
}

/** Runs of consecutive rows from the same table block. */
function rowRuns(system: Pick<SystemJson, "blocks" | "rows">, rows: readonly string[]): { block: PubBlock; rows: string[] }[] {
  const blocks = new Map(system.blocks.map((b) => [b.id, b]));
  const out: { block: PubBlock; rows: string[] }[] = [];
  for (const id of rows) {
    const r = system.rows[id];
    const b = r ? blocks.get(r.block) : undefined;
    if (!b) continue;
    const last = out[out.length - 1];
    if (last && last.block.id === b.id) last.rows.push(id);
    else out.push({ block: b, rows: [id] });
  }
  return out;
}

/** A pharm-notes part as shown: its blocks, its cut, and its file (when not the card's own). */
interface NotesPart extends PartCut {
  id: string;
  blocks: readonly string[];
  file?: string;
  basePt?: number;
}

/** Her notes of `parts`, each block as shown (cut, less the lines in `hidden`), one piece per block that shows. */
function notesPieces(system: SystemJson, parts: readonly NotesPart[], file: string, basePt: number, hidden?: ReadonlyMap<string, ReadonlySet<number>>): PanelPiece[] {
  return parts.flatMap((p) => p.blocks.flatMap((id): PanelPiece[] => {
    const b = system.notesBlocks[id];
    const view = b ? noteView(withoutLines(b.doc, hidden?.get(id)), p, { firstRow: false }) : null;
    if (!view || view.doc.content.length === 0) return [];
    return [{ kind: "notes", basePt: p.basePt ?? basePt, title: view.title, file: p.file ?? file, doc: view.doc, part: p.id }];
  }));
}

/**
 * What a panel entry shows of the card as published, as pieces in order: its rows of her guide's drug
 * tables (at the guide's base size `guideBasePt`), then her pharm notes on it. A card with guide rows
 * here shows the notes written for this condition's uses, less what those rows already say; a card
 * without rows here shows what its pharm section shows. A part of her pharm notes attached to the
 * topic shows that part.
 */
export function entryPieces(system: SystemJson, topic: Pick<PubTopic, "title" | "section">, m: PubMedsCard, guideBasePt: number): PanelPiece[] {
  if (m.part !== undefined) {
    const part = system.parts[m.part];
    return part ? notesPieces(system, [{ ...part, id: m.part }], part.file, part.basePt) : [];
  }
  const rows = rowRuns(system, m.rows).flatMap((run): PanelPiece[] => {
    const doc = rowsView(run.block.doc, run.rows, { firstRow: false });
    return doc ? [{ kind: "rows", basePt: guideBasePt, title: null, file: null, doc, part: null }] : [];
  });
  const card = m.card ? system.cards[m.card] : undefined;
  if (!card) return rows;
  const at = m.rows.length > 0 ? panelUses(system, topic) : new Set([m.section]);
  const parts = shownParts(card, at, topic.title);
  const notes = parts.flatMap((p) => p.blocks);
  const hidden = hiddenLines(system, notes, new Set(m.rows), at);
  if (notes.length === 0 || allLinesHidden(system, notes, hidden)) return rows;
  return [...rows, ...notesPieces(system, parts, card.file, card.basePt, hidden)];
}

/** What an entry shows: her version when she edited it for this topic, else the card as published. */
export function shownPieces(system: SystemJson, topic: Pick<PubTopic, "title" | "section">, entry: PanelEntry, guideBasePt: number): PanelPiece[] {
  return entry.own ? entry.own.map((p) => ({ ...p, part: null })) : entryPieces(system, topic, entry.med, guideBasePt);
}

/**
 * What each entry of a panel item shows (in its order; a sourced card shows its gap block, no
 * pieces): an entry's pieces, or one of her drug classes' entries' pieces with each fact once
 * (`classPieces`). The reader's panel and its search text read them this way.
 */
export function itemPieces(system: SystemJson, topic: Pick<PubTopic, "title" | "section">, item: PanelItem, guideBasePt: number): PanelPiece[][] {
  const pieces = (m: PanelEntryItem): PanelPiece[] => (m.kind === "card" ? shownPieces(system, topic, m.entry, guideBasePt) : []);
  return item.kind === "class" ? classPieces(item.members.map(pieces), rowSource(system)) : [pieces(item)];
}

/**
 * The anchor of the card one of her drug classes shows as, by its first entry's target: its own, so
 * no entry inside it shares it (each entry keeps its own anchor, where search lands). An entry is in
 * one class at most, so no two classes share it.
 */
export const classAnchor = (firstTarget: string): string => `meds-class-${firstTarget}`;

/** A table row of her files: the block it is in, its table there, and its index in that table. */
interface SourceRow {
  block: string;
  table: PMNode;
  index: number;
}

/** Her files' table rows by row id (shown rows, cut or in her own version, keep their ids). */
export type RowSource = (row: string) => SourceRow | undefined;

const sourceRows = new WeakMap<object, Map<string, SourceRow>>();

/** The table rows of a system's guide and pharm-notes blocks, by row id. */
export function rowSource(system: Pick<SystemJson, "blocks" | "notesBlocks">): RowSource {
  let rows = sourceRows.get(system);
  if (!rows) {
    const map = new Map<string, SourceRow>();
    for (const b of [...system.blocks, ...Object.values(system.notesBlocks)]) {
      for (const table of b.doc.content as PMNode[]) {
        if (table.type !== "table") continue;
        (table.content ?? []).forEach((r, index) => {
          const id = r.attrs?.id;
          if (typeof id === "string") map.set(id, { block: b.id, table, index });
        });
      }
    }
    sourceRows.set(system, map);
    rows = map;
  }
  const found = rows;
  return (id) => found.get(id);
}

const rowIdOf = (row: PMNode | undefined): string | null => (typeof row?.attrs?.id === "string" ? row.attrs.id : null);

/**
 * The one merged cell of her files that a shown cell at grid column `col` of row `rowId`, reading
 * `text`, copies — a cell merged down over several of her rows, which a cut of each of those rows
 * repeats — as its block and place there, with the text shown (her own version of a cut may have
 * changed a copy, which then says something else); null for a cell that is no such copy.
 */
function mergedOrigin(source: RowSource, rowId: string | null, col: number, text: string): string | null {
  const s = rowId === null ? undefined : source(rowId);
  if (!s || text === "") return null;
  const cell = placeCells(s.table.content ?? []).cells.find((p) => p.row <= s.index && s.index < p.row + p.rowspan && p.col <= col && col < p.col + p.colspan);
  if (!cell || cell.rowspan < 2) return null;
  return `${s.block}#${String(cell.row)}:${String(cell.col)}\n${text}`;
}

/** A table one of her drug classes showed: its first row's id and text, the entry it is under, and the merged cells of her files it showed. */
interface ShownTable {
  first: string | null;
  firstText: string;
  member: number;
  origins: Set<string>;
}

/** The text of a table's first row, its cells in order. */
const firstRowText = (table: PMNode): string => (table.content?.[0]?.content ?? []).map((c) => collapse(nodeText(c))).join(" | ");

/** A cell without its text: one empty paragraph, as an empty cell is stored. */
function emptied(cell: PMNode): PMNode {
  const first = cell.content?.[0];
  return { ...cell, content: [{ type: "paragraph", ...(first?.attrs ? { attrs: first.attrs } : {}) }] };
}

/**
 * `table`, under entry `member` of a class, as the class shows it after the table `last`. A table
 * carrying on `last` — under a later entry and cut from the same table of hers, starting with the same
 * row of it reading the same, as when one of her pharm tables is cut into rows for several entries,
 * each under her column labels — shows without that first row and without each copy of a merged cell
 * `last` already showed (a cell merged down over her rows, which each cut repeats); a row with nothing
 * else left goes, and the table goes with no row left. Any other cell stays, whatever it says: the
 * same words in another drug's own cell are a fact about that drug.
 */
function carriedOn(table: PMNode, member: number, last: ShownTable | null, source: RowSource): { table: PMNode | null; shown: ShownTable } {
  const rows = table.content ?? [];
  const cells = placeCells(rows).cells;
  const origin = new Map<PMNode, string>();
  for (const c of cells) {
    const o = mergedOrigin(source, rowIdOf(rows[c.row]), c.col, collapse(nodeText(c.node)));
    if (o !== null) origin.set(c.node, o);
  }
  const first = rowIdOf(rows[0]);
  const firstText = firstRowText(table);
  const origins = new Set(origin.values());
  const own = { first, firstText, member, origins };
  if (!last || last.member === member || first === null || last.first !== first || last.firstText !== firstText) return { table, shown: own };
  const shown = { ...own, origins: new Set([...last.origins, ...origins]) };
  const repeat = new Set<PMNode>();
  const kept = rows.map(() => false);
  for (const c of cells) {
    if (c.row === 0 || collapse(nodeText(c.node)) === "") continue;
    const o = origin.get(c.node);
    if (o !== undefined && last.origins.has(o) && c.node.content?.[0]?.type === "paragraph") repeat.add(c.node);
    else kept[c.row] = true;
  }
  const blanked = { ...table, content: rows.map((r) => ({ ...r, content: (r.content ?? []).map((c) => (repeat.has(c) ? emptied(c) : c)) })) };
  return { table: kept.includes(true) ? keepTableRows(blanked, kept) : null, shown };
}

/** Whether a doc's nodes show anything: a table, or a line with text. */
const showsAny = (nodes: readonly PMNode[]): boolean => nodes.some((n) => n.type !== "paragraph" || collapse(nodeText(n)) !== "");

/**
 * What a piece of entry `member` is about: its title — the column it shows, or its first line, which
 * names the drug or class in her notes — or, without one, the entry itself.
 */
function subjectOf(p: PanelPiece, member: number): string {
  if (p.title !== null) return `title:${collapse(p.title)}`;
  const first = (p.doc.content as PMNode[])[0];
  const text = first?.type === "paragraph" ? collapse(nodeText(first)) : "";
  return text === "" ? `entry:${String(member)}` : `title:${text}`;
}

/**
 * Her entries' pieces (`members`, in the class's order) as one of her drug classes shows them under
 * its one title, each fact once — her ruling for one card on a drug class from several of her files,
 * applied to the class. A fact repeats only when it is the same fact about the same thing: a notes
 * line an earlier piece about the same drug or class (`subjectOf`) already said word for word under the
 * same lines (`repeatedLines`), and, where a table carries on a cut of the same rows of her table, its
 * column labels and the copies of a cell her table merges over those rows (`carriedOn`, which finds
 * the rows in `source`). The same words about another drug stay. A piece left with nothing goes.
 * Display only: her files keep every line.
 */
export function classPieces(members: readonly (readonly PanelPiece[])[], source: RowSource): PanelPiece[][] {
  const seen = new Set<string>();
  let last: ShownTable | null = null;
  return members.map((pieces, member) =>
    pieces.flatMap((p): PanelPiece[] => {
      const nodes = p.doc.content as PMNode[];
      const hidden = repeatedLines(nodes, seen, subjectOf(p, member));
      const content = nodes.flatMap((n, i): PMNode[] => {
        if (hidden.has(i)) return [];
        if (n.type !== "table") return [n];
        const shown = carriedOn(n, member, last, source);
        last = shown.shown;
        return shown.table ? [shown.table] : [];
      });
      return showsAny(content) ? [{ ...p, doc: { ...p.doc, content } as DocJSON }] : [];
    }),
  );
}
