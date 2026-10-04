// One search result. Its unit (title, location, text) is fetched when the row scrolls into view,
// which is when its shard is loaded (60 §60.4).
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { SearchUnit } from "../../lib/search/index.ts";
import { Voice } from "../shell/owner.tsx";
import { searchClient } from "./client.ts";
import { GapIcon, UpdateIcon } from "./icons.tsx";
import { excerpt, segments, type Matcher, type Range } from "./match.ts";

export function Highlighted({ text, ranges }: { text: string; ranges: readonly Range[] }): ReactNode {
  return segments(text, ranges).map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>));
}

/** Calls `onVisible` once, when the element first intersects the viewport (or at once without IntersectionObserver). */
function useOnceVisible(onVisible: () => void): RefObject<HTMLButtonElement | null> {
  const ref = useRef<HTMLButtonElement | null>(null);
  const cb = useRef(onVisible);
  useEffect(() => {
    cb.current = onVisible;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      cb.current();
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        cb.current();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}

export function ResultRow({ n, matcher, onOpen }: { n: number; matcher: Matcher | null; onOpen: (unit: SearchUnit) => void }): ReactNode {
  const [unit, setUnit] = useState<SearchUnit | null>(null);
  const [failed, setFailed] = useState(false);
  const ref = useOnceVisible(() => {
    searchClient()
      .unit(n)
      .then(setUnit, () => setFailed(true));
  });

  if (!unit) {
    return (
      <button ref={ref} type="button" className="srch-row pending" disabled data-unit={n}>
        <span className="srch-row-t">{failed ? "This result couldn't load." : "Loading…"}</span>
      </button>
    );
  }
  const titleRanges = matcher ? matcher.ranges(unit.title) : [];
  const ex = excerpt(unit.text, matcher ? matcher.ranges(unit.text) : []);
  const via = matcher ? matcher.via(`${unit.title}\n${unit.text}`) : [];
  return (
    <button ref={ref} type="button" className={`srch-row${unit.label === "gap" ? " gap" : ""}`} data-unit={n} data-label={unit.label} onClick={() => onOpen(unit)}>
      <span className="srch-row-t">
        <span className="srch-title">
          <Highlighted text={unit.title} ranges={titleRanges} />
        </span>
        {unit.label === "gap" && (
          <Voice
            owner={
              <span className="srch-chip gap">
                <GapIcon />
                Not from your notes
              </span>
            }
          />
        )}
        {unit.label === "update" && (
          <span className="srch-chip upd">
            <UpdateIcon />
            Updated guideline
          </span>
        )}
      </span>
      <span className="srch-loc">{unit.loc}</span>
      {ex.text !== "" && (
        <span className="srch-ex">
          {ex.cutStart && "…"}
          <Highlighted text={ex.text} ranges={ex.ranges} />
          {ex.cutEnd && "…"}
        </span>
      )}
      {via.length > 0 && (
        <span className="srch-via">
          Matched through <Voice owner="your" visitor="the" /> abbreviation list ({via.join("; ")})
        </span>
      )}
    </button>
  );
}
