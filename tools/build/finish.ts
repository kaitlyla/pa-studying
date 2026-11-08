// Post-build step, run after `vite build`: checks the Cloudflare Pages limits and records the
// total size of dist/ in dist/data/build.json `siteBytes` (plan 40 §40.1, §40.8).
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { BuildError } from "../../lib/derive/errors.ts";
import { BUILD_PATH, type BuildJson } from "../../lib/derive/published.ts";

/** Cloudflare Pages (free plan): at most 25 MiB per file and 20,000 files per site; no total-size cap. */
export const FILE_LIMIT = 25 * 1024 * 1024;
export const FILE_COUNT_LIMIT = 20_000;

async function sizes(dir: string): Promise<{ path: string; bytes: number }[]> {
  const out: { path: string; bytes: number }[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sizes(path)));
    else out.push({ path, bytes: (await stat(path)).size });
  }
  return out;
}

/** Measure `dist`, fail on a Pages limit, and write `siteBytes` into `dist/data/build.json`. */
export async function finish(dist: string, limits: { file: number; files: number } = { file: FILE_LIMIT, files: FILE_COUNT_LIMIT }): Promise<number> {
  const files = await sizes(dist);
  for (const f of files) {
    if (f.bytes > limits.file) throw new BuildError(relative(dist, f.path).split("\\").join("/"), `file is ${f.bytes} bytes; Cloudflare Pages files must be at most ${limits.file}`);
  }
  if (files.length > limits.files) throw new BuildError("dist", `site has ${files.length} files; Cloudflare Pages sites must have at most ${limits.files}`);
  const total = files.reduce((n, f) => n + f.bytes, 0);
  const path = join(dist, "data", ...BUILD_PATH.split("/"));
  const build = JSON.parse(await readFile(path, "utf8")) as BuildJson;
  await writeFile(path, JSON.stringify({ ...build, siteBytes: total }), "utf8");
  return total;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  finish(join(process.cwd(), "dist")).then(
    (bytes) => console.log(`dist/ is ${bytes} bytes.`),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    },
  );
}
