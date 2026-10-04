// The source inventory (30 §30.2): `tools/import/sources.json` and `tools/import/guides.json`.
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { GUIDE_IDS, OTHER_SECTION_IDS } from "../../lib/content/index.ts";
import type { GuideId } from "../../lib/content/index.ts";
import { REF_TABS } from "../../lib/derive/routes.ts";
import type { RefTabId } from "../../lib/derive/routes.ts";

export const SOURCE_KINDS = ["guide", "word", "pharm", "pdf", "image", "slides", "deck", "vocab", "duplicate"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** Pharm-file categories (30 §30.2 pharm-file placement). */
export const CATEGORIES = ["CV", "PULM", "EENT", "GI", "ID", "PSY", "ENDO"] as const;
export type Category = (typeof CATEGORIES)[number];

export type OtherSectionId = (typeof OTHER_SECTION_IDS)[number];

export type Placement =
  | { guide: GuideId }
  | { reftabs: RefTabId }
  | { other: OtherSectionId }
  | { pharm: Category[] }
  | { sidebarEnd: "pance" }
  | { deck: GuideId }
  | { duplicateOf: string }
  | null;

export interface Source {
  /** Project-root-relative path with `/` separators. */
  path: string;
  kind: SourceKind;
  /** Display name (the signed mockup's name). */
  name: string;
  placement: Placement;
}

export interface GuideSystemConfig {
  title: string;
  pct: string;
  /**
   * The pharm-file category the system belongs to (30 §30.2 system → category map), or null for a
   * system no pharm file covers. Explicit per system, so a renamed title cannot silently drop a
   * system's pharm files.
   */
  category: Category | null;
  /** Leading text of her heading when it does not start with `title` (30 §30.8). */
  match?: string;
}

export type GuidesConfig = Record<GuideId, { systems: GuideSystemConfig[] }>;

export const SOURCES_FILE = "tools/import/sources.json";
export const GUIDES_FILE = "tools/import/guides.json";

function fail(file: string, message: string): never {
  throw new Error(`${file}: ${message}`);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const has = <T extends string>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v);

/** The placement shapes each kind accepts. */
const PLACEMENT_KEYS: Record<SourceKind, readonly string[]> = {
  guide: ["guide"],
  word: ["reftabs", "other", "pharm"],
  pdf: ["reftabs", "other", "pharm", "sidebarEnd"],
  image: ["reftabs", "other", "pharm"],
  slides: ["reftabs", "other", "pharm"],
  deck: ["deck"],
  pharm: [],
  vocab: [],
  duplicate: ["duplicateOf"],
};

function checkPlacement(file: string, at: string, kind: SourceKind, p: unknown): Placement {
  const allowed = PLACEMENT_KEYS[kind];
  if (allowed.length === 0) {
    if (p !== null) fail(file, `${at}.placement: expected null for kind ${kind}`);
    return null;
  }
  if (!isObj(p) || Object.keys(p).length !== 1) fail(file, `${at}.placement: expected an object with one of ${allowed.join(", ")}`);
  const [key, value] = Object.entries(p)[0] as [string, unknown];
  if (!allowed.includes(key)) fail(file, `${at}.placement: ${key} is not a placement for kind ${kind}`);
  const ok =
    (key === "guide" || key === "deck") ? has(GUIDE_IDS, value)
      : key === "reftabs" ? has(REF_TABS, value)
        : key === "other" ? has(OTHER_SECTION_IDS, value)
          : key === "pharm" ? Array.isArray(value) && value.length > 0 && value.every((c) => has(CATEGORIES, c)) && new Set(value).size === value.length
            : key === "sidebarEnd" ? value === "pance"
              : isStr(value);
  if (!ok) fail(file, `${at}.placement.${key}: invalid value ${JSON.stringify(value)}`);
  return p as Placement;
}

/** Validate the parsed `sources.json`. */
export function parseSources(json: unknown, file = SOURCES_FILE): Source[] {
  if (!isObj(json) || json.v !== 1 || !Array.isArray(json.sources)) fail(file, "expected { v: 1, sources: [...] }");
  const out: Source[] = json.sources.map((row: unknown, i: number) => {
    const at = `sources[${i}]`;
    if (!isObj(row)) fail(file, `${at}: expected an object`);
    const keys = Object.keys(row).sort().join();
    if (keys !== "kind,name,path,placement") fail(file, `${at}: expected exactly path, kind, name, placement`);
    if (!isStr(row.path) || row.path.includes("\\") || row.path.startsWith("/")) fail(file, `${at}.path: expected a relative path with / separators`);
    if (!has(SOURCE_KINDS, row.kind)) fail(file, `${at}.kind: unknown kind ${JSON.stringify(row.kind)}`);
    if (!isStr(row.name)) fail(file, `${at}.name: expected a non-empty string`);
    return { path: row.path, kind: row.kind, name: row.name, placement: checkPlacement(file, at, row.kind, row.placement) };
  });
  const paths = new Set<string>();
  for (const s of out) {
    if (paths.has(s.path)) fail(file, `duplicate path ${s.path}`);
    paths.add(s.path);
  }
  const guides = out.filter((s) => s.kind === "guide").map((s) => (s.placement as { guide: GuideId }).guide);
  if (guides.length !== GUIDE_IDS.length || GUIDE_IDS.some((g) => !guides.includes(g))) {
    fail(file, `expected one guide row for each of ${GUIDE_IDS.join(", ")}`);
  }
  for (const s of out) {
    if (s.kind !== "duplicate") continue;
    const of = (s.placement as { duplicateOf: string }).duplicateOf;
    if (!out.some((o) => o.path === of && o.kind === "word")) fail(file, `${s.path}: duplicateOf must name a word row, got ${of}`);
  }
  if (out.filter((s) => s.kind === "vocab").length > 1) fail(file, "at most one vocab row");
  if (out.filter((s) => s.kind === "pdf" && s.placement !== null && "sidebarEnd" in s.placement).length > 1) fail(file, "at most one sidebarEnd row");
  return out;
}

/** Validate the parsed `guides.json`. */
export function parseGuides(json: unknown, file = GUIDES_FILE): GuidesConfig {
  if (!isObj(json) || json.v !== 1 || !isObj(json.guides)) fail(file, "expected { v: 1, guides: {...} }");
  const guides = json.guides;
  for (const k of Object.keys(guides)) if (!has(GUIDE_IDS, k)) fail(file, `unknown guide ${k}`);
  for (const g of GUIDE_IDS) {
    const entry = guides[g];
    if (!isObj(entry) || !Array.isArray(entry.systems) || entry.systems.length === 0) fail(file, `${g}: expected { systems: [...] } with at least one system`);
    entry.systems.forEach((s: unknown, i: number) => {
      const at = `${g}.systems[${i}]`;
      if (!isObj(s) || !isStr(s.title) || typeof s.pct !== "string" || !Object.hasOwn(s, "category")) fail(file, `${at}: expected { title, pct, category, match? }`);
      for (const k of Object.keys(s)) if (!["title", "pct", "category", "match"].includes(k)) fail(file, `${at}.${k}: no such key`);
      if (s.category !== null && !has(CATEGORIES, s.category)) fail(file, `${at}.category: expected one of ${CATEGORIES.join(", ")} or null, got ${JSON.stringify(s.category)}`);
      if (s.match !== undefined && !isStr(s.match)) fail(file, `${at}.match: expected a non-empty string`);
    });
  }
  return guides as GuidesConfig;
}

async function readJson(root: string, path: string): Promise<unknown> {
  return JSON.parse(await readFile(join(root, ...path.split("/")), "utf8"));
}

export async function loadSources(root: string): Promise<Source[]> {
  return parseSources(await readJson(root, SOURCES_FILE));
}

export async function loadGuides(root: string): Promise<GuidesConfig> {
  return parseGuides(await readJson(root, GUIDES_FILE));
}

/** The import fails if any listed path is missing (30 §30.2); every missing path is named. */
export async function checkSourcesExist(root: string, sources: readonly Source[]): Promise<void> {
  const missing: string[] = [];
  for (const s of sources) {
    try {
      await access(join(root, ...s.path.split("/")));
    } catch {
      missing.push(s.path);
    }
  }
  if (missing.length > 0) throw new Error(`Source files missing:\n  ${missing.join("\n  ")}`);
}

/** The file name of a source path (`a/b/c.docx` → `c.docx`). */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The file name without its last extension. */
export function stem(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
