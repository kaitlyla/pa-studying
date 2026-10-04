// The one-time import (30 §30.1): her source files → `content/` (20), with every pre-curation
// file the build reads (30 §30.14). The whole tree is written to a staging directory and moved
// into place only when every source converted, so a failed run leaves no partial `content/`.
import { mkdtemp, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { newId, slug } from "../../lib/content/index.ts";
import type {
  AsIsFile, BlockFile, CardsFile, ChecksFile, ConceptsFile, DeckFile, FlagsFile, GeneralFile, GuideFile,
  GuideId, PharmFile, SystemFile, WordDocFile,
} from "../../lib/content/index.ts";
import { writeAsset, writeContent, writeStoredFile } from "../../lib/content/fs.ts";
import { convertDocx, segmentGuide, toBlocks } from "../../lib/docx/index.ts";
import type { ConvertedDoc, TopElement } from "../../lib/docx/index.ts";
import { proveDuplicate } from "./duplicate.ts";
import { pdfText } from "./pdf.ts";
import { buildOther, buildRefTabs, initialStructure, pharmFilesFor, sidebarEndOf } from "./placement.ts";
import type { PlacedDoc } from "./placement.ts";
import { convertDeck, editPsychDeck, PSYCH_REMOVED_LINE } from "./pptx.ts";
import { baseName, checkSourcesExist, loadGuides, loadSources, stem } from "./sources.ts";
import type { GuidesConfig, Source } from "./sources.ts";
import { SITE } from "./site.ts";
import type { Log } from "./site.ts";
import { readVocab } from "./vocab.ts";

/** Kinds that become a document with a `d_` id (20 §20.5). */
const DOC_KINDS: ReadonlySet<Source["kind"]> = new Set(["word", "pdf", "image", "slides", "deck"]);

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

class Importer {
  /** Every id this run has issued, so none is issued twice. */
  private readonly taken = new Set<string>();
  readonly docIds = new Map<string, string>();
  private readonly root: string;
  private readonly out: string;
  private readonly sources: readonly Source[];
  private readonly guides: GuidesConfig;
  private readonly log: Log;

  constructor(root: string, out: string, sources: readonly Source[], guides: GuidesConfig, log: Log) {
    this.root = root;
    this.out = out;
    this.sources = sources;
    this.guides = guides;
    this.log = log;
    for (const s of sources) if (DOC_KINDS.has(s.kind)) this.docIds.set(s.path, this.id("d"));
  }

  private id(prefix: "b" | "d" | "p" | "s"): string {
    const id = newId(prefix, this.taken);
    this.taken.add(id);
    return id;
  }

  private docId(s: Source): string {
    return this.docIds.get(s.path) as string;
  }

  private placed(): PlacedDoc[] {
    return this.sources.filter((s) => DOC_KINDS.has(s.kind)).map((s) => ({ id: this.docId(s), placement: s.placement }));
  }

  private read(s: Source): Promise<Uint8Array> {
    return readFile(join(this.root, ...s.path.split("/"))).then((b) => new Uint8Array(b));
  }

  private write(path: string, value: unknown): Promise<boolean> {
    return writeContent(this.out, path, value);
  }

  private async convert(s: Source): Promise<ConvertedDoc> {
    const conv = await convertDocx(await this.read(s), { storeAsset: (bytes, ext) => writeAsset(this.out, bytes, ext) });
    for (const entry of conv.report) this.log(`  ${s.path}: ${JSON.stringify(entry)}`);
    return conv;
  }

  /** Write the §30.8 blocks of `els` under `dir`; returns their ids in order. */
  private async writeBlocks(dir: string, els: readonly TopElement[]): Promise<string[]> {
    const ids: string[] = [];
    for (const block of toBlocks([...els])) {
      const id = this.id("b");
      const file: BlockFile = { v: 1, id, kind: block.kind, doc: block.doc, meta: {} };
      await this.write(`${dir}/${id}.json`, file);
      ids.push(id);
    }
    return ids;
  }

  async run(): Promise<void> {
    await this.write("content/site.json", SITE);
    for (const s of this.sources) {
      this.log(`${s.kind} ${s.path}`);
      switch (s.kind) {
        case "guide": await this.guide(s); break;
        case "word": await this.word(s); break;
        case "pharm": await this.pharm(s); break;
        case "pdf": await this.pdf(s); break;
        case "image": await this.image(s); break;
        case "slides": await this.slidesViaInbox(s); break;
        case "deck": await this.deck(s); break;
        case "vocab": await this.vocab(s); break;
        case "duplicate": break;
      }
    }
    const placed = this.placed();
    await this.write("content/places/reftabs.json", buildRefTabs(placed));
    await this.write("content/places/other.json", buildOther(placed));
    await this.write("content/pharm/cards.json", { v: 1, cards: [] } satisfies CardsFile);
    await this.write("content/updates/flags.json", { v: 1, flags: [] } satisfies FlagsFile);
    await this.write("content/updates/concepts.json", { v: 1, concepts: [] } satisfies ConceptsFile);
    await this.write("content/updates/checks.json", { v: 1, lastRun: null, nextRun: null, sources: [], seen: {}, seenUrl: {} } satisfies ChecksFile);
  }

  /** A guide (30 §30.8): preamble, systems and their blocks, plus the pre-curation files. */
  private async guide(s: Source): Promise<void> {
    const g = (s.placement as { guide: GuideId }).guide;
    const cfg = this.guides[g].systems;
    const conv = await this.convert(s);
    const seg = segmentGuide(conv.body, cfg);
    const base = `content/guides/${g}`;
    const placed = this.placed();
    const preamble = await this.writeBlocks(`${base}/_preamble/blocks`, seg.preamble);
    const systems: GuideFile["systems"] = [];
    for (const [i, sys] of cfg.entries()) {
      const id = slug(sys.title);
      const blocks = await this.writeBlocks(`${base}/${id}/blocks`, seg.systems[i] ?? []);
      await this.write(`${base}/${id}/system.json`, { v: 1, id, blocks } satisfies SystemFile);
      await this.write(`${base}/${id}/structure.json`, initialStructure(pharmFilesFor(sys.category, placed)));
      systems.push({ id, title: sys.title, pct: sys.pct });
    }
    const sidebarEnd = g === "pance" ? sidebarEndOf(placed) : undefined;
    const guide: GuideFile = {
      v: 1, id: g, source: baseName(s.path), page: conv.page, basePt: conv.basePt, preamble, systems,
      ...(sidebarEnd !== undefined ? { sidebarEnd } : {}),
    };
    await this.write(`${base}/guide.json`, guide);
    if (g !== "pance") await this.write(`${base}/general.json`, { v: 1, topics: [], workup: [] } satisfies GeneralFile);
  }

  /** A Word document shown as a page (`docs/<d>/`). */
  private async word(s: Source): Promise<void> {
    const d = this.docId(s);
    const conv = await this.convert(s);
    const blocks = await this.writeBlocks(`content/docs/${d}/blocks`, conv.body);
    const doc: WordDocFile = {
      v: 1, id: d, name: s.name, kind: "word", source: baseName(s.path), page: conv.page, basePt: conv.basePt, blocks, removed: null,
    };
    await this.write(`content/docs/${d}/doc.json`, doc);
  }

  /** A pharm notes file (30 §30.12): all blocks, one overview part covering them. */
  private async pharm(s: Source): Promise<void> {
    const fileName = stem(baseName(s.path));
    const id = slug(fileName);
    const conv = await this.convert(s);
    const blocks = await this.writeBlocks(`content/pharm/${id}/blocks`, conv.body);
    const parts: PharmFile["parts"] = blocks.length ? [{ id: this.id("p"), role: "overview", title: "", card: null, blocks: [...blocks] }] : [];
    await this.write(`content/pharm/${id}/pharmfile.json`, { v: 1, id, fileName, basePt: conv.basePt, blocks, parts } satisfies PharmFile);
  }

  private async pdf(s: Source): Promise<void> {
    const d = this.docId(s);
    const bytes = await this.read(s);
    const pages = await pdfText(bytes);
    const original = baseName(s.path);
    await writeStoredFile(this.out, d, original, bytes);
    await this.write(`content/files/${d}/text.json`, { pages });
    const file: AsIsFile = { v: 1, id: d, name: s.name, kind: "pdf", original, view: original, pages: pages.length, text: "text.json", removed: null };
    await this.write(`content/files/${d}/file.json`, file);
  }

  private async image(s: Source): Promise<void> {
    const d = this.docId(s);
    const original = baseName(s.path);
    await writeStoredFile(this.out, d, original, await this.read(s));
    const file: AsIsFile = { v: 1, id: d, name: s.name, kind: "image", original, view: original, removed: null };
    await this.write(`content/files/${d}/file.json`, file);
  }

  /**
   * A PowerPoint shown as-is is converted by the inbox job (30 §30.10): the import commit carries
   * only its processing `file.json`; `commitImport` pushes the original on `inbox/<d_id>`.
   */
  private async slidesViaInbox(s: Source): Promise<void> {
    const d = this.docId(s);
    const file: AsIsFile = {
      v: 1, id: d, name: s.name, kind: "slides", original: baseName(s.path), view: null, pages: null, text: null, removed: null, state: "processing",
    };
    await this.write(`content/files/${d}/file.json`, file);
  }

  /** Her psych review deck (30 §30.10): slide blocks, the deck, and her (edited) file. */
  private async deck(s: Source): Promise<void> {
    const g = (s.placement as { deck: GuideId }).deck;
    const d = this.docId(s);
    const edit = await editPsychDeck(await this.read(s));
    this.log(`  ${s.path}: applied her edit on slide 2 (${edit.slidePart}): removed "${PSYCH_REMOVED_LINE}" and moved the next paragraph up one level; every other package entry is byte-identical`);
    const slides: string[] = [];
    for (const doc of convertDeck(edit.bytes)) {
      const id = this.id("s");
      await this.write(`content/slides/${g}/blocks/${id}.json`, { v: 1, id, kind: "slide", doc, meta: {} } satisfies BlockFile);
      slides.push(id);
    }
    await this.write(`content/slides/${g}/deck.json`, { v: 1, guide: g, kind: "own", title: s.name, file: d, slides } satisfies DeckFile);
    const original = baseName(s.path);
    await writeStoredFile(this.out, d, original, edit.bytes);
    const file: AsIsFile = { v: 1, id: d, name: s.name, kind: "slides", original, view: null, pages: slides.length, text: null, removed: null };
    await this.write(`content/files/${d}/file.json`, file);
  }

  private async vocab(s: Source): Promise<void> {
    const conv = await this.convert(s);
    const { vocab, tables, skipped } = readVocab(conv.body.flatMap((e) => e.nodes));
    this.log(`  ${s.path}: ${tables} vocabulary tables, ${vocab.entries.length} entries, ${skipped} rows skipped (empty abbreviation or meaning)`);
    await this.write("content/vocab/abbreviations.json", vocab);
  }
}

/** Duplicate files are proven before anything is written (30 §30.2). */
async function proveDuplicates(root: string, sources: readonly Source[], log: Log): Promise<void> {
  const read = (p: string): Promise<Uint8Array> => readFile(join(root, ...p.split("/"))).then((b) => new Uint8Array(b));
  for (const s of sources) {
    if (s.kind !== "duplicate") continue;
    const of = (s.placement as { duplicateOf: string }).duplicateOf;
    await proveDuplicate(s.path, await read(s.path), of, await read(of));
    log(`duplicate ${s.path}: same paragraph texts and pictures as ${of}; not imported`);
  }
}

/**
 * Move the staged `content/` into place. A new `content/` is one rename. Into an existing
 * `content/` (one without `guides/`), each top-level entry is renamed in after checking that none
 * exists yet; if a rename fails, the entries already moved are moved back, so either all of the
 * import lands or none of it does.
 */
async function moveIntoPlace(staged: string, target: string): Promise<void> {
  if (!(await exists(target))) {
    await rename(staged, target);
    return;
  }
  const entries = await readdir(staged);
  for (const e of entries) if (await exists(join(target, e))) throw new Error(`content/${e} already exists`);
  const moved: string[] = [];
  try {
    for (const e of entries) {
      await rename(join(staged, e), join(target, e));
      moved.push(e);
    }
  } catch (err) {
    for (const e of moved.reverse()) await rename(join(target, e), join(staged, e));
    throw err;
  }
}

export interface ImportResult {
  /** Document id per source path (Word pages, as-is files, the deck). */
  docIds: Map<string, string>;
}

/**
 * Run the import over the project at `root`. Refuses when `content/guides/` exists (30 §30.1).
 * Never modifies a source file.
 */
export async function runImport(root: string, log: Log = console.log): Promise<ImportResult> {
  if (await exists(join(root, "content", "guides"))) {
    throw new Error("content/guides/ already exists: the import is a one-time initial conversion and does not run again");
  }
  const sources = await loadSources(root);
  const guides = await loadGuides(root);
  await checkSourcesExist(root, sources);
  await proveDuplicates(root, sources, log);

  // Staged inside the project so the final move is a rename on the same volume.
  const out = await mkdtemp(join(root, ".import-staging-"));
  try {
    const importer = new Importer(root, out, sources, guides, log);
    await importer.run();
    await moveIntoPlace(join(out, "content"), join(root, "content"));
    log(`content/ written: ${sources.filter((s) => s.kind !== "duplicate").length} sources imported`);
    return { docIds: importer.docIds };
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}
