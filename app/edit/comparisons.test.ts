// Her saved comparisons (site/compare): named quadrant sets read and saved through the owner's own save
// protocol (50 §50.4) — one commit per change, the file published for visitors too, and a save that
// raced another device merged rather than lost.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { comparisonsPath, parseFile, serializeFile, type ComparisonsFile } from "../../lib/content/index.ts";
import { WORKER_ORIGIN } from "../auth/config.ts";
import { DATA_BASE, invalidateData } from "../data/load.ts";
import { FakeGithub, fakeFetch, type FakeRequest } from "../e2e/fake-github.ts";
import { deleteComparison, renameComparison, saveComparison } from "./comparisons.tsx";
import { retry } from "./github.ts";

const R1 = "r_0000000001";
const R2 = "r_0000000002";
const R3 = "r_0000000003";
const R4 = "r_0000000004";
const PATH = comparisonsPath("fm");
const HOUR = 3600_000;

/** The site's record, as much of it as the save path reads. */
const SITE = {
  v: 1,
  name: "PA Studying",
  owner: { login: "kaitlyla", id: 337482200, commitName: "kaitlyla", commitEmail: "337482200+kaitlyla@users.noreply.github.com" },
  repo: "kaitlyla/pa-studying",
};

const isPatch = (r: FakeRequest): boolean => r.method === "PATCH" && r.url.endsWith("/git/refs/heads/main");
const compsIn = (text: string | undefined): ComparisonsFile["comparisons"] => (text === undefined ? [] : parseFile<ComparisonsFile>(PATH, text).comparisons);
const fileOf = (comparisons: ComparisonsFile["comparisons"]): string => serializeFile(PATH, { v: 1, comparisons });

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

describe("saveComparison", () => {
  it("saves the quadrants under a name: one commit, hers to publish", async () => {
    expect(await saveComparison("fm", "Adrenal", [R1, R2, R3])).toBe(true);
    expect(compsIn(fake.readFile(PATH))).toEqual([{ name: "Adrenal", ids: [R1, R2, R3] }]);
    const c = fake.commit(fake.head());
    expect(c?.message).toBe("Comparison: Adrenal\n\nPa-Studying-Kind: comparisons");
    expect(c?.author.email).toBe(SITE.owner.commitEmail);
  });

  it("refuses a name already taken, and commits nothing", async () => {
    expect(await saveComparison("fm", "Adrenal", [R1])).toBe(true);
    const head = fake.head();
    expect(await saveComparison("fm", "Adrenal", [R2])).toBe(false);
    expect(fake.head()).toBe(head);
    expect(compsIn(fake.readFile(PATH))).toEqual([{ name: "Adrenal", ids: [R1] }]);
  });

  it("merges a save another device made while this one was writing", async () => {
    fake.commitFiles({ [PATH]: fileOf([{ name: "Cushing's", ids: [R3] }]) }, { message: "seed" });
    let other = "";
    fake.fail((r) => {
      if (!isPatch(r)) return false;
      other = fake.commitFiles({ [PATH]: fileOf([{ name: "Cushing's", ids: [R3] }, { name: "DM", ids: [R4] }]) }, { message: "Comparison: other device" });
      return true;
    }, { status: 422, body: { message: "Update is not a fast forward" } });

    expect(await saveComparison("fm", "Adrenal", [R1, R2])).toBe(true);
    expect(compsIn(fake.readFile(PATH))).toEqual([
      { name: "Cushing's", ids: [R3] },
      { name: "DM", ids: [R4] },
      { name: "Adrenal", ids: [R1, R2] },
    ]);
    expect(fake.commit(fake.head())?.parents).toEqual([other]);
  });

  it("reports a save GitHub refused, and leaves the file as it was", async () => {
    const seed = fake.commitFiles({ [PATH]: fileOf([{ name: "Cushing's", ids: [R3] }]) }, { message: "seed" });
    fake.fail((r) => isPatch(r), { status: 500, body: { message: "boom" } });
    expect(await saveComparison("fm", "Adrenal", [R1])).toBe(false);
    expect(fake.head()).toBe(seed);
    expect(compsIn(fake.readFile(PATH))).toEqual([{ name: "Cushing's", ids: [R3] }]);
  });
});

describe("renameComparison and deleteComparison", () => {
  it("renames in place, keeping the quadrants and the list's order", async () => {
    await saveComparison("fm", "Adrenal", [R1, R2]);
    await saveComparison("fm", "Cushing's", [R3]);
    expect(await renameComparison("fm", "Adrenal", "Adrenal insufficiency")).toBe(true);
    expect(compsIn(fake.readFile(PATH))).toEqual([
      { name: "Adrenal insufficiency", ids: [R1, R2] },
      { name: "Cushing's", ids: [R3] },
    ]);
    expect(fake.commit(fake.head())?.message).toBe("Comparison renamed: Adrenal → Adrenal insufficiency\n\nPa-Studying-Kind: comparisons");
  });

  it("changes nothing for a rename to a taken name, or a rename of a name that is gone", async () => {
    await saveComparison("fm", "Adrenal", [R1]);
    await saveComparison("fm", "Cushing's", [R2]);
    const head = fake.head();
    expect(await renameComparison("fm", "Adrenal", "Cushing's")).toBe(true);
    expect(await renameComparison("fm", "DM", "DM Type 1")).toBe(true);
    expect(fake.head()).toBe(head);
    expect(compsIn(fake.readFile(PATH))).toEqual([{ name: "Adrenal", ids: [R1] }, { name: "Cushing's", ids: [R2] }]);
  });

  it("deletes one and keeps the rest", async () => {
    await saveComparison("fm", "Adrenal", [R1]);
    await saveComparison("fm", "Cushing's", [R2, R3]);
    expect(await deleteComparison("fm", "Adrenal")).toBe(true);
    expect(compsIn(fake.readFile(PATH))).toEqual([{ name: "Cushing's", ids: [R2, R3] }]);
    expect(fake.commit(fake.head())?.message).toBe("Comparison deleted: Adrenal\n\nPa-Studying-Kind: comparisons");

    // A name that is not there changes nothing.
    const head = fake.head();
    expect(await deleteComparison("fm", "DM")).toBe(true);
    expect(fake.head()).toBe(head);
  });
});
