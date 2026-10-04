// Test-only (imported by app/edit *.test.ts): the synthetic content tree of tools/build/test-fixture.ts
// committed to the in-memory GitHub fake, its published data served at DATA_BASE (app/testing.tsx's
// serveData, everything else passed to the fake), and a signed-in owner.
import { vi } from "vitest";
import { WORKER_ORIGIN } from "../auth/config.ts";
import { FakeGithub, fakeFetch } from "../e2e/fake-github.ts";
import { publishFixture, serveData } from "../testing.tsx";
import { Git, retry } from "./github.ts";

export type Fixture = Awaited<ReturnType<typeof publishFixture>>;

/** The fixture's content files (for the repository) and its published data. */
export const loadFixture = (): Promise<Fixture> => publishFixture();

export interface World {
  fake: FakeGithub;
  git: Git;
  /** Data paths fetched, in order. */
  dataRequests: string[];
  /** Restores `fetch` and the stubs; call in afterEach. */
  stop: () => void;
}

/** A fresh fake repository holding the fixture at one "Import" commit, the owner signed in, retry delays removed. */
export function startWorld(fx: Fixture, published: Map<string, unknown> = fx.published): World {
  localStorage.clear();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: (_name: string, cb: () => Promise<unknown>) => cb() },
  });
  const fake = new FakeGithub();
  fake.workerOrigin = WORKER_ORIGIN;
  fake.commitFiles(fx.files, { message: "Import", date: "2026-10-01T00:00:00Z" });
  const data = serveData(published, fakeFetch(fake));
  vi.spyOn(retry, "sleep").mockResolvedValue(undefined);
  localStorage.setItem("pa.auth", JSON.stringify({ access: "test-token", accessExp: Date.now() + 3600_000, refresh: "r1", refreshExp: Date.now() + 3600_000 }));
  return {
    fake,
    git: new Git("kaitlyla/pa-studying"),
    dataRequests: data.requests,
    stop: () => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      data.restore();
    },
  };
}
