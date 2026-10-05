// Pharm cards, alias matching, pharm sections, drug-table stubs and meds panels (plan 40 §40.4–§40.5).
import type { CardsFile, StructureFile, UsesFile } from "../content/types.ts";
import { escapeRegExp } from "../search/index.ts";
import { BuildError } from "./errors.ts";
import { collapse, firstCell, type Row, type Table } from "./text.ts";
import { withHeadings, type SystemTopics, type Topic } from "./topics.ts";

export type Card = CardsFile["cards"][number];

const matcherCache = new Map<string, (text: string) => boolean>();

/** The whole-word, case-insensitive alternation of the phrases on NFC text, or null for none. */
function phraseSource(phrases: readonly string[], prefix = ""): string | null {
  const alts = phrases.map((p) => p.normalize("NFC")).filter((p) => p.trim() !== "").map(escapeRegExp);
  // Longest first, so a phrase inside a longer one ("loop diuretic" in "loop diuretics") never wins its place.
  alts.sort((a, b) => b.length - a.length);
  return alts.length > 0 ? `(?<![\\p{L}\\p{N}])${prefix}(?:${alts.join("|")})(?![\\p{L}\\p{N}])` : null;
}

/** A whole-word, case-insensitive matcher for any of the phrases, on NFC text (40 §40.4). */
export function phraseMatcher(phrases: readonly string[]): (text: string) => boolean {
  const source = phraseSource(phrases);
  const key = source ?? "";
  const cached = matcherCache.get(key);
  if (cached) return cached;
  let test: (text: string) => boolean = () => false;
  if (source !== null) {
    const re = new RegExp(source, "iu");
    test = (text) => re.test(text.normalize("NFC"));
  }
  matcherCache.set(key, test);
  return test;
}

/** Her negative sign before a class word ("⊖inotropes", "(-) inotropes", "negative inotropes"): the opposite class. */
const NEGATIVE_SIGN = String.raw`(?<!(?:⊖|\(\s*[-−]\s*\)|negative)\s*)`;

/** Her words that make the rest of an item drugs to avoid ("avoid vasodilators", "AVOID nitrates, diuretics"). */
const AVOID = /(?<![\p{L}\p{N}])(?:avoid|no|not|contraindicated|hold|CI)(?![\p{L}\p{N}])/iu;

/** Where an item of her notes ends: a new line, a bullet or numbered point, or a semicolon. */
const ITEM_END = /[\n;▪•»➀-➓]/gu;

/** Whether the item of `text` holding position `at` says to avoid what follows, before `at`. */
function avoidedAt(text: string, at: number): boolean {
  let start = 0;
  for (const m of text.slice(0, at).matchAll(ITEM_END)) start = m.index + 1;
  return AVOID.test(text.slice(start, at));
}

/**
 * Matches texts against the class cards. A class card stands for its whole group: itself and the
 * cards shown inside it (`in`), whose aliases, files and homes count as its own.
 */
export class CardMatcher {
  /** Every card of `cards.json`, members included. */
  readonly all: readonly Card[];
  /** The class cards (in no other card), in `cards.json` order. */
  readonly cards: readonly Card[];
  private readonly members: Map<string, Card[]>;
  private readonly tests: ((text: string) => boolean)[];
  /** Per class card, its group's class words under no negative sign (global), or null. */
  private readonly classWords: (RegExp | null)[];
  /** Every card's aliases (global), or null. */
  private readonly aliases: RegExp | null;

  constructor(cards: readonly Card[]) {
    this.all = cards;
    this.cards = cards.filter((c) => c.in === undefined);
    this.members = new Map(this.cards.map((c) => [c.id, [c, ...cards.filter((m) => m.in === c.id)]]));
    this.tests = this.cards.map((c) => phraseMatcher(this.membersOf(c.id).flatMap((m) => m.aliases)));
    const global = (source: string | null): RegExp | null => (source === null ? null : new RegExp(source, "giu"));
    this.classWords = this.cards.map((c) => global(phraseSource(this.membersOf(c.id).flatMap((m) => m.classWords ?? []), NEGATIVE_SIGN)));
    this.aliases = global(phraseSource(cards.flatMap((c) => c.aliases)));
  }

  /** Ids of the class cards with an alias in `text`, in `cards.json` order. */
  matching(text: string): string[] {
    return this.cards.filter((_, i) => this.tests[i]?.(text)).map((c) => c.id);
  }

  /** The class card first, then the cards shown inside it in `cards.json` order. */
  membersOf(classId: string): Card[] {
    return this.members.get(classId) ?? [];
  }

  /** The class card a card shows as: its `in`, else itself. */
  classOf(cardId: string): string {
    return this.all.find((c) => c.id === cardId)?.in ?? cardId;
  }

  /** The pharm files the class card's group comes from. */
  filesOf(classId: string): Set<string> {
    return new Set(this.membersOf(classId).map((m) => m.file));
  }

  /** True when any alias of the class card's group occurs in `text`. */
  cardIn(classId: string, text: string): boolean {
    const i = this.cards.findIndex((c) => c.id === classId);
    return i >= 0 && (this.tests[i]?.(text) ?? false);
  }

  /**
   * Ids of the class cards that her words for a drug class (`classWords`) name in a condition's
   * treatment text: "diuretics" names her loop, thiazide and potassium-sparing cards at once. A class
   * word inside a card's own name ("loop diuretics") names only that card, through its alias; one under
   * her negative sign ("⊖inotropes"), or after "avoid", "no", "not", "contraindicated", "hold" or "CI"
   * in the same item ("AVOID nitrates, diuretics"), names nothing.
   */
  namedByClassWords(text: string): Set<string> {
    const nfc = text.normalize("NFC");
    const masked = this.aliases ? nfc.replace(this.aliases, (m) => " ".repeat(m.length)) : nfc;
    const named = new Set<string>();
    this.cards.forEach((c, i) => {
      const re = this.classWords[i];
      if (re && [...masked.matchAll(re)].some((m) => !avoidedAt(masked, m.index))) named.add(c.id);
    });
    return named;
  }

  /**
   * Whether any of the class card's group was written for the pharm section: a card without `for`
   * is written for any use, so a group shows wherever one of its cards may.
   */
  relevantIn(classId: string, section: string): boolean {
    return this.membersOf(classId).some((m) => m.for === undefined || m.for.includes(section));
  }
}

/** One system of one guide, as the pharm derivations need it. */
export interface PharmSystem {
  guide: string;
  system: string;
  structure: StructureFile;
  topics: SystemTopics;
}

export interface PlacedSection {
  /** Cards matched from the section's tables, in row order. */
  tableCards: string[];
  /** `also` cards, including cards appended for their home (40 §40.4). */
  also: string[];
}

/** `guide/system/section` → its cards. */
export type Placements = Map<string, PlacedSection>;

export const sectionKey = (guide: string, system: string, section: string): string => `${guide}/${system}/${section}`;

/** A topic's condition section as a key of `SystemJson.panelSections` ("" in a system without sections). */
export const conditionKey = (section: string | null): string => section ?? "";

/**
 * The pharm sections relevant to each condition section (content/pharm/uses.json `conditions`), by
 * `sectionKey(guide, system, conditionKey(section))`. Every condition section of every system with drug
 * tables has exactly one entry, naming only that system's pharm sections, so no panel is left to chance.
 */
export function conditionUses(conditions: UsesFile["conditions"], systems: readonly PharmSystem[]): Map<string, ReadonlySet<string>> {
  const out = new Map<string, ReadonlySet<string>>();
  const where = "content/pharm/uses.json";
  const keysOf = (s: PharmSystem): (string | null)[] => (s.structure.sections.length > 0 ? s.structure.sections.map((x) => x.id) : [null]);
  for (const c of conditions) {
    const s = systems.find((x) => x.guide === c.guide && x.system === c.system);
    const at = `${c.guide}/${c.system}/${c.section ?? "(no sections)"}`;
    if (!s || s.structure.drugTables.length === 0) throw new BuildError(where, `condition entry ${at} names no system with drug tables`);
    if (!keysOf(s).includes(c.section)) throw new BuildError(where, `condition entry ${at} names no condition section of that system`);
    const own = new Set(s.structure.pharmSections.map((ps) => ps.id));
    for (const id of c.for) if (!own.has(id)) throw new BuildError(where, `condition entry ${at} names pharm section "${id}", which that system lacks`);
    out.set(sectionKey(c.guide, c.system, conditionKey(c.section)), new Set(c.for));
  }
  for (const s of systems) {
    if (s.structure.drugTables.length === 0) continue;
    for (const section of keysOf(s)) {
      if (!out.has(sectionKey(s.guide, s.system, conditionKey(section)))) {
        throw new BuildError(where, `condition section ${s.guide}/${s.system}/${section ?? "(no sections)"} has no entry`);
      }
    }
  }
  return out;
}

function contentRows(table: Table, conditionRows: readonly string[]): Row[] {
  const cond = new Set(conditionRows);
  return table.rows.filter((r) => r.kind === "content" && !cond.has(r.id));
}

/** A heading-row column label that names her drug-name column ("Drugs", "RX", "PHARM"). */
const DRUG_COLUMN = /^(?:drugs?|rx|pharm)$/i;

/**
 * The cells under the drug row's heading-row drug-name columns, where her tables list the agents
 * ("CCBs ‖ DHP: Amlodipine … ‖ Non-DHP: Verapamil …"). A column whose label reads empty belongs to
 * the labeled column to its left, since a heading cell spanning several columns reads empty in the
 * ones it covers.
 */
function drugColumnText(t: SystemTopics, row: Row): string {
  const heading = t.rows.get(row.id)?.heading;
  const columns = heading ? (t.headings.get(heading)?.columns ?? []) : [];
  const parts: string[] = [];
  let drug = false;
  columns.forEach((label, i) => {
    if (collapse(label) !== "") drug = DRUG_COLUMN.test(collapse(label));
    if (drug) parts.push(row.cells[i + 1] ?? "");
  });
  return parts.join("\n");
}

/**
 * The cards a drug row lists: the cards matching its first cell (the class she names), plus the
 * cards matching the agents in its drug-name columns that come from the same med list as one of
 * those. Her med lists keep a class together with its sub-classes, so a card from another med list
 * that shares an agent covers that drug's other use (prazosin in her BPH list on her ⍺1-blocker
 * row), not this row's class. When the first cell matches no card, every card its agents match counts.
 * A card written only for other pharm sections than the row's (`section`) never counts: her
 * anesthesia notes on local anesthetics do not belong to her "Class Ib: Lidocaine" row.
 */
export function rowCards(matcher: CardMatcher, t: SystemTopics, row: Row, section: string): string[] {
  const relevant = (c: string): boolean => matcher.relevantIn(c, section);
  const named = matcher.matching(firstCell(row)).filter(relevant);
  const files = new Set(named.flatMap((c) => [...matcher.filesOf(c)]));
  const sameFile = (c: string): boolean => [...matcher.filesOf(c)].some((f) => files.has(f));
  const listed = matcher.matching(drugColumnText(t, row)).filter((c) => relevant(c) && !named.includes(c) && (named.length === 0 || sameFile(c)));
  return matcher.cards.map((c) => c.id).filter((c) => named.includes(c) || listed.includes(c));
}

/**
 * Card order on every pharm section, with every card placed at least once (40 §40.4). `systems`
 * is in site order. Fails when a card names an unknown file or home, or is placed nowhere.
 */
export function placeCards(systems: readonly PharmSystem[], matcher: CardMatcher, pharmFiles: ReadonlySet<string>): Placements {
  const placements: Placements = new Map();
  for (const s of systems) {
    for (const ps of s.structure.pharmSections) {
      const tableCards: string[] = [];
      for (const tableId of ps.tables) {
        const table = s.topics.tables.get(tableId);
        const drug = s.structure.drugTables.find((d) => d.block === tableId);
        if (!table || !drug) continue;
        for (const row of contentRows(table, drug.conditionRows)) {
          for (const c of rowCards(matcher, s.topics, row, ps.id)) if (!tableCards.includes(c)) tableCards.push(c);
        }
      }
      const also = [...new Set(ps.also.map((c) => matcher.classOf(c)))];
      placements.set(sectionKey(s.guide, s.system, ps.id), { tableCards, also: also.filter((c) => !tableCards.includes(c)) });
    }
  }
  const placedIn = (card: string, guide: string | null): boolean => {
    for (const [key, p] of placements) {
      if ((guide === null || key.startsWith(`${guide}/`)) && (p.tableCards.includes(card) || p.also.includes(card))) return true;
    }
    return false;
  };
  const sectionIds = new Set(systems.flatMap((s) => s.structure.pharmSections.map((ps) => ps.id)));
  for (const card of matcher.all) {
    if (!pharmFiles.has(card.file)) throw new BuildError(card.id, `card names pharm file "${card.file}", which does not exist`);
    for (const id of card.for ?? []) if (!sectionIds.has(id)) throw new BuildError(card.id, `card is for pharm section "${id}", which no guide has`);
  }
  // A class card's group has a home in each system any of its cards names: the first pharm section
  // there that the group was written for.
  for (const card of matcher.cards) {
    for (const m of matcher.membersOf(card.id)) {
      for (const [guide, system] of Object.entries(m.home)) {
        const home = systems.find((s) => s.guide === guide && s.system === system);
        if (!home) throw new BuildError(m.id, `card home names system "${guide}/${system}", which does not exist`);
        if (placedIn(card.id, guide)) continue;
        const first = home.structure.pharmSections.find((ps) => matcher.relevantIn(card.id, ps.id));
        if (first) placements.get(sectionKey(guide, system, first.id))?.also.push(card.id);
      }
    }
    if (!placedIn(card.id, null)) throw new BuildError(card.id, "pharm card appears in no pharm section of any guide");
  }
  return placements;
}

/** Cards of a pharm section page in order: table cards, then `also`. */
export function sectionCards(p: PlacedSection | undefined): string[] {
  return p ? [...p.tableCards, ...p.also.filter((c) => !p.tableCards.includes(c))] : [];
}

/** Whether the system has a Pharm section (40 §40.5, ruling D3). */
export function hasPharm(s: PharmSystem, placements: Placements): boolean {
  if (s.structure.drugTables.length > 0 || s.structure.pharmFiles.length > 0) return true;
  return s.structure.pharmSections.some((ps) => sectionCards(placements.get(sectionKey(s.guide, s.system, ps.id))).length > 0);
}

/** The stub label: first cell of the table's first heading row, else of its first row. */
export function stubLabel(table: Table): string {
  const row = table.rows.find((r) => r.kind === "heading") ?? table.rows[0];
  return row ? collapse(firstCell(row)) : "";
}

export interface MedsCard {
  /** The class card, or null for a row matching no card. */
  card: string | null;
  /** Card title, or the row's first-cell text for a card-less row. */
  title: string;
  /** The card's rows, each run preceded once by its heading row. */
  rows: string[];
  /** Pharm section holding the card's first row. */
  section: string;
  /** Scroll target on that section page: the card, or the row. */
  target: string;
}

/** All cells of the topic's rows. */
export function topicText(t: SystemTopics, topic: Topic): string {
  const rows = new Map<string, Row>();
  for (const table of t.tables.values()) for (const r of table.rows) rows.set(r.id, r);
  return topic.rows.map((id) => rows.get(id)?.cells.join("\n") ?? "").join("\n");
}

/** A heading-row column label that names her treatment column ("Management", "Treatment", "DX/TX", …). */
const TREATMENT_COLUMN = /\b(?:management|treatment|tx)\b/i;

/**
 * The topic's treatment text: the cells under its heading rows' treatment columns, or all its cells
 * when no heading row above it labels one. A column whose label reads empty belongs to the labeled
 * column to its left, since a heading cell spanning several columns reads empty in the ones it covers.
 * Drugs named elsewhere in her notes — as a cause, a risk factor, a diagnostic maneuver — do not treat
 * the condition.
 */
export function treatmentText(t: SystemTopics, topic: Topic): string {
  const rows = new Map<string, Row>();
  for (const table of t.tables.values()) for (const r of table.rows) rows.set(r.id, r);
  const parts: string[] = [];
  let labeled = false;
  for (const id of topic.rows) {
    const heading = t.rows.get(id)?.heading;
    const columns = heading ? (t.headings.get(heading)?.columns ?? []) : [];
    let treatment = false;
    columns.forEach((label, i) => {
      if (collapse(label) !== "") treatment = TREATMENT_COLUMN.test(label);
      if (!treatment) return;
      labeled = true;
      parts.push(rows.get(id)?.cells[i + 1] ?? "");
    });
  }
  return labeled ? parts.join("\n") : topicText(t, topic);
}

/**
 * The meds panel under a condition topic (40 §40.5): the system's drug rows whose first cell, or an
 * alias or class word of a card matching the row's drug names, occurs in the topic's treatment text, grouped under the matching
 * cards her treatment text names (every matching card when only the row's own name occurs). A drug
 * table's place in her guide says nothing about which conditions it treats — her groups never close,
 * so a table can follow conditions it has nothing to do with — and condition rows are never offered.
 * Each card keeps only its rows from tables of `relevant`, the pharm sections whose drugs treat the
 * topic's condition section (`panelSections`): her hypertension panel shows her Hypertension table's
 * beta-blocker row, not her antiarrhythmics table's. A card with no row in a relevant table keeps all
 * its rows, since her treatment text names it and most conditions have no pharm section of their
 * own (ACE inhibitors on acute coronary syndrome live only in her hypertension and heart failure tables).
 */
export function medsPanel(
  s: PharmSystem, blockOrder: readonly string[], topic: Topic, matcher: CardMatcher, cardTitle: (card: string) => string, relevant: ReadonlySet<string>,
): MedsCard[] {
  const sectionOf = (block: string): string => s.structure.drugTables.find((d) => d.block === block)?.pharmSection ?? "";
  const drugBlocks = blockOrder.filter((b) => s.structure.drugTables.some((d) => d.block === b));
  const rowsOf = (block: string): Row[] => {
    const table = s.topics.tables.get(block);
    const drug = s.structure.drugTables.find((d) => d.block === block);
    return table && drug ? contentRows(table, drug.conditionRows) : [];
  };
  const picked: { row: Row; section: string; cards: string[] }[] = [];
  const seen = new Set<string>();
  const text = treatmentText(s.topics, topic);
  const byClassWord = matcher.namedByClassWords(text);
  for (const block of drugBlocks) {
    const section = sectionOf(block);
    for (const r of rowsOf(block)) {
      const first = firstCell(r);
      if (collapse(first) === "" || seen.has(r.id)) continue;
      // A row naming several classes ("NSAIDs: Naproxen Indomethacin") files only under the cards
      // her text names: "NSAIDs" in her text means the NSAIDs card, not the naproxen sub-class card.
      const cards = rowCards(matcher, s.topics, r, section);
      const named = cards.filter((c) => matcher.cardIn(c, text) || byClassWord.has(c));
      if (named.length === 0 && !phraseMatcher([first])(text)) continue;
      seen.add(r.id);
      picked.push({ row: r, section, cards: named.length > 0 ? named : cards });
    }
  }

  type Picked = (typeof picked)[number];
  const groups: { card: string | null; title: string; rows: Picked[] }[] = [];
  for (const p of picked) {
    if (p.cards.length === 0) {
      groups.push({ card: null, title: collapse(firstCell(p.row)), rows: [p] });
      continue;
    }
    for (const c of p.cards) {
      const g = groups.find((x) => x.card === c);
      if (g) g.rows.push(p);
      else groups.push({ card: c, title: cardTitle(c), rows: [p] });
    }
  }
  return groups.map((g) => {
    const inRelevant = g.rows.filter((p) => relevant.has(p.section));
    const kept = inRelevant.length > 0 ? inRelevant : g.rows;
    const first = kept[0] as Picked;
    return { card: g.card, title: g.title, rows: withHeadings(s.topics, kept.map((p) => p.row.id)), section: first.section, target: g.card ?? first.row.id };
  });
}
