// The search box's state, shared by the header box, the phone full-screen panel and result landing.
import { useSyncExternalStore } from "react";

export interface SearchState {
  /** The text in the search box (kept after opening a result, 60 §60.5 Landing). */
  query: string;
  /** Whether the results panel is open. */
  open: boolean;
}

let state: SearchState = { query: "", open: false };
const listeners = new Set<() => void>();

function emit(next: SearchState): void {
  if (next.query === state.query && next.open === state.open) return;
  state = next;
  for (const l of listeners) l();
}

export function getSearchState(): SearchState {
  return state;
}

export function setQuery(query: string): void {
  emit({ query, open: true });
}

export function openPanel(): void {
  emit({ ...state, open: true });
}

/** Close the panel; the text stays in the box and the route is unchanged (search/edges/clear). */
export function closePanel(): void {
  emit({ ...state, open: false });
}

/** Clear the box and close the panel; the route is unchanged. */
export function clearSearch(): void {
  emit({ query: "", open: false });
}

/** Put a landing query in an empty box (opening a `?q=` link directly). */
export function adoptQuery(query: string): void {
  if (state.query === "") emit({ ...state, query });
}

export function useSearchState(): SearchState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** Reset to the initial state (tests). */
export function resetSearchState(): void {
  state = { query: "", open: false };
  for (const l of listeners) l();
}
