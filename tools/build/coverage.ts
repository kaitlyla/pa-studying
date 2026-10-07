// `node tools/build/coverage.ts [root]`: lists every piece of shown text in the content tree under
// `root` (default: the current directory) that no search unit contains, and exits 1 if there is any
// (Orchestrator ruling 2026-10-04 04:45Z; run over the real imported guides at S9/S10).
import { pathToFileURL } from "node:url";
import { uncoveredText, type Uncovered } from "../../lib/derive/coverage.ts";
import { publish } from "../../lib/derive/publish.ts";
import { loadContent } from "./load.ts";

export async function searchCoverage(root: string): Promise<Uncovered[]> {
  const content = await loadContent(root);
  const out = publish(content);
  return uncoveredText(content, out.units, out.files);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  searchCoverage(process.argv[2] ?? process.cwd()).then(
    (missing) => {
      for (const m of missing) console.log(`${m.id}\t${m.text}`);
      console.log(missing.length === 0 ? "Every shown text is in a search unit." : `${missing.length} shown text(s) are in no search unit.`);
      if (missing.length > 0) process.exitCode = 1;
    },
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    },
  );
}
