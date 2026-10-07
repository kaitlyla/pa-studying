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
/**
 * A part of a pharm notes file: its blocks, whole; or, with `column` or `rows`, its one table block
 * cut as a place note cuts it (BlockNote), so several parts can share one stored table. A `topic`
 * part may give both, `rows` and then `column` of those rows (PartCut), for a table holding several
 * conditions side by side; a `card` or `lo` part may give `rows` and then `columns` grid columns from
 * `column` on, for a table holding several drug classes side by side.
 */
export interface PharmPart extends PartCut {
  id: string;
  /** `topic`: shown on the meds panels of the guide topics in `topics`, on no class card. */
  role: "overview" | "lo" | "card" | "topic";
  title: string;
  card: string | null;
  blocks: string[];
  /** A `topic` part's guide topics (each a topic's id, as SystemJson `topics[].id`); only on a `topic` part. */
  topics?: string[];
  /**
   * The conditions a `card` part is written for ("Tourette's Syndrome: Typical APs"), each matched as
   * a whole phrase in any case: the part shows on the meds panels of conditions whose title names one,
   * and in a pharm section only when its card is written for that section (CardsFile `for`); her
   * file page shows it as always. Only on a `card` part.
   */
  diseases?: string[];
}

/**
 * A cut of one table block: some rows, and/or one grid column of them. A column cut shows grid column
 * `label` (the first column when omitted) beside `column`, for a table that pairs a name column with
 * each notes column. With `columns` (only with `rows`, on a card or lo part) the cut is instead the
 * `columns` grid columns from `column` on (column 0 included), with no label column: one class of
 * a table that sets classes side by side, titled by its cell in the first listed row.
 */
export interface PartCut extends Omit<BlockNote, "block"> {
  label?: number;
  columns?: number;
}

export interface PharmFile {
  v: 1;
  id: string;
  fileName: string;
  basePt: number;
  /**
   * The `d_` id of her Word page, when the file's notes are that page: `blocks` are blocks of that
   * page, stored once under it (content/docs/<page>/blocks), so an edit shows on the page and on
   * every card. A block no longer on the page is dropped from the parts it was in. (Not `doc`: a
   * top-level `doc` in a content file is rich text.)
   */
  page?: string;
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
   * Content row id → what titles the topic the row starts: the index of the cell of the heading row
   * directly above it (0 = the label), which must be non-empty (Orchestrator rulings 2026-10-04
   * 21:02Z and 22:01Z, amending 40 §40.2), or a title used verbatim (Orchestrator ruling
   * 2026-10-06). Opt-in per row. deriveTopics checks the rows; fitTopicRows drops entries an edit
   * has broken.
   */
  titled?: Record<string, number | string>;
  /**
   * Content rows of non-drug tables that would start a topic but start none: each is shown in place
   * only, like an untitled row, and rows that would continue it stay untitled too (Orchestrator
   * ruling 2026-10-06). deriveTopics checks the rows; fitTopicRows drops entries an edit has broken.
   */
  unlisted?: string[];
  /**
   * `onlyFor`: the conditions a table's rows are written only for (disease-specific dosing, a stage or
   * maintenance scheme: her Gout and IBD tables), so a meds panel shows them only under a condition
   * whose title names one, like a card's `diseases` (Orchestrator ruling 2026-10-06, an agent decision).
   */
  drugTables: { block: string; pharmSection: string; conditionRows: string[]; onlyFor?: string[] }[];
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
   * `classWords`: her other words for the card's drugs in treatment text — the wider drug class it
   * belongs to ("diuretics", "anticoagulation"), shared by every card of that class, and her
   * abbreviations and other names for its drugs ("BDZs", "MTX", "azathioprine"). They match only a
   * condition's treatment text, naming every card that lists the word; unlike `aliases` they never
   * match her drug-table rows, where "K-Sparing Diuretics" names one card, not every diuretic.
   * `diseases`: the diseases her notes on the card are written for ("multiple sclerosis"), where they
   * would misstate the drugs elsewhere. In a meds panel without the card's drug-table rows, the card
   * shows only on a condition whose title, or the treatment item naming the card's drug, names one
   * of them (whole words, any case).
   * `notDiseases`: conditions her treatment text names the card's drug for although her notes on the
   * card do not cover that use ("topical NTG or nifedipine" on anal fissure is not her angina card).
   * On a class card only; the group shows on no condition whose title names one of them.
   */
  cards: {
    id: string; file: string; aliases: string[]; home: Partial<Record<GuideId, string>>; in?: string; for?: string[]; classWords?: string[]; diseases?: string[];
    notDiseases?: string[];
  }[];
}

/**
 * Her own meds panel for one condition topic of one guide (`content/guides/<g>/<system>/meds/<topic id>.json`).
 * The panel is otherwise worked out at publish; this changes it for that topic only, and never changes
 * a card, her guide or her pharm notes. `add`: class cards she added (card ids), after the panel's own.
 * `remove`: panel entries she took off (each entry's target: a card id, a card-less guide row's id, or
 * a pharm part's id). `own`: entries she edited there, each shown as its `pieces` instead of the card's
 * guide rows and pharm notes. At least one of the three is non-empty: with none, there is no file.
 */
export interface MedsFile {
  v: 1;
  add: string[];
  remove: string[];
  own: { target: string; pieces: MedsPiece[] }[];
}

/**
 * One thing an edited panel entry shows, in order: rows of her guide's drug table (`rows`: one table,
 * at the guide's base size), or her pharm notes (`notes`: at `basePt`, her file's size, under `title`
 * when the notes were cut to a titled column, labeled with her file's name `file`).
 */
export interface MedsPiece {
  kind: "rows" | "notes";
  basePt: number;
  title: string | null;
  file: string | null;
  doc: DocJSON;
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
 * first column and column n, from its second row on, under column n's first-row text; with `rows`
 * (its row ids, not with `column`), a table block shows only its first row and those rows, in table
 * order. The same row may be shown by several notes.
 */
export type PlaceNote = { heading: string } | BlockNote;
export type BlockNote = { block: string; column?: number; rows?: string[] };

/**
 * One page of a reference tab. `group`: the heading it is listed under in the tab's sidebar and
 * landing page (e.g. an imaging modality); the subs of one group are consecutive. `intro`: ids of
 * this sub's gap blocks shown open first (e.g. how to read the study); when present, every other
 * gap block shows as a closed collapsible under its title, in `gaps` order (`[]`: all collapsible).
 */
export interface RefSub {
  id: string;
  title: string;
  group?: string;
  intro?: string[];
  notes?: PlaceNote[];
  links: RefLink[];
  gaps: string[];
}

export interface RefTab {
  subs: RefSub[];
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

/**
 * One item of an Other section's outline (its `notes`), in page order. `heading`: a sidebar entry
 * that starts a part of the page (navigation, not her text); with `sub`, a second-level entry under
 * the top heading before it. `block`: as in PlaceNote. `doc`: one of the section's `files`, shown
 * whole. `original`: one of the section's `files` shown only as a small link to its File page — the
 * original of text shown on the page. `gap`: one of the section's `gaps`. `link`: the `target` of
 * one of the section's `links`.
 */
export type OtherNote =
  | { heading: string; sub?: true }
  | BlockNote
  | { doc: string }
  | { original: string }
  | { gap: string }
  | { link: string };

export interface OtherFile {
  v: 1;
  sections: { id: string; title: string; lead: string | null; notes?: OtherNote[]; files: string[]; links: Link[]; gaps?: string[] }[];
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

/**
 * An example image shown in a gap block: a freely licensed file stored under `content/assets/`, with
 * the credit its license requires and the quoted source description that shows what it depicts.
 */
export interface GapFigure {
  /** Content-addressed file name under `content/assets/`. */
  asset: string;
  /** Pixel size of the stored file. */
  width: number;
  height: number;
  /**
   * The width it is shown at, in pt, at most GAP_FIGURE_WIDTH_PT. Absent: its natural size, never wider
   * than the column.
   */
  widthPt?: number;
  /**
   * The height it is shown at, in pt, at most GAP_FIGURE_HEIGHT_PT, when she squished or stretched it;
   * only together with widthPt. Absent: its height keeps the file's ratio.
   */
  heightPt?: number;
  /** What the image shows; also its alternative text. */
  caption: string;
  credit: {
    author: string;
    /** License name as the source states it, e.g. "CC BY-SA 4.0", "Public domain". */
    license: string;
    /** The license's deed; null when the source has none (public domain). */
    licenseUrl: string | null;
    /** The source's page for this file. */
    page: string;
    /** Changes made to the source file, or null when it is stored unchanged. */
    changes: string | null;
  };
  /** The source description's wording that states what the image shows, quoted verbatim. */
  evidence: { quote: string; accessed: string };
}

export interface GapMeta {
  title: string;
  relevantTo: string;
  written: string;
  differs: { doc: DocJSON } | null;
  sources: GapSource[];
  ownerEdits: string[];
  figures?: GapFigure[];
  /**
   * She chose to show this block as her own notes: no gap box, badge or "Relevant to" line, and its
   * sources in small print. Absent: shown as a gap block.
   */
  asNotes?: true;
}

/** A gap block's content width in pt (US Letter with 1-inch margins). */
export const GAP_CONTENT_PT = 468;
/** A gap block's content height in pt, on the same page. */
export const GAP_CONTENT_HEIGHT_PT = 648;
/**
 * The largest a gap block's figure can be set, in pt. Gap blocks are not printed, so a figure is held
 * to what the screen shows rather than to a page: a figure never resized is drawn at its file's own
 * size within the column, up to about 1062 pt wide in the widest page frame (1400 px) and, for her
 * tallest figures, about 1740 pt tall. These limits are above that, so no figure shown on screen is
 * outside them; a column narrower than the set width scales the figure down, keeping its shape.
 */
export const GAP_FIGURE_WIDTH_PT = 1100;
export const GAP_FIGURE_HEIGHT_PT = 2000;

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
