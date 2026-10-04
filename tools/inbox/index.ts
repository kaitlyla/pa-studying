// CLI for the processing job (50 §50.9, 10 §10.5): `node tools/inbox/index.ts --item <d_id>`.
// It reads the item from the fetched inbox branch, processes it into `content/` and commits the
// result. process-inbox.yml then pushes, deletes the branch and dispatches publish.
import { execFileSync } from "node:child_process";
import { ID_RE, parseFile } from "../../lib/content/index.ts";
import type { UploadFile } from "../../lib/content/index.ts";
import { verifyWordDoc } from "../verify/index.ts";
import { processItem, sofficeConvert } from "./process.ts";
import type { ProcessDeps } from "./process.ts";

const USAGE = "usage: node tools/inbox/index.ts --item <d_id>";

/** The ref process-inbox.yml fetches the item's branch into. */
export const inboxRef = (id: string): string => `refs/remotes/origin/inbox/${id}`;

export interface MainOptions {
  root?: string;
  deps?: ProcessDeps;
}

/** The CLI. Returns the process exit code: 0 whenever the item ends ready or failed. */
export async function main(argv: readonly string[], options: MainOptions = {}): Promise<number> {
  const root = options.root ?? process.cwd();
  const deps = options.deps ?? { soffice: sofficeConvert, verifyWordDoc, log: console.log, error: console.error };
  const id = argv[1];
  if (argv.length !== 2 || argv[0] !== "--item" || id === undefined || !ID_RE.d.test(id)) {
    deps.error(USAGE);
    return 2;
  }
  // The parts can each be 16 MiB; git's stdout is read whole.
  const git = (args: string[], input?: string): Buffer =>
    execFileSync("git", args, { cwd: root, input, maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
  const blob = (name: string): Buffer => git(["cat-file", "blob", `${inboxRef(id)}:inbox/${id}/${name}`]);

  const uploadPath = `inbox/${id}/upload.json`;
  const upload = parseFile<UploadFile>(uploadPath, blob("upload.json").toString("utf8"));
  const parts: Buffer[] = [];
  for (let i = 0; i < upload.parts; i++) parts.push(blob(`part-${String(i).padStart(3, "0")}`));

  const result = await processItem(root, upload, new Uint8Array(Buffer.concat(parts)), deps);
  if (result === null) return 0;
  git(["add", "-A", "--", "content"]);
  git(["commit", "-q", "-F", "-"], result.message);
  deps.log(result.ok ? `${id}: committed` : `${id}: committed as failed`);
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
