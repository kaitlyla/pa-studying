// The header search: a box with a drop-down panel on laptop, a magnifier opening a full-screen
// panel on phone (search/layout, site-shell/responsive). The index loads on first focus (60 §60.4).
import { useEffect, useRef, type ReactNode } from "react";
import { useRoute } from "../shell/route.ts";
import { CloseIcon, MagnifierIcon } from "./icons.tsx";
import { SearchPanel } from "./SearchPanel.tsx";
import { adoptQuery, clearSearch, closePanel, openPanel, setQuery, useSearchState } from "./store.ts";
import "./search.css";

export function SearchBox({ phone }: { phone: boolean }): ReactNode {
  const { query, open } = useSearchState();
  const landingQuery = useRoute().query.q;
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (landingQuery) adoptQuery(landingQuery);
  }, [landingQuery]);

  // Clicking outside closes the laptop panel and leaves the page as it was (search/states).
  useEffect(() => {
    if (!open || phone) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) closePanel();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, phone]);

  if (phone) {
    return (
      <div className="srch-phone" ref={rootRef}>
        <button type="button" className="srch-icon-btn srch-mag" aria-label="Search" onClick={openPanel}>
          <MagnifierIcon size={18} />
        </button>
        {open && <SearchPanel phone />}
      </div>
    );
  }
  return (
    <div className="srch-box" role="search" ref={rootRef}>
      <span className="srch-ico">
        <MagnifierIcon />
      </span>
      <input
        aria-label="Search all notes"
        placeholder="Search all notes"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={openPanel}
        onKeyDown={(e) => {
          if (e.key === "Escape") clearSearch();
        }}
      />
      {query !== "" && (
        <button type="button" className="srch-clr" aria-label="Clear search" onClick={clearSearch}>
          <CloseIcon />
        </button>
      )}
      {open && <SearchPanel phone={false} />}
    </div>
  );
}
