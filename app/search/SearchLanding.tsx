// Arriving from a search result (60 §60.5 Landing, guide-reader/search-landing): every match in the
// rendered content is highlighted through <HitText>, the page scrolls to the first one, and a bar
// offers "Clear highlights". The renderer wraps its text in <HitText>, so React owns the marks.
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { queryRuns } from "../../lib/search/index.ts";
import { navigate, useRoute } from "../shell/route.ts";
import { createMatcher, segments, type Matcher } from "./match.ts";
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

/** A text run with every search match wrapped in `<mark class="hit">`; plain text when no search is active. */
export function HitText({ text }: { text: string }): ReactNode {
  const matcher = useContext(HighlightContext);
  if (!matcher) return text;
  const ranges = matcher.ranges(text);
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
 * The first match inside the element(s) marked `data-anchor="<at>"` (the result's own block, row,
 * slide or page, since several results can share one route), preferring one that is displayed
 * (the phone's stacked rows and the table both carry the anchor). Null when there is none.
 */
function firstInAnchor(root: Element, at: string | null): Element | null {
  if (at === null) return null;
  const marks = [...root.querySelectorAll("[data-anchor]")].flatMap((el) => {
    const m = el.getAttribute("data-anchor") === at ? el.querySelector("mark.hit") : null;
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
      const first = root.querySelector("mark.hit");
      if (!first) return false;
      (firstInAnchor(root, at) ?? first).scrollIntoView({ block: "center" });
      return true;
    };
    if (scrollToFirst()) return;
    // The page's data may still be loading: wait for the first match to render.
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
