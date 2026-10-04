// The import commit (30 §30.14) and the inbox hand-off of PowerPoint files shown as-is (30 §30.10).
// Run after the import output has been verified: it commits `content/` and the verifier's reports
// as the repository's first content commit, pushes `main`, then for each processing document
// pushes `inbox/<d_id>` (20 §20.2 layout, built with git locally) and dispatches process-inbox.yml.
// `handOffInbox` alone does the hand-off for an import already on `main`.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { commitMessage, inboxItemDir, inboxUploadPath, partName, serializeFile, UPLOAD_NAME } from "../../lib/content/index.ts";
import type { AsIsFile, SiteFile, UploadExt, UploadFile } from "../../lib/content/index.ts";
import { listDir, readContent } from "../../lib/content/fs.ts";
import { baseName, loadSources } from "./sources.ts";
import type { Log } from "./site.ts";

/** Runs a program; resolves with its stdout, rejects on a non-zero exit. */
export type Runner = (cmd: string, args: readonly string[], opts?: { input?: Uint8Array | string; env?: Record<string, string> }) => Promise<string>;

export const spawnRunner = (cwd: string): Runner => (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...opts.env }, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}: ${Buffer.concat(err).toString("utf8").trim()}`));
    });
    child.stdin.end(opts.input ?? "");
  });

/** gh is not on PowerShell's PATH on her machine (10 §10.1). */
export function ghPath(): string {
  const win = "C:\\Program Files\\GitHub CLI\\gh.exe";
  return process.env.PA_GH ?? (process.platform === "win32" && existsSync(win) ? win : "gh");
}

/** Raw slice size of an inbox part (50 §50.9). */
export const PART_BYTES = 16 * 1024 * 1024;

export const IMPORT_SUBJECT = "Import her source files";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Documents the import left in `state: "processing"` (the PowerPoint files shown as-is). */
async function processingFiles(root: string): Promise<AsIsFile[]> {
  const out: AsIsFile[] = [];
  for (const d of await listDir(root, "content/files")) {
    const f = await readContent<AsIsFile>(root, `content/files/${d}/file.json`);
    if (f.state === "processing") out.push(f);
  }
  return out;
}

export interface CommitOptions {
  run: Runner;
  gh?: string;
  log?: Log;
}

async function ownerEnv(root: string): Promise<Record<string, string>> {
  const site = await readContent<SiteFile>(root, "content/site.json");
  return {
    GIT_AUTHOR_NAME: site.owner.commitName, GIT_AUTHOR_EMAIL: site.owner.commitEmail,
    GIT_COMMITTER_NAME: site.owner.commitName, GIT_COMMITTER_EMAIL: site.owner.commitEmail,
  };
}

/** Each processing document paired with its source path; throws if one has no slides source. */
async function pendingOriginals(root: string): Promise<{ file: AsIsFile; path: string }[]> {
  const pending = await processingFiles(root);
  const sources = await loadSources(root);
  return pending.map((f) => {
    const src = sources.find((s) => s.kind === "slides" && baseName(s.path) === f.original);
    if (!src) throw new Error(`content/files/${f.id}: no slides source named ${f.original} in sources.json`);
    return { file: f, path: src.path };
  });
}

/**
 * Commit and push the import, then hand each processing document to the inbox job. Author and
 * committer are `site.json.owner`'s commit identity.
 */
export async function commitImport(root: string, { run, gh = ghPath(), log = console.log }: CommitOptions): Promise<{ commit: string; inbox: string[] }> {
  const env = await ownerEnv(root);
  // Refuse before committing anything if a hand-off could not be built.
  await pendingOriginals(root);

  const paths = ["content"];
  if (existsSync(join(root, "tools", "import", "reports"))) paths.push("tools/import/reports");
  await run("git", ["add", "--", ...paths]);
  await run("git", ["commit", "-F", "-"], { input: commitMessage(IMPORT_SUBJECT, { kind: "import" }), env });
  const commit = (await run("git", ["rev-parse", "HEAD"])).trim();
  log(`committed ${commit}: ${IMPORT_SUBJECT}`);
  await run("git", ["push", "origin", "main"]);
  log("pushed main");
  return { commit, inbox: await handOffInbox(root, { run, gh, log }) };
}

/**
 * Push `inbox/<d_id>` for each processing document, as a child of `origin/main` (fetched first),
 * and dispatch process-inbox.yml for it. Never touches `main`; author and committer are
 * `site.json.owner`'s commit identity.
 *
 * Re-running is the recovery when a dispatch or job failed: a branch already on origin is left as
 * it is (a process-inbox run may be reading it) and only dispatched again, provided it holds the
 * same file. Each document is handed off on its own; failures are reported together at the end.
 */
export async function handOffInbox(root: string, { run, gh = ghPath(), log = console.log }: CommitOptions): Promise<string[]> {
  const env = await ownerEnv(root);
  const originals = await pendingOriginals(root);
  if (originals.length === 0) return [];
  await run("git", ["fetch", "origin", "main"]);
  const parent = (await run("git", ["rev-parse", "refs/remotes/origin/main"])).trim();

  const inbox: string[] = [];
  const failures: string[] = [];
  for (const { file, path } of originals) {
    try {
      await handOffOne(file, path);
      inbox.push(file.id);
    } catch (e) {
      failures.push(`${file.id} (${file.original}): ${(e as Error).message}`);
    }
  }
  if (failures.length > 0) throw new Error(`inbox hand-off failed for ${failures.join("; ")}`);
  return inbox;

  async function handOffOne(file: AsIsFile, path: string): Promise<void> {
    const branch = `refs/heads/inbox/${file.id}`;
    const bytes = new Uint8Array(await readFile(join(root, ...path.split("/"))));
    const ext = file.original.slice(file.original.lastIndexOf(".") + 1).toLowerCase() as UploadExt;
    const parts = Math.max(1, Math.ceil(bytes.length / PART_BYTES));
    const upload: UploadFile = {
      v: 1, id: file.id, fileName: file.original, ext, size: bytes.length, sha256: await sha256Hex(bytes), parts, replaces: null,
    };

    if ((await run("git", ["ls-remote", "--heads", "origin", branch])).trim() !== "") {
      const tracking = `refs/remotes/origin/inbox/${file.id}`;
      await run("git", ["fetch", "--no-tags", "origin", `+${branch}:${tracking}`]);
      const onOrigin = JSON.parse(await run("git", ["show", `${tracking}:${inboxUploadPath(file.id)}`])) as UploadFile;
      if (onOrigin.sha256 !== upload.sha256 || onOrigin.size !== upload.size) {
        throw new Error(`inbox/${file.id} on origin holds a different file (sha256 ${onOrigin.sha256}); delete that branch once no process-inbox run is using it, then re-run`);
      }
      await run(gh, ["workflow", "run", "process-inbox.yml", "-f", `item=${file.id}`]);
      log(`inbox/${file.id} (${file.original}) is already on origin with the same file; dispatched process-inbox.yml again`);
      return;
    }

    const entries: string[] = [];
    for (let i = 0; i < parts; i++) {
      const blob = (await run("git", ["hash-object", "-w", "--stdin"], { input: bytes.subarray(i * PART_BYTES, (i + 1) * PART_BYTES) })).trim();
      entries.push(`100644 blob ${blob}\t${partName(i)}`);
    }
    const uploadText = serializeFile(inboxUploadPath(file.id), upload);
    const uploadBlob = (await run("git", ["hash-object", "-w", "--stdin"], { input: uploadText })).trim();
    entries.push(`100644 blob ${uploadBlob}\t${UPLOAD_NAME}`);
    // Wrap the item's tree in each directory of its path, innermost first.
    let rootTree = (await run("git", ["mktree"], { input: `${entries.join("\n")}\n` })).trim();
    for (const dir of inboxItemDir(file.id).split("/").reverse()) {
      rootTree = (await run("git", ["mktree"], { input: `040000 tree ${rootTree}\t${dir}\n` })).trim();
    }
    const inboxCommit = (await run("git", ["commit-tree", rootTree, "-p", parent, "-F", "-"], { input: `Inbox: ${file.original}\n`, env })).trim();
    await run("git", ["push", "origin", `${inboxCommit}:${branch}`]);
    await run(gh, ["workflow", "run", "process-inbox.yml", "-f", `item=${file.id}`]);
    log(`pushed inbox/${file.id} (${file.original}, ${parts} part${parts === 1 ? "" : "s"}) and dispatched process-inbox.yml`);
  }
}
