// Reading and writing content files by repository path (plan 20 §20.2). Browser-safe: callers
// supply file text (from disk, or Git blobs in the app) and receive validated records.
import { ContentError } from "./check.ts";
import { idSource, SLUG_SOURCE } from "./ids.ts";
import type { IdPrefix } from "./ids.ts";
import { GUIDE_IDS } from "./types.ts";
import {
  normalizeDoc, validateAsIsFile, validateBlock, validateCards, validateChecks, validateConcepts, validateDeck,
  validateEvidence, validateFileText, validateFlags, validateGap, validateGeneral, validateGuide, validateOther,
  validatePharmFile, validateRefTabs, validateSite, validateSlide, validateStructure, validateSystem, validateUpload,
  validateVocab, validateWordDoc,
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

/** Every JSON file of the content tree, by path pattern, with its validator. */
const ROUTES: readonly [RegExp, Validator][] = [
  [pathRe("content/site\\.json"), validateSite],
  [pathRe("content/vocab/abbreviations\\.json"), validateVocab],
  [pathRe(`content/guides/${named(GUIDE)}/guide\\.json`), validateGuide],
  [pathRe(`content/guides/${named(GUIDE)}/general\\.json`), validateGeneral],
  [pathRe(`content/guides/${GUIDE}/_preamble/blocks/${ident("b")}\\.json`), validateBlock],
  [pathRe(`content/guides/${GUIDE}/${named(SLUG)}/system\\.json`), validateSystem],
  [pathRe(`content/guides/${GUIDE}/${SLUG}/structure\\.json`), validateStructure],
  [pathRe(`content/guides/${GUIDE}/${SLUG}/blocks/${ident("b")}\\.json`), validateBlock],
  [pathRe("content/pharm/cards\\.json"), validateCards],
  [pathRe(`content/pharm/${named(SLUG)}/pharmfile\\.json`), validatePharmFile],
  [pathRe(`content/pharm/${SLUG}/blocks/${ident("b")}\\.json`), validateBlock],
  [pathRe(`content/docs/${ident("d")}/doc\\.json`), validateWordDoc],
  [pathRe(`content/docs/${idSource("d")}/blocks/${ident("b")}\\.json`), validateBlock],
  [pathRe(`content/files/${ident("d")}/file\\.json`), validateAsIsFile],
  [pathRe(`content/files/${idSource("d")}/text\\.json`), validateFileText],
  [GAP_FILE_RE, validateGap],
  [pathRe(`content/gapfill/${ident("g")}\\.evidence\\.json`), validateEvidence],
  [pathRe(`content/slides/${named(GUIDE)}/deck\\.json`), validateDeck],
  [pathRe(`content/slides/${GUIDE}/blocks/${ident("s")}\\.json`), validateSlide],
  [pathRe("content/places/reftabs\\.json"), validateRefTabs],
  [pathRe("content/places/other\\.json"), validateOther],
  [pathRe("content/updates/flags\\.json"), validateFlags],
  [pathRe("content/updates/concepts\\.json"), validateConcepts],
  [pathRe("content/updates/checks\\.json"), validateChecks],
  [pathRe(`inbox/${ident("d")}/upload\\.json`), validateUpload],
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
