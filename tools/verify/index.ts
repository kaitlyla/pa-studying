// tools/verify (30 §30.13): proves each imported source is complete in the content store.
// `node tools/verify/index.ts [--rendered] [--post-curation]` writes tools/import/reports/ and exits
// non-zero on any discrepancy. `verifyWordDoc` is the per-upload check the inbox job runs.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { ContentError, slug } from "../../lib/content/index.ts";
import type { AsIsFile, BlockFile, CardsFile, DeckFile, FileText, GuideFile, PharmFile, WordDocFile } from "../../lib/content/index.ts";
import { checkBlockDir, listDir, readContent, readContentIfExists, readStoredFile } from "../../lib/content/fs.ts";
import type { Counts, Discrepancy, ReadAsset } from "./compare.ts";
import { align, compareDocx, readStored } from "./compare.ts";
import { deckParagraphs } from "./deck.ts";
import type { InfoEntry } from "./extract.ts";
import { extract } from "./extract.ts";

export interface SourceReport {
  source: string;
  counts: Partial<Counts>;
  discrepancies: Discrepancy[];
  info: InfoEntry[];
}

export interface SourceRow {
  path: string;
  kind: string;
  name: string;
  placement: unknown;
}

export const REPORT_DIR = "tools/import/reports";

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** Reads stored images from `content/assets/`. */
export function assetReader(root: string): ReadAsset {
  return async (name) => {
    try {
      return new Uint8Array(await readFile(join(root, "content", "assets", name)));
    } catch {
      return null;
    }
  };
}

function uniqueInfo(info: InfoEntry[]): InfoEntry[] {
  const seen = new Map<string, InfoEntry & { count: number }>();
  for (const e of info) {
    const key = JSON.stringify(e);
    const prev = seen.get(key);
    if (prev) prev.count++;
    else seen.set(key, { ...e, count: 1 });
  }
  return [...seen.values()];
}

/** Reads block files under `dir` listed by `ids`, checking reachability (each listed once, none unlisted). */
async function blocksOf(root: string, dir: string, ids: readonly string[], out: Discrepancy[], story: string): Promise<BlockFile[]> {
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  for (const id of dup) out.push({ kind: "reachability", story, index: ids.indexOf(id), expected: "listed once", actual: `${id} listed twice` });
  try {
    await checkBlockDir(root, dir, ids);
  } catch (e) {
    out.push({ kind: "reachability", story, index: -1, expected: "every block file listed exactly once", actual: (e as Error).message });
  }
  const blocks: BlockFile[] = [];
  for (const id of [...new Set(ids)]) {
    const b = await readContentIfExists<BlockFile>(root, `${dir}/${id}.json`);
    if (b) blocks.push(b);
  }
  return blocks;
}

/** The stored blocks each report covers, for the rendered check. */
const reportBlocks = new WeakMap<SourceReport, BlockFile[]>();

async function wordReport(source: string, bytes: Uint8Array, blocks: BlockFile[], basePt: number, root: string, pre: Discrepancy[]): Promise<SourceReport> {
  const atoms = await extract(bytes);
  const r = await compareDocx(atoms, blocks.map((b) => b.doc), basePt, assetReader(root));
  const report = { source, counts: r.counts, discrepancies: [...pre, ...r.discrepancies], info: uniqueInfo(atoms.info) };
  reportBlocks.set(report, blocks);
  return report;
}

/** Verifies a Word page `content/docs/<docId>/` against its .docx (the inbox job's upload check). */
export async function verifyWordDoc(root: string, docId: string, docx: Uint8Array): Promise<SourceReport> {
  const base = `content/docs/${docId}`;
  const doc = await readContent<WordDocFile>(root, `${base}/doc.json`);
  const pre: Discrepancy[] = [];
  const blocks = await blocksOf(root, `${base}/blocks`, doc.blocks, pre, "body");
  return wordReport(doc.source, docx, blocks, doc.basePt, root, pre);
}

async function verifyGuide(root: string, guide: string, source: string, bytes: Uint8Array): Promise<SourceReport> {
  const base = `content/guides/${guide}`;
  const g = await readContent<GuideFile>(root, `${base}/guide.json`);
  const pre: Discrepancy[] = [];
  const blocks = await blocksOf(root, `${base}/_preamble/blocks`, g.preamble, pre, "preamble");
  for (const s of g.systems) {
    const sys = await readContent<{ blocks: string[] }>(root, `${base}/${s.id}/system.json`);
    blocks.push(...(await blocksOf(root, `${base}/${s.id}/blocks`, sys.blocks, pre, s.id)));
  }
  return wordReport(source, bytes, blocks, g.basePt, root, pre);
}

async function verifyPharm(root: string, source: string, bytes: Uint8Array): Promise<SourceReport> {
  const id = slug(basename(source).replace(/\.[^.]+$/, ""));
  const base = `content/pharm/${id}`;
  const pf = await readContent<PharmFile>(root, `${base}/pharmfile.json`);
  const pre: Discrepancy[] = [];
  const blocks = await blocksOf(root, `${base}/blocks`, pf.blocks, pre, "body");
  const concat = pf.parts.flatMap((p) => p.blocks);
  if (JSON.stringify(concat) !== JSON.stringify(pf.blocks)) {
    pre.push({ kind: "pharm", story: "parts", index: -1, expected: pf.blocks, actual: concat });
  }
  const cards = await readContentIfExists<CardsFile>(root, "content/pharm/cards.json");
  const cardIds = new Set((cards?.cards ?? []).map((c) => c.id));
  pf.parts.forEach((p, i) => {
    if (p.role === "card" && (!p.card || !cardIds.has(p.card))) {
      pre.push({ kind: "pharm", story: "parts", index: i, expected: "a card in pharm/cards.json", actual: p.card });
    }
  });
  return wordReport(source, bytes, blocks, pf.basePt, root, pre);
}

async function pdfPages(bytes: Uint8Array): Promise<number> {
  const task = getDocument({ data: bytes.slice(), verbosity: 0 });
  try {
    return (await task.promise).numPages;
  } finally {
    await task.destroy();
  }
}

async function findDoc<T extends { removed: unknown }>(root: string, dir: "docs" | "files", file: string, match: (v: T) => boolean): Promise<{ id: string; value: T } | null> {
  for (const id of await listDir(root, `content/${dir}`)) {
    const v = await readContentIfExists<T>(root, `content/${dir}/${id}/${file}`);
    if (v && match(v)) return { id, value: v };
  }
  return null;
}

async function verifyAsIs(root: string, row: SourceRow, bytes: Uint8Array): Promise<SourceReport> {
  const name = basename(row.path);
  const report: SourceReport = { source: name, counts: {}, discrepancies: [], info: [] };
  const found = await findDoc<AsIsFile>(root, "files", "file.json", (f) => f.original === name);
  if (!found) {
    report.discrepancies.push({ kind: "file", story: "file", index: -1, expected: name, actual: null });
    return report;
  }
  const f = found.value;
  if (f.state === "processing") {
    report.info.push({ kind: "processing", id: found.id });
    return report;
  }
  const stored = await readStoredFile(root, found.id, f.original).catch(() => null);
  if (!stored || sha256(stored) !== sha256(bytes)) {
    report.discrepancies.push({ kind: "file", story: "file", index: -1, expected: `sha256 ${sha256(bytes)}`, actual: stored ? `sha256 ${sha256(stored)}` : null });
  }
  if (row.kind === "pdf") {
    const pages = await pdfPages(bytes);
    const text = f.text ? await readContentIfExists<FileText>(root, `content/files/${found.id}/${f.text}`) : null;
    report.counts = { stories: pages };
    if (!text || text.pages.length !== pages) {
      report.discrepancies.push({ kind: "file", story: "text.json", index: -1, expected: { pages }, actual: { pages: text?.pages.length ?? null } });
    }
  }
  return report;
}

async function verifyDeck(root: string, row: SourceRow, bytes: Uint8Array): Promise<SourceReport> {
  const guide = (row.placement as { deck: string }).deck;
  const report: SourceReport = { source: basename(row.path), counts: {}, discrepancies: [], info: [] };
  const deck = await readContent<DeckFile>(root, `content/slides/${guide}/deck.json`);
  const blocks = await blocksOf(root, `content/slides/${guide}/blocks`, deck.slides, report.discrepancies, "slides");
  const expected = deckParagraphs(bytes);
  if (expected.length !== blocks.length) {
    report.discrepancies.push({ kind: "deck", story: "slides", index: -1, expected: { slides: expected.length }, actual: { slides: blocks.length } });
  }
  expected.forEach((want, i) => {
    const b = blocks[i];
    if (!b) return;
    const got = readStored([b.doc]).main.paragraphs.map((p) => p.text);
    const { pairs, missing, extra } = align(want, got);
    for (const k of missing) report.discrepancies.push({ kind: "deck", story: `slide ${i + 1}`, index: k, expected: want[k], actual: null });
    for (const k of extra) report.discrepancies.push({ kind: "deck", story: `slide ${i + 1}`, index: k, expected: null, actual: got[k] });
    for (const [k, g] of pairs) {
      if (want[k] !== got[g]) report.discrepancies.push({ kind: "deck", story: `slide ${i + 1}`, index: k, expected: want[k], actual: got[g] });
    }
  });
  report.counts = { stories: expected.length, paragraphs: expected.reduce((n, s) => n + s.length, 0) };
  reportBlocks.set(report, blocks);
  return report;
}

/** Verifies one source row of `tools/import/sources.json`; null for rows with nothing to compare. */
export async function verifySource(root: string, row: SourceRow): Promise<SourceReport | null> {
  if (row.kind === "duplicate" || row.kind === "vocab") return null;
  const bytes = new Uint8Array(await readFile(join(root, ...row.path.split("/"))));
  const name = basename(row.path);
  try {
    switch (row.kind) {
      case "guide":
        return await verifyGuide(root, (row.placement as { guide: string }).guide, name, bytes);
      case "word": {
        const found = await findDoc<WordDocFile>(root, "docs", "doc.json", (d) => d.source === name);
        if (!found) return { source: name, counts: {}, discrepancies: [{ kind: "file", story: "doc", index: -1, expected: name, actual: null }], info: [] };
        return await verifyWordDoc(root, found.id, bytes);
      }
      case "pharm":
        return await verifyPharm(root, name, bytes);
      case "deck":
        return await verifyDeck(root, row, bytes);
      default:
        return await verifyAsIs(root, row, bytes);
    }
  } catch (e) {
    if (!(e instanceof ContentError)) throw e;
    return { source: name, counts: {}, discrepancies: [{ kind: "file", story: "content", index: -1, expected: "readable content", actual: e.message }], info: [] };
  }
}

export function reportName(source: string): string {
  return `${slug(source)}.json`;
}

export interface RunOptions {
  rendered?: boolean;
  postCuration?: boolean;
  log?: (line: string) => void;
}

/** Runs the whole proof over `tools/import/sources.json`, writes the reports, returns the exit code. */
export async function runVerify(root: string, opts: RunOptions = {}): Promise<number> {
  const log = opts.log ?? console.log;
  const sources = (JSON.parse(await readFile(join(root, "tools", "import", "sources.json"), "utf8")) as { sources: SourceRow[] }).sources;
  const reports: SourceReport[] = [];
  for (const row of sources) {
    const r = await verifySource(root, row);
    if (r) reports.push(r);
  }
  if (opts.rendered) {
    const { renderedCheck } = await import("./rendered.ts");
    const blocks = new Map<SourceReport, BlockFile[]>();
    for (const r of reports) {
      const b = reportBlocks.get(r);
      if (b) blocks.set(r, b);
    }
    await renderedCheck(root, blocks, { postCuration: !!opts.postCuration, log });
  }
  const dir = join(root, ...REPORT_DIR.split("/"));
  await mkdir(dir, { recursive: true });
  for (const r of reports) await writeFile(join(dir, reportName(r.source)), `${JSON.stringify(r, null, 1)}\n`, "utf8");
  const summary = { sources: reports.map((r) => ({ source: r.source, discrepancies: r.discrepancies.length })) };
  await writeFile(join(dir, "summary.json"), `${JSON.stringify(summary, null, 1)}\n`, "utf8");
  const bad = reports.filter((r) => r.discrepancies.length);
  for (const r of reports) log(`${r.discrepancies.length ? "FAIL" : "ok  "} ${r.source}${r.discrepancies.length ? ` — ${r.discrepancies.length} discrepancies` : ""}`);
  log(bad.length ? `${bad.length} of ${reports.length} sources have discrepancies` : `all ${reports.length} sources complete`);
  return bad.length ? 1 : 0;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  process.exitCode = await runVerify(ROOT, { rendered: argv.includes("--rendered"), postCuration: argv.includes("--post-curation") });
}
