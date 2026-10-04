// CLI (30 §30.1). `npm.cmd run import` converts her source files into `content/`;
// `npm.cmd run import -- commit` then commits and pushes the verified import (30 §30.14) and hands
// the PowerPoint files shown as-is to the inbox job (30 §30.10). `npm.cmd run import -- inbox`
// does only that hand-off, for an import already pushed to `main`.
import { fileURLToPath } from "node:url";
import { commitImport, handOffInbox, spawnRunner } from "./commit.ts";
import { runImport } from "./run.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export async function main(argv: readonly string[], root: string = ROOT): Promise<number> {
  const [command, ...rest] = argv;
  if (rest.length > 0 || (command !== undefined && command !== "commit" && command !== "inbox")) {
    console.error("usage: node tools/import/index.ts [commit | inbox]");
    return 2;
  }
  try {
    if (command === "commit") await commitImport(root, { run: spawnRunner(root) });
    else if (command === "inbox") await handOffInbox(root, { run: spawnRunner(root) });
    else await runImport(root);
    return 0;
  } catch (e) {
    console.error(`import failed: ${(e as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
