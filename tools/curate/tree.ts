// Staged curation writes (plan 90 §90.1): every change is validated through lib/content, applied
// to the loaded content model in memory, and checked with the build's own 40 §40.1 invariants
// (lib/derive publish) before anything reaches the disk.
import { ContentError, GAP_FILE_RE, serializeFile } from "../../lib/content/index.ts";
import { removeContent, writeContent } from "../../lib/content/fs.ts";
import type { BlockFile, DeckFile, EvidenceFile, GapFile, GeneralFile, GuideFile, PharmFile, SlideMeta, StructureFile, SystemFile, WordDocFile } from "../../lib/content/types.ts";
import type { Content } from "../../lib/derive/model.ts";
import { publish } from "../../lib/derive/publish.ts";
import { loadContent } from "../build/load.ts";

/** One file to write (`value`) or delete (`null`), by repository path. */
export interface Change {
  path: string;
  value: unknown;
}

export class CurateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CurateError";
  }
}

/** Load the content tree a command works on. */
export function load(root: string): Promise<Content> {
  return loadContent(root);
}

/**
 * Validate every change for its path and return the stored (normalized) values. A file is listed
 * at most once.
 */
function normalize(changes: readonly Change[]): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const ch of changes) {
    if (out.has(ch.path)) throw new CurateError(`${ch.path}: written twice in one command`);
    out.set(ch.path, ch.value === null ? null : JSON.parse(serializeFile(ch.path, ch.value)));
  }
  return out;
}

/** The blocks of an owner list, taking changed block files over the loaded ones. */
function rebuild<T extends { id: string }>(dir: string, ids: readonly string[], loaded: readonly T[], staged: ReadonlyMap<string, unknown>): T[] {
  const byId = new Map(loaded.map((b) => [b.id, b]));
  return ids.map((id) => {
    const path = `${dir}/${id}.json`;
    const v = staged.get(path);
    if (v === null) throw new ContentError(path, "listed block file is deleted");
    const block = (v ?? byId.get(id)) as T | undefined;
    if (!block) throw new ContentError(path, "listed block file is missing");
    return block;
  });
}

const EVIDENCE_SUFFIX = ".evidence.json";
/** The gap block id of a gap block's evidence file path. */
const evidenceOf = (path: string): string | undefined =>
  path.endsWith(EVIDENCE_SUFFIX) ? GAP_FILE_RE.exec(`${path.slice(0, -EVIDENCE_SUFFIX.length)}.json`)?.groups?.id : undefined;
const DECK_RE = /^content\/slides\/(?<guide>[a-z]+)\/deck\.json$/;

/** Apply staged values to the content model, as `loadContent` would read them back. */
function overlay(c: Content, staged: ReadonlyMap<string, unknown>): void {
  const get = <T>(path: string, current: T): T => (staged.has(path) ? (staged.get(path) as T) : current);

  for (const g of c.guides) {
    const base = `content/guides/${g.file.id}`;
    g.file = get<GuideFile>(`${base}/guide.json`, g.file);
    g.preamble = rebuild(`${base}/_preamble/blocks`, g.file.preamble, g.preamble, staged);
    if (g.general) g.general = get<GeneralFile>(`${base}/general.json`, g.general);
    for (const s of g.systems) {
      const sb = `${base}/${s.file.id}`;
      s.file = get<SystemFile>(`${sb}/system.json`, s.file);
      s.structure = get<StructureFile>(`${sb}/structure.json`, s.structure);
      s.blocks = rebuild(`${sb}/blocks`, s.file.blocks, s.blocks, staged);
    }
  }
  for (const p of c.pharm) {
    const base = `content/pharm/${p.file.id}`;
    p.file = get<PharmFile>(`${base}/pharmfile.json`, p.file);
    p.blocks = rebuild(`${base}/blocks`, p.file.blocks, p.blocks, staged);
  }
  for (const [id, d] of c.docs) {
    if (d.kind !== "word") continue;
    const base = `content/docs/${id}`;
    d.file = get<WordDocFile>(`${base}/doc.json`, d.file);
    if (!d.file.removed) d.blocks = rebuild(`${base}/blocks`, d.file.blocks, d.blocks, staged);
  }
  c.cards = get("content/pharm/cards.json", c.cards);
  c.reftabs = get("content/places/reftabs.json", c.reftabs);
  c.other = get("content/places/other.json", c.other);
  c.flags = get("content/updates/flags.json", c.flags);
  c.concepts = get("content/updates/concepts.json", c.concepts);

  // Gap blocks before their evidence files, so a new block's evidence finds it.
  for (const [path, v] of staged) {
    const id = GAP_FILE_RE.exec(path)?.groups?.id;
    if (id === undefined) continue;
    if (v === null) c.gaps.delete(id);
    else c.gaps.set(id, { block: v as GapFile, evidence: c.gaps.get(id)?.evidence ?? null });
  }
  for (const [path, v] of staged) {
    const id = evidenceOf(path);
    if (id === undefined) continue;
    const entry = c.gaps.get(id);
    if (!entry) throw new ContentError(path, "evidence without its gap block");
    entry.evidence = v as EvidenceFile | null;
  }
  for (const [path, v] of staged) {
    const guide = DECK_RE.exec(path)?.groups?.guide;
    if (guide === undefined) continue;
    const file = v as DeckFile;
    const loaded = c.decks.get(guide)?.slides ?? [];
    c.decks.set(guide, { file, slides: rebuild<BlockFile<SlideMeta>>(`content/slides/${guide}/blocks`, file.slides, loaded, staged) });
  }
}

/** Order on disk: new and changed files first, then owner lists, then deletions. */
function writeOrder(a: [string, unknown], b: [string, unknown]): number {
  const rank = ([path, v]: [string, unknown]): number => (v === null ? 2 : /\/blocks\//.test(path) ? 0 : 1);
  return rank(a) - rank(b);
}

/**
 * Validate the changes, check the resulting tree with the build's invariants, then write them.
 * Returns the paths written or deleted. Nothing is written when any check fails.
 */
export async function commitChanges(root: string, c: Content, changes: readonly Change[]): Promise<string[]> {
  const staged = normalize(changes);
  overlay(c, staged);
  publish(c);
  const done: string[] = [];
  for (const [path, value] of [...staged].sort(writeOrder)) {
    if (value === null) await removeContent(root, path);
    else await writeContent(root, path, value);
    done.push(path);
  }
  return done;
}
