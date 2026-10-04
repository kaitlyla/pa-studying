// Whole-guide PDF releases (plan 70 §70.5, as amended by the Orchestrator's ruling of 2026-10-04 04:38Z):
// GitHub Release `pdf-<g>` holds the guide's one PDF asset. Its body records the commit the PDF was
// built from and a digest of the built data it consumed:
//   commit: <sha>
//   digest: <sha-256 hex>
// The PDF is rebuilt when that data changed, or when anything outside content/ changed since the commit.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NavJson } from "../../lib/derive/published.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Run = (cmd: string, args: readonly string[]) => RunResult;

export const spawnRun: Run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
};

function must(r: RunResult, what: string): string {
  if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}): ${r.stderr.trim()}`);
  return r.stdout;
}

export const releaseTag = (guide: string): string => `pdf-${guide}`;

/**
 * The `dist/data/` files a guide's whole PDF is built from, in a fixed order: its nav, home and system
 * files, and the font map. Pictures are named by their content hash inside these files.
 */
export async function consumedFiles(dataDir: string, guide: string): Promise<string[]> {
  const nav = JSON.parse(await readFile(join(dataDir, "g", guide, "nav.json"), "utf8")) as NavJson;
  return [`g/${guide}/nav.json`, `g/${guide}/home.json`, ...nav.systems.map((s) => `g/${guide}/s/${s.id}.json`), "fonts/fontmap.json"];
}

/** SHA-256 over each consumed file's path and bytes. None of them carries a build timestamp. */
export async function guideDigest(dataDir: string, guide: string): Promise<string> {
  const hash = createHash("sha256");
  for (const path of await consumedFiles(dataDir, guide)) {
    const bytes = await readFile(join(dataDir, path));
    hash.update(`${path}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

/** A path whose change cannot alter a PDF beyond what the data digest covers: content, CI config, docs. */
export function outsideBuild(path: string): boolean {
  return path.startsWith("content/") || path.startsWith(".github/") || path.startsWith("docs/") || path.endsWith(".md");
}

export interface ReleaseRecord {
  exists: boolean;
  commit: string | null;
  digest: string | null;
}

/** What the release body records, or `exists: false` when the release does not exist. */
export function releaseRecord(run: Run, guide: string): ReleaseRecord {
  const r = run("gh", ["release", "view", releaseTag(guide), "--json", "body"]);
  if (r.code !== 0) {
    if (/release not found/i.test(r.stderr)) return { exists: false, commit: null, digest: null };
    throw new Error(`gh release view ${releaseTag(guide)} failed (exit ${r.code}): ${r.stderr.trim()}`);
  }
  const body = String((JSON.parse(r.stdout) as { body?: unknown }).body ?? "");
  return {
    exists: true,
    commit: /^commit: ([0-9a-f]{40})\s*$/m.exec(body)?.[1] ?? null,
    digest: /^digest: ([0-9a-f]{64})\s*$/m.exec(body)?.[1] ?? null,
  };
}

export type Decision = { regenerate: true; reason: string } | { regenerate: false };

/** Whether the guide's PDF must be rebuilt for HEAD, given the data digest computed for HEAD. */
export function decide(run: Run, released: ReleaseRecord, digest: string): Decision {
  if (!released.exists) return { regenerate: true, reason: "no release" };
  if (released.commit === null || released.digest === null) return { regenerate: true, reason: "release body lacks its commit or digest" };
  if (released.digest !== digest) return { regenerate: true, reason: "the guide's built data changed" };
  if (run("git", ["cat-file", "-e", `${released.commit}^{commit}`]).code !== 0) return { regenerate: true, reason: `commit ${released.commit} is not in the clone` };
  const changed = must(run("git", ["diff", "--name-only", released.commit, "HEAD"]), "git diff")
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p !== "" && !outsideBuild(p));
  return changed.length === 0 ? { regenerate: false } : { regenerate: true, reason: `code changed since ${released.commit}: ${changed.length} file(s)` };
}

/** Uploads the guide's PDF to its release (created when absent) and records the commit and digest. */
export function publish(run: Run, guide: string, guideName: string, exists: boolean, file: string, head: string, digest: string): void {
  const tag = releaseTag(guide);
  if (!exists) must(run("gh", ["release", "create", tag, "--title", `${guideName} PDF`, "--notes", ""]), `gh release create ${tag}`);
  must(run("gh", ["release", "upload", tag, file, "--clobber"]), `gh release upload ${tag}`);
  must(run("gh", ["release", "edit", tag, "--notes", `commit: ${head}\ndigest: ${digest}`]), `gh release edit ${tag}`);
}

export function headCommit(run: Run): string {
  return must(run("git", ["rev-parse", "HEAD"]), "git rev-parse HEAD").trim();
}
