// The key–value store (plan 50 §50.3, §50.5): the in-memory fallback, and the IndexedDB store against a
// small fake that follows the request contract (callbacks fire asynchronously after the caller sets them).
import { afterEach, describe, expect, it, vi } from "vitest";
import { kvStore, memoryStore } from "./idb.ts";

interface FakeRequest {
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded: (() => void) | null;
  result: unknown;
  error: DOMException | null;
}

function fakeRequest(): FakeRequest {
  return { onsuccess: null, onerror: null, onupgradeneeded: null, result: undefined, error: null };
}

function succeedLater(req: FakeRequest, result: unknown): FakeRequest {
  queueMicrotask(() => {
    req.result = result;
    req.onsuccess?.();
  });
  return req;
}

function fakeIndexedDB() {
  const data = new Map<string, Map<string, unknown>>();
  const stores = new Map<string, string[]>();
  const fake = {
    opens: 0,
    failNextOpen: false,
    created: (name: string) => stores.get(name) ?? [],
    open(name: string): FakeRequest {
      fake.opens++;
      const req = fakeRequest();
      const fail = fake.failNextOpen;
      fake.failNextOpen = false;
      queueMicrotask(() => {
        if (fail) {
          req.error = new DOMException("blocked", "UnknownError");
          req.onerror?.();
          return;
        }
        const firstOpen = !data.has(name);
        if (firstOpen) data.set(name, new Map());
        const map = data.get(name) ?? new Map<string, unknown>();
        const created = stores.get(name) ?? [];
        stores.set(name, created);
        const store = {
          get: (key: string) => succeedLater(fakeRequest(), map.get(key)),
          put: (value: unknown, key: string) => {
            map.set(key, value);
            return succeedLater(fakeRequest(), key);
          },
          delete: (key: string) => {
            map.delete(key);
            return succeedLater(fakeRequest(), undefined);
          },
          getAllKeys: () => succeedLater(fakeRequest(), [...map.keys()]),
          getAll: () => succeedLater(fakeRequest(), [...map.values()]),
        };
        req.result = {
          objectStoreNames: { contains: (s: string) => created.includes(s) },
          createObjectStore: (s: string) => {
            created.push(s);
          },
          transaction: (s: string) => {
            if (!created.includes(s)) throw new DOMException(`no store ${s}`, "NotFoundError");
            return { objectStore: () => store };
          },
        };
        if (firstOpen) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
  return fake;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("memoryStore", () => {
  it("puts, gets, deletes and lists entries", async () => {
    const s = memoryStore<number>();
    await s.put("a", 1);
    await s.put("b", 2);
    expect(await s.get("a")).toBe(1);
    expect(await s.entries()).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    await s.delete("a");
    expect(await s.get("a")).toBeUndefined();
    expect(await s.entries()).toEqual([["b", 2]]);
  });
});

describe("kvStore", () => {
  it("keeps values in memory where IndexedDB is missing", async () => {
    expect(typeof indexedDB).toBe("undefined");
    const s = kvStore<string>("pa-drafts");
    await s.put("k", "v");
    expect(await s.get("k")).toBe("v");
  });

  it("stores values in IndexedDB, opening the database once", async () => {
    const fake = fakeIndexedDB();
    vi.stubGlobal("indexedDB", fake);
    const s = kvStore<{ x: number }>("pa-drafts");
    await s.put("k", { x: 1 });
    expect(await s.get("k")).toEqual({ x: 1 });
    expect(await s.entries()).toEqual([["k", { x: 1 }]]);
    await s.delete("k");
    expect(await s.get("k")).toBeUndefined();
    expect(fake.created("pa-drafts")).toEqual(["kv"]);
    expect(fake.opens).toBe(1);
  });

  it("opens again after a failed open", async () => {
    const fake = fakeIndexedDB();
    vi.stubGlobal("indexedDB", fake);
    const s = kvStore<number>("pa-overlay");
    fake.failNextOpen = true;
    await expect(s.get("k")).rejects.toThrow("blocked");
    await s.put("k", 2);
    expect(await s.get("k")).toBe(2);
    expect(fake.opens).toBe(2);
  });
});
