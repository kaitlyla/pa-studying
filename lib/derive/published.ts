// Shapes of the published data under `dist/data/` (plan 40 §40.8). Written by tools/build, read by the app.
import type { DocJSON, FileKind, Flag, GeneralKey, GuideId, PageSetup } from "../content/types.ts";
import { REF_TABS, type SiteIndex } from "./routes.ts";

// ---- data file paths (relative to dist/data/) ----

export const navPath = (guide: string): string => `g/${guide}/nav.json`;
export const systemPath = (guide: string, system: string): string => `g/${guide}/s/${system}.json`;
export const docPath = (docId: string): string => `docs/${docId}.json`;
export const homePath = (guide: string): string => `g/${guide}/home.json`;
export const generalPath = (guide: string, key: string): string => `g/${guide}/general/${key}.json`;
export const workupPath = (guide: string): string => `g/${guide}/workup.json`;
export const slidesPath = (guide: string): string => `g/${guide}/slides.json`;
export const refPath = (tab: string): string => `ref/${tab}.json`;
/** A reference tab page: `tab`, one of REF_TABS. */
export const REF_PATH_RE = new RegExp(`^ref/(?<tab>${REF_TABS.join("|")})\\.json$`);
export const OTHER_PATH = "other.json";
export const UPDATES_PATH = "updates.json";
export const SITE_PATH = "site.json";
export const HOSTS_PATH = "hosts.json";
// Written by tools/build beside publish's files.
export const BUILD_PATH = "build.json";
export const FONTMAP_PATH = "fonts/fontmap.json";
export const SEARCH_INDEX_PATH = "search/index.json";
export const SEARCH_VOCAB_PATH = "search/vocab.json";
export const unitsPath = (shard: number): string => `search/units-${shard}.json`;
/** A guide's nav.json: `guide`. */
export const NAV_PATH_RE = /^g\/(?<guide>[^/]+)\/nav\.json$/;
/** A system page: `guide`, `system`. */
export const SYSTEM_PATH_RE = /^g\/(?<guide>[^/]+)\/s\/(?<system>[^/]+)\.json$/;
/** A document page: `id`. */
export const DOC_PATH_RE = /^docs\/(?<id>[^/]+)\.json$/;

/** A block as published: the stored envelope's id, kind and doc. */
export interface PubBlock {
  id: string;
  kind: "prose" | "table" | "gap" | "slide";
  doc: DocJSON;
}

/** An Updated guideline note placed at a target (40 §40.7, 80 §80.4). */
export interface FlagNote {
  id: string;
  guideline: string;
  org: string;
  published: string;
  quote: string | null;
  grade: string | null;
  url: string;
  flagged: string;
}

/** target id (row, block, gap or document) → its placed notes. Present only for targets with notes. */
export type Notes = Record<string, FlagNote[]>;

/** A route and its location label (`hosts.json`, resolved links). */
export interface Place {
  route: string;
  loc: string;
}

/** A visible document in a list. */
export interface DocRef {
  id: string;
  name: string;
  kind: FileKind;
  /** `#/file/<d_id>` */
  route: string;
}

export interface RemovedDoc {
  id: string;
  name: string;
  at: string;
}

export interface PendingDoc {
  id: string;
  name: string;
  state: "processing" | "failed";
}

/** A place that lists documents (40 §40.8): visible files, plus owner-only removed and pending lists. */
export interface DocList {
  files: DocRef[];
  removed: RemovedDoc[];
  pending: PendingDoc[];
}

/** A resolved `links[]` entry. */
export interface PubLink extends Place {
  target: string;
  /** The target's name, as search titles it: topic title, listed block title, drug name, gap title or document name. */
  title: string;
  covers: string;
  /** The target has a placed flag (brown badge). */
  flagged: boolean;
}

/** A resolved gap block (40 §40.7). */
export interface PubGap {
  id: string;
  title: string;
  relevantTo: string;
  written: string;
  doc: DocJSON;
  differs: DocJSON | null;
  sources: { name: string; org: string; year: string; url: string | null }[];
  ownerEdits: string[];
  /** Notes placed at this gap id (shown at the top of the gap block). */
  notes: FlagNote[];
}

// ---- build.json -------------------------------------------------------------------------------

export interface BuildJson {
  commit: string;
  builtAt: string;
  /** Total bytes of dist/ after `vite build`; 0 until the post-build step writes it. */
  siteBytes: number;
  dropped: { file: string; id: string }[];
  /** "U+XXXX" code points no vendored font covers (70 §70.4). */
  uncoveredGlyphs: string[];
}

// ---- site.json --------------------------------------------------------------------------------

export interface PubSystemSummary {
  id: string;
  title: string;
  pct: string;
}

export interface SiteJson {
  name: string;
  /** `owner/name` of the repository (Releases link, editing). */
  repo: string;
  /** As in `content/site.json`. */
  owner: { login: string; id: number; commitName: string; commitEmail: string };
  tabs: string[];
  /** EOR picker cards, in picker order. */
  eors: { id: GuideId; name: string; systems: PubSystemSummary[]; general: number }[];
  pance: { id: GuideId; name: string; systems: PubSystemSummary[] };
  guideNames: Record<string, string>;
  /** Names for location labels (lib/derive/routes.ts `fileLocation`). */
  index: SiteIndex;
}

// ---- g/<g>/nav.json ---------------------------------------------------------------------------

export interface NavEntry {
  kind: "topic" | "block";
  /** Topic: its first row id (route `…/t/<id>`); block: the listed block id (route `…/b/<id>`). */
  id: string;
  title: string;
}

export interface NavSystem {
  id: string;
  title: string;
  pct: string;
  /** Empty when the system has no sections; then `entries` holds the flat list. */
  sections: { id: string; title: string; entries: NavEntry[] }[];
  entries: NavEntry[];
  /** Present when the system has a Pharm section (40 §40.5). */
  pharm: { sections: { id: string; title: string }[] } | null;
}

export interface NavJson {
  guide: GuideId;
  title: string;
  /** The guide's source document name, page setup and base size (20 §20.4), for PDFs and rendering. */
  source: string;
  page: PageSetup;
  basePt: number;
  systems: NavSystem[];
  /** EOR guides: present general topics in the fixed order. PANCE: []. */
  general: { key: GeneralKey; label: string }[];
  /** The deck's title (last sidebar item), or null when the guide shows no deck. */
  slides: { title: string } | null;
  /** PANCE: the document shown as the last sidebar item. */
  sidebarEnd: DocRef | null;
  /** PANCE sidebar (`sidebarEnd`) and Psychiatry sidebar (own deck document): owner-only lists. */
  removed: RemovedDoc[];
  pending: PendingDoc[];
}

// ---- g/<g>/home.json --------------------------------------------------------------------------

export interface HomeJson {
  guide: GuideId;
  title: string;
  preamble: PubBlock[];
  systems: PubSystemSummary[];
  notes: Notes;
}

// ---- g/<g>/s/<system>.json --------------------------------------------------------------------

export interface PubRow {
  block: string;
  kind: "heading" | "content";
  /** Nearest heading row above in the same table. */
  heading: string | null;
  /** Topic (first row id) this row belongs to. */
  topic: string | null;
}

export interface PubMedsCard {
  card: string | null;
  title: string;
  /** Row ids, each run preceded once by its heading row id. */
  rows: string[];
  /** Pharm section holding the card's first row; the "Open in <System> pharm" link goes there. */
  section: string;
  /** Scroll target: the card id, or the row id for a card-less row. */
  target: string;
}

export interface PubTopic {
  id: string;
  title: string;
  section: string | null;
  condition: boolean;
  /** The topic's rows, each run preceded once by its heading row id. */
  rows: string[];
  /** Meds panel cards (empty when there are none). */
  meds: PubMedsCard[];
}

export interface PubSectionItem {
  block: string;
  /** For a table: the member rows with heading rows inserted; null for a whole prose/one-column block. */
  rows: string[] | null;
}

export interface PubPharmSection {
  id: string;
  title: string;
  /** Drug table block ids, in full. */
  tables: string[];
  /** Class cards in page order (table cards, then "Also in your pharm notes"). */
  cards: string[];
  /** Index in `cards` where the "Also in your pharm notes" cards begin. */
  alsoFrom: number;
  overview: string | null;
  lo: string | null;
  /** Condition topics whose meds panel draws from this section's tables, in guide order. */
  treats: string[];
}

export interface PubCard {
  title: string;
  /** Pharm file name (label shown on the card). */
  file: string;
  /** The pharm file's base size; its blocks' `size` marks are relative to it. */
  basePt: number;
  /** Notes blocks (keys of `notesBlocks`), in file order. */
  blocks: string[];
  /** The card's pharm-notes parts in order, each with its blocks; a search unit's `at` names a part id. */
  parts: { id: string; blocks: string[] }[];
}

export interface PubPart {
  title: string;
  role: "overview" | "lo";
  file: string;
  basePt: number;
  blocks: string[];
}

export interface SystemJson {
  guide: GuideId;
  id: string;
  title: string;
  pct: string;
  /** Every block of the system, in order. */
  blocks: PubBlock[];
  rows: Record<string, PubRow>;
  /** Heading rows: label (first cell) and column headings (other cells). */
  headings: Record<string, { label: string; columns: string[] }>;
  /** Topics in guide order. */
  topics: PubTopic[];
  /** drug table block id → its stub on the system page. */
  stubs: Record<string, { label: string; section: string }>;
  /** Section pages; [] when the system has no sections. */
  sections: { id: string; title: string; items: PubSectionItem[] }[];
  /** The system's Pharm section, or null when it has none. */
  pharm: { sections: PubPharmSection[]; files: DocList } | null;
  /** Class cards used on this system's pages (pharm sections and meds panels). */
  cards: Record<string, PubCard>;
  /** Overview / learning-objectives parts used by the pharm sections. */
  parts: Record<string, PubPart>;
  /** Pharm-notes blocks referenced by `cards` and `parts`. */
  notesBlocks: Record<string, PubBlock>;
  notes: Notes;
}

// ---- general, workup, slides, ref, other, docs -------------------------------------------------

export interface GeneralJson {
  guide: GuideId;
  key: GeneralKey;
  label: string;
  howto: string | null;
  links: PubLink[];
  files: DocList;
  gaps: PubGap[];
}

export interface WorkupJson {
  guide: GuideId;
  items: { id: string; title: string; conds: string; gap: PubGap }[];
}

export interface SlidesJson {
  guide: GuideId;
  kind: "own" | "generated";
  /** Generated: deck.json title; own: the document's name. */
  title: string;
  /** Own deck: its document id (Download original, Rename, Replace, Remove, Versions). */
  file: string | null;
  /** `summarizes`: the existing summarized rows, each with its topic's title and route. */
  slides: { id: string; doc: DocJSON; summarizes: { id: string; title: string; route: string }[]; ownerEdits: string[] }[];
}

export interface RefTabJson {
  tab: string;
  label: string;
  subs: { id: string; title: string; links: PubLink[]; gaps: PubGap[] }[];
  files: DocList;
}

export interface OtherJson {
  sections: {
    id: string;
    title: string;
    lead: PubGap | null;
    links: PubLink[];
    files: DocList;
    /** Present only on sections whose stored record has `gaps` (Legal, Screenings). */
    gaps?: PubGap[];
  }[];
}

/** `docs/<d>.json`: a visible document. Word pages carry their blocks; other kinds their stored files. */
export interface DocJson {
  id: string;
  name: string;
  kind: FileKind;
  /** Word: */
  basePt?: number;
  page?: PageSetup;
  blocks?: PubBlock[];
  /** As-is files: paths relative to `dist/data/` (`files/<d>/<name>`). */
  original?: string;
  view?: string | null;
  pages?: number | null;
  /** Notes placed at this document id or its blocks. */
  notes: Notes;
}

// ---- updates.json, hosts.json ---------------------------------------------------------------------

export type PubFlag = Omit<Flag, "verification" | "locator" | "by"> & {
  /** Locations of the targets where the flag is placed (none for list-only flags). */
  addedTo: Place[];
};

export interface UpdatesJson {
  lastRun: string | null;
  nextRun: string | null;
  sources: { id: string; lastSuccess: string | null; lastAttempt: string; status: "ok" | "fail" }[];
  /** Cited series (80 §80.3.3), in label order: id `cite:<series>`, name and org. */
  series: { id: string; label: string; org: string }[];
  /** Every flag, newest first by `published`, ties by `flagged` descending. */
  flags: PubFlag[];
}

/** id → the route that shows it and its location label. */
export type HostsJson = Record<string, Place>;

// ---- fonts/fontmap.json ----------------------------------------------------------------------------

export interface FontMapJson {
  /**
   * Fonts in 70 §70.4 order: Carlito, Noto Sans Math, Noto Sans Symbols, Noto Sans Symbols 2,
   * DejaVu Sans. `file` is the Regular face under `/fonts/` (Carlito's other faces are
   * `Carlito-Bold.ttf`, `Carlito-Italic.ttf`, `Carlito-BoldItalic.ttf`).
   */
  fonts: { family: string; file: string }[];
  /**
   * Decimal code point → index into `fonts`, for every code point of the content's text and
   * paragraph markers except U+FE00–U+FE0F and control characters. Uncovered code points map to DejaVu Sans.
   */
  map: Record<string, number>;
}
