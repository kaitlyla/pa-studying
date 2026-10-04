import { afterEach, describe, expect, it } from "vitest";
import { SearchClient } from "./client.ts";
import { loadEngine, serveEngine, type WorkerRequest, type WorkerResponse } from "./engine.ts";
import { BASE, fakeSite, inProcessWorker, U } from "./testing.ts";

const ns = (hits: { n: number }[]): number[] => hits.map((h) => h.n);

describe("loadEngine", () => {
  it("splits title matches from mentions, each in site order, and counts results per tab", async () => {
    const site = fakeSite();
    const engine = await loadEngine(BASE, site.fetch);
    const r = engine.search("endocard");
    expect(r).not.toBeNull();
    expect(ns(r?.titles ?? [])).toEqual([U.ie, U.gap, U.cushion]);
    expect(ns(r?.mentions ?? [])).toEqual([U.angina]);
    expect(r?.counts).toEqual({ eor: 3, anatomy: 1 });
    expect(r?.query).toBe("endocard");
  });

  it("finds a vocabulary abbreviation's meaning", async () => {
    const engine = await loadEngine(BASE, fakeSite().fetch);
    const r = engine.search("MI");
    expect(ns(r?.titles ?? [])).toEqual([]);
    expect(ns(r?.mentions ?? [])).toEqual([U.angina, U.acs]);
    expect(r?.counts).toEqual({ eor: 1, pance: 1 });
  });

  it("does not run a one-character query", async () => {
    const engine = await loadEngine(BASE, fakeSite().fetch);
    expect(engine.search("e")).toBeNull();
  });

  it("fails when a file is missing", async () => {
    const site = fakeSite();
    site.failing.add("index.json");
    await expect(loadEngine(BASE, site.fetch)).rejects.toThrow("index.json: HTTP 500");
  });
});

describe("serveEngine", () => {
  function scope() {
    const out: WorkerResponse[] = [];
    let resolveNext: (() => void) | null = null;
    const s = {
      onmessage: null as ((ev: MessageEvent<WorkerRequest>) => void) | null,
      postMessage(m: WorkerResponse) {
        out.push(m);
        resolveNext?.();
      },
    };
    const send = (m: WorkerRequest): void => s.onmessage?.({ data: m } as MessageEvent<WorkerRequest>);
    const next = (count: number): Promise<void> =>
      new Promise((resolve) => {
        const check = (): void => {
          if (out.length >= count) resolve();
        };
        resolveNext = check;
        check();
      });
    return { s, send, out, next };
  }

  it("answers a search sent before the index finished loading once it has loaded", async () => {
    const site = fakeSite();
    const { s, send, out, next } = scope();
    serveEngine(s, site.fetch);
    send({ type: "load", base: BASE });
    send({ type: "load", base: BASE });
    send({ type: "search", id: 7, query: "troponin" });
    await next(2);
    expect(out[0]).toEqual({ type: "loaded" });
    const res = out[1];
    expect(res?.type === "results" && res.id).toBe(7);
    expect(res?.type === "results" && res.results && ns(res.results.titles)).toEqual([U.troponin]);
    // The duplicate load fetched nothing more.
    expect(site.requests.filter((r) => r === "index.json")).toHaveLength(1);
  });

  it("answers null to a search with no load requested", async () => {
    const { s, send, out, next } = scope();
    serveEngine(s, fakeSite().fetch);
    send({ type: "search", id: 1, query: "troponin" });
    await next(1);
    expect(out).toEqual([{ type: "results", id: 1, results: null }]);
  });

  it("reports a failed load, answers null meanwhile, and loads again on the next request", async () => {
    const site = fakeSite();
    site.failing.add("vocab.json");
    const { s, send, out, next } = scope();
    serveEngine(s, site.fetch);
    send({ type: "load", base: BASE });
    send({ type: "search", id: 2, query: "troponin" });
    await next(2);
    expect(out).toContainEqual({ type: "load-failed", message: "vocab.json: HTTP 500" });
    expect(out).toContainEqual({ type: "results", id: 2, results: null });
    site.failing.clear();
    send({ type: "load", base: BASE });
    await next(3);
    expect(out[2]).toEqual({ type: "loaded" });
  });
});

describe("SearchClient", () => {
  let client: SearchClient | null = null;
  afterEach(() => {
    client = null;
  });

  it("loads the index in the worker and reports its status", async () => {
    const site = fakeSite();
    client = new SearchClient(() => inProcessWorker(site.fetch), BASE, site.fetch);
    const seen: string[] = [];
    client.subscribe(() => seen.push(client?.getStatus() ?? ""));
    expect(client.getStatus()).toBe("idle");
    const loading = client.load();
    expect(client.load()).toBe(loading);
    await loading;
    expect(seen).toEqual(["loading", "ready"]);
    const r = await client.search("endocard");
    expect(ns(r?.titles ?? [])).toEqual([U.ie, U.gap, U.cushion]);
  });

  it("rejects a failed load and succeeds when retried", async () => {
    const site = fakeSite();
    site.failing.add("index.json");
    client = new SearchClient(() => inProcessWorker(site.fetch), BASE, site.fetch);
    await expect(client.load()).rejects.toThrow("index.json: HTTP 500");
    expect(client.getStatus()).toBe("failed");
    site.failing.clear();
    await client.load();
    expect(client.getStatus()).toBe("ready");
  });

  it("fetches only the shard holding the requested unit, once", async () => {
    const site = fakeSite();
    client = new SearchClient(() => inProcessWorker(site.fetch), BASE, site.fetch);
    const ie = await client.unit(U.ie);
    expect(ie.title).toBe("Infective endocarditis");
    await client.unit(U.angina);
    expect(site.requests).toEqual(["units-0.json"]);
    const cushion = await client.unit(U.cushion);
    expect(cushion.title).toBe("Endocardial cushion");
    expect(site.requests).toEqual(["units-0.json", "units-1.json"]);
  });

  it("refetches a shard after a failed fetch, and rejects a unit number beyond the shard", async () => {
    const site = fakeSite();
    client = new SearchClient(() => inProcessWorker(site.fetch), BASE, site.fetch);
    site.failing.add("units-0.json");
    await expect(client.unit(U.ie)).rejects.toThrow("units-0.json: HTTP 500");
    site.failing.clear();
    await expect(client.unit(U.ie)).resolves.toMatchObject({ route: "#/eor/fm/t/r_ie" });
    await expect(client.unit(U.cushion + 1000)).rejects.toThrow("unit 3050 is not in units-1.json");
  });

  it("loads the vocabulary once and again after a failure", async () => {
    const site = fakeSite();
    client = new SearchClient(() => inProcessWorker(site.fetch), BASE, site.fetch);
    site.failing.add("vocab.json");
    await expect(client.vocab()).rejects.toThrow("vocab.json: HTTP 500");
    site.failing.clear();
    const v = await client.vocab();
    expect(v.entries[0]?.abbr).toEqual(["MI"]);
    expect(await client.vocab()).toBe(v);
    expect(site.requests.filter((r) => r === "vocab.json")).toHaveLength(2);
  });
});
