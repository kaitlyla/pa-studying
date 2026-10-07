// What a condition topic's meds panel shows (40 §40.5, pharm/meds-panel), read the same way by the
// reader and the editor: its entries with her own panel for the topic applied (content MedsFile), and
// each entry's content as pieces — her guide rows and her pharm notes, cut and trimmed as published,
// or her own version of them. Browser-safe.
import { isId } from "../content/ids.ts";
import type { MedsFile, MedsPiece } from "../content/types.ts";
import { noteView, rowsView } from "./columns.ts";
import type { PartCut, PubBlock, PubMedsCard, PubMedsClass, PubMedsEdit, PubTopic, SystemJson } from "./published.ts";
import { allLinesHidden, hiddenLines, panelUses, shownParts, withoutLines } from "./trim.ts";

/** A piece as the panel shows it: the stored piece, and the pharm part it shows (search lands on it), if any. */
export interface PanelPiece extends MedsPiece {
  part: string | null;
}

/** One entry of a panel and, when she edited it for this topic, her version of it. */
export interface PanelEntry {
  med: PubMedsCard;
  own: MedsPiece[] | null;
}

/** The entries a topic's meds panel shows: its own less those she took off, then the cards she added. */
export function panelEntries(topic: Pick<PubTopic, "meds" | "medsEdit">): PanelEntry[] {
  const e = topic.medsEdit;
  if (!e) return topic.meds.map((med) => ({ med, own: null }));
  const kept = topic.meds.filter((m) => !e.remove.includes(m.target));
  const shown = new Set(kept.map((m) => m.target));
  return [...kept, ...e.add.filter((m) => !shown.has(m.target))].map((med) => ({ med, own: e.own[med.target] ?? null }));
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
 * Her own panel for a topic as published: `derived` is the panel worked out from her notes, `card`
 * the entry a card she added shows as (null when the site has no such card). Her versions of entries
 * the panel does not show are left out. `missing` gets each target that names nothing the panel could
 * show.
 */
export function publishedEdit(
  file: MedsFile, derived: readonly PubMedsCard[], card: (id: string) => PubMedsClass | null, missing: (target: string) => void = () => undefined,
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
  for (const o of file.own) {
    if (file.remove.includes(o.target)) continue;
    if (!has.has(o.target) && !add.some((m) => m.target === o.target)) {
      missing(o.target);
      continue;
    }
    own[o.target] = o.pieces;
  }
  for (const t of file.remove) if (!has.has(t)) missing(t);
  return { remove: [...file.remove], add, own };
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
