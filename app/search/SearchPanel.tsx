// The results panel: states, tab chips and the two groups (search/layout, search/states, 60 §60.5).
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { queryRuns, type Hit, type SearchUnit } from "../../lib/search/index.ts";
import { navigate } from "../shell/route.ts";
import { Voice } from "../shell/owner.tsx";
import { searchClient } from "./client.ts";
import type { SearchResults } from "./engine.ts";
import { BackIcon, CloseIcon } from "./icons.tsx";
import { createMatcher } from "./match.ts";
import { ResultRow } from "./ResultRow.tsx";
import { clearSearch, closePanel, setQuery, useSearchState } from "./store.ts";
import { useVocab } from "./useVocab.ts";

/** Tabs in site order, with their chip labels. */
export const SEARCH_TABS: readonly (readonly [string, string])[] = [
  ["eor", "EOR"],
  ["pance", "PANCE"],
  ["labs", "Labs"],
  ["imaging", "Imaging"],
  ["ekg", "EKG"],
  ["anatomy", "Anatomy"],
  ["other", "Other"],
];

/** Results update this long after the last keystroke (search/run/happy/results). */
export const DEBOUNCE_MS = 120;

function useLoadStatus() {
  const client = searchClient();
  return useSyncExternalStore(
    (l) => client.subscribe(l),
    () => client.getStatus(),
  );
}

export function SearchPanel({ phone }: { phone: boolean }): ReactNode {
  const { query } = useSearchState();
  const status = useLoadStatus();
  const runs = queryRuns(query);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [filter, setFilter] = useState("all");
  const vocab = useVocab(runs);

  useEffect(() => {
    if (status === "idle") void searchClient().load().catch(() => undefined);
  }, [status]);

  useEffect(() => {
    if (!runs || status !== "ready") return;
    let live = true;
    const timer = setTimeout(() => {
      void searchClient()
        .search(query)
        .then((r) => {
          if (live) setResults(r);
        });
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, runs, status]);

  const shown = runs ? results : null;
  const matcher = useMemo(() => (vocab && shown ? createMatcher(vocab, shown.query) : null), [vocab, shown]);
  const counts = shown?.counts ?? {};
  const total = shown ? shown.titles.length + shown.mentions.length : 0;
  const tab = filter !== "all" && (counts[filter] ?? 0) > 0 ? filter : "all";
  const keep = (h: Hit): boolean => tab === "all" || h.tab === tab;

  const open = (unit: SearchUnit, q: string): void => {
    void navigate(`${unit.route}?q=${encodeURIComponent(q)}`).then((moved) => {
      if (moved) {
        setFilter("all");
        closePanel();
      }
    });
  };

  let message: ReactNode = null;
  if (query.trim() === "") {
    message = (
      <Voice
        owner="Search every tab: your guides, general topics, Labs, Imaging, EKG, Anatomy, Other, files and guideline notes."
        visitor="Search every tab: the guides, general topics, Labs, Imaging, EKG, Anatomy, Other, files and guideline notes."
      />
    );
  } else if (!runs) {
    message = "Keep typing — searches start at 2 characters.";
  } else if (status === "failed") {
    message = (
      <>
        Search couldn't load.{" "}
        <button type="button" className="srch-link" onClick={() => void searchClient().load().catch(() => undefined)}>
          Try again
        </button>
      </>
    );
  } else if (!shown) {
    message = "Searching…";
  } else if (total === 0) {
    message = (
      <>
        No matches for <b>“{shown.query.trim()}”</b>. Check the spelling or try an abbreviation or the full term.
      </>
    );
  }

  const groups =
    shown && total > 0 ? (
      <div className="srch-groups">
        {shown.titles.some(keep) && <div className="srch-grp">Topics named “{shown.query.trim()}”</div>}
        {shown.titles.filter(keep).map((h) => (
          <ResultRow key={`${shown.query}|${h.n}`} n={h.n} matcher={matcher} onOpen={(u) => open(u, shown.query)} />
        ))}
        {shown.mentions.some(keep) && <div className="srch-grp">Mentions</div>}
        {shown.mentions.filter(keep).map((h) => (
          <ResultRow key={`${shown.query}|${h.n}`} n={h.n} matcher={matcher} onOpen={(u) => open(u, shown.query)} />
        ))}
      </div>
    ) : null;

  return (
    <div
      className={`srch-panel${phone ? " full" : ""}`}
      role="region"
      aria-label="Search results"
      data-surface="search"
      onKeyDown={(e) => {
        if (e.key === "Escape") clearSearch();
      }}
    >
      <div className="srch-top">
        {phone && (
          <div className="srch-phone-in">
            <button type="button" className="srch-icon-btn" aria-label="Close search" onClick={closePanel}>
              <BackIcon />
            </button>
            <input
              autoFocus
              aria-label="Search all notes"
              placeholder="Search everything"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query !== "" && (
              <button type="button" className="srch-icon-btn" aria-label="Clear search" onClick={() => setQuery("")}>
                <CloseIcon />
              </button>
            )}
          </div>
        )}
        <div className="srch-chips" role="group" aria-label="Limit to a tab">
          <button type="button" aria-pressed={tab === "all"} onClick={() => setFilter("all")}>
            All{total > 0 ? ` ${total}` : ""}
          </button>
          {SEARCH_TABS.map(([id, label]) => {
            const n = counts[id] ?? 0;
            return (
              <button key={id} type="button" aria-pressed={tab === id} disabled={n === 0} onClick={() => setFilter(id)}>
                {label}
                {n > 0 ? ` ${n}` : ""}
              </button>
            );
          })}
        </div>
      </div>
      <div className="srch-status" aria-live="polite">
        {message ?? <span className="srch-sr">{total === 1 ? "1 result" : `${total} results`}</span>}
      </div>
      {message === null && groups}
    </div>
  );
}
