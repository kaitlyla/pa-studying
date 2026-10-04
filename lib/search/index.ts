// Search tokens, abbreviation concepts, query trees and the MiniSearch configuration (plan 60 §60.2–§60.4).
// Shared by the build (indexing) and the app's search worker; browser-safe.
import MiniSearch, { type Options, type Query, type SearchOptions } from "minisearch";
import type { VocabFile } from "../content/types.ts";
import { stripVariationSelectors } from "../fonts.ts";

/** One search unit as published in `search/units-<n>.json` (60 §60.1). */
export interface SearchUnit {
  tab: string;
  title: string;
  loc: string;
  route: string;
  /**
   * Where on the route's page the unit sits, since several units can share one route: the id of
   * the block, row, topic, gap block, slide, pharm part or flag it covers, or `p<n>` (1-based) for
   * a page of an as-is document. Null when the route shows only this unit (an Initial workup item).
   */
  at: string | null;
  ord: number;
  label: "notes" | "gap" | "update" | "slides";
  text: string;
}

/** The document MiniSearch indexes for a unit; `n` is the unit number. */
export interface IndexDoc {
  n: number;
  title: string;
  text: string;
  concepts: string;
  titleConcepts: string;
  ord: number;
  tab: string;
}

export type VocabEntry = VocabFile["entries"][number];

/** Units per `units-<n>.json` shard. */
export const SHARD_SIZE = 2000;

const TOKEN_RE = /[\p{L}\p{N}\p{M}]+|\p{S}/gu;
const WORD_TOKEN_RE = /^[\p{L}\p{N}\p{M}]+$/u;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const CONCEPT_TERM_RE = /^~\d+$/;
const CONCEPT_FIELDS = new Set(["concepts", "titleConcepts"]);

/**
 * `s` with the RegExp syntax characters escaped, so it matches literally. Only syntax characters
 * are escaped: under the `u` flag any other escaped character (such as `\-`) is a SyntaxError.
 */
export function escapeRegExp(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/** NFC, variation selectors removed, locale-independent lowercase (60 §60.2). */
export function normalize(text: string): string {
  return stripVariationSelectors(text.normalize("NFC")).toLowerCase();
}

/** Word tokens (runs of letters, numbers, marks) and single-character symbol tokens of normalized text. */
export function tokens(text: string): string[] {
  return normalize(text).match(TOKEN_RE) ?? [];
}

/**
 * The tokens of `text` with their UTF-16 [start, end) offsets in the original text. Each token is
 * normalized as `tokens()` gives it; runs that normalize to nothing (a lone variation selector) are skipped.
 */
export function tokenSpans(text: string): { token: string; start: number; end: number }[] {
  const out: { token: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    for (const token of tokens(m[0])) out.push({ token, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** True for a word token; symbol tokens match only exactly. */
export function isWordToken(token: string): boolean {
  return WORD_TOKEN_RE.test(token);
}

/**
 * The tokenizer for indexing and for query strings. Concept fields hold space-separated `~k` terms;
 * a query string that is a concept term (built by `queryTree`, never typed) stays whole.
 */
export function tokenize(text: string, field?: string): string[] {
  if (field === undefined ? CONCEPT_TERM_RE.test(text) : CONCEPT_FIELDS.has(field)) {
    return text.split(" ").filter((t) => t !== "");
  }
  return tokens(text);
}

const identity = (term: string): string => term;

/** MiniSearch options shared by the build and the client (60 §60.4); `loadJSON` needs the same ones. */
export const indexOptions: Options<IndexDoc> = {
  idField: "n",
  fields: ["title", "text", "concepts", "titleConcepts"],
  storeFields: ["ord", "tab"],
  tokenize,
  processTerm: identity,
  searchOptions: { tokenize, processTerm: identity, fuzzy: false },
};

// ---------------------------------------------------------------------------------------------
// Abbreviation concepts (60 §60.3)

/** Code point ending just before index `i` is a letter or number. */
function wordCharBefore(text: string, i: number): boolean {
  if (i <= 0) return false;
  const lo = text.charCodeAt(i - 1);
  const start = lo >= 0xdc00 && lo <= 0xdfff && i >= 2 ? i - 2 : i - 1;
  return WORD_CHAR_RE.test(String.fromCodePoint(text.codePointAt(start) ?? 0));
}

/** Code point starting at index `i` is a letter or number. */
function wordCharAt(text: string, i: number): boolean {
  if (i >= text.length) return false;
  return WORD_CHAR_RE.test(String.fromCodePoint(text.codePointAt(i) ?? 0));
}

/** Exact strings looked up at whole-word positions of a text. */
class PhraseSet {
  private readonly map = new Map<string, number[]>();
  private lengths: number[] = [];
  private readonly firsts = new Set<string>();

  add(phrase: string, entry: number): void {
    if (phrase === "") return;
    const list = this.map.get(phrase);
    if (list) {
      if (!list.includes(entry)) list.push(entry);
    } else {
      this.map.set(phrase, [entry]);
      this.firsts.add(phrase[0] ?? "");
      if (!this.lengths.includes(phrase.length)) this.lengths = [...this.lengths, phrase.length].sort((a, b) => a - b);
    }
  }

  /**
   * Visit every phrase occurrence in `text` bounded by start/end or a non-letter/number, with its
   * [start, end) offsets in `text`. With `fold`, text is compared lowercased (phrases are stored lowercased).
   */
  scan(text: string, fold: boolean, visit: (start: number, end: number, entries: readonly number[]) => void): void {
    if (this.map.size === 0) return;
    for (let s = 0; s < text.length; s++) {
      const ch = text[s] ?? "";
      if (!this.firsts.has(fold ? ch.toLowerCase() : ch) || wordCharBefore(text, s)) continue;
      for (const len of this.lengths) {
        const e = s + len;
        if (e > text.length) break;
        const slice = text.slice(s, e);
        const hit = this.map.get(fold ? slice.toLowerCase() : slice);
        if (hit && !wordCharAt(text, e)) visit(s, e, hit);
      }
    }
  }
}

/** The vocabulary prepared for concept detection on units and clause detection on queries. */
export class Vocab {
  readonly entries: readonly VocabEntry[];
  private readonly abbrs = new PhraseSet();
  private readonly meanings = new PhraseSet();
  private readonly symbols = new Map<string, number[]>();
  private readonly queryKeys = new Map<string, number[]>();

  constructor(entries: readonly VocabEntry[]) {
    this.entries = entries;
    entries.forEach((entry, k) => {
      for (const raw of entry.abbr) {
        const abbr = raw.normalize("NFC");
        if (WORD_CHAR_RE.test(abbr)) this.abbrs.add(abbr, k);
        else if (abbr !== "") pushUnique(this.symbols, abbr, k);
        this.addQueryKey(abbr, k);
      }
      for (const raw of entry.meanings) {
        const meaning = raw.normalize("NFC");
        this.meanings.add(meaning.toLowerCase(), k);
        this.addQueryKey(meaning, k);
      }
    });
  }

  private addQueryKey(phrase: string, k: number): void {
    const key = tokens(phrase).join(" ");
    if (key !== "") pushUnique(this.queryKeys, key, k);
  }

  /**
   * Entry indexes whose abbreviation occurs in `text` as a whole word, case-sensitively (symbol
   * abbreviations as the bare character), or whose meaning occurs as a whole-word phrase,
   * case-insensitively.
   */
  conceptsOf(text: string): number[] {
    const out = new Set<number>();
    this.visit(text.normalize("NFC"), (_s, _e, ks) => {
      for (const k of ks) out.add(k);
    });
    return [...out].sort((a, b) => a - b);
  }

  /**
   * The [start, end) ranges in `text` where an abbreviation or meaning of one of `entries` occurs,
   * by the same rules as `conceptsOf`, in text order. `text` should be NFC (stored text is).
   */
  occurrences(text: string, entries: readonly number[]): [number, number][] {
    const want = new Set(entries);
    const out: [number, number][] = [];
    this.visit(text, (s, e, ks) => {
      if (ks.some((k) => want.has(k)) && !out.some(([a, b]) => a === s && b === e)) out.push([s, e]);
    });
    return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }

  private visit(text: string, f: (start: number, end: number, entries: readonly number[]) => void): void {
    this.abbrs.scan(text, false, f);
    this.meanings.scan(text, true, f);
    for (const [symbol, ks] of this.symbols) {
      for (let i = text.indexOf(symbol); i >= 0; i = text.indexOf(symbol, i + symbol.length)) f(i, i + symbol.length, ks);
    }
  }

  /** Entries whose abbreviation or meaning tokenizes to exactly this token span. */
  entriesForSpan(span: readonly string[]): number[] {
    return this.queryKeys.get(span.join(" ")) ?? [];
  }

  /** The longest span length (in tokens) of any query key. */
  get maxSpan(): number {
    let max = 0;
    for (const key of this.queryKeys.keys()) max = Math.max(max, key.split(" ").length);
    return max;
  }
}

function pushUnique(map: Map<string, number[]>, key: string, k: number): void {
  const list = map.get(key);
  if (!list) map.set(key, [k]);
  else if (!list.includes(k)) list.push(k);
}

/** The space-separated `~k` terms of a text. */
export function conceptTerms(vocab: Vocab, text: string): string {
  return vocab.conceptsOf(text).map((k) => `~${k}`).join(" ");
}

/** The indexed document for unit number `n`. */
export function indexDoc(vocab: Vocab, unit: SearchUnit, n: number): IndexDoc {
  return {
    n,
    title: unit.title,
    text: unit.text,
    concepts: conceptTerms(vocab, `${unit.title}\n${unit.text}`),
    titleConcepts: conceptTerms(vocab, unit.title),
    ord: unit.ord,
    tab: unit.tab,
  };
}

/** Build the index over units numbered by their position. */
export function buildIndex(vocab: Vocab, units: readonly SearchUnit[]): MiniSearch<IndexDoc> {
  const ms = new MiniSearch<IndexDoc>(indexOptions);
  ms.addAll(units.map((u, n) => indexDoc(vocab, u, n)));
  return ms;
}

/** Load a serialized index (`index.json`) with the shared options. */
export function loadIndex(json: string): MiniSearch<IndexDoc> {
  return MiniSearch.loadJSON<IndexDoc>(json, indexOptions);
}

// ---------------------------------------------------------------------------------------------
// Queries (60 §60.3, §60.4)

/** One AND-ed clause: its tokens, and the concept entries that also satisfy it (empty for a plain token). */
export interface Clause {
  tokens: string[];
  concepts: number[];
}

/** True when the query runs (trimmed length ≥ 2 characters, 60 §60.2). */
export function queryRuns(query: string): boolean {
  return [...query.trim()].length >= 2;
}

/** Split a query into clauses: longest vocabulary spans left to right, other tokens alone. */
export function clauses(vocab: Vocab, query: string): Clause[] {
  const toks = tokens(query);
  const max = vocab.maxSpan;
  const out: Clause[] = [];
  for (let i = 0; i < toks.length; ) {
    let taken = false;
    for (let j = Math.min(toks.length, i + max); j > i; j--) {
      const span = toks.slice(i, j);
      const concepts = vocab.entriesForSpan(span);
      if (concepts.length > 0) {
        out.push({ tokens: span, concepts });
        i = j;
        taken = true;
        break;
      }
    }
    if (!taken) {
      out.push({ tokens: [toks[i] ?? ""], concepts: [] });
      i++;
    }
  }
  return out;
}

const prefix: SearchOptions["prefix"] = (term) => isWordToken(term);

/** The query tree; `titleOnly` builds group 1's tree (title fields only). */
export function queryTree(cls: readonly Clause[], titleOnly = false): Query {
  const fields = titleOnly ? ["title"] : ["title", "text"];
  const conceptFields = titleOnly ? ["titleConcepts"] : ["concepts"];
  return {
    combineWith: "AND",
    queries: cls.map((c): Query => {
      if (c.concepts.length === 0) return { queries: c.tokens, fields, prefix };
      return {
        combineWith: "OR",
        queries: [
          { combineWith: "AND", queries: c.tokens, fields, prefix },
          { combineWith: "OR", queries: c.concepts.map((k) => `~${k}`), fields: conceptFields, prefix: false },
        ],
      };
    }),
  };
}

export interface Hit {
  n: number;
  ord: number;
  tab: string;
}

/** Group 1 (title satisfies every clause) and group 2 (the rest), each sorted by `ord`. */
export function runSearch(ms: MiniSearch<IndexDoc>, vocab: Vocab, query: string): { titles: Hit[]; mentions: Hit[] } | null {
  if (!queryRuns(query)) return null;
  const cls = clauses(vocab, query);
  if (cls.length === 0) return { titles: [], mentions: [] };
  const hit = (r: { id: unknown; ord?: unknown; tab?: unknown }): Hit => ({ n: Number(r.id), ord: Number(r.ord), tab: String(r.tab) });
  const byOrd = (a: Hit, b: Hit): number => a.ord - b.ord;
  const titles = ms.search(queryTree(cls, true)).map(hit).sort(byOrd);
  const inTitles = new Set(titles.map((h) => h.n));
  const mentions = ms.search(queryTree(cls)).map(hit).filter((h) => !inTitles.has(h.n)).sort(byOrd);
  return { titles, mentions };
}
