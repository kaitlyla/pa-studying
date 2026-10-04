// tools/build: build:data output (40 §40.1, §40.8; 60 §60.4; 70 §70.4) and the post-build size step.
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BuildError } from "../../lib/derive/errors.ts";
import type { BuildJson, FontMapJson, SiteJson } from "../../lib/derive/published.ts";
import { FONTS } from "../../lib/fonts.ts";
import { loadIndex, runSearch, SHARD_SIZE, Vocab, type SearchUnit } from "../../lib/search/index.ts";
import { searchCoverage } from "./coverage.ts";
import { finish, FILE_LIMIT, SITE_LIMIT } from "./finish.ts";
import { build, currentCommit, isoNow } from "./index.ts";
import { D, PNG, writeFixture } from "./test-fixture.ts";

const FONTS_DIR = join(process.cwd(), "app", "public", "fonts");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

let root: string;
let out: string;
let result: BuildJson;
const read = async (path: string): Promise<string> => readFile(join(out, ...path.split("/")), "utf8");
const json = async <T>(path: string): Promise<T> => JSON.parse(await read(path)) as T;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pa-build-"));
  await writeFixture(root);
  out = join(root, "dist", "data");
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "stale.json"), "{}");
  result = await build({ root, fontsDir: FONTS_DIR, commit: COMMIT, builtAt: "2026-10-04T05:00:00Z" });
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("search coverage (ruling 2026-10-04 04:45Z)", () => {
  it("finds every shown text of the content tree in a search unit", async () => {
    // lib/derive/derive.test.ts shows the check reports text that a unit misses.
    await expect(searchCoverage(root)).resolves.toEqual([]);
  });
});

describe("build:data", () => {
  it("clears stale output and writes every published file as minified JSON", async () => {
    await expect(stat(join(out, "stale.json"))).rejects.toThrow();
    const site = await read("site.json");
    expect(site).toBe(JSON.stringify(JSON.parse(site)));
    expect(site).not.toContain("\n");
    expect((JSON.parse(site) as SiteJson).repo).toBe("kaitlyla/pa-studying");
    for (const path of ["g/fm/nav.json", "g/fm/s/cardiovascular.json", "g/pance/home.json", "hosts.json", "updates.json", `docs/${D(5)}.json`]) {
      expect(JSON.parse(await read(path)), path).toBeTruthy();
    }
  });

  it("copies the assets and visible stored files the pages use, and no removed ones", async () => {
    const assets = await readdir(join(out, "assets"));
    expect(assets).toHaveLength(1);
    expect(new Uint8Array(await readFile(join(out, "assets", assets[0] as string)))).toEqual(PNG);
    expect(await readdir(join(out, "files", D(1)))).toEqual(["ACLS algorithms.pdf"]);
    await expect(stat(join(out, "files", D(6)))).rejects.toThrow();
  });

  it("writes a search index that loads and answers, the units in site-ordered shards, and the vocabulary", async () => {
    const units = await json<SearchUnit[]>("search/units-0.json");
    expect(units.length).toBeGreaterThan(0);
    expect(units.length).toBeLessThanOrEqual(SHARD_SIZE);
    expect(units.map((u) => u.ord)).toEqual(units.map((_, i) => i));
    await expect(stat(join(out, "search", "units-1.json"))).rejects.toThrow();
    const vocabFile = await json<{ v: number; entries: { abbr: string[]; meanings: string[] }[] }>("search/vocab.json");
    expect(vocabFile.entries).toEqual([{ abbr: ["AF"], meanings: ["atrial fibrillation"] }]);
    const hits = runSearch(loadIndex(await read("search/index.json")), new Vocab(vocabFile.entries), "asthma");
    expect(hits?.titles.map((h) => units[h.n]?.title)).toContain("Asthma");
  });

  it("maps each content code point to the first vendored font with its glyph, falling back to DejaVu Sans", async () => {
    const fm = await json<FontMapJson>("fonts/fontmap.json");
    expect(fm.fonts).toEqual(FONTS.map((f) => ({ family: f.family, file: f.file })));
    expect(fm.map[String("A".codePointAt(0))]).toBe(0);
    expect(fm.map[String(0x2295)]).toBe(1); // ⊕: not in Carlito, in Noto Sans Math
    expect(fm.fonts[fm.map[String(0xf0000)] ?? -1]?.family).toBe("DejaVu Sans");
    expect(fm.map[String(0x0a)]).toBeUndefined();
  });

  it("records the commit, build time, dropped references and uncovered glyphs in build.json", async () => {
    const b = await json<BuildJson>("build.json");
    expect(b).toEqual(result);
    expect(b).toMatchObject({ commit: COMMIT, builtAt: "2026-10-04T05:00:00Z", siteBytes: 0, uncoveredGlyphs: ["U+F0000"] });
    expect(b.dropped.map((d) => d.file)).toEqual([
      "content/updates/concepts.json", "content/guides/fm/general.json", expect.stringMatching(/^content\/slides\/fm\/blocks\//),
    ]);
  });
});

describe("post-build size step", () => {
  const sizeOf = async (dir: string): Promise<number> => {
    let n = 0;
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      n += e.isDirectory() ? await sizeOf(p) : (await stat(p)).size;
    }
    return n;
  };

  it("uses the GitHub Pages limits: 100 MiB per file, 1 GB per site", () => {
    expect(FILE_LIMIT).toBe(104_857_600);
    expect(SITE_LIMIT).toBe(1_000_000_000);
  });

  it("writes the total size of dist into build.json siteBytes", async () => {
    const dist = join(root, "dist");
    await writeFile(join(dist, "index.html"), "<!doctype html>");
    const bytes = await finish(dist);
    const b = await json<BuildJson>("build.json");
    expect(b.siteBytes).toBe(bytes);
    // siteBytes was measured before its own digits replaced the 0, so allow for that growth only.
    const now = await sizeOf(dist);
    expect(now - bytes).toBe(String(bytes).length - 1);
  });

  it("fails naming a file over the per-file limit, and the site over the site limit", async () => {
    const dist = await mkdtemp(join(tmpdir(), "pa-finish-"));
    try {
      await mkdir(join(dist, "data"), { recursive: true });
      await writeFile(join(dist, "data", "build.json"), "{}");
      await writeFile(join(dist, "data", "big.bin"), new Uint8Array(11));
      let e: unknown = null;
      await finish(dist, { file: 10, site: 1000 }).catch((x: unknown) => { e = x; });
      expect(e).toBeInstanceOf(BuildError);
      expect((e as BuildError).id).toBe("data/big.bin");
      e = null;
      await finish(dist, { file: 100, site: 12 }).catch((x: unknown) => { e = x; });
      expect((e as BuildError).id).toBe("dist");
      await expect(finish(dist, { file: 100, site: 13 })).resolves.toBe(13);
    } finally {
      await rm(dist, { recursive: true, force: true });
    }
  });
});

describe("build metadata", () => {
  it("takes the commit from GITHUB_SHA when set, else the checkout's HEAD", () => {
    const saved = process.env.GITHUB_SHA;
    try {
      process.env.GITHUB_SHA = COMMIT;
      expect(currentCommit(process.cwd())).toBe(COMMIT);
      delete process.env.GITHUB_SHA;
      expect(currentCommit(process.cwd())).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      if (saved === undefined) delete process.env.GITHUB_SHA;
      else process.env.GITHUB_SHA = saved;
    }
  });

  it("stamps the build time as a seconds-precision UTC timestamp", () => {
    expect(isoNow()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});
