// A tiny key–value store on IndexedDB: `pa-drafts` (50 §50.3) and `pa-overlay` (50 §50.5). Each
// database holds one object store, "kv". Where IndexedDB is missing the values live in memory.

export interface KvStore<T> {
  get(key: string): Promise<T | undefined>;
  put(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  entries(): Promise<[string, T][]>;
}

const STORE = "kv";

function request<R>(req: IDBRequest<R>): Promise<R> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function open(name: string): Promise<IDBDatabase> {
  const req = indexedDB.open(name, 1);
  req.onupgradeneeded = () => {
    if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
  };
  return request(req);
}

function idbStore<T>(name: string): KvStore<T> {
  let db: Promise<IDBDatabase> | null = null;
  const tx = async <R>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<R>): Promise<R> => {
    // A failed open is not kept: the next call tries again (iOS Safari can refuse after backgrounding).
    db ??= open(name).catch((e: unknown) => {
      db = null;
      throw e;
    });
    const store = (await db).transaction(STORE, mode).objectStore(STORE);
    return request(run(store));
  };
  return {
    get: (key) => tx("readonly", (s) => s.get(key) as IDBRequest<T | undefined>),
    put: async (key, value) => {
      await tx("readwrite", (s) => s.put(value, key));
    },
    delete: async (key) => {
      await tx("readwrite", (s) => s.delete(key));
    },
    entries: async () => {
      const [keys, values] = await Promise.all([
        tx("readonly", (s) => s.getAllKeys()),
        tx("readonly", (s) => s.getAll() as IDBRequest<T[]>),
      ]);
      return keys.map((k, i) => [String(k), values[i] as T]);
    },
  };
}

export function memoryStore<T>(): KvStore<T> {
  const m = new Map<string, T>();
  return {
    get: async (key) => m.get(key),
    put: async (key, value) => {
      m.set(key, value);
    },
    delete: async (key) => {
      m.delete(key);
    },
    entries: async () => [...m],
  };
}

export function kvStore<T>(name: string): KvStore<T> {
  return typeof indexedDB === "undefined" ? memoryStore<T>() : idbStore<T>(name);
}
