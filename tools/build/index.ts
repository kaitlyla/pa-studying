// `npm run build:data`: reads content/ through lib/content and writes dist/data/ (plan 40 §40.1, §40.8).
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { publish } from "../../lib/derive/publish.ts";
import type { BuildJson } from "../../lib/derive/published.ts";
import { buildIndex, SHARD_SIZE, Vocab } from "../../lib/search/index.ts";
import { buildFontMap } from "./fonts.ts";
import { loadContent } from "./load.ts";

export interface BuildOptions {
  /** Repository root (holds `content/` and `app/public/fonts/`). */
  root: string;
  /** Output directory; defaults to `<root>/dist/data`. It is cleared first. */
  out?: string;
  /** Vendored fonts; defaults to `<root>/app/public/fonts`. */
  fontsDir?: string;
  commit: string;
  builtAt: string;
}

async function writeJSON(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf8");
}

async function copyInto(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
}

export async function build(opts: BuildOptions): Promise<BuildJson> {
  const out = opts.out ?? join(opts.root, "dist", "data");
  const content = await loadContent(opts.root);
  const result = publish(content);

  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  for (const [path, value] of result.files) await writeJSON(join(out, ...path.split("/")), value);
  for (const name of result.assets) await copyInto(join(opts.root, "content", "assets", name), join(out, "assets", name));
  for (const f of result.stored) await copyInto(join(opts.root, "content", "files", f.doc, f.name), join(out, "files", f.doc, f.name));

  const vocab = new Vocab(content.vocab.entries);
  await writeJSON(join(out, "search", "index.json"), buildIndex(vocab, result.units));
  for (let i = 0; i * SHARD_SIZE < result.units.length; i++) {
    await writeJSON(join(out, "search", `units-${i}.json`), result.units.slice(i * SHARD_SIZE, (i + 1) * SHARD_SIZE));
  }
  await writeJSON(join(out, "search", "vocab.json"), content.vocab);

  const { fontmap, uncovered } = buildFontMap(result.codePoints, opts.fontsDir ?? join(opts.root, "app", "public", "fonts"));
  await writeJSON(join(out, "fonts", "fontmap.json"), fontmap);

  const buildJson: BuildJson = { commit: opts.commit, builtAt: opts.builtAt, siteBytes: 0, dropped: result.dropped, uncoveredGlyphs: uncovered };
  await writeJSON(join(out, "build.json"), buildJson);
  return buildJson;
}

/** The commit being built: `GITHUB_SHA` in Actions, else the checkout's HEAD. */
export function currentCommit(root: string): string {
  return process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

/** Seconds-precision ISO UTC timestamp. */
export function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd();
  build({ root, commit: currentCommit(root), builtAt: isoNow() }).then(
    (b) => {
      console.log(`dist/data written for ${b.commit}; ${b.dropped.length} dropped reference(s), ${b.uncoveredGlyphs.length} uncovered glyph(s).`);
    },
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    },
  );
}
