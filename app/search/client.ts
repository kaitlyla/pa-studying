// Page-side search client: drives the search worker, fetches only the unit shards a result row
// needs, and loads the vocabulary for highlighting (60 §60.4).
import { SHARD_SIZE, Vocab, type SearchUnit } from "../../lib/search/index.ts";
import type { VocabFile } from "../../lib/content/types.ts";
import type { SearchResults, WorkerRequest, WorkerResponse } from "./engine.ts";

export interface WorkerLike {
  postMessage(message: WorkerRequest): void;
  onmessage: ((ev: MessageEvent<WorkerResponse>) => void) | null;
}

export type LoadStatus = "idle" | "loading" | "ready" | "failed";

export class SearchClient {
  private worker: WorkerLike | null = null;
  private status: LoadStatus = "idle";
  private loading: Promise<void> | null = null;
  private settleLoad: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, (r: SearchResults | null) => void>();
  private readonly shards = new Map<number, Promise<SearchUnit[]>>();
  private vocabPromise: Promise<Vocab> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly createWorker: () => WorkerLike;
  /** URL of `data/search/`. */
  readonly base: string;
  private readonly fetcher: typeof fetch;

  constructor(createWorker: () => WorkerLike, base: string, fetcher: typeof fetch = (input, init) => fetch(input, init)) {
    this.createWorker = createWorker;
    this.base = base;
    this.fetcher = fetcher;
  }

  getStatus(): LoadStatus {
    return this.status;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(status: LoadStatus): void {
    this.status = status;
    for (const l of this.listeners) l();
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.onmessage = (ev) => {
      const msg = ev.data;
      if (msg.type === "results") {
        const resolve = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve?.(msg.results);
      } else if (msg.type === "loaded") {
        this.setStatus("ready");
        this.settleLoad?.resolve();
      } else {
        this.loading = null;
        this.setStatus("failed");
        this.settleLoad?.reject(new Error(msg.message));
      }
    };
    this.worker = worker;
    return worker;
  }

  /** Load the index into the worker (first focus of the search box). Retries after a failure. */
  load(): Promise<void> {
    if (this.loading) return this.loading;
    const worker = this.ensureWorker();
    this.loading = new Promise<void>((resolve, reject) => {
      this.settleLoad = { resolve, reject };
    });
    this.loading.catch(() => undefined);
    this.setStatus("loading");
    worker.postMessage({ type: "load", base: this.base });
    return this.loading;
  }

  /** Run a query; null when it does not run or the index is unavailable. */
  search(query: string): Promise<SearchResults | null> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      worker.postMessage({ type: "search", id, query });
    });
  }

  private async getJson<T>(name: string): Promise<T> {
    const res = await this.fetcher(new URL(name, this.base));
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /** Unit number `n`, fetching its shard on first need. */
  async unit(n: number): Promise<SearchUnit> {
    const k = Math.floor(n / SHARD_SIZE);
    let shard = this.shards.get(k);
    if (!shard) {
      shard = this.getJson<SearchUnit[]>(`units-${k}.json`);
      this.shards.set(k, shard);
      shard.catch(() => this.shards.delete(k));
    }
    const unit = (await shard)[n % SHARD_SIZE];
    if (!unit) throw new Error(`unit ${n} is not in units-${k}.json`);
    return unit;
  }

  /** The abbreviation vocabulary, for match highlighting on the page. */
  vocab(): Promise<Vocab> {
    if (!this.vocabPromise) {
      const p = this.getJson<VocabFile>("vocab.json").then((f) => new Vocab(f.entries));
      this.vocabPromise = p;
      p.catch(() => {
        this.vocabPromise = null;
      });
    }
    return this.vocabPromise;
  }
}

let client: SearchClient | null = null;

/** The site's search client, created on first use. */
export function searchClient(): SearchClient {
  client ??= new SearchClient(
    () => new Worker(new URL("./search.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike,
    new URL("data/search/", document.baseURI).href,
  );
  return client;
}

/** Replace the site's search client (tests run the engine in-process instead of in a Worker). */
export function setSearchClient(next: SearchClient | null): void {
  client = next;
}
