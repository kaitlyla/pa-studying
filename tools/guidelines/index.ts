// tools/guidelines (80 §80.2):
//   node tools/guidelines/index.ts [--commit]   run the monthly check; --commit commits the result
//                                               (Kind `guidelines`) with the configured git identity
//   node tools/guidelines/index.ts --probe <g_id>
//                                               print {series, year} for each track of a gap block
import { execFileSync } from "node:child_process";
import { commitMessage, gapFilePath, isId } from "../../lib/content/index.ts";
import type { GapFile } from "../../lib/content/index.ts";
import { readContent } from "../../lib/content/fs.ts";
import { detectCited, detectEdition } from "./editions.ts";
import { Http, realNet } from "./http.ts";
import type { Net } from "./http.ts";
import { CHECKS_PATH, FLAGS_PATH, runCheck } from "./run.ts";

export interface ProbeLine {
  series: string;
  year: number | null;
  error?: string;
}

/** Run the edition detector of each `track` of gap block `gapId`. Writes nothing. */
export async function probe(root: string, http: Http, gapId: string, today: string): Promise<ProbeLine[]> {
  if (!isId("g", gapId)) throw new Error(`not a gap block id: ${gapId}`);
  const gap = await readContent<GapFile>(root, gapFilePath(gapId));
  const lines: ProbeLine[] = [];
  for (const { track } of gap.meta.sources) {
    if (!track) continue;
    try {
      let year: number;
      if (track.method !== "fixed") year = (await detectCited(http, track, today)).year;
      else if (track.source === "uspstf") throw new Error("USPSTF is checked per recommendation and has no edition year");
      else year = (await detectEdition(http, track.source, today)).year;
      lines.push({ series: track.series, year });
    } catch (e) {
      lines.push({ series: track.series, year: null, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return lines;
}

/** Stage the two updates files and commit them when they changed. Returns whether a commit was made. */
export function commitUpdates(root: string, today: string): boolean {
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("add", "--", FLAGS_PATH, CHECKS_PATH);
  if (git("diff", "--cached", "--name-only", "--", FLAGS_PATH, CHECKS_PATH).trim() === "") return false;
  git("commit", "-m", commitMessage(`Guideline check ${today}`, { kind: "guidelines" }), "--", FLAGS_PATH, CHECKS_PATH);
  return true;
}

export interface MainOptions {
  root?: string;
  net?: Net;
  /** The run's moment; its UTC date is the run's `today`. */
  now?: Date;
  out?: (line: string) => void;
}

const USAGE = "usage: node tools/guidelines/index.ts [--commit] | --probe <g_id>";

/** The CLI. Returns the process exit code. */
export async function main(argv: readonly string[], options: MainOptions = {}): Promise<number> {
  const root = options.root ?? process.cwd();
  const out = options.out ?? ((line: string) => console.log(line));
  const http = new Http(options.net ?? realNet);
  const today = (options.now ?? new Date()).toISOString().slice(0, 10);
  if (argv[0] === "--probe") {
    if (argv.length !== 2) {
      out(USAGE);
      return 2;
    }
    for (const line of await probe(root, http, argv[1]!, today)) out(JSON.stringify(line));
    return 0;
  }
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--commit")) {
    out(USAGE);
    return 2;
  }
  const report = await runCheck(root, http, today, out);
  const failed = report.sources.filter((s) => !s.ok).length;
  out(`Checked ${report.sources.length} source(s), ${failed} couldn't be checked.`);
  if (argv[0] === "--commit") out(commitUpdates(root, today) ? "Committed the updates." : "Nothing changed; no commit.");
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
