// Published data (`dist/data/`, plan 40 §40.8): fetched per route and cached in memory for the session
// (40 §40.9). While the owner is signed in, OB9 passes every fetch through its local overlay (50 §50.5).
import { use, useSyncExternalStore } from "react";

/** The URL prefix of the published data (`<base>data/`). */
export const DATA_BASE = `${import.meta.env.BASE_URL}data/`;

/** A data file that does not exist: the page "isn't on the site" (10 §10.4). */
export class NotFoundError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Not found: ${path}`);
    this.name = "NotFoundError";
    this.path = path;
  }
}

/** The data request itself could not be made (no connection); HTTP, JSON and overlay errors are not this. */
export class DataOfflineError extends Error {
  readonly path: string;

  constructor(path: string, options?: ErrorOptions) {
    super(`Offline: ${path}`, options);
    this.name = "DataOfflineError";
    this.path = path;
  }
}

type Overlay = (path: string, json: unknown) => Promise<unknown>;

let overlay: Overlay | null = null;
const cache = new Map<string, Promise<unknown>>();
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version += 1;
  for (const l of listeners) l();
}

async function fetchJson(path: string): Promise<unknown> {
  // Pages serves data with max-age=600; revalidate so a re-read after her save is deployed is never
  // answered from the browser's stale copy (an unchanged file costs a 304).
  const res = await fetch(DATA_BASE + path, { cache: "no-cache" }).catch((e: unknown) => {
    throw new DataOfflineError(path, { cause: e });
  });
  if (res.status === 404) throw new NotFoundError(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const json: unknown = await res.json();
  return overlay ? overlay(path, json) : json;
}

/** Loads `dist/data/<path>` once per session (until invalidated). */
export function loadData<T>(path: string): Promise<T> {
  let p = cache.get(path);
  if (!p) {
    p = fetchJson(path);
    cache.set(path, p);
    // A failed fetch is not kept, so a later visit retries.
    p.catch(() => {
      if (cache.get(path) === p) cache.delete(path);
    });
  }
  return p as Promise<T>;
}

/** Installs (or removes, with null) the owner's local overlay and reloads every page's data. */
export function setDataOverlay(fn: Overlay | null): void {
  overlay = fn;
  invalidateData();
}

/** Drops cached data (one path, or everything) so the next read fetches again. */
export function invalidateData(path?: string): void {
  if (path === undefined) cache.clear();
  else cache.delete(path);
  bump();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const getVersion = (): number => version;

/**
 * Reads a data file inside a Suspense boundary; re-reads after an invalidation. Errors (including
 * NotFoundError) are thrown to the nearest error boundary.
 */
export function useData<T>(path: string): T {
  useSyncExternalStore(subscribe, getVersion);
  return use(loadData<T>(path));
}
