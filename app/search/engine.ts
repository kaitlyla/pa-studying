// The search worker's engine: loads `index.json` and `vocab.json`, runs the two query trees and
// returns each group sorted by `ord` with per-tab counts (60 §60.4, §60.5).
import type MiniSearch from "minisearch";
import { loadIndex, runSearch, Vocab, type Hit, type IndexDoc } from "../../lib/search/index.ts";
import type { VocabFile } from "../../lib/content/types.ts";

export interface SearchResults {
  query: string;
  /** Group 1, "Topics named 'x'". */
  titles: Hit[];
  /** Group 2, "Mentions". */
  mentions: Hit[];
  /** Result count per tab over both groups. */
  counts: Record<string, number>;
}

/** Messages to the worker. */
export type WorkerRequest =
  | { type: "load"; base: string }
  | { type: "search"; id: number; query: string };

/** Messages from the worker. */
export type WorkerResponse =
  | { type: "loaded" }
  | { type: "load-failed"; message: string }
  | { type: "results"; id: number; results: SearchResults | null };

export interface Engine {
  search(query: string): SearchResults | null;
}

/** Fetch the index and vocabulary under `base` (the `data/search/` URL) and build the engine. */
export async function loadEngine(base: string, fetcher: typeof fetch = fetch): Promise<Engine> {
  const get = async (name: string): Promise<string> => {
    const res = await fetcher(new URL(name, base));
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    return res.text();
  };
  const [indexJson, vocabJson] = await Promise.all([get("index.json"), get("vocab.json")]);
  const ms: MiniSearch<IndexDoc> = loadIndex(indexJson);
  const vocab = new Vocab((JSON.parse(vocabJson) as VocabFile).entries);
  return {
    search(query) {
      const groups = runSearch(ms, vocab, query);
      if (!groups) return null;
      const counts: Record<string, number> = {};
      for (const h of [...groups.titles, ...groups.mentions]) counts[h.tab] = (counts[h.tab] ?? 0) + 1;
      return { query, titles: groups.titles, mentions: groups.mentions, counts };
    },
  };
}

interface WorkerScope {
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
}

/** Serve requests on a worker scope. Searches wait for the load to finish. */
export function serveEngine(scope: WorkerScope, fetcher: typeof fetch = fetch): void {
  let engine: Promise<Engine> | null = null;
  scope.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.type === "load") {
      if (engine) return;
      const loading = loadEngine(msg.base, fetcher);
      engine = loading;
      loading.then(
        () => scope.postMessage({ type: "loaded" }),
        (err: unknown) => {
          engine = null;
          scope.postMessage({ type: "load-failed", message: err instanceof Error ? err.message : String(err) });
        },
      );
      return;
    }
    const pending = engine;
    if (!pending) {
      scope.postMessage({ type: "results", id: msg.id, results: null });
      return;
    }
    pending.then(
      (e) => scope.postMessage({ type: "results", id: msg.id, results: e.search(msg.query) }),
      () => scope.postMessage({ type: "results", id: msg.id, results: null }),
    );
  };
}
