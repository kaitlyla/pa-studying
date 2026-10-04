// Reads the content tree through lib/content into the model lib/derive publishes from.
import {
  checkBlockDir, listDir, listGapBlocks, readContent, readContentIfExists, readSystem,
} from "../../lib/content/fs.ts";
import type {
  AsIsFile, BlockFile, CardsFile, ChecksFile, ConceptsFile, DeckFile, EvidenceFile, FileText, FlagsFile, GeneralFile,
  GuideFile, OtherFile, PharmFile, RefTabsFile, SiteFile, SlideMeta, StructureFile, VocabFile, WordDocFile,
} from "../../lib/content/types.ts";
import type { Content, DeckData, DocData, GapData, GuideData, PharmData } from "../../lib/derive/model.ts";

async function readBlocks<M = Record<string, unknown>>(root: string, dir: string, ids: readonly string[]): Promise<BlockFile<M>[]> {
  await checkBlockDir(root, dir, ids);
  return Promise.all(ids.map((id) => readContent<BlockFile<M>>(root, `${dir}/${id}.json`)));
}

async function loadGuide(root: string, id: string, eor: boolean): Promise<GuideData> {
  const base = `content/guides/${id}`;
  const file = await readContent<GuideFile>(root, `${base}/guide.json`);
  const preamble = await readBlocks(root, `${base}/_preamble/blocks`, file.preamble);
  const general = eor ? await readContent<GeneralFile>(root, `${base}/general.json`) : null;
  const systems = await Promise.all(
    file.systems.map(async (s) => {
      const { system, blocks } = await readSystem(root, id, s.id);
      const structure = await readContent<StructureFile>(root, `${base}/${s.id}/structure.json`);
      return { file: system, structure, blocks };
    }),
  );
  return { file, preamble, general, systems };
}

async function loadDocs(root: string): Promise<Map<string, DocData>> {
  const docs = new Map<string, DocData>();
  for (const id of await listDir(root, "content/docs")) {
    const file = await readContent<WordDocFile>(root, `content/docs/${id}/doc.json`);
    // A removed document's blocks are deleted from the tree (20 §20.5).
    const blocks = file.removed ? [] : await readBlocks(root, `content/docs/${id}/blocks`, file.blocks);
    docs.set(id, { kind: "word", file, blocks });
  }
  for (const id of await listDir(root, "content/files")) {
    const file = await readContent<AsIsFile>(root, `content/files/${id}/file.json`);
    const text = file.text && !file.removed ? await readContent<FileText>(root, `content/files/${id}/${file.text}`) : null;
    docs.set(id, { kind: "file", file, text });
  }
  return docs;
}

async function loadPharm(root: string): Promise<PharmData[]> {
  const out: PharmData[] = [];
  for (const name of await listDir(root, "content/pharm")) {
    if (name === "cards.json") continue;
    const file = await readContent<PharmFile>(root, `content/pharm/${name}/pharmfile.json`);
    out.push({ file, blocks: await readBlocks(root, `content/pharm/${name}/blocks`, file.blocks) });
  }
  return out;
}

async function loadGaps(root: string): Promise<Map<string, GapData>> {
  const gaps = new Map<string, GapData>();
  for (const block of await listGapBlocks(root)) {
    gaps.set(block.id, { block, evidence: await readContentIfExists<EvidenceFile>(root, `content/gapfill/${block.id}.evidence.json`) });
  }
  return gaps;
}

async function loadDecks(root: string, guides: readonly string[], docs: ReadonlyMap<string, DocData>): Promise<Map<string, DeckData>> {
  const decks = new Map<string, DeckData>();
  for (const g of guides) {
    const file = await readContentIfExists<DeckFile>(root, `content/slides/${g}/deck.json`);
    if (!file) continue;
    // An own deck's slide blocks are deleted with its removed document (20 §20.10).
    const removed = file.file !== null && docs.get(file.file)?.file.removed;
    decks.set(g, { file, slides: removed ? [] : await readBlocks<SlideMeta>(root, `content/slides/${g}/blocks`, file.slides) });
  }
  return decks;
}

/** Load the whole content tree under `root`. Every curation file the build reads must exist. */
export async function loadContent(root: string): Promise<Content> {
  const site = await readContent<SiteFile>(root, "content/site.json");
  const ids = [...site.eors, site.pance];
  const docs = await loadDocs(root);
  const [vocab, guides, cards, pharm, gaps, decks, reftabs, other, flags, concepts, checks] = await Promise.all([
    readContent<VocabFile>(root, "content/vocab/abbreviations.json"),
    Promise.all(ids.map((g) => loadGuide(root, g, g !== site.pance))),
    readContent<CardsFile>(root, "content/pharm/cards.json"),
    loadPharm(root),
    loadGaps(root),
    loadDecks(root, ids, docs),
    readContent<RefTabsFile>(root, "content/places/reftabs.json"),
    readContent<OtherFile>(root, "content/places/other.json"),
    readContent<FlagsFile>(root, "content/updates/flags.json"),
    readContent<ConceptsFile>(root, "content/updates/concepts.json"),
    readContent<ChecksFile>(root, "content/updates/checks.json"),
  ]);
  return { site, vocab, guides, cards, pharm, docs, gaps, decks, reftabs, other, flags, concepts, checks };
}
