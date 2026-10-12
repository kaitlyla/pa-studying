// Her comparison favorites (site/compare): the pair file read and saved through the owner's own save
// protocol (50 §50.4) — both ways, one commit each time, and a save that raced another device merged
// rather than lost.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { favoritesPath, parseFile, serializeFile, type FavoritesFile } from "../../lib/content/index.ts";
import { WORKER_ORIGIN } from "../auth/config.ts";
import { DATA_BASE, invalidateData } from "../data/load.ts";
import { FakeGithub, fakeFetch, type FakeRequest } from "../e2e/fake-github.ts";
import { pairList, resetFavoritesForTests, setFavorite } from "./favorites.tsx";
import { retry } from "./github.ts";

const R1 = "r_0000000001";
const R2 = "r_0000000002";
const R3 = "r_0000000003";
const R4 = "r_0000000004";
const R5 = "r_0000000005";
const R6 = "r_0000000006";
const PATH = favoritesPath("fm");
const HOUR = 3600_000;

/** The site's record, as much of it as the save path reads. */
const SITE = {
  v: 1,
  name: "PA Studying",
  owner: { login: "kaitlyla", id: 337482200, commitName: "kaitlyla", commitEmail: "337482200+kaitlyla@users.noreply.github.com" },
  repo: "kaitlyla/pa-studying",
};

const isPatch = (r: FakeRequest): boolean => r.method === "PATCH" && r.url.endsWith("/git/refs/heads/main");
const pairsIn = (text: string | undefined): FavoritesFile["pairs"] => parseFile<FavoritesFile>(PATH, text as string).pairs;

let fake: FakeGithub;
let restore: () => void;

function installLocks(): void {
  const tails = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (name: string, cb: () => Promise<unknown>) => {
        const run = (tails.get(name) ?? Promise.resolve()).then(cb, cb);
        tails.set(name, run.catch(() => undefined));
        return run;
      },
    },
  });
}

function signIn(access = "test-token"): void {
  localStorage.setItem("pa.auth", JSON.stringify({ access, accessExp: Date.now() + HOUR, refresh: "r1", refreshExp: Date.now() + HOUR }));
}

/** The published site's data (site.json) plus the fake GitHub for everything else. */
function installFetch(): void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(DATA_BASE)) {
      const body = url.slice(DATA_BASE.length) === "site.json" ? JSON.stringify(SITE) : null;
      return Promise.resolve(body === null ? new Response("not found", { status: 404 }) : new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
    }
    return fakeFetch(fake)(input, init);
  }) as typeof fetch;
  invalidateData();
  restore = () => {
    globalThis.fetch = original;
    invalidateData();
  };
}

beforeEach(() => {
  localStorage.clear();
  installLocks();
  resetFavoritesForTests();
  fake = new FakeGithub();
  fake.workerOrigin = WORKER_ORIGIN;
  fake.commitFiles({ "content/guides/fm/guide.json": "{}\n" }, { message: "Import" });
  installFetch();
  vi.spyOn(retry, "sleep").mockResolvedValue(undefined);
  signIn();
});

afterEach(() => {
  restore();
  vi.restoreAllMocks();
});

describe("pair lists", () => {
  it("keeps each pair in id order, sorted, once, and never a topic with itself", () => {
    expect(pairList([[R2, R1], [R3, R3], [R4, R5], [R1, R2]])).toEqual([[R1, R2], [R4, R5]]);
  });
});

describe("setFavorite", () => {
  it("adds a pair: one commit, the file canonical, and the pair saved both ways", async () => {
    expect(await setFavorite("fm", R2, R1, true, "Favorites: AF + angina")).toBe(true);
    expect(pairsIn(fake.readFile(PATH))).toEqual([[R1, R2]]);
    const c = fake.commit(fake.head());
    expect(c?.message).toBe("Favorites: AF + angina\n\nPa-Studying-Kind: favorites");
    expect(c?.author.email).toBe(SITE.owner.commitEmail);

    // The same pair, given the other way round, is already saved: no second commit.
    const head = fake.head();
    expect(await setFavorite("fm", R1, R2, true, "Favorites: again")).toBe(true);
    expect(fake.head()).toBe(head);

    // And removing it either way round takes it off.
    expect(await setFavorite("fm", R2, R1, false, "Favorites: off")).toBe(true);
    expect(pairsIn(fake.readFile(PATH))).toEqual([]);
  });

  it("merges a save another device made while this one was writing", async () => {
    fake.commitFiles({ [PATH]: serializeFile(PATH, { v: 1, pairs: [[R3, R4]] }) }, { message: "seed" });
    let other = "";
    fake.fail((r) => {
      if (!isPatch(r)) return false;
      other = fake.commitFiles({ [PATH]: serializeFile(PATH, { v: 1, pairs: [[R3, R4], [R5, R6]] }) }, { message: "Favorites: other device" });
      return true;
    }, { status: 422, body: { message: "Update is not a fast forward" } });

    expect(await setFavorite("fm", R1, R2, true, "Favorites: mine")).toBe(true);
    expect(pairsIn(fake.readFile(PATH))).toEqual([[R1, R2], [R3, R4], [R5, R6]]);
    expect(fake.commit(fake.head())?.parents).toEqual([other]);
  });

  it("reports a save GitHub refused, and leaves the file as it was", async () => {
    const seed = fake.commitFiles({ [PATH]: serializeFile(PATH, { v: 1, pairs: [[R3, R4]] }) }, { message: "seed" });
    fake.fail((r) => isPatch(r), { status: 500, body: { message: "boom" } });
    expect(await setFavorite("fm", R1, R2, true, "Favorites: mine")).toBe(false);
    expect(fake.head()).toBe(seed);
    expect(pairsIn(fake.readFile(PATH))).toEqual([[R3, R4]]);
  });
});
