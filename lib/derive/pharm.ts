// Pharm cards, alias matching, pharm sections, drug-table stubs and meds panels (plan 40 §40.4–§40.5).
import type { CardsFile, StructureFile, UsesFile } from "../content/types.ts";
import { escapeRegExp } from "../search/index.ts";
import { BuildError } from "./errors.ts";
import { collapse, firstCell, type Row, type Table } from "./text.ts";
import { withHeadings, type SystemTopics, type Topic } from "./topics.ts";

export type Card = CardsFile["cards"][number];

/** The class card `classId` first, then the cards shown inside it (their `in`), in `cards.json` order; none if it is no card. */
export function cardGroup(cards: readonly Card[], classId: string): Card[] {
  const own = cards.find((c) => c.id === classId);
  return own === undefined ? [] : [own, ...cards.filter((m) => m.in === classId)];
}

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
 * Her words that make the drugs after them drugs to avoid, stop or be wary of ("avoid vasodilators",
 * "AVOID nitrates, diuretics", "stop all anticoagulants", "DC/⇣ opioid", "cautious use of digoxin",
 * "Elimination of topical steroids"). Her "DC cardioversion" is a shock, and a stop weighed against
 * going on is a choice, not a stop: "DC anticoagulation vs continue indefinitely".
 */
const AVOID =
  /(?<![\p{L}\p{N}])(?:avoid|no|not|contraindicated|hold|CI|cautious\s+use\s+of|elimination\s+of|eliminate|(?:stop|discontinue|D\/C|DC(?!\s*(?:cardioversion|shock)))(?![\p{L}\p{N}])(?![^\n;▪•»]*(?<![\p{L}\p{N}])(?:vs|versus)(?![\p{L}\p{N}])))(?![\p{L}\p{N}])/giu;

/** Her line heading a list of drugs to avoid ("AVOID: nonselective beta blockers"). */
const AVOID_HEAD = /^[^\S\n]*(?:avoid|contraindicated|CI)[^\S\n]*:/iu;

/** Her line heading a list of causes ("First search for reversible causes"), unless it says to treat them. */
const CAUSE_HEAD = /(?<![\p{L}\p{N}])(?:causes|triggers|precipitants)[^\S\n]*:?[^\S\n]*$/iu;
const TREATS = /(?<![\p{L}\p{N}])(?:treat|tx|manage|correct|directed|address)/iu;

/** A line of her bulleted or dashed list ("▪︎beta blockers", "  – e.g., propranolol"). */
const LIST_LINE = /^[^\S\n]*[▪•»➀-➓–—*-]/u;

/**
 * Whether the drug word at `at` of `text` sits in her list under a line heading drugs to avoid
 * (`AVOID_HEAD`) or causes (`CAUSE_HEAD`): her list's lines up to that heading, with no blank line
 * between. Her arrow before it on its line leads to the treatment: "•opiate OD 🡪 naloxone".
 */
function headedOut(text: string, at: number): boolean {
  const lines = text.slice(0, at).split("\n");
  const own = lines[lines.length - 1] ?? "";
  if (!LIST_LINE.test(own) || ARROW.test(own)) return false;
  for (let i = lines.length - 2; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (line.trim() === "") return false;
    if (!LIST_LINE.test(line)) return AVOID_HEAD.test(line) || (CAUSE_HEAD.test(line) && !TREATS.test(line));
  }
  return false;
}

/** Her words after an avoid word that turn to what to do instead: "D/C offending AP drug or switch to …". */
const INSTEAD = /(?<![\p{L}\p{N}])(?:switch(?:ing)?\s+to|change\s+to|instead|initiation\s+of)(?![\p{L}\p{N}])/iu;

/** Her words that stop a drug too, so "DC/avoid cardiotoxic drugs" still avoids them. */
const STOP_WORD = /^(?:avoid|no|not|contraindicated|hold|CI|DC|D\/C|stop|discontinue)$/iu;

/** Her arrows to what comes next ("if CI 🡪 methotrexate", "if no response ⇢ sulfasalazine"). */
const ARROW = /[→⇢⇒🡪🡒⤷➔➜⟶⟹]/u;

/**
 * The losing side of her comparison, right before a drug word: "DOAC recommended over ASA",
 * "Warfarin *preferred vs DOACs", "AC alone > thrombolytic + AC"; or the drug a problem comes from:
 * "if from nitroprusside infusion".
 */
const PASSED_OVER = /(?:(?<![\p{L}\p{N}])(?:over|from|preferred\s+(?:vs\.?|versus))|>)\s*$/iu;

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
 * it contraindicated, her point holding it sets a condition on having the drug (`contrasted`), or it
 * is in her list under a heading of drugs to avoid or of causes (`headedOut`). `drugs` is every drug
 * word.
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
  return avoided || PASSED_OVER.test(before) || RULED_OUT.test(clause) || contrasted(point, escapeRegExp(text.slice(at, end))) || headedOut(text, at);
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
 * line of its own that her bulleted or dashed list follows ("Antiemetics ⏎•scopolamine patch", "Rescue
 * antiemetics – if N/V occur in the PACU… ⏎•prochlorperazine", "non-heparin anticoagulants ⏎- direct
 * thrombin inhibitors"). The list's items name their own cards.
 */
function headsList(text: string, at: number, end: number): boolean {
  const rest = text.slice(end);
  if (/^\s*:/u.test(rest)) return true;
  const line = text.slice(text.lastIndexOf("\n", at) + 1, at);
  const listFollows = (after: string): boolean => /^[^\n]*\n\s*(?:[▪•»➀-➓]|[-–—][^\S\n])/u.test(after);
  // Her dash-led gloss on the line her list follows is part of its heading: "Rescue antiemetics – if
  // N/V occur in the PACU, we administer an antiemetic from a different class…".
  if (!/[▪•»➀-➓*]|^[^\S\n]*[-–—]/u.test(line) && /[^\S\n][–—][^\S\n]/u.test(line) && listFollows(rest)) return true;
  // A word in her list line or list is not its heading; a hyphen or slash inside a word ("non-heparin",
  // "D/C") is not a list mark.
  if (/[▪•»➀-➓*,;]|^[^\S\n]*[-–]|[-–/](?![\p{L}\p{N}])|(?<![\p{L}\p{N}])[-–/]/u.test(line)) return false;
  return /^[^\S\n]*(?:[–—][^\n]*)?\n\s*(?:[▪•»➀-➓]|[-–—][^\S\n])/u.test(rest);
}

/**
 * Her words hyphen-joined before a drug word that make another word of it: "non-heparin
 * anticoagulants", "low-iron diet", "5-ASA" (mesalamine, not aspirin).
 */
const JOINED_BEFORE = /(?:(?<![\p{L}\p{N}])(?:non|low|high)|\p{N})-$/iu;

/** An ordinal right before a drug word makes it a place, not a drug: "5th ICS" (intercostal space). */
const ORDINAL_BEFORE = /(?<![\p{L}\p{N}])\p{N}+(?:st|nd|rd|th)[^\S\n]+$/iu;

/**
 * Her words right before a drug word that make it the body's own substance, a lab value, a stimulus
 * or a substrate, not the treatment: "endogenous opioids", "serum estradiol", "ritual-eliciting
 * stimulants", "inhibits conversion of testosterone to DHT"; or a topical form her systemic drug
 * cards don't cover: "topical steroids", "topical minoxidil".
 */
const OTHER_BEFORE = /(?<![\p{L}\p{N}])(?:endogenous|serum|plasma|topical|(?:\p{L}+-)?eliciting|conversions?\s+of)[^\S\n]+$/iu;

/**
 * Her words right after a drug word on its line, or hyphen-joined to it, that make it the problem or
 * another thing, not the treatment: "iron overload", "iron deficiency anemia", "Deferoxamine
 * (iron-chelation)", "serum salicylate level", "liver iron concentrations", "when iron accumulates
 * to toxic levels", "APAP nomogram", "opiate OD", "Opioid-induced", "PEG-INF", her heading for
 * treating a poison: "Iron TX: chelation therapy", her heading for the drug as the cause:
 * "Corticosteroid use: gradual taper", a lost substance: "folic acid depletion", and a culture
 * medium: "sorbitol agar".
 */
const PROBLEM_AFTER =
  /^(?:[^\S\n]+|-)(?:overload|deficiency|deficient|depletion|toxicity|poisoning|overdose|OD|levels?|concentrations?|accumulates|accumulation|nomogram|induced|withdrawal|intoxication|chelation|agar|INF|IFN|TX\s*:|use\s*:)(?![\p{L}\p{N}])/iu;

/**
 * Her open parenthetical of the therapy a patient already needs, which makes them eligible for
 * something else: palivizumab for "chronic lung disease … requiring medical therapy (O2,
 * bronchodilator, diuretic, steroids)".
 */
const PRIOR_THERAPY = /(?<![\p{L}\p{N}])requir(?:ing|es?)[^\S\n]+(?:medical[^\S\n]+)?(?:therapy|treatment|tx)[^\S\n]*\([^()]*$/iu;

/**
 * Whether her drug word at `at`–`end` of `notes` is part of another word, a place, another thing,
 * names the problem, or is therapy her patient already needs (`JOINED_BEFORE`, `ORDINAL_BEFORE`,
 * `OTHER_BEFORE`, `PROBLEM_AFTER`, `PRIOR_THERAPY`).
 */
function notTreatment(notes: string, at: number, end: number): boolean {
  const before = notes.slice(Math.max(0, at - 40), at);
  return (
    JOINED_BEFORE.test(before) ||
    ORDINAL_BEFORE.test(before) ||
    OTHER_BEFORE.test(before) ||
    PRIOR_THERAPY.test(notes.slice(Math.max(0, at - 120), at)) ||
    PROBLEM_AFTER.test(notes.slice(end, end + 40))
  );
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

/** Her drug named with "w/" right after a word, naming her choice the same way: "anticoagulate w/ Warfarin". */
const WITH_CHOICE = /^[^\S\n]*(?:w\/|with(?![\p{L}\p{N}]))([^\n,;()]*)/iu;

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
 * A drug's own name as she writes it: one or two lower-case words of letters and hyphens, the last
 * without a class noun's ending (plural "-s", "-al", "-ic", "-ant", "-or", "-er", "-ist").
 */
const DRUG_NAME = /^\p{Ll}[\p{Ll}-]*(?: \p{Ll}[\p{Ll}-]*)?(?<!s|al|ic|ant|or|er|ist)$/u;

/** The phrases (lowercased, once each) that occur in `text` as whole words. */
function foundIn(phrases: readonly string[], text: string): string[] {
  return [...new Set(phrases.filter((p) => phraseMatcher([p])(text)).map((p) => p.normalize("NFC").toLowerCase()))];
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
  /** Per class card, its group's aliases as drug words (`drugWords`), or null. */
  private readonly aliasWords: (RegExp | null)[];
  /** Per class card, its group's class words as drug words (`drugWords`), or null. */
  private readonly classWords: (RegExp | null)[];
  /** Every card's aliases (global), or null. */
  private readonly aliases: RegExp | null;
  /** Every card's aliases and class words, or null: what makes an element of her list a drug. */
  readonly drugs: RegExp | null;
  /** Per class word (lowercased), the class cards of the cards listing it. */
  private readonly classWordCards: Map<string, Set<string>>;
  /** Her antidotes right after a drug word's colon or dash (`ANTIDOTE_CARD`), or null for none. */
  private readonly antidoteHead: RegExp | null;
  /** Per card, the `diseases` of its parts (content PharmPart): the conditions some of its notes are written for. */
  private readonly partDiseases: ReadonlyMap<string, readonly (readonly string[])[]>;

  constructor(cards: readonly Card[], partDiseases: ReadonlyMap<string, readonly (readonly string[])[]> = new Map()) {
    this.all = cards;
    this.partDiseases = partDiseases;
    this.cards = cards.filter((c) => c.in === undefined);
    this.members = new Map(this.cards.map((c) => [c.id, cardGroup(cards, c.id)]));
    this.aliasWords = this.cards.map((c) => drugWords(this.membersOf(c.id).flatMap((m) => m.aliases)));
    this.classWords = this.cards.map((c) => drugWords(this.membersOf(c.id).flatMap((m) => m.classWords ?? [])));
    const source = phraseSource(cards.flatMap((c) => c.aliases));
    this.aliases = source === null ? null : new RegExp(source, "giu");
    const drugs = phraseSource(cards.flatMap((c) => [...c.aliases, ...(c.classWords ?? [])]));
    this.drugs = drugs === null ? null : new RegExp(drugs, "iu");
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
   * parenthetical or "w/" right after it names cards of that class ("anticoagulation (enoxaparin)"
   * names only her heparin card, "anticoagulate w/ Warfarin" only her warfarin card), in which case
   * it names those only.
   */
  private narrowedTo(classId: string, text: string, at: number, end: number): boolean {
    const choice = PARENTHETICAL.exec(text.slice(end)) ?? WITH_CHOICE.exec(text.slice(end));
    if (!choice) return true;
    const sharing = this.classWordCards.get(text.slice(at, end).toLowerCase()) ?? new Set<string>();
    const named = this.matching(choice[1] ?? "").filter((c) => sharing.has(c));
    return named.length === 0 || named.includes(classId);
  }

  /**
   * The drug names (lowercased) her text spells out whole: at each place, the longest alias of any
   * card there, so "valsartan" inside "Sacubitril/Valsartan" names her ARNI card, not her ARB card.
   */
  private wholeNames(text: string): Set<string> {
    return new Set(this.aliases ? [...text.normalize("NFC").matchAll(this.aliases)].map((m) => m[0].toLowerCase()) : []);
  }

  /** Ids of the class cards with an alias among `text`'s whole drug names (`wholeNames`), in `cards.json` order. */
  matching(text: string): string[] {
    const names = this.wholeNames(text);
    return this.cards.map((c) => c.id).filter((c) => this.membersOf(c).some((m) => m.aliases.some((a) => names.has(a.normalize("NFC").toLowerCase()))));
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

  /** The pharm file of the class card itself: the med list whose class it is. */
  fileOf(classId: string): string | undefined {
    return this.membersOf(classId)[0]?.file;
  }

  /** The aliases (lowercased) of the class card's group among `text`'s whole drug names (`wholeNames`). */
  aliasesIn(classId: string, text: string): string[] {
    const names = this.wholeNames(text);
    return foundIn(this.membersOf(classId).flatMap((m) => m.aliases), text).filter((a) => names.has(a));
  }

  /** Whether `text` names the class card's class by one of its group's aliases or class words other than `besides` (lowercased). */
  namesClass(classId: string, text: string, besides: ReadonlySet<string>): boolean {
    const words = this.membersOf(classId).flatMap((m) => [...m.aliases, ...(m.classWords ?? [])]);
    return phraseMatcher(words.filter((w) => !besides.has(w.normalize("NFC").toLowerCase())))(text);
  }

  /**
   * Whether `word` (lowercased) names one drug of the class card's group, not its class: an alias she
   * writes in lower case as a drug's own name ("prazosin", "bismuth subsalicylate") rather than a
   * class word, an abbreviation ("BB") or a class name ("thiazide diuretic", "sglt2 inhibitors").
   */
  namesDrug(classId: string, word: string): boolean {
    const members = this.membersOf(classId);
    if (members.some((m) => (m.classWords ?? []).some((w) => w.normalize("NFC").toLowerCase() === word))) return false;
    return DRUG_NAME.test(word) && members.some((m) => m.aliases.some((a) => a.normalize("NFC") === word));
  }

  /** Whether one of the class card's group was written for the pharm section `section` by name (its `for`). */
  namedFor(classId: string, section: string): boolean {
    return this.membersOf(classId).some((m) => m.for?.includes(section) ?? false);
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
    // Her class word inside parentheses opened right after a drug name describes that drug, which names
    // its own card: "Dantrolene (muscle relaxant)", "furosemide (K-wasting diuretic)".
    const describes = (at: number): boolean => names.some(([, e]) => /^[^\S\n]*\([^()\n]*$/u.test(nfc.slice(e, at)));
    const out = new Map<string, string[]>();
    this.cards.forEach((c, i) => {
      const words = [
        ...unavoided(this.aliasWords[i] ?? null, nfc, this.drugs, { names, keep: (_, end) => !headsAntidote(end) }),
        ...unavoided(this.classWords[i] ?? null, masked, this.drugs, {
          classWords: true,
          notes: nfc,
          keep: (at, end) => !headsAntidote(end) && !describes(at) && this.narrowedTo(c.id, nfc, at, end),
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
   * Whether a card of the class card's group, or a part of one, lists `diseases`, one of which
   * `title` (a condition title, or her item naming the card) names.
   */
  titledFor(classId: string, title: string): boolean {
    return this.membersOf(classId).some((m) =>
      [...(m.diseases ? [m.diseases] : []), ...(this.partDiseases.get(m.id) ?? [])].some((d) => phraseMatcher(d)(title)),
    );
  }

  /**
   * The class cards with a part written for the condition titled `title`: a part of their group lists
   * `diseases`, one of which the title names (her "Restless Leg Syndrome: Levodopa" notes on Restless
   * Leg Syndrome), unless the title names one of the group's `notDiseases`. `sections` are the pharm
   * sections of the condition's system.
   */
  partTitled(title: string, sections: ReadonlySet<string>): string[] {
    // A card written `for` pharm sections places by disease title only where the system teaches one of
    // them: her depression notes on the atypicals card do not reach Peds, which has no depression section.
    const teaches = (m: Card): boolean => m.for === undefined || m.for.some((s) => sections.has(s));
    return this.cards
      .filter((c) => this.membersOf(c.id).some((m) => teaches(m) && (this.partDiseases.get(m.id) ?? []).some((d) => phraseMatcher(d)(title))) && !this.notFor(c.id, title))
      .map((c) => c.id);
  }

  /** Whether `title` (a condition title) names one of the `notDiseases` of the class card's group. */
  notFor(classId: string, title: string): boolean {
    const not = this.membersOf(classId).flatMap((m) => m.notDiseases ?? []);
    return not.length > 0 && phraseMatcher(not)(title);
  }

  /**
   * Whether any of the class card's group was written for the condition titled `title` whose
   * treatment text `text` names the card by `words` (`namedBy`): a card without `diseases` is written
   * for any disease; one with them, for a title naming one of them, or for a use her item naming the
   * card names one of them ("Pulmonary HTN: bosentan, sildenafil" on systemic sclerosis). Never for
   * a condition whose title names one of its `notDiseases`.
   */
  writtenFor(classId: string, title: string, text = "", words: readonly string[] = []): boolean {
    if (this.notFor(classId, title)) return false;
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
  /** The pharm file of every pharm part, by part id. */
  partFiles: ReadonlyMap<string, string>;
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

/** Her combination partner after an agent ("Amiloride (combo w/ HCTZ → Moduretic)"): another class's drug, up to her closing parenthesis, arrow or line end. */
const COMBO_PARTNER = /(?<![\p{L}\p{N}])(?:combo|combination|combined)\s+(?:w\/|with(?![\p{L}\p{N}]))[^()\n→⇢🡪]*/giu;

/**
 * The cells under the drug row's heading-row drug-name columns, where her tables list the agents
 * ("CCBs ‖ DHP: Amlodipine … ‖ Non-DHP: Verapamil …"), with her combination partners blanked
 * (`COMBO_PARTNER`). A column whose label reads empty belongs to the labeled column to its left,
 * since a heading cell spanning several columns reads empty in the ones it covers.
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
  return parts.join("\n").replace(COMBO_PARTNER, (m) => " ".repeat(m.length));
}

/**
 * The cards a drug row's words match: the cards matching its first cell (the class she names), plus
 * the cards matching the agents in its drug-name columns whose own class comes from the same med list
 * as one of those (`CardMatcher.fileOf`: a member from her multi-class review list does not make her
 * IBD glucocorticoid card one of her "Inhaled Corticosteroids (ICS)" row's agents); when the first
 * cell matches no card, every card its agents match. A card written only for
 * other pharm sections than the row's (`section`) never counts: her anesthesia notes on local
 * anesthetics do not belong to her "Class Ib: Lidocaine" row.
 */
function foundCards(matcher: CardMatcher, t: SystemTopics, row: Row, section: string): string[] {
  const relevant = (c: string): boolean => matcher.relevantIn(c, section);
  const named = matcher.matching(firstCell(row)).filter(relevant);
  const files = new Set(named.map((c) => matcher.fileOf(c)));
  const sameFile = (c: string): boolean => files.has(matcher.fileOf(c));
  const listed = matcher.matching(drugColumnText(t, row)).filter((c) => relevant(c) && !named.includes(c) && (named.length === 0 || sameFile(c)));
  return matcher.cards.map((c) => c.id).filter((c) => named.includes(c) || listed.includes(c));
}

/** A drug row her table bullets under the row above it ("▪︎DHPs: nifedipine, amlodipine"). */
const BULLET_ROW = /^\s*[▪•·◦‣–-]/u;

/** A drug row's label: its first cell up to the first line break or colon, where her agents begin ("Hydralazine & Nitrates:"). */
function rowLabel(row: Row): string {
  return firstCell(row).split(/[\n:]/u)[0] ?? "";
}

/** A drug row's matched cards, each with its matched aliases no other matched card has (`own`) and those another has too (`shared`). */
interface RowMatch {
  row: Row;
  found: string[];
  own: Map<string, string[]>;
  shared: Map<string, string[]>;
}

function rowMatch(matcher: CardMatcher, t: SystemTopics, row: Row, section: string): RowMatch {
  const found = foundCards(matcher, t, row, section);
  const text = `${firstCell(row)}\n${drugColumnText(t, row)}`;
  const aliases = new Map(found.map((c) => [c, matcher.aliasesIn(c, text)]));
  const own = new Map<string, string[]>();
  const shared = new Map<string, string[]>();
  for (const c of found) {
    const elsewhere = new Set(found.filter((o) => o !== c).flatMap((o) => aliases.get(o) ?? []));
    own.set(c, (aliases.get(c) ?? []).filter((a) => !elsewhere.has(a)));
    shared.set(c, (aliases.get(c) ?? []).filter((a) => elsewhere.has(a)));
  }
  return { row, found, own, shared };
}

/**
 * The cards each drug row of a pharm section lists, by row id: of the cards its words match
 * (`foundCards`), the cards of the class the row is about. Her med lists file a drug under each class
 * she uses it in, so a drug alias two cards share names only the card of the row's class:
 * prochlorperazine on her antiemetic "Dopamine Blockers" row is her phenothiazine antiemetic card, not
 * her typical antipsychotic card. A card written for other diseases (`CardMatcher.writtenFor`) than the
 * row's first cell, its heading or the section's title names, and not for the section, never stays:
 * ozanimod on her IBD row is not her MS card. Otherwise a card stays on its row
 * - by an alias no other matched card has;
 * - by a shared alias, when it outranks every card sharing that alias: a card from one of the
 *   section's own med lists (`section.lists`, the files of its Overview and LO; for a section with
 *   neither, a list with a card on one of its rows by an unshared alias, or written for the section)
 *   ranks above one that is not, and among those, a card whose class the row's first
 *   cell, its heading or the section's title names, by a class word or an alias other than the drugs
 *   it shares on the row, ranks higher ("Antiemetics" names her antiemetic cards, not the typical
 *   antipsychotic card that shares prochlorperazine with them). Equal
 *   ranks keep both; no evidence at all (phenobarbital on her anticholinergics row) keeps neither.
 * A row a card of the section's own lists is both about and from keeps only that list's cards, the
 * cards written for the section and the cards its label names (`rowLabel`): her IBD "Anti-TNF agents" row's golimumab is not her
 * rheumatology biologics card, and her migraine "Antiemetics" row's chlorpromazine is not her
 * typical antipsychotic card, while her heart failure "Hydralazine & Nitrates:" row keeps her nitrate card.
 */
export function sectionRowCards(
  matcher: CardMatcher, t: SystemTopics, rows: readonly Row[], section: { id: string; title: string; lists: ReadonlySet<string> },
): Map<string, string[]> {
  const matches = rows.map((r) => rowMatch(matcher, t, r, section.id));
  const lists = new Set<string | undefined>(section.lists);
  if (lists.size === 0) {
    for (const m of matches) {
      for (const c of m.found) if ((m.own.get(c) ?? []).length > 0 || matcher.namedFor(c, section.id)) lists.add(matcher.fileOf(c));
    }
  }
  const out = new Map<string, string[]>();
  for (const m of matches) {
    const heading = t.rows.get(m.row.id)?.heading;
    const context = [firstCell(m.row), heading ? (t.headings.get(heading)?.label ?? "") : "", section.title].join("\n");
    const about = (c: string): boolean => matcher.namedFor(c, section.id) || matcher.namesClass(c, context, new Set(m.shared.get(c)));
    const rank = (c: string): number => (lists.has(matcher.fileOf(c)) ? 2 : 0) + (about(c) ? 1 : 0);
    const rowLists = new Set(m.found.filter((c) => rank(c) === 3).map((c) => matcher.fileOf(c)));
    const forHere = (c: string): boolean => matcher.namedFor(c, section.id) || matcher.writtenFor(c, context);
    // Only the cards that may stay on the row contest a shared alias: her hemorrhoid steroid card
    // does not take her RA "Corticosteroids" row from her glucocorticoid card.
    const rivals = (c: string, a: string): string[] => m.found.filter((o) => o !== c && forHere(o) && (m.shared.get(o) ?? []).includes(a));
    const wins = (c: string): boolean =>
      (m.shared.get(c) ?? []).some((a) => {
        const others = rivals(c, a);
        if (others.length === 0) return true;
        const best = Math.max(rank(c), ...others.map(rank));
        return best > 0 && rank(c) === best;
      });
    const label = rowLabel(m.row);
    const outside = (c: string): boolean =>
      rowLists.size > 0 && !rowLists.has(matcher.fileOf(c)) && !matcher.namedFor(c, section.id) && matcher.aliasesIn(c, label).length === 0;
    const keep = (c: string): boolean => forHere(c) && !outside(c) && ((m.own.get(c) ?? []).length > 0 || wins(c));
    out.set(m.row.id, m.found.filter(keep));
  }
  return out;
}

/** The cards each drug row of the pharm section's tables lists (`sectionRowCards`), by row id. */
export function sectionCardsByRow(matcher: CardMatcher, s: PharmSystem, ps: StructureFile["pharmSections"][number]): Map<string, string[]> {
  const rows = ps.tables.flatMap((tableId) => {
    const table = s.topics.tables.get(tableId);
    const drug = s.structure.drugTables.find((d) => d.block === tableId);
    return table && drug ? contentRows(table, drug.conditionRows) : [];
  });
  const lists = new Set<string>();
  for (const part of [ps.overview, ps.lo]) {
    const file = part === null ? undefined : s.partFiles.get(part);
    if (file !== undefined) lists.add(file);
  }
  return sectionRowCards(matcher, s.topics, rows, { id: ps.id, title: ps.title, lists });
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
      for (const cards of sectionCardsByRow(matcher, s, ps).values()) for (const c of cards) if (!tableCards.includes(c)) tableCards.push(c);
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
  // A class card's group has a home in each system any of its cards names. Where no pharm section of
  // that guide places it, the pharm sections of its home system it was written for by name (`for`)
  // take it; a card is never put in a section of another class.
  for (const card of matcher.cards) {
    for (const m of matcher.membersOf(card.id)) {
      for (const [guide, system] of Object.entries(m.home)) {
        const home = systems.find((s) => s.guide === guide && s.system === system);
        if (!home) throw new BuildError(m.id, `card home names system "${guide}/${system}", which does not exist`);
        if (placedIn(card.id, guide)) continue;
        for (const ps of home.structure.pharmSections) if (matcher.namedFor(card.id, ps.id)) placements.get(sectionKey(guide, system, ps.id))?.also.push(card.id);
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
 * without a link (system null). Within the system or the guide, a section of `prefer` (the sections
 * relevant to the panel's condition) comes first. Null for a card placed nowhere.
 */
export function panelHome(
  list: readonly PharmPlace[], guide: string, system: string, prefer: ReadonlySet<string> = new Set(),
): { system: string | null; section: string } | null {
  const pick = (ps: PharmPlace[]): PharmPlace | undefined => ps.find((p) => prefer.has(p.section)) ?? ps[0];
  const here = pick(list.filter((p) => p.guide === guide && p.system === system)) ?? pick(list.filter((p) => p.guide === guide));
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
 * The topic's treatment text: the cells under its heading rows' treatment columns or its "TX:"
 * lead-ins (`treatmentColumn`), or all its cells when it has neither.
 */
export function treatmentText(t: SystemTopics, topic: Topic): string {
  return treatmentColumn(t, topic) ?? topicText(t, topic);
}

/**
 * The cells under the topic's heading rows' treatment columns. A column whose label reads empty
 * belongs to the labeled column to its left, since a heading cell spanning several columns reads
 * empty in the ones it covers. When no heading row above the topic labels one, her "TX:" lead-ins
 * in its cells (`txSpans`: "TX: ciprofloxacin or azithromycin" under ETEC); null when it has neither.
 * Drugs named elsewhere in her notes — as a cause, a risk factor, a diagnostic maneuver — do not
 * treat the condition.
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
  if (labeled) return parts.join("\n");
  const spans = topic.rows.flatMap((id) => (rows.get(id)?.cells ?? []).flatMap(txSpans));
  return spans.length > 0 ? spans.join("\n") : null;
}

/** A line opening, after any bullet or numbering, with her treatment lead-in ("TX:", "ACUTE TX:"). */
const TX_LEAD = /^[^\p{L}]*(?:[A-Za-z]+\s+)?TX\s*:/u;
/** A line opening, after any bullet or numbering, with a labelled lead-in ("DX:", "S/SXS:", "➁ Peutz-Jeghers syndrome (PJS):"). */
const LEAD = /^[^\p{L}]*\p{L}[\p{L}0-9 /&()+'’-]{0,30}:/u;

/** How deep a line sits in her list: its leading whitespace, then whether a bullet or number follows. */
function depth(line: string): [number, boolean] {
  const prefix = /^[^\p{L}]*/u.exec(line)?.[0] ?? "";
  const spaces = /^\s*/.exec(prefix)?.[0].length ?? 0;
  return [spaces, prefix.slice(spaces).trim() !== ""];
}

/** Whether `line` sits deeper in her list than `tx`: more indented, or as indented with a bullet `tx` lacks. */
function deeper(line: string, tx: string): boolean {
  const [ls, lb] = depth(line);
  const [ts, tb] = depth(tx);
  return ls > ts || (ls === ts && lb && !tb);
}

/**
 * Her treatment text in a cell without a treatment column: each line opening with a TX lead-in and
 * the lines after it, up to the next labelled lead-in no deeper than it ("DX:", "Complications:",
 * "➁ Peutz-Jeghers syndrome (PJS):") or the cell's end. A labelled line bulleted under her TX line
 * is more of her treatment ("TX: directed at underlying cause" / "•renal failure: give alkali").
 */
function txSpans(cell: string): string[] {
  const out: string[] = [];
  let cur: string[] | null = null;
  for (const line of cell.split("\n")) {
    if (TX_LEAD.test(line)) {
      if (cur) out.push(cur.join("\n"));
      cur = [line];
    } else if (cur && LEAD.test(line) && !deeper(line, cur[0]!)) {
      out.push(cur.join("\n"));
      cur = null;
    } else if (cur) cur.push(line);
  }
  if (cur) out.push(cur.join("\n"));
  return out;
}

/** Where a meds panel finds the cards her text names: in its own system, and in which pharm sections. */
export interface PanelPlaces {
  /** Whether the system itself has the card: a row of its tables, or a pharm section of its own. */
  inSystem: (card: string) => boolean;
  /** The pharm sections placing the card, by section id, in any guide. */
  sectionsOf: (card: string) => ReadonlySet<string>;
  /** Whether the panel may show the card at all, so that it counts as evidence. */
  shows: (card: string) => boolean;
}

/**
 * Of the class cards her treatment text names (`CardMatcher.namedBy`), the ones she means, in
 * `cards.json` order. Her med lists file a drug under each class she uses it in, so a drug word cards of
 * several med lists share ("aspirin" on her antiplatelet and her pain list) names only the cards with
 * the most evidence for it in her item naming it. A card of a med list written for the condition ranks
 * first: a list with a card whose notes, or a part of them, are written for a disease the condition
 * `title` or that item names (`CardMatcher.titledFor`: "dexamethasone" under Nausea/Vomiting is her
 * antiemetic steroid card, not her migraine card), or that the item also names by another of her
 * class words for it ("sulfasalazine, MTX" is her DMARD card, not her IBD card). Then a card sharing
 * a pharm section with a card of its own med list the item names by an unshared word ("aspirin +
 * clopidogrel": her antiplatelet list and section), and among equals, a card the system itself has.
 * No evidence names none: "topical lidocaine" on hand, foot and mouth disease is neither her
 * antiarrhythmic nor her local anesthetic card. A class word only cards of one med list share names
 * them all ("diuretics"); a drug's own name several cards of one list hold names the ones that fit
 * the condition or item, if any does ("methylprednisolone" on hyperemesis is her antiemetic steroid
 * card, not her IBD glucocorticoid card), else all of them. A card whose `notDiseases` the condition
 * `title` names holds no word there: "Aspirin" on Acute Rheumatic Fever is her pain list's card.
 */
export function meantCards(matcher: CardMatcher, title: string, text: string, namedBy: ReadonlyMap<string, readonly string[]>, places: PanelPlaces): string[] {
  const holders = new Map<string, string[]>();
  // A card her data rules out for the condition (`notDiseases`) is not what her word means there, so it
  // contests nothing: "Aspirin" under Acute Rheumatic Fever is her pain-list card, not her antiplatelet card.
  for (const [c, words] of namedBy) if (!matcher.notFor(c, title)) for (const w of words) holders.set(w, [...(holders.get(w) ?? []), c]);
  // A drug's own name two cards hold is contested even inside one med list, where her class words are
  // not: "methylprednisolone" on hyperemesis is her antiemetic steroid card, not her IBD glucocorticoid card.
  const drugWord = (w: string): boolean => (holders.get(w) ?? []).every((c) => matcher.namesDrug(c, w));
  const contested = (w: string): boolean =>
    new Set((holders.get(w) ?? []).map((c) => matcher.fileOf(c))).size > 1 || (drugWord(w) && (holders.get(w) ?? []).filter((c) => places.shows(c)).length > 1);
  const sure = [...namedBy].filter(([c, words]) => places.shows(c) && words.some((w) => !contested(w))).map(([c]) => c);
  const items = text.split(ITEM_END);
  const naming = (w: string): string[] => items.filter((item) => phraseMatcher([w])(item));
  const together = (w: string, o: string): boolean => naming(w).some((item) => phraseMatcher(namedBy.get(o) ?? [])(item));
  const withSure = (c: string, w: string): boolean =>
    sure.some((o) => matcher.fileOf(o) === matcher.fileOf(c) && [...places.sectionsOf(o)].some((x) => places.sectionsOf(c).has(x)) && together(w, o));
  const fits = (c: string, w: string): boolean => {
    const others = phraseMatcher((namedBy.get(c) ?? []).filter((o) => o !== w && !matcher.namesDrug(c, o)));
    // The contested word itself is no evidence: "antiemetics" does not fit a card written for antiemetic use.
    const word = new RegExp(phraseSource([w]) ?? "$^", "giu");
    return matcher.titledFor(c, title) || naming(w).map((item) => item.normalize("NFC").replace(word, " ")).some((item) => matcher.titledFor(c, item) || others(item));
  };
  // Fit is her med list's: "Rescue antiemetics" under Nausea/Vomiting names all her GI antiemetic cards
  // over her migraine card, though only her antiemetic steroid card is written for nausea by name.
  const listFits = (c: string, w: string): boolean => (holders.get(w) ?? []).some((o) => matcher.fileOf(o) === matcher.fileOf(c) && fits(o, w));
  const rank = (c: string, w: string): number => (listFits(c, w) ? 4 : 0) + (withSure(c, w) ? 2 : 0) + (places.inSystem(c) ? 1 : 0);
  const wins = (c: string, w: string): boolean => {
    if (new Set((holders.get(w) ?? []).map((o) => matcher.fileOf(o))).size === 1) {
      const fitting = (holders.get(w) ?? []).filter((o) => places.shows(o) && fits(o, w));
      return fitting.length === 0 || fitting.includes(c);
    }
    const best = Math.max(...(holders.get(w) ?? []).map((o) => rank(o, w)));
    return best > 0 && rank(c, w) === best;
  };
  return [...namedBy].filter(([c, words]) => places.shows(c) && (sure.includes(c) || words.some((w) => wins(c, w)))).map(([c]) => c);
}

/**
 * The meds panel under a condition topic (40 §40.5): the system's drug rows whose first cell, or an
 * alias or class word of a card matching the row's drug names, occurs in the topic's treatment text, grouped under the matching
 * cards her treatment text names (every matching card when only the row's own name occurs). A drug
 * table's place in her guide says nothing about which conditions it treats — her groups never close,
 * so a table can follow conditions it has nothing to do with — and condition rows are never offered.
 * A table written only for some conditions (`onlyFor`) is offered only under a condition whose title
 * names one. Her Treatment column names a card's rows from the first of: the tables of the pharm
 * section named for the condition, the tables of `relevant` (the pharm sections whose drugs treat
 * the topic's condition section, `panelSections`: her hypertension panel shows her Hypertension
 * table's beta-blocker row, not her antiarrhythmics table's), and all its tables, since most
 * conditions have no pharm section of their own (ACE inhibitors on acute coronary syndrome live only
 * in her hypertension and heart failure tables). A drug's own name names only its own rows, so a card
 * whose rows are all other drugs of it shows without rows ("diltiazem" is not her Amlodipine row).
 * A card links to the pharm section `home` gives it, preferring `relevant`, when one of its rows is
 * there, else to its first row's.
 * A card her Treatment column names that has no row in the system follows, in `cards.json` order,
 * with the pharm section `home` gives it: her pulmonary embolism text names the DOACs card, whose rows
 * are in her cardiovascular tables. So does a card with notes written for the condition its title
 * names (`CardMatcher.partTitled`), though her text names none of its drugs: her levodopa card's
 * restless-legs notes on Restless Leg Syndrome. A topic with neither a Treatment column nor a "TX:"
 * lead-in (`treatmentColumn`) shows no named card, since its notes name drugs as causes and risk
 * factors too, unless the card is written for the condition its
 * title names (`CardMatcher.titledFor`): her antiemetic steroids on Nausea/Vomiting. Nor does a card
 * written for other diseases than the condition's, or than its item naming the card
 * (`CardMatcher.writtenFor`): "IVIG" on ITP is not her MS card. Her text names only the cards it
 * means (`meantCards`), given the pharm sections placing each card (`sectionsOf`).
 */
export function medsPanel(
  s: PharmSystem, blockOrder: readonly string[], topic: Topic, matcher: CardMatcher, cardTitle: (card: string) => string, relevant: ReadonlySet<string>,
  home: (card: string, prefer?: ReadonlySet<string>) => { system: string | null; section: string } | null, sectionsOf: (card: string) => ReadonlySet<string>,
): MedsCard[] {
  const sectionOf = (block: string): string => s.structure.drugTables.find((d) => d.block === block)?.pharmSection ?? "";
  // A table written only for some conditions (`onlyFor`) shows under a condition whose title names
  // one of them, and nowhere else: her Gout table's "ACUTE › NSAIDs" row is gout dosing, not her
  // ankle sprain's NSAIDs.
  const forHere = (d: StructureFile["drugTables"][number]): boolean => d.onlyFor === undefined || phraseMatcher(d.onlyFor)(topic.title);
  const drugBlocks = blockOrder.filter((b) => s.structure.drugTables.some((d) => d.block === b && forHere(d)));
  const rowsOf = (block: string): Row[] => {
    const table = s.topics.tables.get(block);
    const drug = s.structure.drugTables.find((d) => d.block === block);
    return table && drug ? contentRows(table, drug.conditionRows) : [];
  };
  const picked: { row: Row; section: string; cards: string[] }[] = [];
  const seen = new Set<string>();
  const column = treatmentColumn(s.topics, topic);
  const text = (column ?? topicText(s.topics, topic)).normalize("NFC");
  const byRow = new Map(s.structure.pharmSections.flatMap((ps) => [...sectionCardsByRow(matcher, s, ps)]));
  const rowCards = new Set([...byRow.values()].flat());
  const namedBy = matcher.namedBy(text);
  const shows = (c: string): boolean => matcher.writtenFor(c, topic.title, text, namedBy.get(c));
  const namedCards = meantCards(matcher, topic.title, text, namedBy, { inSystem: (c) => rowCards.has(c) || home(c)?.system === s.system, sectionsOf, shows });
  // Her Treatment column names only the rows of a card that carry her words for it ("topiramate"
  // names her Na-channel card's Topiramate row, not its Lamotrigine row), with the bulleted rows
  // right under such a row ("▪︎DHPs: nifedipine" under "Calcium Channel Blockers (CCBs):"). When no
  // row carries them, her drug names name none of its rows if each row is another drug of the card
  // ("prazosin" is not her Propranolol row), and her class words name all of them ("BB"). A topic
  // with neither a Treatment column nor a "TX:" lead-in shows no rowless card, so there a card keeps
  // every row of it.
  const strict = column !== null;
  const variants = (w: string): string[] => {
    const stem = w.replace(/-/g, " ").replace(/s$/u, "");
    return [stem, `${stem}s`, stem.replace(/ /g, "-"), `${stem.replace(/ /g, "-")}s`];
  };
  // Her drug word names a row of one of the card's drugs by that drug, not by her notes on it:
  // "bupropion" in her Vortioxetine row's CYP2D6 note does not name that row. A class row is named
  // anywhere in it (her "5-ASA" row lists sulfasalazine among its formulations), and so is any row by
  // her class word ("BB" in her heart failure Beta Blockers row's indications).
  const drugText = (c: string, r: Row): string => {
    const first = firstCell(r);
    const drugRow = matcher.aliasesIn(c, first).some((a) => matcher.namesDrug(c, a));
    return drugRow ? `${first}\n${drugColumnText(s.topics, r)}` : r.cells.join("\n");
  };
  const onRow = (c: string, r: Row): boolean =>
    (namedBy.get(c) ?? []).some((w) => phraseMatcher(variants(w))(matcher.namesDrug(c, w) ? drugText(c, r) : r.cells.join("\n")));
  const ownRows = (c: string): { row: Row; section: string }[] =>
    drugBlocks.flatMap((b) => rowsOf(b).map((row) => ({ row, section: sectionOf(b) }))).filter((r) => (byRow.get(r.row.id) ?? []).includes(c));
  // Her rows in the pharm section named for the condition come first, then those in the sections
  // relevant to it, then the rest: her gout "corticosteroids" is her Gout table's Glucocorticoids
  // row, not her RA table's Corticosteroids row, though both tables treat her rheumatologic disorders.
  const titleOf = new Map(s.structure.pharmSections.map((ps) => [ps.id, ps.title]));
  const namesCondition = (section: string): boolean => {
    const title = titleOf.get(section)?.trim() ?? "";
    return title !== "" && phraseMatcher([title])(topic.title);
  };
  const rowRule = new Map<string, { how: "named" | "none" | "all"; scope: ReadonlySet<string> }>();
  for (const c of namedCards) {
    const own = ownRows(c);
    const drugsOnly = (namedBy.get(c) ?? []).every((w) => matcher.namesDrug(c, w));
    const tiers = [own.filter((r) => namesCondition(r.section)), own.filter((r) => relevant.has(r.section)), own].filter((t) => t.length > 0);
    const ids = (t: typeof own): ReadonlySet<string> => new Set(t.map((r) => r.row.id));
    const tier = tiers.find((t) => !drugsOnly || t.some((r) => onRow(c, r.row)));
    if (tier) rowRule.set(c, { how: tier.some((r) => onRow(c, r.row)) ? "named" : "all", scope: ids(tier) });
    else if (drugsOnly && own.length > 0 && own.every((r) => matcher.aliasesIn(c, r.row.cells.join("\n")).length > 0)) rowRule.set(c, { how: "none", scope: new Set() });
    else rowRule.set(c, { how: "all", scope: ids(own) });
  }
  for (const block of drugBlocks) {
    const section = sectionOf(block);
    let above = new Set<string>();
    for (const r of rowsOf(block)) {
      const first = firstCell(r);
      if (collapse(first) === "" || seen.has(r.id)) continue;
      // A row naming several classes ("NSAIDs: Naproxen Indomethacin") files only under the cards
      // her text names: "NSAIDs" in her text means the NSAIDs card, not the naproxen sub-class card.
      const cards = byRow.get(r.id) ?? [];
      const under = BULLET_ROW.test(first);
      const rule = (c: string): boolean => {
        const at = rowRule.get(c);
        if (!strict || at === undefined) return true;
        if (!at.scope.has(r.id)) return false;
        return at.how === "all" || (at.how === "named" && (onRow(c, r) || (under && above.has(c))));
      };
      const named = cards.filter((c) => namedCards.includes(c) && rule(c));
      above = new Set(named);
      if (named.length === 0 && !mentions([first], text, matcher.drugs)) continue;
      // A row only her row name occurs for files under its cards written for the condition, other
      // than a card her text names whose own rows are elsewhere; a row whose cards are all written
      // for other diseases is not hers here (propranolol for aggression on conduct disorder is not
      // her anxiety β-blocker row).
      const shown = named.length > 0 ? named : cards.filter((c) => shows(c) && !(strict && namedCards.includes(c)));
      if (cards.length > 0 && shown.length === 0) continue;
      seen.add(r.id);
      picked.push({ row: r, section, cards: shown });
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
  const kept = groups.map((g) => {
    const inRelevant = g.rows.filter((p) => relevant.has(p.section));
    return inRelevant.length > 0 ? { ...g, rows: inRelevant } : g;
  });
  // A card links to the pharm section `home` gives it when one of its rows is there, else to its first
  // row's: her statins on coronary artery disease open her Hyperlipidemia section, a class section of
  // theirs, though her CAD drug table lists them too.
  const withRows: MedsCard[] = kept.map((g) => {
    const first = g.rows[0] as Picked;
    const card = g.card;
    const at = card === null ? null : home(card, relevant);
    const section = g.rows.some((p) => p.section === at?.section && at.system === s.system) ? (at?.section ?? first.section) : first.section;
    return { card, title: g.title, rows: withHeadings(s.topics, g.rows.map((p) => p.row.id)), section, system: s.system, target: card ?? first.row.id };
  });
  // A card with notes written for the condition (`partTitled`) shows under it even where her text
  // names none of its drugs: her levodopa card's restless-legs notes on Restless Leg Syndrome.
  const rowless = [
    ...namedCards.filter((c) => !kept.some((g) => g.card === c) && (column !== null || matcher.titledFor(c, topic.title))),
    ...matcher.partTitled(topic.title, new Set(s.structure.pharmSections.map((p) => p.id))).filter((c) => !namedCards.includes(c) && !kept.some((g) => g.card === c)),
  ];
  const withoutRows = rowless.flatMap((c): MedsCard[] => {
    const at = home(c, relevant);
    if (!at) return [];
    return [{ card: c, title: cardTitle(c), rows: [], section: at.section, system: at.system, target: c }];
  });
  return [...withRows, ...withoutRows];
}
