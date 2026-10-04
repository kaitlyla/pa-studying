import { act, Component, createElement, Suspense, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, until, type Mounted } from "../testing.tsx";
import { DATA_BASE, DataOfflineError, invalidateData, loadData, NotFoundError, retryFailedReads, setDataOverlay, useData } from "./load.ts";

const originalFetch = globalThis.fetch;
/** Full URLs requested, in order. */
let requests: string[];
/** Served JSON by data path; a path with no body answers 404. */
let bodies: Map<string, unknown>;
/** Non-404 failure statuses by data path. */
let statuses: Map<string, number>;
/** Replies held back by the test, taken (in order) before anything else for their path. */
let held: Map<string, Promise<Response>[]>;
let mounted: Mounted | null = null;

beforeEach(() => {
  requests = [];
  bodies = new Map();
  statuses = new Map();
  held = new Map();
  globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    const path = url.startsWith(DATA_BASE) ? url.slice(DATA_BASE.length) : url;
    const next = held.get(path)?.shift();
    if (next) return next;
    const status = statuses.get(path);
    if (status !== undefined) return Promise.resolve(new Response("error", { status }));
    if (!bodies.has(path)) return Promise.resolve(new Response("not found", { status: 404 }));
    return Promise.resolve(new Response(JSON.stringify(bodies.get(path)), { status: 200, headers: { "content-type": "application/json" } }));
  };
  invalidateData();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  globalThis.fetch = originalFetch;
  setDataOverlay(null);
  invalidateData();
});

const url = (path: string): string => DATA_BASE + path;

describe("loadData", () => {
  it("fetches DATA_BASE + path once and serves the cached value after", async () => {
    expect(DATA_BASE.endsWith("data/")).toBe(true);
    bodies.set("site.json", { name: "PA Studying" });
    const first = loadData<{ name: string }>("site.json");
    const second = loadData<{ name: string }>("site.json");
    expect(second).toBe(first);
    expect(await first).toEqual({ name: "PA Studying" });
    expect(await second).toBe(await first);
    expect(await loadData("site.json")).toBe(await first);
    expect(requests).toEqual([url("site.json")]);
  });

  it("rejects a 404 with NotFoundError carrying the path", async () => {
    const err = await loadData("guides/none.json").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toBeInstanceOf(Error);
    if (!(err instanceof NotFoundError)) throw new Error("expected NotFoundError");
    expect(err.path).toBe("guides/none.json");
    expect(err.name).toBe("NotFoundError");
    expect(err.message).toBe("Not found: guides/none.json");
  });

  it("rejects another failed status with an Error naming it, and does not keep the failure", async () => {
    statuses.set("flaky.json", 500);
    const err = await loadData("flaky.json").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NotFoundError);
    if (!(err instanceof Error)) throw new Error("expected an Error");
    expect(err.message).toBe("flaky.json: HTTP 500");

    statuses.delete("flaky.json");
    bodies.set("flaky.json", { ok: true });
    expect(await loadData("flaky.json")).toEqual({ ok: true });
    expect(requests).toEqual([url("flaky.json"), url("flaky.json")]);
  });

  it("revalidates with the server on every fetch (cache: no-cache), including the re-read after an invalidation", async () => {
    const inits: (RequestInit | undefined)[] = [];
    const serve = globalThis.fetch;
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      inits.push(init);
      return serve(input, init);
    };
    bodies.set("site.json", { v: 1 });
    await loadData("site.json");
    invalidateData("site.json");
    await loadData("site.json");
    expect(inits.map((i) => i?.cache)).toEqual(["no-cache", "no-cache"]);
  });

  it("rejects with DataOfflineError only when the request itself fails, keeping the cause", async () => {
    const cause = new TypeError("Failed to fetch");
    held.set("offline.json", [Promise.reject(cause)]);
    const err = await loadData("offline.json").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DataOfflineError);
    if (!(err instanceof DataOfflineError)) throw new Error("expected DataOfflineError");
    expect(err.name).toBe("DataOfflineError");
    expect(err.path).toBe("offline.json");
    expect(err.cause).toBe(cause);

    // An HTTP failure, a 404, bad JSON and an overlay error are not offline.
    statuses.set("down.json", 503);
    held.set("bad.json", [Promise.resolve(new Response("{not json", { status: 200 }))]);
    bodies.set("ov.json", { v: 1 });
    setDataOverlay(async (path, json) => {
      if (path === "ov.json") throw new TypeError("overlay bug");
      return json;
    });
    for (const p of ["down.json", "none.json", "bad.json", "ov.json"]) {
      const e = await loadData(p).then(
        () => null,
        (x: unknown) => x,
      );
      expect(e, p).toBeInstanceOf(Error);
      expect(e, p).not.toBeInstanceOf(DataOfflineError);
    }
  });

  it("a stale failure does not drop the newer cached load of the same path", async () => {
    let release: (r: Response) => void = () => {};
    held.set(
      "race.json",
      [
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
      ],
    );
    const stale = loadData("race.json");
    invalidateData("race.json");
    bodies.set("race.json", { n: 2 });
    const fresh = loadData("race.json");
    expect(fresh).not.toBe(stale);
    expect(await fresh).toEqual({ n: 2 });

    release(new Response("error", { status: 503 }));
    await expect(stale).rejects.toThrow("race.json: HTTP 503");
    expect(loadData("race.json")).toBe(fresh);
    expect(requests).toEqual([url("race.json"), url("race.json")]);
  });
});

describe("setDataOverlay", () => {
  it("passes every fetched file through the overlay, reloading cached data, until removed", async () => {
    bodies.set("a.json", { v: 1 });
    bodies.set("b.json", { v: 2 });
    expect(await loadData("a.json")).toEqual({ v: 1 });
    expect(requests).toEqual([url("a.json")]);

    const overlay = vi.fn((path: string, json: unknown): Promise<unknown> => Promise.resolve({ path, json, edited: true }));
    setDataOverlay(overlay);
    expect(await loadData("a.json")).toEqual({ path: "a.json", json: { v: 1 }, edited: true });
    expect(await loadData("b.json")).toEqual({ path: "b.json", json: { v: 2 }, edited: true });
    expect(overlay.mock.calls).toEqual([
      ["a.json", { v: 1 }],
      ["b.json", { v: 2 }],
    ]);
    expect(requests).toEqual([url("a.json"), url("a.json"), url("b.json")]);

    setDataOverlay(null);
    expect(await loadData("a.json")).toEqual({ v: 1 });
    expect(requests).toHaveLength(4);
    expect(overlay).toHaveBeenCalledTimes(2);
  });
});

describe("invalidateData", () => {
  it("drops one path, or every path", async () => {
    bodies.set("a.json", { v: 1 });
    bodies.set("b.json", { v: 2 });
    await loadData("a.json");
    await loadData("b.json");
    expect(requests).toEqual([url("a.json"), url("b.json")]);

    invalidateData("a.json");
    await loadData("a.json");
    await loadData("b.json");
    expect(requests).toEqual([url("a.json"), url("b.json"), url("a.json")]);

    invalidateData();
    await loadData("a.json");
    await loadData("b.json");
    expect(requests).toEqual([url("a.json"), url("b.json"), url("a.json"), url("a.json"), url("b.json")]);
  });
});

describe("useData", () => {
  function Show({ path }: { path: string }): ReactNode {
    const d = useData<{ v: number }>(path);
    return createElement("p", { className: "v" }, `value ${d.v}`);
  }

  it("suspends until the file loads, and re-reads it after an invalidation", async () => {
    // The first reply is held back so the suspended state can be observed.
    let release: (r: Response) => void = () => {};
    held.set("v.json", [new Promise<Response>((r) => (release = r))]);
    const m = await mount(createElement(Suspense, { fallback: createElement("p", { className: "wait" }, "loading") }, createElement(Show, { path: "v.json" })));
    mounted = m;
    expect(m.container.querySelector(".wait")?.textContent).toBe("loading");
    expect(m.container.querySelector(".v")).toBeNull();
    release(new Response(JSON.stringify({ v: 1 }), { status: 200 }));
    await until(() => m.container.querySelector(".v")?.textContent === "value 1", "the first value");
    expect(requests).toEqual([url("v.json")]);

    bodies.set("v.json", { v: 2 });
    await act(async () => {
      invalidateData("v.json");
    });
    await until(() => m.container.querySelector(".v")?.textContent === "value 2", "the reloaded value");
    expect(requests).toEqual([url("v.json"), url("v.json")]);
  });

  class Catch extends Component<{ children?: ReactNode }, { error: unknown }> {
    state: { error: unknown } = { error: null };
    static getDerivedStateFromError(error: unknown): { error: unknown } {
      return { error };
    }
    render(): ReactNode {
      const { error } = this.state;
      if (error === null) return this.props.children;
      return createElement("p", { className: "err" }, error instanceof NotFoundError ? `missing ${error.path}` : "other");
    }
  }
  const failing = (): ReactNode =>
    createElement(Catch, null, createElement(Suspense, { fallback: createElement("p", { className: "wait" }, "loading") }, createElement(Show, { path: "gone.json" })));

  it("a missing file reaches the error boundary after one request, and is fetched again only after a navigation", async () => {
    const m = await mount(failing());
    mounted = m;
    await until(() => m.container.querySelector(".err")?.textContent === "missing gone.json", "the error boundary");
    // React renders again after the rejection; that render must reuse the failed read, not fetch anew.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(requests).toEqual([url("gone.json")]);

    // Another page reading the same path before any navigation gets the same failure.
    m.unmount();
    const again = await mount(failing());
    mounted = again;
    await until(() => again.container.querySelector(".err") !== null, "the error boundary again");
    expect(requests).toEqual([url("gone.json")]);

    // After a navigation the read is retried, and the file now exists.
    again.unmount();
    mounted = null;
    bodies.set("gone.json", { v: 3 });
    retryFailedReads();
    const after = await mount(failing());
    mounted = after;
    await until(() => after.container.querySelector(".v")?.textContent === "value 3", "the retried value");
    expect(requests).toEqual([url("gone.json"), url("gone.json")]);
  });
});
