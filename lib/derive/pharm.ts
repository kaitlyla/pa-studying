// Pharm cards, alias matching, pharm sections, drug-table stubs and meds panels (plan 40 §40.4–§40.5).
import type { CardsFile, StructureFile, UsesFile } from "../content/types.ts";
import { escapeRegExp } from "../search/index.ts";
import { BuildError } from "./errors.ts";
import { collapse, firstCell, type Row, type Table } from "./text.ts";
import { withHeadings, type SystemTopics, type Topic } from "./topics.ts";

export type Card = CardsFile["cards"][number];

const matcherCache = new Map<string, (text: string) => boolean>();

/** The whole-word, case-insensitive alternation of the phrases on NFC text, or null for none. */
function phraseSource(phrases: readonly string[], prefix = "", suffix = ""): string | null {
  const alts = phrases.map((p) => p.normalize("NFC")).filter((p) => p.trim() !== "").map(escapeRegExp);
  // Longest first, so a phrase inside a longer one ("loop diuretic" in "loop diuretics") never wins its place.
  alts.sort((a, b) => b.length - a.length);
  return alts.length > 0 ? `(?<![\\p{L}\\p{N}])${prefix}(?:${alts.join("|")})(?![\\p{L}\\p{N}])${suffix}` : null;
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

/** Her negative sign before a drug word ("⊖inotropes", "(-) inotropes", "negative inotropes"): the opposite class. */
const NEGATIVE_SIGN = String.raw`(?<!(?:⊖|\(\s*[-−]\s*\)|negative)\s*)`;

/**
 * Her words that make the drugs after them drugs to avoid or stop ("avoid vasodilators", "AVOID
 * nitrates, diuretics", "stop all anticoagulants", "DC/⇣ opioid"). Her "DC cardioversion" is a shock,
 * and a stop weighed against going on is a choice, not a stop: "DC anticoagulation vs continue
 * indefinitely".
 */
const AVOID =
  /(?<![\p{L}\p{N}])(?:avoid|no|not|contraindicated|hold|CI|(?:stop|discontinue|D\/C|DC(?!\s*(?:cardioversion|shock)))(?![\p{L}\p{N}])(?![^\n;▪•»]*(?<![\p{L}\p{N}])(?:vs|versus)(?![\p{L}\p{N}])))(?![\p{L}\p{N}])/giu;

/** Her words after an avoid word that turn to what to do instead: "D/C offending AP drug or switch to …". */
const INSTEAD = /(?<![\p{L}\p{N}])(?:switch(?:ing)?\s+to|change\s+to|instead|initiation\s+of)(?![\p{L}\p{N}])/iu;

/** Her words that stop a drug too, so "DC/avoid cardiotoxic drugs" still avoids them. */
const STOP_WORD = /^(?:avoid|no|not|contraindicated|hold|CI|DC|D\/C|stop|discontinue)$/iu;

/** Her arrows to what comes next ("if CI 🡪 methotrexate", "if no response ⇢ sulfasalazine"). */
const ARROW = /[→⇢⇒🡪🡒⤷➔➜⟶⟹]/u;

/**
 * The losing side of her comparison, right before a drug word: "DOAC recommended over ASA",
 * "AC alone > thrombolytic + AC"; or the drug a problem comes from: "if from nitroprusside infusion".
 */
const PASSED_OVER = /(?:(?<![\p{L}\p{N}])(?:over|from)|>)\s*$/iu;

/**
 * Her word right after a drug that rules it out ("steroid injection contraindicated", "thrombolytics
 * contraindicated"), before her clause ends at a colon, comma, parenthesis, arrow or "if": in "CCBs:
 * indicated if beta blockers are contraindicated" the CCBs are the treatment.
 */
const RULED_OUT = /^[^:,()→⇢⇒🡪🡒⤷➔➜⟶⟹]*?(?<![\p{L}\p{N}])contraindicated(?![\p{L}\p{N}])/iu;
const CLAUSE_IF = /(?<![\p{L}\p{N}])(?:if|unless)(?![\p{L}\p{N}])/iu;

/**
 * Where an item of her notes ends: a new line, a bullet or numbered point, or a semicolon. A list
 * she wraps after a comma goes on: "avoid hepatotoxic drugs: NSAIDs, opiates, ⏎ BDZs (HE)".
 */
const ITEM_END = /[;▪•»➀-➓]|(?<!,[^\S\n]*)\n/gu;

/**
 * Whether the avoid word ending at `from` in `item` reaches the drug word at `to`: through her list of
 * drugs after it ("AVOID nitrates, diuretics, ACEI/ARBs", "avoid (-) inotropes (CCBs, BBs)"), up to
 * the first list element naming no drug ("avoid high-impact activities, splint, …, ibuprofen"), an
 * arrow or her words for what to do instead (`INSTEAD`), a colon after other words ("No response to
 * NSAIDs: sulfasalazine") or the parenthesis it sits in closing ("(avoid bed rest), NSAIDs"). A colon
 * after her words for drugs, naming none, opens the list instead ("avoid hepatotoxic drugs: NSAIDs,
 * opiates, BDZs").
 */
function avoidReaches(item: string, from: number, to: number, drugs: RegExp | null): boolean {
  const span = item.slice(from, to);
  if (ARROW.test(span) || INSTEAD.test(span)) return false;
  const lead = /^\s*:/u.exec(span)?.[0].length ?? 0;
  for (let at = span.indexOf(":", lead); at >= 0; at = span.indexOf(":", at + 1)) {
    const head = span.slice(0, at);
    if (!DRUGS_HEAD.test(head) || (drugs !== null && drugs.test(head))) return false;
  }
  // Her list elements: split at commas outside parentheses, so "(e.g., NSAIDs)" stays one element.
  const elements = [""];
  let depth = 0;
  for (const ch of span) {
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return false;
    if (ch === "," && depth === 0) elements.push("");
    else elements[elements.length - 1] += ch;
  }
  elements.pop();
  return elements.every((e) => (drugs !== null && drugs.test(e)) || CONDITION.test(e));
}

/** Her words for drugs ending the text before a colon: "hepatotoxic drugs:". */
const DRUGS_HEAD = /(?<![\p{L}\p{N}])(?:drugs|meds|medications|agents)\s*$/iu;

/** A list element of hers that says when to avoid, not what: "AVOID in inferior, PDE-5 inhibitor in last 24h". */
const CONDITION = /^\s*(?:in|if|w\/|with|after|during|when|for|unless)(?![\p{L}\p{N}])/iu;

/**
 * Whether her avoid word at `m` is a word of a slash pair with a word that does not stop a drug —
 * "intolerance/CI: GLP-1s" labels the case for the drugs that follow, unlike "DC/avoid".
 */
function pairedLabel(item: string, m: RegExpMatchArray): boolean {
  const at = m.index ?? 0;
  const left = /([\p{L}\p{N}-]+)\s*\/\s*$/u.exec(item.slice(0, at));
  const right = /^\s*\/\s*([\p{L}\p{N}-]+)/u.exec(item.slice(at + m[0].length));
  const partner = left?.[1] ?? right?.[1];
  return partner !== undefined && !STOP_WORD.test(partner);
}

/** Where a point of her notes ends: a bullet or numbered point, or a blank line. Its sub-lines stay in it. */
const POINT_END = /[▪•»➀-➓]|\n[^\S\n]*\n/gu;

/**
 * Whether the item of `text` holding the drug word at `at`–`end` rules it out: an avoid word before
 * it reaches it (`avoidReaches`), it is on the losing side of a comparison, her clause after it calls
 * it contraindicated, or her point holding it sets a condition on having the drug (`contrasted`).
 * `drugs` is every drug word.
 */
function avoidedAt(text: string, at: number, end: number, drugs: RegExp | null): boolean {
  const before = text.slice(lastEnd(text, at, ITEM_END), at);
  const after = untilEnd(text.slice(end), ITEM_END);
  const ifAt = after.search(CLAUSE_IF);
  const clause = ifAt < 0 ? after : after.slice(0, ifAt);
  const point = text.slice(lastEnd(text, at, POINT_END), end) + untilEnd(text.slice(end), POINT_END);
  // Her avoid words are read in the whole item, whose rest can make a stop a choice (`AVOID`).
  const item = before + text.slice(at, end) + after;
  const avoided = [...item.matchAll(AVOID)].some(
    (m) => m.index + m[0].length <= before.length && !pairedLabel(before, m) && avoidReaches(before, m.index + m[0].length, before.length, drugs),
  );
  return avoided || PASSED_OVER.test(before) || RULED_OUT.test(clause) || contrasted(point, escapeRegExp(text.slice(at, end)));
}

/** Where the last `ends` (global) match before `at` in `text` ends, or 0. */
function lastEnd(text: string, at: number, ends: RegExp): number {
  let start = 0;
  for (const m of text.slice(0, at).matchAll(ends)) start = m.index + m[0].length;
  return start;
}

/** `rest` up to its first `ends` match. */
function untilEnd(rest: string, ends: RegExp): string {
  const stop = rest.search(ends);
  return stop < 0 ? rest : rest.slice(0, stop);
}

/**
 * Whether her point sets a condition on having the drug word (escaped, `word`) rather than treating
 * with it: the word under her ⊘, Ø, ∅ or ⍉ ("without", "not") sign — "≥185/110 (thrombolytic therapy)
 * or ≥220/120 (⊘thrombolytic therapy)", "Ø memantine, ineffective" — or the word twice with one
 * followed by "not" — "before thrombolytic therapy started – If thrombolytic therapy not planned". A
 * lone "SSRIs have not been effective, but may be used for comorbid anxiety" still names them.
 */
function contrasted(point: string, word: string): boolean {
  if (new RegExp(`[⊘Ø∅⍉]\\s*${word}(?![\\p{L}\\p{N}])`, "iu").test(point)) return true;
  const all = new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, "giu");
  const negated = new RegExp(`(?<![\\p{L}\\p{N}])${word}(?:\\s+(?!(?:if|unless|when)(?![\\p{L}\\p{N}]))\\p{L}+)?\\s+not(?![\\p{L}\\p{N}])`, "iu");
  return [...point.matchAll(all)].length > 1 && negated.test(point);
}

/**
 * Whether the class word at `at`–`end` heads her list rather than naming its class: followed by a
 * colon ("Antidepressants: off-label use for insomnia", "prokinetics: fiber, psyllium"), or ending a
 * line of its own that her bulleted list follows ("Antiemetics ⏎•scopolamine patch", "Rescue
 * antiemetics – if N/V occur in the PACU… ⏎•prochlorperazine"). The list's items name their own cards.
 */
function headsList(text: string, at: number, end: number): boolean {
  const rest = text.slice(end);
  if (/^\s*:/u.test(rest)) return true;
  const line = text.slice(text.lastIndexOf("\n", at) + 1, at);
  if (/[▪•»➀-➓*\-–,;/]/u.test(line)) return false;
  return /^[^\S\n]*(?:[–—][^\n]*)?\n\s*[▪•»➀-➓]/u.test(rest);
}

/**
 * Her words hyphen-joined before a drug word that make another word of it: "non-heparin
 * anticoagulants", "low-iron diet", "5-ASA" (mesalamine, not aspirin).
 */
const JOINED_BEFORE = /(?:(?<![\p{L}\p{N}])(?:non|low|high)|\p{N})-$/iu;

/**
 * Her words right after a drug word on its line, or hyphen-joined to it, that make it the problem or
 * another thing, not the treatment: "iron overload", "iron deficiency anemia", "Deferoxamine
 * (iron-chelation)", "serum salicylate level", "liver iron concentrations", "when iron accumulates
 * to toxic levels", "APAP nomogram", "opiate OD", "Opioid-induced", "PEG-INF", and her heading for
 * treating a poison: "Iron TX: chelation therapy".
 */
const PROBLEM_AFTER =
  /^(?:[^\S\n]+|-)(?:overload|deficiency|deficient|toxicity|poisoning|overdose|OD|levels?|concentrations?|accumulates|accumulation|nomogram|induced|withdrawal|intoxication|chelation|INF|IFN|TX\s*:)(?![\p{L}\p{N}])/iu;

/** Whether her drug word at `at`–`end` of `notes` is part of another word or names the problem (`JOINED_BEFORE`, `PROBLEM_AFTER`). */
function notTreatment(notes: string, at: number, end: number): boolean {
  return JOINED_BEFORE.test(notes.slice(Math.max(0, at - 8), at)) || PROBLEM_AFTER.test(notes.slice(end, end + 40));
}

/** Drug words (global, under no negative sign): `phraseSource(phrases, NEGATIVE_SIGN)`, or null for none. */
function drugWords(phrases: readonly string[]): RegExp | null {
  const source = phraseSource(phrases, NEGATIVE_SIGN);
  return source === null ? null : new RegExp(source, "giu");
}

/**
 * Whether the drug word ending at `end` heads her list in the possessive, as the drug the list is
 * for: "Warfarin’s: Vit K, FFP, prothrombin complex concentrate".
 */
function headsPossessive(text: string, end: number): boolean {
  return /^['’]s\s*:/u.test(text.slice(end));
}

interface UnavoidedOptions {
  /** The words are class words, so heading any list of hers names nothing (`headsList`). */
  classWords?: boolean;
  /** Her text before any masking, of the same length as the matched text. */
  notes?: string;
  /** Drug-name spans (start, end): a match inside a longer one is part of another drug's name. */
  names?: readonly (readonly [number, number])[];
  /** Whether a match at `at`–`end` of `notes` names the card, by a rule of the caller's. */
  keep?: (at: number, end: number) => boolean;
}

/**
 * The matches of the drug words `re` in `text`, lowercased, that her item does not rule out
 * (`avoidedAt`), that are her treatment (`notTreatment`) and that do not head her list in the
 * possessive (`headsPossessive`), read with `options`. Her wording is read in `notes`: masking a
 * card's name must not hide the drugs of her avoid list.
 */
function unavoided(re: RegExp | null, text: string, drugs: RegExp | null, options: UnavoidedOptions = {}): string[] {
  if (re === null) return [];
  const { classWords = false, notes = text, names = [], keep } = options;
  return [...text.matchAll(re)]
    .filter((m) => {
      const end = m.index + m[0].length;
      if (names.some(([s, e]) => s <= m.index && e >= end && e - s > end - m.index)) return false;
      if (notTreatment(notes, m.index, end) || headsPossessive(notes, end)) return false;
      if (keep && !keep(m.index, end)) return false;
      return !(classWords && headsList(notes, m.index, end)) && !avoidedAt(notes, m.index, end, drugs);
    })
    .map((m) => m[0].toLowerCase());
}

/**
 * Her parenthetical right after a word, naming her choice: "anticoagulation (enoxaparin)". Her
 * examples do not narrow the word: "vasodilators (e.g., nitrates)".
 */
const PARENTHETICAL = /^[^\S\n]*\((?![^\S\n]*(?:e\.?\s?g\b|ex\b|such as\b|including\b))([^()\n]*)\)/iu;

/** Her card of reversal agents, by its own name: the antidotes she lists under a drug she reverses. */
const ANTIDOTE_CARD = /^(?:reversal agents?|antidotes?)$/iu;

const mentionCache = new Map<string, RegExp | null>();

/**
 * Whether her treatment text (NFC) names one of the phrases outside her avoid, negative and ruled-out
 * wording; `drugs` is every drug word (`CardMatcher.drugs`).
 */
function mentions(phrases: readonly string[], text: string, drugs: RegExp | null): boolean {
  const key = phrases.join("\n");
  let re = mentionCache.get(key);
  if (re === undefined) {
    re = drugWords(phrases);
    mentionCache.set(key, re);
  }
  return unavoided(re, text, drugs).length > 0;
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
  /** Per class card, its group's aliases as drug words (`drugWords`), or null. */
  private readonly aliasWords: (RegExp | null)[];
  /** Per class card, its group's class words as drug words (`drugWords`), or null. */
  private readonly classWords: (RegExp | null)[];
  /** Every card's aliases (global), or null. */
  private readonly aliases: RegExp | null;
  /** Every card's aliases and class words, or null: what makes an element of her list a drug. */
  readonly drugs: RegExp | null;
  /**
   * Her drug words (lowercased) that her pharm files put on class cards of more than one file, each
   * written for its own use: "lidocaine" on her antiarrhythmic and her local anesthetic card,
   * "methotrexate" on her DMARD and her IBD card.
   */
  private readonly sharedWords: Set<string>;
  /** Per class word (lowercased), the class cards of the cards listing it. */
  private readonly classWordCards: Map<string, Set<string>>;
  /** Her antidotes right after a drug word's colon or dash (`ANTIDOTE_CARD`), or null for none. */
  private readonly antidoteHead: RegExp | null;

  constructor(cards: readonly Card[]) {
    this.all = cards;
    this.cards = cards.filter((c) => c.in === undefined);
    this.members = new Map(this.cards.map((c) => [c.id, [c, ...cards.filter((m) => m.in === c.id)]]));
    this.tests = this.cards.map((c) => phraseMatcher(this.membersOf(c.id).flatMap((m) => m.aliases)));
    this.aliasWords = this.cards.map((c) => drugWords(this.membersOf(c.id).flatMap((m) => m.aliases)));
    this.classWords = this.cards.map((c) => drugWords(this.membersOf(c.id).flatMap((m) => m.classWords ?? [])));
    const source = phraseSource(cards.flatMap((c) => c.aliases));
    this.aliases = source === null ? null : new RegExp(source, "giu");
    const drugs = phraseSource(cards.flatMap((c) => [...c.aliases, ...(c.classWords ?? [])]));
    this.drugs = drugs === null ? null : new RegExp(drugs, "iu");
    const filed = new Map<string, { classes: Set<string>; files: Set<string> }>();
    for (const c of cards) {
      for (const w of [...c.aliases, ...(c.classWords ?? [])]) {
        const key = w.normalize("NFC").toLowerCase();
        const at = filed.get(key) ?? { classes: new Set<string>(), files: new Set<string>() };
        at.classes.add(c.in ?? c.id);
        at.files.add(c.file);
        filed.set(key, at);
      }
    }
    this.sharedWords = new Set([...filed].filter(([, at]) => at.classes.size > 1 && at.files.size > 1).map(([w]) => w));
    this.classWordCards = new Map();
    for (const c of cards) {
      for (const w of c.classWords ?? []) {
        const key = w.normalize("NFC").toLowerCase();
        this.classWordCards.set(key, (this.classWordCards.get(key) ?? new Set()).add(c.in ?? c.id));
      }
    }
    const antidotes = this.cards.filter((c) => this.membersOf(c.id).some((m) => m.aliases.some((a) => ANTIDOTE_CARD.test(a))));
    const antidoteWords = phraseSource(antidotes.flatMap((c) => this.membersOf(c.id).flatMap((m) => m.aliases)));
    this.antidoteHead = antidoteWords === null ? null : new RegExp(`^[^\\S\\n]*(?::|[–—]|-(?=[^\\S\\n]))[^\\S\\n]*${antidoteWords}`, "iu");
  }

  /**
   * Whether the class word at `at`–`end` of her `text` names the class card `classId`: unless her
   * parenthetical right after it names cards of that class ("anticoagulation (enoxaparin)" names
   * only her heparin card), in which case it names those only.
   */
  private narrowedTo(classId: string, text: string, at: number, end: number): boolean {
    const paren = PARENTHETICAL.exec(text.slice(end));
    if (!paren) return true;
    const sharing = this.classWordCards.get(text.slice(at, end).toLowerCase()) ?? new Set<string>();
    const named = this.matching(paren[1] ?? "").filter((c) => sharing.has(c));
    return named.length === 0 || named.includes(classId);
  }

  /** Whether every one of the words (lowercased) is shared by cards of several files (`sharedWords`). */
  allShared(words: readonly string[]): boolean {
    return words.every((w) => this.sharedWords.has(w));
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

  /**
   * The class cards a condition's treatment text names, in `cards.json` order, each with the words
   * (lowercased) naming it: an alias of the card's group ("aspirin"), or her other words for its drugs
   * (`classWords`) — "diuretics" names her loop, thiazide and potassium-sparing cards at once. A class
   * word inside a card's own name ("loop diuretics") names only that card, through its alias, and a
   * class word heading her list ("Antidepressants:") names nothing; one her parenthetical narrows
   * names only the cards it names ("anticoagulation (enoxaparin)"). A drug word heading her list of
   * its antidotes names nothing ("Direct thrombin inhibitors: Idarucizumab"). A drug word under her negative sign
   * ("⊖inotropes"), reached by "avoid", "no", "not", "contraindicated", "hold" or "CI" before it
   * ("AVOID nitrates, diuretics"), called contraindicated in her clause after it ("steroid injection
   * contraindicated"), on the losing side of a comparison ("DOAC recommended over ASA"), or under her ⊘
   * sign or followed by "not" anywhere in the item names nothing (`avoidedAt`).
   */
  namedBy(text: string): Map<string, string[]> {
    const nfc = text.normalize("NFC");
    const masked = this.aliases ? nfc.replace(this.aliases, (m) => " ".repeat(m.length)) : nfc;
    // Every drug name in her text, longest first: "opioid" in her "mu-opioid antagonists" names only
    // her opioid antagonist card, as "loop diuretic" in "loop diuretics" names nothing of its own.
    const names = this.aliases ? [...nfc.matchAll(this.aliases)].map((m): [number, number] => [m.index, m.index + m[0].length]) : [];
    // A drug word heading her list of its antidotes is the drug they reverse: "Direct thrombin inhibitors: Idarucizumab".
    const headsAntidote = (end: number): boolean => this.antidoteHead?.test(nfc.slice(end)) ?? false;
    const out = new Map<string, string[]>();
    this.cards.forEach((c, i) => {
      const words = [
        ...unavoided(this.aliasWords[i] ?? null, nfc, this.drugs, { names, keep: (_, end) => !headsAntidote(end) }),
        ...unavoided(this.classWords[i] ?? null, masked, this.drugs, {
          classWords: true,
          notes: nfc,
          keep: (at, end) => !headsAntidote(end) && this.narrowedTo(c.id, nfc, at, end),
        }),
      ];
      if (words.length > 0) out.set(c.id, [...new Set(words)]);
    });
    return out;
  }

  /** Ids of the class cards a condition's treatment text names (`namedBy`), in `cards.json` order. */
  named(text: string): string[] {
    return [...this.namedBy(text).keys()];
  }

  /**
   * Whether any of the class card's group was written for the pharm section: a card without `for`
   * is written for any use, so a group shows wherever one of its cards may.
   */
  relevantIn(classId: string, section: string): boolean {
    return this.membersOf(classId).some((m) => m.for === undefined || m.for.includes(section));
  }

  /**
   * Whether any of the class card's group was written for the condition titled `title` whose
   * treatment text `text` names the card by `words` (`namedBy`): a card without `diseases` is written
   * for any disease; one with them, for a title naming one of them, or for a use her item naming the
   * card names one of them ("Pulmonary HTN: bosentan, sildenafil" on systemic sclerosis).
   */
  writtenFor(classId: string, title: string, text = "", words: readonly string[] = []): boolean {
    const naming = phraseMatcher(words);
    const items = text.split(ITEM_END).filter((item) => naming(item));
    return this.membersOf(classId).some((m) => {
      if (m.diseases === undefined) return true;
      const names = phraseMatcher(m.diseases);
      return names(title) || items.some((item) => names(item));
    });
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
  /** The card's rows, each run preceded once by its heading row; [] for a card with no row in the system. */
  rows: string[];
  /**
   * Pharm section holding the card's first row; for a card without rows, the pharm section her pharm
   * places it in (`panelHome`), whose notes it shows.
   */
  section: string;
  /** The system of the guide holding `section`, or null when `section` is in another guide's pharm (no link). */
  system: string | null;
  /** Scroll target on that section page: the card, or the row. */
  target: string;
}

/** A pharm section of one system of one guide. */
export interface PharmPlace {
  guide: string;
  system: string;
  section: string;
}

/**
 * The pharm section a meds panel in `guide`/`system` points to for a card with no row there, given
 * the pharm sections placing the card in site order: the first in the system itself, else in the
 * guide, else anywhere in the site — that one from another guide, so the panel shows the card
 * without a link (system null). Null for a card placed nowhere.
 */
export function panelHome(list: readonly PharmPlace[], guide: string, system: string): { system: string | null; section: string } | null {
  const here = list.find((p) => p.guide === guide && p.system === system) ?? list.find((p) => p.guide === guide);
  if (here) return { system: here.system, section: here.section };
  const away = list[0];
  return away ? { system: null, section: away.section } : null;
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
 * when no heading row above it labels one (`treatmentColumn`).
 */
export function treatmentText(t: SystemTopics, topic: Topic): string {
  return treatmentColumn(t, topic) ?? topicText(t, topic);
}

/**
 * The cells under the topic's heading rows' treatment columns, or null when no heading row above it
 * labels one. A column whose label reads empty belongs to the labeled column to its left, since a
 * heading cell spanning several columns reads empty in the ones it covers. Drugs named elsewhere in
 * her notes — as a cause, a risk factor, a diagnostic maneuver — do not treat the condition.
 */
export function treatmentColumn(t: SystemTopics, topic: Topic): string | null {
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
  return labeled ? parts.join("\n") : null;
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
 * A card her Treatment column names that has no row in the system follows, in `cards.json` order,
 * with the pharm section `home` gives it: her pulmonary embolism text names the DOACs card, whose rows
 * are in her cardiovascular tables. A topic without a Treatment column shows no such card, since its
 * notes name drugs as causes and risk factors too; nor does a card named only by drug words her pharm
 * files put on cards written for other uses (`CardMatcher.allShared`), unless `home` finds it in the
 * system itself: "topical lidocaine" on hand, foot and mouth disease is not her antiarrhythmic card;
 * nor a card written for other diseases than the condition's, or than its item naming the card
 * (`CardMatcher.writtenFor`): "IVIG" on ITP is not her MS card.
 */
export function medsPanel(
  s: PharmSystem, blockOrder: readonly string[], topic: Topic, matcher: CardMatcher, cardTitle: (card: string) => string, relevant: ReadonlySet<string>,
  home: (card: string) => { system: string | null; section: string } | null,
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
  const column = treatmentColumn(s.topics, topic);
  const text = (column ?? topicText(s.topics, topic)).normalize("NFC");
  const namedBy = matcher.namedBy(text);
  const namedCards = [...namedBy.keys()];
  for (const block of drugBlocks) {
    const section = sectionOf(block);
    for (const r of rowsOf(block)) {
      const first = firstCell(r);
      if (collapse(first) === "" || seen.has(r.id)) continue;
      // A row naming several classes ("NSAIDs: Naproxen Indomethacin") files only under the cards
      // her text names: "NSAIDs" in her text means the NSAIDs card, not the naproxen sub-class card.
      const cards = rowCards(matcher, s.topics, r, section);
      const named = cards.filter((c) => namedCards.includes(c));
      if (named.length === 0 && !mentions([first], text, matcher.drugs)) continue;
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
  const withRows: MedsCard[] = groups.map((g) => {
    const inRelevant = g.rows.filter((p) => relevant.has(p.section));
    const kept = inRelevant.length > 0 ? inRelevant : g.rows;
    const first = kept[0] as Picked;
    return { card: g.card, title: g.title, rows: withHeadings(s.topics, kept.map((p) => p.row.id)), section: first.section, system: s.system, target: g.card ?? first.row.id };
  });
  const withoutRows = column === null ? [] : namedCards.filter((c) => !groups.some((g) => g.card === c)).flatMap((c): MedsCard[] => {
    const at = home(c);
    if (!at || !matcher.writtenFor(c, topic.title, text, namedBy.get(c)) || (at.system !== s.system && matcher.allShared(namedBy.get(c) ?? []))) return [];
    return [{ card: c, title: cardTitle(c), rows: [], section: at.section, system: at.system, target: c }];
  });
  return [...withRows, ...withoutRows];
}
