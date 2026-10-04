// The 50 §50.4 commit protocol (99 §99.1 app/edit/commit.test.ts) against the in-memory GitHub fake.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeGithub, fakeFetch, type FakeRequest } from "../e2e/fake-github.ts";
import { WORKER_ORIGIN } from "../auth/config.ts";
import { commitChanges, firstChanged, type CommitRequest } from "./commit.ts";
import { Git, retry } from "./github.ts";

const HOUR = 3600_000;
const AUTHOR = { name: "Kaitlyn", email: "337482200+kaitlyla@users.noreply.github.com" };
const A = "content/guides/fm/cardiovascular/blocks/b_AAAAAAAAAA.json";
const S = "content/guides/fm/cardiovascular/structure.json";
const OTHER = "content/guides/fm/renal/blocks/b_BBBBBBBBBB.json";

let fake: FakeGithub;
let git: Git;

function signIn(access = "test-token"): void {
  localStorage.setItem("pa.auth", JSON.stringify({ access, accessExp: Date.now() + HOUR, refresh: "r1", refreshExp: Date.now() + HOUR }));
}

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

const isPatch = (r: FakeRequest): boolean => r.method === "PATCH" && r.url.endsWith("/git/refs/heads/main");
const patches = (): FakeRequest[] => fake.requests.filter(isPatch);

async function request(changes: CommitRequest["changes"]): Promise<CommitRequest> {
  const base = await git.ref();
  return {
    git, base, baseFiles: await git.files(base), scope: { files: [A, S], dirs: [] }, changes,
    message: "Edit: Hypertension\n\nPa-Studying-Kind: edit", author: AUTHOR,
  };
}

beforeEach(() => {
  localStorage.clear();
  installLocks();
  fake = new FakeGithub();
  fake.workerOrigin = WORKER_ORIGIN;
  fake.commitFiles({ [A]: "a0\n", [S]: "s0\n", [OTHER]: "o0\n" }, { message: "Import" });
  vi.stubGlobal("fetch", fakeFetch(fake));
  vi.spyOn(retry, "sleep").mockResolvedValue(undefined);
  git = new Git("kaitlyla/pa-studying");
  signIn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("commit protocol", () => {
  it("head = base: blobs, tree, commit and one PATCH succeed", async () => {
    const req = await request([{ path: A, content: "a1\n" }]);
    const out = await commitChanges(req);
    expect(out.kind).toBe("saved");
    expect(patches()).toHaveLength(1);
    expect(fake.readFile(A)).toBe("a1\n");
    expect(fake.readFile(OTHER)).toBe("o0\n");
    const c = fake.commit(fake.head());
    expect(c?.parents).toEqual([req.base]);
    expect(c?.author).toMatchObject(AUTHOR);
    expect(c?.message).toBe(req.message);
    expect(out.kind === "saved" && out.commit).toBe(fake.head());
  });

  it("PATCH 422 with a new head that leaves the file set unchanged: round 2 against the new head succeeds", async () => {
    const req = await request([{ path: A, content: "a1\n" }]);
    let other = "";
    fake.fail((r) => {
      if (!isPatch(r)) return false;
      other = fake.commitFiles({ [OTHER]: "o1\n" }, { message: "Edit: Renal" });
      return true;
    }, { status: 422, body: { message: "Update is not a fast forward" } });
    const out = await commitChanges(req);
    expect(out.kind).toBe("saved");
    expect(fake.readFile(A)).toBe("a1\n");
    expect(fake.readFile(OTHER)).toBe("o1\n");
    expect(fake.commit(fake.head())?.parents).toEqual([other]);
    // Only the second PATCH reached the fake (the first was the injected 422).
    expect(patches()).toHaveLength(1);
    // The blob made in round 1 was reused: one blob POST in all.
    expect(fake.requests.filter((r) => r.method === "POST" && r.url.endsWith("/git/blobs"))).toHaveLength(1);
  });

  it("PATCH 409 with a new head that changed a file of the set: conflict, and nothing more is written", async () => {
    const req = await request([{ path: A, content: "a1\n" }]);
    fake.fail((r) => {
      if (!isPatch(r)) return false;
      fake.commitFiles({ [S]: "s1\n" }, { message: "Edit: other device", date: "2099-03-04T05:06:07Z" });
      return true;
    }, { status: 409 });
    const writesBefore = (): number => fake.writes().length;
    let writesAtConflict = -1;
    const out = await commitChanges(req).finally(() => { writesAtConflict = writesBefore(); });
    expect(out).toEqual({ kind: "conflict", at: "2099-03-04T05:06:07Z", path: S });
    expect(fake.readFile(A)).toBe("a0\n");
    expect(fake.readFile(S)).toBe("s1\n");
    // Blob, tree and commit of round 1 only; the injected PATCH is not recorded and nothing followed.
    expect(fake.writes().map((r) => new URL(r.url).pathname.split("/").slice(-1)[0])).toEqual(["blobs", "trees", "commits"]);
    expect(writesAtConflict).toBe(3);
  });

  it("PATCH 422 with the ref unchanged: refused, no retry", async () => {
    const req = await request([{ path: A, content: "a1\n" }]);
    fake.fail(isPatch, { status: 422 }, 5);
    const out = await commitChanges(req);
    expect(out).toEqual({ kind: "refused" });
    expect(fake.writes().filter((r) => r.url.endsWith("/git/commits"))).toHaveLength(1);
    expect(fake.readFile(A)).toBe("a0\n");
  });

  it("main moving outside the file set before every PATCH: refused after three rounds", async () => {
    const req = await request([{ path: A, content: "a1\n" }]);
    let n = 0;
    fake.fail((r) => {
      if (!isPatch(r)) return false;
      fake.commitFiles({ [OTHER]: `o${++n}\n` }, { message: "Edit: Renal" });
      return true;
    }, { status: 422 }, 10);
    const out = await commitChanges(req);
    expect(out).toEqual({ kind: "refused" });
    expect(n).toBe(3);
    expect(fake.readFile(A)).toBe("a0\n");
  });

  for (const [what, fault] of [["its response is lost", "network"], ["GitHub then answers 502", { status: 502 }]] as const) {
    it(`a PATCH that was applied but ${what} is a successful save, not a conflict`, async () => {
      const req = await request([{ path: A, content: "a1\n" }]);
      fake.fail((r) => {
        if (!isPatch(r)) return false;
        fake.setRef("refs/heads/main", (JSON.parse(r.body ?? "{}") as { sha: string }).sha);
        return true;
      }, fault);
      const out = await commitChanges(req);
      expect(out).toEqual({ kind: "saved", commit: fake.head() });
      expect(fake.readFile(A)).toBe("a1\n");
      expect(fake.writes().filter((r) => r.url.endsWith("/git/commits"))).toHaveLength(1);
    });
  }

  it("a 401 refreshes once, then the same save resumes and succeeds", async () => {
    fake.validTokens = new Set(["stale"]);
    fake.refreshTokens.set("r1", "stale");
    signIn("stale");
    const req = await request([{ path: A, content: "a1\n" }]);
    fake.validTokens.delete("stale");
    const out = await commitChanges(req);
    expect(out.kind).toBe("saved");
    expect(fake.requests.filter((r) => r.url === `${WORKER_ORIGIN}/refresh`)).toHaveLength(1);
    expect(fake.readFile(A)).toBe("a1\n");
  });

  it("a network failure after three attempts 2 s and 4 s apart is the offline failure", async () => {
    const req = await request([{ path: A, content: "a1\n" }]);
    fake.fail((r) => r.url.endsWith("/git/ref/heads/main"), "network", 3);
    const out = await commitChanges(req);
    expect(out).toEqual({ kind: "offline" });
    expect(vi.mocked(retry.sleep).mock.calls).toEqual([[2000], [4000]]);
    expect(fake.writes()).toEqual([]);
  });

  it("a 5xx is retried and the save then succeeds", async () => {
    const req = await request([{ path: A, content: "a1\n" }]);
    fake.fail((r) => r.url.endsWith("/git/trees"), { status: 502 }, 2);
    expect((await commitChanges(req)).kind).toBe("saved");
    expect(fake.readFile(A)).toBe("a1\n");
  });

  it("deletes a file with sha null and reuses an existing blob by sha", async () => {
    const req = await request([{ path: OTHER, sha: null }, { path: "content/x.json", sha: fake.fileSha(A) as string }]);
    expect((await commitChanges(req)).kind).toBe("saved");
    expect(fake.readFile(OTHER)).toBeUndefined();
    expect(fake.readFile("content/x.json")).toBe("a0\n");
  });
});

describe("firstChanged", () => {
  it("compares whole directories of a doc key, including added and deleted entries", () => {
    const scope = { files: [], dirs: ["content/docs/d_1/", "content/files/d_1/"] };
    const base = new Map([["content/docs/d_1/doc.json", "1"], ["content/other.json", "9"]]);
    expect(firstChanged(base, new Map([...base, ["content/other.json", "8"]]), scope)).toBeNull();
    expect(firstChanged(base, new Map([...base, ["content/files/d_1/file.json", "2"]]), scope)).toBe("content/files/d_1/file.json");
    expect(firstChanged(base, new Map([["content/other.json", "9"]]), scope)).toBe("content/docs/d_1/doc.json");
  });
});
