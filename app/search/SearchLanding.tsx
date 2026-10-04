// Arriving from a search result (60 §60.5 Landing, guide-reader/search-landing): every match in the
// rendered content is highlighted through <HitText>, the page scrolls to the first one, and a bar
// offers "Clear highlights". The renderer wraps its text in <HitText>, so React owns the marks.
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { queryRuns } from "../../lib/search/index.ts";
import { navigate, useRoute } from "../shell/route.ts";
import { createMatcher, segments, type Matcher, type Range } from "./match.ts";
import { adoptQuery } from "./store.ts";
import { useVocab } from "./useVocab.ts";
import "./search.css";

const HighlightContext = createContext<Matcher | null>(null);

/** Provides the matcher for the route's `?q=` to every <HitText> below it. */
export function SearchHighlightProvider({ children }: { children?: ReactNode }): ReactNode {
  const q = useRoute().query.q;
  const active = q !== null && queryRuns(q);
  const vocab = useVocab(active);
  const matcher = useMemo(() => (active && vocab && q !== null ? createMatcher(vocab, q) : null), [active, vocab, q]);
  return <HighlightContext.Provider value={matcher}>{children}</HighlightContext.Provider>;
}

/** The matches of the enclosing <HitBlock>'s joined text; null outside one or without a search. */
const BlockRangesContext = createContext<readonly Range[] | null>(null);

/**
 * A paragraph or cell whose text runs render through `<HitText offset>`. Matches are found in the
 * block's joined inline text, the text the index searched, so a word her formatting splits across
 * runs ("M|itral S|tenosis") is still highlighted, piece by piece.
 */
export function HitBlock({ text, children }: { text: string; children?: ReactNode }): ReactNode {
  const matcher = useContext(HighlightContext);
  // Tabs and line breaks read as spaces, as in the index's search text (60 §60.1); same length.
  const ranges = useMemo(() => (matcher ? matcher.ranges(text.replace(/[\t\r\n]/g, " ")) : null), [matcher, text]);
  return <BlockRangesContext.Provider value={ranges}>{children}</BlockRangesContext.Provider>;
}

/** The part of `ranges` inside `[offset, offset + length)`, relative to `offset`. */
function sliceRanges(ranges: readonly Range[], offset: number, length: number): Range[] {
  const out: Range[] = [];
  for (const [a, b] of ranges) {
    const s = Math.max(a, offset);
    const e = Math.min(b, offset + length);
    if (s < e) out.push([s - offset, e - offset]);
  }
  return out;
}

/**
 * A text run with every search match wrapped in `<mark class="hit">`; plain text when no search is
 * active. With `offset` (the run's start in the joined text of the enclosing <HitBlock>) the run
 * shows its share of the block's matches; without it the run is matched on its own.
 */
export function HitText({ text, offset }: { text: string; offset?: number }): ReactNode {
  const matcher = useContext(HighlightContext);
  const block = useContext(BlockRangesContext);
  if (!matcher) return text;
  const ranges = offset !== undefined && block ? sliceRanges(block, offset, text.length) : matcher.ranges(text);
  if (ranges.length === 0) return text;
  return segments(text, ranges).map((s, i) =>
    s.hit ? (
      <mark key={i} className="hit">
        {s.text}
      </mark>
    ) : (
      s.text
    ),
  );
}

/**
 * The match to scroll to. With an `at` anchor whose element(s) are on the page (the result's own
 * block, row, slide or page, since several results share one route), only a match inside them, one
 * that is displayed first (the phone's stacked rows and the table both carry the anchor), or null
 * until one renders. Without the anchor, the page's first match.
 */
function scrollTarget(root: Element, at: string | null): Element | null {
  const anchored = at === null ? [] : [...root.querySelectorAll("[data-anchor]")].filter((el) => el.getAttribute("data-anchor") === at);
  if (anchored.length === 0) return root.querySelector("mark.hit");
  const marks = anchored.flatMap((el) => {
    const m = el.querySelector("mark.hit");
    return m ? [m] : [];
  });
  return marks.find((m) => m.getClientRects().length > 0) ?? marks[0] ?? null;
}

/** The "Showing matches for 'x' · Clear highlights" bar; also scrolls to the result's first match. */
export function SearchLanding(): ReactNode {
  const route = useRoute();
  const q = route.query.q;
  const matcher = useContext(HighlightContext);
  const barRef = useRef<HTMLDivElement | null>(null);
  const active = q !== null && queryRuns(q);

  useEffect(() => {
    if (q) adoptQuery(q);
  }, [q]);

  const at = route.query.at;
  useEffect(() => {
    if (!matcher) return;
    const root = barRef.current?.closest("main") ?? document.body;
    const scrollToFirst = (): boolean => {
      const target = scrollTarget(root, at);
      if (!target) return false;
      target.scrollIntoView({ block: "center" });
      return true;
    };
    if (scrollToFirst()) return;
    // The page's data may still be loading: wait for the match to render.
    const mo = new MutationObserver(() => {
      if (scrollToFirst()) mo.disconnect();
    });
    mo.observe(root, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [matcher, route.path, at]);

  if (!active || q === null) return null;
  const clear = (): void => {
    void navigate(route.query.from ? `${route.path}?from=${encodeURIComponent(route.query.from)}` : route.path);
  };
  return (
    <div className="hitbar" ref={barRef} role="status">
      <span>
        Showing matches for <b>“{q.trim()}”</b>
      </span>
      <span aria-hidden="true">·</span>
      <button type="button" className="srch-link" onClick={clear}>
        Clear highlights
      </button>
    </div>
  );
}
