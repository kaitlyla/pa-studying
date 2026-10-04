// Match ranges, excerpts and "matched via" lines for search results and landing highlights (60 §60.5).
// A match is a text token satisfying a query clause by the 60 §60.2–§60.3 token rules, or an
// occurrence of an abbreviation/meaning of a concept entry that the clause detected. Tokens and
// occurrences come from lib/search, so highlighting follows the same rules as the index.
import { clauses, isWordToken, normalize, queryRuns, tokenSpans, type Clause, type Vocab, type VocabEntry } from "../../lib/search/index.ts";

/** A half-open `[start, end)` range of UTF-16 offsets into the original text. */
export type Range = [number, number];

export interface Matcher {
  readonly query: string;
  readonly clauses: readonly Clause[];
  /** Every match in `text`, sorted and merged. */
  ranges(text: string): Range[];
  /** "abbr = meaning" for each concept entry of a clause whose abbreviation or meaning occurs in `text`. */
  via(text: string): string[];
}

/**
 * The `[start, end)` offsets within `raw` of the part whose normalized form is the first `length`
 * characters of the token: leading characters that normalize away (a variation selector ahead of
 * the letters) are not part of the match.
 */
function prefixSpan(raw: string, length: number): Range {
  let start = 0;
  for (const ch of raw) {
    if (normalize(ch) !== "") break;
    start += ch.length;
  }
  let end = start;
  for (const ch of raw.slice(start)) {
    end += ch.length;
    if (normalize(raw.slice(start, end)).length >= length) break;
  }
  return [start, end];
}

function mergeRanges(ranges: Range[]): Range[] {
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Range[] = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

function viaLine(entry: VocabEntry): string {
  return `${entry.abbr.join(", ")} = ${entry.meanings.join(", ")}`;
}

/** The matcher for a query, or null when the query does not run (fewer than 2 characters). */
export function createMatcher(vocab: Vocab, query: string): Matcher | null {
  if (!queryRuns(query)) return null;
  const cls = clauses(vocab, query);
  const wordTokens = new Set<string>();
  const symbolTokens = new Set<string>();
  for (const c of cls) for (const t of c.tokens) (isWordToken(t) ? wordTokens : symbolTokens).add(t);
  // Longest first, so a token matching several clause tokens is highlighted to the longest prefix.
  const words = [...wordTokens].sort((a, b) => b.length - a.length);
  const concepts = [...new Set(cls.flatMap((c) => c.concepts))].sort((a, b) => a - b);

  return {
    query,
    clauses: cls,
    ranges(text) {
      const out: Range[] = [];
      for (const { token, start, end } of tokenSpans(text)) {
        if (isWordToken(token)) {
          const q = words.find((w) => token.startsWith(w));
          if (q !== undefined) {
            const [a, b] = prefixSpan(text.slice(start, end), q.length);
            out.push([start + a, start + b]);
          }
        } else if (symbolTokens.has(token)) {
          out.push([start, end]);
        }
      }
      if (concepts.length > 0) out.push(...vocab.occurrences(text, concepts));
      return mergeRanges(out);
    },
    via(text) {
      const nfc = text.normalize("NFC");
      return concepts.flatMap((k) => {
        const entry = vocab.entries[k];
        return entry && vocab.occurrences(nfc, [k]).length > 0 ? [viaLine(entry)] : [];
      });
    },
  };
}

/** A piece of text with its highlighted ranges relative to the piece. */
export interface Excerpt {
  text: string;
  ranges: Range[];
  /** True when text was cut before / after the window. */
  cutStart: boolean;
  cutEnd: boolean;
}

const BEFORE = 60;
const AFTER = 120;
const SPACE_RE = /\s/u;

/**
 * The window around the first match: 60 characters before it and 120 after, cut at word
 * boundaries (60 §60.5). Without a match in `text`, the window starts at the beginning.
 */
export function excerpt(text: string, ranges: readonly Range[]): Excerpt {
  const first = ranges[0];
  const matchStart = first ? first[0] : 0;
  const matchEnd = first ? first[1] : 0;
  let start = Math.max(0, matchStart - BEFORE);
  if (start > 0 && !SPACE_RE.test(text[start - 1] ?? "")) {
    // Move forward to the start of the next word, but never past the match.
    let i = start;
    while (i < matchStart && !SPACE_RE.test(text[i] ?? "")) i++;
    start = i < matchStart ? i + 1 : matchStart;
  }
  let end = Math.min(text.length, matchEnd + AFTER);
  if (end < text.length && !SPACE_RE.test(text[end] ?? "")) {
    // Move back to the end of the previous word, but never into the match.
    let i = end;
    while (i > matchEnd && !SPACE_RE.test(text[i - 1] ?? "")) i--;
    end = i > matchEnd ? i : end;
  }
  const inWindow: Range[] = [];
  for (const [a, b] of ranges) {
    if (b <= start || a >= end) continue;
    inWindow.push([Math.max(a, start) - start, Math.min(b, end) - start]);
  }
  return { text: text.slice(start, end).trimEnd(), ranges: inWindow, cutStart: start > 0, cutEnd: end < text.length };
}

/** Split text into plain and highlighted pieces by sorted, non-overlapping ranges. */
export function segments(text: string, ranges: readonly Range[]): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [a, b] of ranges) {
    const s = Math.max(a, at);
    const e = Math.min(b, text.length);
    if (e <= s) continue;
    if (s > at) out.push({ text: text.slice(at, s), hit: false });
    out.push({ text: text.slice(s, e), hit: true });
    at = e;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}
