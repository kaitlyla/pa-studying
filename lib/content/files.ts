// Reading and writing content files by repository path (plan 20 §20.2). Browser-safe: callers
// supply file text (from disk, or Git blobs in the app) and receive validated records.
import { ContentError } from "./check.ts";
import { idSource, SLUG_SOURCE } from "./ids.ts";
import type { IdPrefix } from "./ids.ts";
import { GUIDE_IDS } from "./types.ts";
import {
  normalizeDoc, validateAsIsFile, validateBlock, validateCards, validateChecks, validateConcepts, validateDeck,
  validateEvidence, validateFileText, validateFlags, validateGap, validateGeneral, validateGuide, validateOther,
  validatePharmFile, validateRefTabs, validateSite, validateSlide, validateStructure, validateSystem, validateTrims,
  validateUpload, validateVocab, validateWordDoc,
} from "./validate.ts";
import type { Validator } from "./validate.ts";

/** Canonical bytes of a content JSON file: 1-space indent, LF, trailing newline (no BOM). */
export function serializeJSON(value: unknown): string {
  return `${JSON.stringify(value, null, 1)}\n`;
}

const BOM = 0xfeff;

// Path pattern pieces. A group named `id` captures the identity the path fixes for the record.
const GUIDE = `(?:${GUIDE_IDS.join("|")})`;
const SLUG = SLUG_SOURCE;
const named = (pattern: string): string => `(?<id>${pattern})`;
const ident = (p: IdPrefix): string => named(idSource(p));
const pathRe = (source: string): RegExp => new RegExp(`^${source}$`);

/** A gap block's file: `content/gapfill/<g_id>.json` (not its evidence file). */
export const GAP_FILE_RE = pathRe(`content/gapfill/${ident("g")}\\.json`);
export const gapFilePath = (gapId: string): string => `content/gapfill/${gapId}.json`;

/** An inbox item's directory (50 §50.7): `inbox/<d_id>`, holding UPLOAD_NAME and the parts. */
export const inboxItemDir = (docId: string): string => `inbox/${docId}`;
/** The item's upload record, inside its directory. */
export const UPLOAD_NAME = "upload.json";
export const inboxUploadPath = (docId: string): string => `${inboxItemDir(docId)}/${UPLOAD_NAME}`;
/** The `i`th (0-based) part of the uploaded bytes, inside the item directory: `part-000`, `part-001`, … */
export const partName = (i: number): string => `part-${String(i).padStart(3, "0")}`;

/** A Word page's record: `content/docs/<d_id>/doc.json`. */
export const WORD_DOC_RE = pathRe(`content/docs/${ident("d")}/doc\\.json`);
/** An as-is document's record: `content/files/<d_id>/file.json`. */
export const AS_IS_FILE_RE = pathRe(`content/files/${ident("d")}/file\\.json`);
/** Where block files live (`<dir>/blocks/<id>.json`), the id prefix each takes, and its validator. */
const BLOCK_LOCATIONS: readonly { dir: string; prefix: IdPrefix; validator: Validator }[] = [
  { dir: `content/guides/${GUIDE}/_preamble`, prefix: "b", validator: validateBlock },
  { dir: `content/guides/${GUIDE}/${SLUG}`, prefix: "b", validator: validateBlock },
  { dir: `content/pharm/${SLUG}`, prefix: "b", validator: validateBlock },
  { dir: `content/docs/${idSource("d")}`, prefix: "b", validator: validateBlock },
  { dir: `content/slides/${GUIDE}`, prefix: "s", validator: validateSlide },
];
/**
 * Any block file, its id in `id`: a guide preamble's, a system's, a pharm file's or a Word page's
 * (`b_`), or a deck slide (`s_`).
 */
export const BLOCK_FILE_RE = pathRe(
  `(?:${BLOCK_LOCATIONS.map((l) => `${l.dir}/blocks/(?=${l.prefix}_)`).join("|")})${named(idSource(...new Set(BLOCK_LOCATIONS.map((l) => l.prefix))))}\\.json`,
);

/**
 * A topic's "below" block: her own notes and pictures shown after the topic (after its table and meds
 * panel), `content/guides/<g>/<system>/below/<topic id>.json`, the topic in `topic`. A prose block.
 */
export const TOPIC_BELOW_RE = pathRe(`content/guides/${GUIDE}/${SLUG}/below/(?<topic>${idSource("r")})\\.json`);
export const topicBelowDir = (guide: string, system: string): string => `content/guides/${guide}/${system}/below`;
export const topicBelowPath = (guide: string, system: string, topic: string): string => `${topicBelowDir(guide, system)}/${topic}.json`;

/** Every JSON file of the content tree, by path pattern, with its validator. */
const ROUTES: readonly [RegExp, Validator][] = [
  [pathRe("content/site\\.json"), validateSite],
  [pathRe("content/vocab/abbreviations\\.json"), validateVocab],
  [pathRe(`content/guides/${named(GUIDE)}/guide\\.json`), validateGuide],
  [pathRe(`content/guides/${named(GUIDE)}/general\\.json`), validateGeneral],
  [pathRe(`content/guides/${GUIDE}/${named(SLUG)}/system\\.json`), validateSystem],
  [pathRe(`content/guides/${GUIDE}/${SLUG}/structure\\.json`), validateStructure],
  [pathRe("content/pharm/cards\\.json"), validateCards],
  [pathRe("content/pharm/trims\\.json"), validateTrims],
  [pathRe(`content/pharm/${named(SLUG)}/pharmfile\\.json`), validatePharmFile],
  [WORD_DOC_RE, validateWordDoc],
  [AS_IS_FILE_RE, validateAsIsFile],
  [pathRe(`content/files/${idSource("d")}/text\\.json`), validateFileText],
  [GAP_FILE_RE, validateGap],
  [pathRe(`content/gapfill/${ident("g")}\\.evidence\\.json`), validateEvidence],
  [pathRe(`content/slides/${named(GUIDE)}/deck\\.json`), validateDeck],
  [pathRe("content/places/reftabs\\.json"), validateRefTabs],
  [pathRe("content/places/other\\.json"), validateOther],
  [pathRe("content/updates/flags\\.json"), validateFlags],
  [pathRe("content/updates/concepts\\.json"), validateConcepts],
  [pathRe("content/updates/checks\\.json"), validateChecks],
  [pathRe(`${inboxItemDir(ident("d"))}/${UPLOAD_NAME.replace(".", "\\.")}`), validateUpload],
  [TOPIC_BELOW_RE, validateBlock],
  ...BLOCK_LOCATIONS.map((l): [RegExp, Validator] => [pathRe(`${l.dir}/blocks/${ident(l.prefix)}\\.json`), l.validator]),
];

function route(file: string): (v: unknown) => void {
  for (const [pattern, validator] of ROUTES) {
    const m = pattern.exec(file);
    if (m) return (v) => validator(v, { file }, m.groups?.id);
  }
  throw new ContentError(file, "not a content JSON file");
}

/** Whether `path` (repository-relative, `/`-separated) is a JSON file of the content contract. */
export function isContentJSON(path: string): boolean {
  return ROUTES.some(([p]) => p.test(path));
}

/** Validate a record for `path` without serializing it. */
export function validateFile(path: string, value: unknown): void {
  route(path)(value);
}

/**
 * Parse a content file. The text must be exactly the canonical serialization of a record that is
 * valid for its path; anything else (a BOM, CRLF, other indentation, an invalid block) is an error.
 */
export function parseFile<T = unknown>(path: string, text: string): T {
  if (text.charCodeAt(0) === BOM) throw new ContentError(path, "not in canonical form (starts with a byte-order mark)");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new ContentError(path, `not JSON: ${(e as Error).message}`);
  }
  if (serializeJSON(value) !== text) {
    throw new ContentError(path, "not in canonical form (UTF-8 without BOM, 1-space indent, LF, trailing newline)");
  }
  route(path)(value);
  return value as T;
}

/**
 * Serialize a record for `path` after validating it. Rich text is normalized through the schema
 * first (attribute defaults made explicit, schema key order), so the stored doc round-trips unchanged.
 */
export function serializeFile(path: string, value: unknown): string {
  const normalized = normalizeDocs(path, value);
  route(path)(normalized);
  return serializeJSON(normalized);
}

function normalizeDocs(path: string, value: unknown): unknown {
  if (typeof value !== "object" || value === null || !Object.hasOwn(value, "doc")) return value;
  const rec = value as Record<string, unknown>;
  const out: Record<string, unknown> = { ...rec, doc: normalizeDoc(rec.doc, ".doc", path) };
  const meta = rec.meta as Record<string, unknown> | undefined;
  const differs = meta?.differs as { doc?: unknown } | null | undefined;
  if (differs && typeof differs === "object" && Object.hasOwn(differs, "doc")) {
    out.meta = { ...meta, differs: { ...differs, doc: normalizeDoc(differs.doc, ".meta.differs.doc", path) } };
  }
  return out;
}
