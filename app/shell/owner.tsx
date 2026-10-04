// Who is looking: the owner (signed in and passing 50 §50.1) or a visitor. OB9's owner check is the
// only writer; everything else reads. Owner-only wording is hidden by CSS keyed on `html[data-owner]`
// (40 §40.6 Voice), so both wordings are always rendered and saved pages read neutrally to visitors.
import { useSyncExternalStore, type ReactNode } from "react";

export interface OwnerState {
  owner: boolean;
  login?: string;
  avatarUrl?: string;
}

const VISITOR: OwnerState = { owner: false };
let state: OwnerState = VISITOR;
const listeners = new Set<() => void>();

/** Sets the owner state and the `data-owner` attribute on `<html>`. */
export function setOwner(next: OwnerState): void {
  state = next.owner ? { ...next } : VISITOR;
  const root = document.documentElement;
  if (state.owner) root.setAttribute("data-owner", "");
  else root.removeAttribute("data-owner");
  for (const l of listeners) l();
}

export function getOwner(): OwnerState {
  return state;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useOwner(): OwnerState {
  return useSyncExternalStore(subscribe, getOwner);
}

/**
 * Owner and visitor wording (site-shell/voice). Both are in the DOM; CSS shows the one that applies.
 * `visitor` may be omitted for owner-only wording.
 */
export function Voice({ owner, visitor }: { owner: ReactNode; visitor?: ReactNode }): ReactNode {
  return (
    <>
      <span className="own-only">{owner}</span>
      {visitor !== undefined && <span className="vis-only">{visitor}</span>}
    </>
  );
}
