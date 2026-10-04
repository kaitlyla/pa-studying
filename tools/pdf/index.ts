// tools/pdf (plan 70 §70.5), run by the `pdf` job of publish.yml after `npm run build:data`:
//   node tools/pdf/index.ts --all            rebuild and upload each guide's stale whole-guide PDF
//   node tools/pdf/index.ts --guide <g> --out <file>
//                                            build one guide's whole PDF locally; no release calls
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { navPath, SITE_PATH, type NavJson, type SiteJson } from "../../lib/derive/published.ts";
import { wholeGuideAsset } from "../../lib/pdf/index.ts";
import { buildGuidePdf, loadFontmap, nodeRenderer, type PdfRenderer } from "./build.ts";
import { decide, guideDigest, headCommit, publish, releaseRecord, spawnRun, type Run } from "./release.ts";

export interface Options {
  dataDir: string;
  fontsDir: string;
  outDir: string;
  run: Run;
  log: (line: string) => void;
  renderer?: PdfRenderer;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

/** Every guide: rebuild when stale (release.ts `decide`), upload, and record HEAD and the data digest. Returns the guides rebuilt. */
export async function runAll(o: Options): Promise<string[]> {
  const site = await readJson<SiteJson>(join(o.dataDir, SITE_PATH));
  const guides = [...site.eors.map((e) => e.id), site.pance.id];
  const renderer = o.renderer ?? nodeRenderer(o.dataDir, o.fontsDir, await loadFontmap(o.dataDir));
  const head = headCommit(o.run);
  const rebuilt: string[] = [];
  for (const g of guides) {
    const released = releaseRecord(o.run, g);
    const digest = await guideDigest(o.dataDir, g);
    const decision = decide(o.run, released, digest);
    if (!decision.regenerate) {
      o.log(`${g}: up to date`);
      continue;
    }
    o.log(`${g}: regenerating (${decision.reason})`);
    const nav = await readJson<NavJson>(join(o.dataDir, navPath(g)));
    const file = join(o.outDir, wholeGuideAsset(nav.source));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, await buildGuidePdf(o.dataDir, g, renderer));
    publish(o.run, g, site.guideNames[g] ?? g, released.exists, file, head, digest);
    rebuilt.push(g);
  }
  return rebuilt;
}

export async function main(argv: readonly string[], run: Run = spawnRun, log: (line: string) => void = console.log): Promise<number> {
  const dataDir = join("dist", "data");
  const fontsDir = join("app", "public", "fonts");
  if (argv[0] === "--all" && argv.length === 1) {
    await runAll({ dataDir, fontsDir, outDir: join("dist", "pdf"), run, log });
    return 0;
  }
  if (argv[0] === "--guide" && argv[1] && argv[2] === "--out" && argv[3]) {
    const renderer = nodeRenderer(dataDir, fontsDir, await loadFontmap(dataDir));
    await mkdir(dirname(argv[3]), { recursive: true });
    await writeFile(argv[3], await buildGuidePdf(dataDir, argv[1], renderer));
    log(`wrote ${argv[3]}`);
    return 0;
  }
  log("usage: node tools/pdf/index.ts --all | --guide <g> --out <file>");
  return 2;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
