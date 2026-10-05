// Stored content records (plan 20). Field names and shapes are the repository data contract.

export const GUIDE_IDS = ["em", "fm", "im", "ob", "peds", "psy", "surg", "pance"] as const;
export type GuideId = (typeof GUIDE_IDS)[number];

/** ProseMirror doc JSON (validated against lib/schema.ts). */
export interface DocJSON {
  type: "doc";
  content: unknown[];
}

export interface PageSetup {
  widthPt: number;
  heightPt: number;
  margins: { top: number; right: number; bottom: number; left: number };
}

// 20.3
export interface SiteFile {
  v: 1;
  name: string;
  owner: { login: string; id: number; commitName: string; commitEmail: string };
  repo: string;
  tabs: string[];
  eors: GuideId[];
  guideNames: Record<GuideId, string>;
}

// 20.4
export interface GuideFile {
  v: 1;
  id: GuideId;
  source: string;
  page: PageSetup;
  basePt: number;
  preamble: string[];
  systems: { id: string; title: string; pct: string }[];
  /** PANCE only: the document shown as the guide's last sidebar item (20 §20.8). */
  sidebarEnd?: string;
}

export interface SystemFile {
  v: 1;
  id: string;
  blocks: string[];
}

export type BlockKind = "prose" | "table" | "gap" | "slide";

/** The block envelope shared by every block kind (20 §20.4). */
export interface BlockFile<M = Record<string, unknown>> {
  v: 1;
  id: string;
  kind: BlockKind;
  doc: DocJSON;
  meta: M;
}

// 20.5
export interface Removed {
  at: string;
  from: string;
}

/** A replacement in progress on the current, still-shown document (20 §20.5). */
export interface Replacing {
  fileName: string;
  at: string;
}

/**
 * The last replacement couldn't be processed; the document shown is the one it would have replaced.
 * `at` is when she chose the new file. Cleared by a successful replace or by her dismissing the note
 * (Orchestrator ruling 2026-10-04 20:39Z, amending 50 §50.9 step 4).
 */
export interface ReplaceFailed {
  fileName: string;
  at: string;
}

export interface WordDocFile {
  v: 1;
  id: string;
  name: string;
  kind: "word";
  source: string;
  page: PageSetup;
  basePt: number;
  blocks: string[];
  removed: Removed | null;
  replacing?: Replacing;
  replaceFailed?: ReplaceFailed;
}

export type FileKind = "word" | "pdf" | "image" | "slides";

export interface AsIsFile {
  v: 1;
  id: string;
  name: string;
  kind: FileKind;
  original: string;
  view: string | null;
  pages?: number | null;
  text?: string | null;
  removed: Removed | null;
  state?: "processing" | "ready" | "failed";
  replacing?: Replacing;
  replaceFailed?: ReplaceFailed;
}

export interface FileText {
  pages: string[];
}

/** File types that can be added (50 §50.7), as stored in `upload.json` `ext`. */
export const UPLOAD_EXTS = ["doc", "docx", "pdf", "png", "jpg", "jpeg", "ppt", "pptx"] as const;
export type UploadExt = (typeof UPLOAD_EXTS)[number];
/** The kind of document each added file type becomes (50 §50.9 Processing job, step 2). */
export const UPLOAD_KIND: Readonly<Record<UploadExt, FileKind>> = {
  doc: "word", docx: "word", pdf: "pdf", png: "image", jpg: "image", jpeg: "image", ppt: "slides", pptx: "slides",
};

export interface UploadFile {
  v: 1;
  id: string;
  fileName: string;
  ext: UploadExt;
  size: number;
  sha256: string;
  parts: number;
  replaces: null | true;
}

// 20.6
export interface PharmPart {
  id: string;
  role: "overview" | "lo" | "card";
  title: string;
  card: string | null;
  blocks: string[];
}

export interface PharmFile {
  v: 1;
  id: string;
  fileName: string;
  basePt: number;
  blocks: string[];
  parts: PharmPart[];
}

// 20.7
export interface StructureFile {
  v: 1;
  sections: { id: string; title: string }[];
  /**
   * Row or block id → a section id (the section it is shown under), or, for a row, the id of the
   * topic row it is recorded under (Orchestrator ruling 2026-10-04 04:44Z). Decode with
   * `memberTarget` (ids.ts).
   */
  members: Record<string, string>;
  listed: Record<string, string>;
  /**
   * Content row id → the index of the cell of the heading row directly above it whose text titles
   * the topic the row starts (0 = the label). Opt-in per row; that cell must be non-empty
   * (Orchestrator rulings 2026-10-04 21:02Z and 22:01Z, amending 40 §40.2). deriveTopics checks
   * the rows; fitTitled drops entries an edit has broken.
   */
  titled?: Record<string, number>;
  drugTables: { block: string; pharmSection: string; conditionRows: string[] }[];
  pharmSections: {
    id: string;
    title: string;
    tables: string[];
    overview: string | null;
    lo: string | null;
    also: string[];
  }[];
  pharmFiles: string[];
}

export interface CardsFile {
  v: 1;
  /**
   * `in`: the class card this card's notes show inside (display only), where another of her files
   * covers the same class; such a card is never shown as a card of its own.
   * `for`: the pharm sections (ids, as in every guide's structure) her file wrote this card's notes
   * for, where it files them under one use ("Antiarrhythmics:", "BPH"); its notes show only there and
   * in meds panels of conditions mapped to them (`UsesFile.conditions`). Display only. A card without
   * it is written for any use.
   * `classWords`: her words for the wider drug class the card belongs to ("diuretics", "inotropes"),
   * shared by every card of that class. They match only a condition's treatment text, naming all those
   * cards at once; unlike `aliases` they never match her drug-table rows, where "K-Sparing Diuretics"
   * names one card, not every diuretic.
   */
  cards: {
    id: string; file: string; aliases: string[]; home: Partial<Record<GuideId, string>>; in?: string; for?: string[]; classWords?: string[];
  }[];
}

/**
 * Pharm-notes lines written for one use inside notes that are otherwise about the whole class,
 * judged line by line ("Clin Use: Stable angina - Variant angina" in her angina notes on CCBs).
 * Display only: her notes are never edited. A line shows only on the pharm sections in `for` and in
 * meds panels of conditions mapped to them, and only while it still reads exactly as judged.
 */
export interface UsesFile {
  v: 1;
  /** `block`: the notes block; `text`: the line's collapsed text; `for`: pharm section ids. */
  lines: { block: string; text: string; for: string[] }[];
  /**
   * Which of a system's pharm sections are relevant to each of its condition sections (`section`
   * null: a system without sections): the pharm sections whose drugs treat its conditions. A
   * condition's meds panel shows only rows from tables in those sections, and only their notes.
   * Every condition section of every system with drug tables has exactly one entry; `for` may be empty.
   */
  conditions: { guide: GuideId; system: string; section: string | null; for: string[] }[];
}

/**
 * Pharm-notes lines her guide table already states, judged line by line. Display only: her notes
 * are never edited. A judgment applies only while the line and its covering row still read exactly
 * as they did when judged, so an edit to either shows the line again.
 */
export interface TrimsFile {
  v: 1;
  /** Guide-table row id → the row's text (`trimRowText`) when lines were judged against it. */
  rows: Record<string, string>;
  /**
   * `block`: the notes block; `text`: the line's collapsed text. A covered line names the rows that
   * each fully state it (`label: false`, `rows` non-empty). A label line (a class, drug or category
   * name) names none, and hides only when every line under it is hidden.
   */
  lines: { block: string; text: string; label: boolean; rows: string[] }[];
}

// 20.8
export interface Link {
  target: string;
  covers: string;
}

export const GENERAL_KEYS = ["labs", "ekg", "imaging", "anatomy", "procedures", "guidelines", "screenings", "workup"] as const;
export type GeneralKey = (typeof GENERAL_KEYS)[number];

export interface GeneralFile {
  v: 1;
  topics: { key: GeneralKey; howto: string | null; links: Link[]; files: string[]; gaps: string[] }[];
  workup: { id: string; title: string; conds: string; gap: string }[];
}

/**
 * A reference-tab link. `gap`: one of the same sub's gap blocks, the section the link is shown
 * under (where that section can be found in her notes); without it the link is listed after the sections.
 */
export interface RefLink extends Link {
  gap?: string;
}

/**
 * Her own notes shown on a place page (a reference-tab topic or an Other section), above its gap
 * blocks, in order. `heading`: a heading for finding one's way, not part of her notes. `block`: a
 * block of one of her Word pages, as stored; with `column` n (≥ 1), a table block shows only its
 * first column and column n, from its second row on, under column n's first-row text.
 */
export type PlaceNote = { heading: string } | { block: string; column?: number };

export interface RefTab {
  subs: { id: string; title: string; notes?: PlaceNote[]; links: RefLink[]; gaps: string[] }[];
  files: string[];
}

export interface RefTabsFile {
  v: 1;
  labs: RefTab;
  imaging: RefTab;
  ekg: RefTab;
  anatomy: RefTab;
}

export const OTHER_SECTION_IDS = ["emergency", "vaccines", "guidelines", "screenings", "legal", "pa", "vitamins", "pe", "notes"] as const;
/** The Other sections whose record has a `gaps` list (content not from her notes); no other section has one. */
export const OTHER_GAP_SECTIONS: readonly (typeof OTHER_SECTION_IDS)[number][] = ["screenings", "legal", "pa", "pe", "notes"];

export interface OtherFile {
  v: 1;
  sections: { id: string; title: string; lead: string | null; notes?: PlaceNote[]; files: string[]; links: Link[]; gaps?: string[] }[];
}

// 20.9
/** The fixed guideline sources of 80 §80.3. */
export const FIXED_SOURCES = ["gold", "gina", "ada", "hf", "cpr", "uspstf"] as const;
export type FixedSource = (typeof FIXED_SOURCES)[number];

export interface TrackBase {
  series: string;
  label: string;
  org: string;
  edition: number;
}
export type Track =
  | (TrackBase & { method: "fixed"; source: FixedSource })
  | (TrackBase & { method: "pubmed"; term: string; title: string })
  | (TrackBase & { method: "page"; url: string; pattern: string })
  | (TrackBase & { method: "none" });

export interface GapSource {
  name: string;
  org: string;
  year: string;
  url: string | null;
  type: "guideline" | "reference" | "course";
  track: Track | null;
}

export interface GapMeta {
  title: string;
  relevantTo: string;
  written: string;
  differs: { doc: DocJSON } | null;
  sources: GapSource[];
  ownerEdits: string[];
}

export type GapFile = BlockFile<GapMeta> & { kind: "gap" };

export interface EvidenceFile {
  v: 1;
  block: string;
  author: string;
  claims: { text: string; source: number; quote: string; locator: string; accessed: string }[];
  verification: {
    verifier: string;
    at: string;
    result: "pass" | "fail";
    notes: { claim: number; issue: string; resolution: string }[];
  };
}

// 20.10
export interface DeckFile {
  v: 1;
  guide: GuideId;
  kind: "own" | "generated";
  title: string;
  file: string | null;
  slides: string[];
}

export interface SlideMeta {
  summarizes?: string[];
  evidence?: { item: string; row: string; quote: string }[];
  verification?: { verifier: string; at: string; result: "pass" | "fail"; notes: unknown[] };
  ownerEdits?: string[];
}

// 20.11
export interface VocabFile {
  v: 1;
  entries: { abbr: string[]; meanings: string[] }[];
}

// 20.12
export interface Flag {
  id: string;
  kind: "rec" | "edition";
  source: string;
  by: "check" | "agent";
  key: string;
  subject: string | null;
  guideline: string;
  org: string;
  published: string;
  quote: string | null;
  grade: string | null;
  url: string;
  flagged: string;
  supersededBy: string | null;
  /**
   * ISO date on which the guideline check found the recommendation permanently gone from its
   * source; a retired flag is listed but never placed (Orchestrator rulings, 2026-10-04 03:06Z/03:07Z).
   */
  retired?: string;
  locator?: string;
  verification?: { verifier: string; at: string; result: "pass" | "fail" };
}

export interface FlagsFile {
  v: 1;
  flags: Flag[];
}

export interface ConceptsFile {
  v: 1;
  concepts: { id: string; title: string; sourceKeys: Record<string, string[]>; targets: string[] }[];
}

export interface ChecksFile {
  v: 1;
  lastRun: string | null;
  nextRun: string | null;
  sources: { id: string; lastSuccess: string | null; lastAttempt: string; status: "ok" | "fail" }[];
  seen: Record<string, unknown>;
  seenUrl: Record<string, string>;
}
