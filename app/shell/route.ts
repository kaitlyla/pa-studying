// The live location for hash routes (plan 10 §10.4): the React hook, in-app navigation with the
// unsaved-changes guard (50 §50.3), and back/forward handling. The route grammar itself (parser and
// builders) is lib/derive/routes.ts, shared with the build.
import { useSyncExternalStore } from "react";
import { parseHash, type Route } from "../../lib/derive/routes.ts";
import { retryFailedReads } from "../data/load.ts";

export {
  PANCE,
  parseHash,
  guideBase,
  guideViewHash,
  fileHash,
  versionsHash,
  stripQuery,
  refHash,
  otherHash,
  type GuideView,
  type RoutePage,
  type RouteQuery,
  type Route,
} from "../../lib/derive/routes.ts";

type Guard = (toHash: string) => boolean | Promise<boolean>;
let guard: Guard | null = null;
const listeners = new Set<() => void>();
let current = typeof location === "undefined" ? "" : location.hash;
let currentRoute: Route = parseHash(current);

/** Records a new current hash (and its parsed route) and notifies subscribers. */
function setCurrent(hash: string): void {
  if (hash !== current) {
    current = hash;
    currentRoute = parseHash(hash);
    retryFailedReads();
  }
  for (const l of listeners) l();
}

function apply(hash: string): void {
  const h = hash.startsWith("#") ? hash : `#${hash}`;
  if (h !== location.hash) location.hash = h;
  setCurrent(h);
}

/**
 * Registers the check every in-app navigation awaits (OB9's unsaved-changes guard, 50 §50.3).
 * Returns the unregister function.
 */
export function setNavigationGuard(fn: Guard): () => void {
  guard = fn;
  return () => {
    if (guard === fn) guard = null;
  };
}

/** Navigates to `hash` once the navigation guard (if any) allows it. Resolves to whether it moved. */
export async function navigate(hash: string): Promise<boolean> {
  const h = hash.startsWith("#") ? hash : `#${hash}`;
  if (guard && !(await guard(h))) return false;
  apply(h);
  return true;
}

function onHashChange(): void {
  const to = location.hash;
  if (to === current) return;
  if (!guard) {
    setCurrent(to);
    return;
  }
  // A back/forward or typed change has already moved the address. The entry it landed on stays as it
  // is; the page keeps showing `from` until the guard decides. Refused: a new entry for `from` puts
  // the address back (and drops the forward entries, as any new navigation does).
  const from = current;
  void Promise.resolve(guard(to)).then((ok) => {
    if (ok) setCurrent(to);
    else history.pushState(null, "", from === "" ? location.pathname + location.search : from);
  });
}

let installed = false;
function install(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  if (location.hash !== current) {
    current = location.hash;
    currentRoute = parseHash(current);
  }
  window.addEventListener("hashchange", onHashChange);
}

function subscribe(cb: () => void): () => void {
  install();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const getSnapshot = (): Route => currentRoute;

/** The current route, re-rendering on every location change. */
export function useRoute(): Route {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** The current hash, for code outside React. */
export function currentHash(): string {
  install();
  return current;
}

/** Re-reads `location.hash` (used by tests and after `history` changes made outside the router). */
export function syncFromLocation(): void {
  setCurrent(location.hash);
}
