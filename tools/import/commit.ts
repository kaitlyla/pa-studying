// The import commit (30 §30.14) and the inbox hand-off of PowerPoint files shown as-is (30 §30.10).
// Run after the import output has been verified: it commits `content/` and the verifier's reports
// as the repository's first content commit, pushes `main`, then for each processing document
// pushes `inbox/<d_id>` (20 §20.2 layout, built with git locally) and dispatches process-inbox.yml.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { commitMessage, serializeFile } from "../../lib/content/index.ts";
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

/**
 * Commit and push the import, then hand each processing document to the inbox job. Author and
 * committer are `site.json.owner`'s commit identity.
 */
export async function commitImport(root: string, { run, gh = ghPath(), log = console.log }: CommitOptions): Promise<{ commit: string; inbox: string[] }> {
  const site = await readContent<SiteFile>(root, "content/site.json");
  const env = {
    GIT_AUTHOR_NAME: site.owner.commitName, GIT_AUTHOR_EMAIL: site.owner.commitEmail,
    GIT_COMMITTER_NAME: site.owner.commitName, GIT_COMMITTER_EMAIL: site.owner.commitEmail,
  };
  const pending = await processingFiles(root);
  const sources = await loadSources(root);
  const originals = pending.map((f) => {
    const src = sources.find((s) => s.kind === "slides" && baseName(s.path) === f.original);
    if (!src) throw new Error(`content/files/${f.id}: no slides source named ${f.original} in sources.json`);
    return { file: f, path: src.path };
  });

  const paths = ["content"];
  if (existsSync(join(root, "tools", "import", "reports"))) paths.push("tools/import/reports");
  await run("git", ["add", "--", ...paths]);
  await run("git", ["commit", "-F", "-"], { input: commitMessage(IMPORT_SUBJECT, { kind: "import" }), env });
  const commit = (await run("git", ["rev-parse", "HEAD"])).trim();
  log(`committed ${commit}: ${IMPORT_SUBJECT}`);
  await run("git", ["push", "origin", "main"]);
  log("pushed main");

  const inbox: string[] = [];
  for (const { file, path } of originals) {
    const bytes = new Uint8Array(await readFile(join(root, ...path.split("/"))));
    const ext = file.original.slice(file.original.lastIndexOf(".") + 1).toLowerCase() as UploadExt;
    const parts = Math.max(1, Math.ceil(bytes.length / PART_BYTES));
    const upload: UploadFile = {
      v: 1, id: file.id, fileName: file.original, ext, size: bytes.length, sha256: await sha256Hex(bytes), parts, replaces: null,
    };
    const entries: string[] = [];
    for (let i = 0; i < parts; i++) {
      const blob = (await run("git", ["hash-object", "-w", "--stdin"], { input: bytes.subarray(i * PART_BYTES, (i + 1) * PART_BYTES) })).trim();
      entries.push(`100644 blob ${blob}\tpart-${String(i).padStart(3, "0")}`);
    }
    const uploadText = serializeFile(`inbox/${file.id}/upload.json`, upload);
    const uploadBlob = (await run("git", ["hash-object", "-w", "--stdin"], { input: uploadText })).trim();
    entries.push(`100644 blob ${uploadBlob}\tupload.json`);
    const itemTree = (await run("git", ["mktree"], { input: `${entries.join("\n")}\n` })).trim();
    const inboxTree = (await run("git", ["mktree"], { input: `040000 tree ${itemTree}\t${file.id}\n` })).trim();
    const rootTree = (await run("git", ["mktree"], { input: `040000 tree ${inboxTree}\tinbox\n` })).trim();
    const inboxCommit = (await run("git", ["commit-tree", rootTree, "-p", commit, "-F", "-"], { input: `Inbox: ${file.original}\n`, env })).trim();
    await run("git", ["push", "origin", `${inboxCommit}:refs/heads/inbox/${file.id}`]);
    await run(gh, ["workflow", "run", "process-inbox.yml", "-f", `item=${file.id}`]);
    log(`pushed inbox/${file.id} (${file.original}, ${parts} part${parts === 1 ? "" : "s"}) and dispatched process-inbox.yml`);
    inbox.push(file.id);
  }
  return { commit, inbox };
}
