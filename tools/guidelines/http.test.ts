import { afterEach, describe, expect, it, vi } from "vitest";
import { EUTILS_BASE, EUTILS_SPACING_MS, EUTILS_TOOL, FETCH_TIMEOUT_MS, Http, realNet, USER_AGENT } from "./http.ts";
import { fakeNet, html, json } from "./testing.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Http", () => {
  it("sends the job's User-Agent, follows redirects and bounds each request with a 30 s timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fake = fakeNet(() => html("<p>ok</p>"));
    expect(await new Http(fake.net).text("https://goldcopd.org/")).toBe("<p>ok</p>");
    const init = fake.inits[0]!;
    expect(init.headers).toEqual({ "User-Agent": USER_AGENT });
    expect(init.redirect).toBe("follow");
    expect(timeout).toHaveBeenCalledWith(FETCH_TIMEOUT_MS);
    expect(init.signal).toBe(timeout.mock.results[0]!.value);
    expect(USER_AGENT).toBe("PA-Studying-guideline-check (+https://kaitlyla.github.io/pa-studying/)");
  });

  it("throws on a non-2xx status, a network error and invalid JSON", async () => {
    await expect(new Http(fakeNet(() => html("Forbidden", 403)).net).text("https://diabetesjournals.org/")).rejects.toThrow("GET https://diabetesjournals.org/: HTTP 403");
    await expect(new Http(fakeNet(() => undefined).net).text("https://example.org/")).rejects.toThrow("fetch failed");
    await expect(new Http(fakeNet(() => html("<html>")).net).json("https://example.org/a.json")).rejects.toThrow("GET https://example.org/a.json: invalid JSON");
    expect(await new Http(fakeNet(() => json({ a: 1 })).net).json("https://example.org/a.json")).toEqual({ a: 1 });
  });

  it("E-utilities: db, retmode and tool on every request, and the next request waits out the 400 ms spacing", async () => {
    const fake = fakeNet(() => json({ ok: true }));
    const http = new Http(fake.net);
    await http.eutils("esearch.fcgi", { term: "a b", retmax: "20" });
    expect(fake.sleeps).toEqual([]);
    await fake.net.sleep(150); // 150 ms pass between the two requests
    await http.eutils("esummary.fcgi", { id: "1,2" });
    expect(fake.sleeps).toEqual([150, EUTILS_SPACING_MS - 150]);
    const [first, second] = fake.requests.map((u) => new URL(u));
    expect(`${first!.origin}${first!.pathname}`).toBe(`${EUTILS_BASE}/esearch.fcgi`);
    expect(Object.fromEntries(first!.searchParams)).toEqual({ db: "pubmed", retmode: "json", term: "a b", retmax: "20", tool: EUTILS_TOOL });
    expect(Object.fromEntries(second!.searchParams)).toEqual({ db: "pubmed", retmode: "json", id: "1,2", tool: EUTILS_TOOL });
  });

  it("E-utilities: spacing counts from a failed request too", async () => {
    let calls = 0;
    const fake = fakeNet(() => (++calls === 1 ? html("busy", 429) : json({})));
    const http = new Http(fake.net);
    await expect(http.eutils("esearch.fcgi", { term: "x" })).rejects.toThrow(/HTTP 429/);
    await http.eutils("esearch.fcgi", { term: "x" });
    expect(fake.sleeps).toEqual([EUTILS_SPACING_MS]);
  });
});

describe("realNet", () => {
  it("delegates to the global fetch and waits with real timers", async () => {
    const fetchMock = vi.fn(async () => new Response("hi"));
    vi.stubGlobal("fetch", fetchMock);
    const response = await realNet.fetch("https://example.org/", { redirect: "follow" });
    expect(await response.text()).toBe("hi");
    expect(fetchMock).toHaveBeenCalledWith("https://example.org/", { redirect: "follow" });
    const before = realNet.now();
    await realNet.sleep(5);
    expect(realNet.now() - before).toBeGreaterThanOrEqual(4);
  });
});
