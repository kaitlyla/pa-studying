// initTestRepo / cloneTestRepo: throwaway repositories whose commits start no background git maintenance.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloneTestRepo, initTestRepo } from "./git.ts";

let base: string;
beforeEach(async () => { base = await mkdtemp(join(tmpdir(), "pa-git-testing-")); });
afterEach(async () => { await rm(base, { recursive: true, force: true }); });

/**
 * The argv of every process the commit started, read from git's trace2 event log. Maintenance
 * is kept in the foreground (`maintenance.autoDetach=false`) so the control repo below leaves
 * nothing running behind the test either; whether maintenance starts at all is unaffected.
 */
async function commitChildren(repo: string): Promise<string[][]> {
  const trace = join(base, `${Math.random().toString(36).slice(2)}.trace.json`);
  execFileSync("git", ["-c", "maintenance.autoDetach=false", "commit", "-q", "--allow-empty", "-m", "x"], {
    cwd: repo,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_TRACE2_EVENT: trace,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
  return (await readFile(trace, "utf8"))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { event: string; argv?: string[] })
    .filter((e) => e.event === "child_start")
    .map((e) => e.argv ?? []);
}

const startsMaintenance = (children: string[][]): boolean => children.some((argv) => argv.includes("maintenance"));

describe("initTestRepo", () => {
  it("a commit in a plain git init repository starts git maintenance (the probe sees it)", async () => {
    const repo = join(base, "plain");
    await mkdir(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "pipe" });
    expect(startsMaintenance(await commitChildren(repo))).toBe(true);
  });

  it("a commit in its repository starts no git maintenance, on main", async () => {
    const repo = join(base, "test");
    await mkdir(repo);
    initTestRepo(repo);
    expect(startsMaintenance(await commitChildren(repo))).toBe(false);
    expect(execFileSync("git", ["symbolic-ref", "HEAD"], { cwd: repo, encoding: "utf8" })).toBe("refs/heads/main\n");
  });

  it("makes a bare repository with auto-maintenance off", async () => {
    const repo = join(base, "origin.git");
    await mkdir(repo);
    initTestRepo(repo, { bare: true });
    expect(execFileSync("git", ["rev-parse", "--is-bare-repository"], { cwd: repo, encoding: "utf8" })).toBe("true\n");
    expect(execFileSync("git", ["config", "--get", "maintenance.auto"], { cwd: repo, encoding: "utf8" })).toBe("false\n");
  });
});

describe("cloneTestRepo", () => {
  it("a commit in its clone starts no git maintenance (a clone doesn't inherit the origin's setting)", async () => {
    const origin = join(base, "origin.git");
    await mkdir(origin);
    initTestRepo(origin, { bare: true });
    const repo = join(base, "clone");
    cloneTestRepo(origin, repo);
    expect(startsMaintenance(await commitChildren(repo))).toBe(false);
  });
});
