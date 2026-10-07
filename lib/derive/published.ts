// Shapes of the published data under `dist/data/` (plan 40 §40.8). Written by tools/build, read by the app.
import type { DocJSON, FileKind, Flag, GapFigure, GapMeta, GeneralKey, GuideId, MedsPiece, PageSetup, PartCut, ReplaceFailed } from "../content/types.ts";
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

export type PubFigure = Omit<GapFigure, "evidence">;

/** A gap block's figures as published: everything but the evidence, which stays in content. */
export function pubFigures(meta: GapMeta): PubFigure[] {
  return (meta.figures ?? []).map((f) => ({
    asset: f.asset, width: f.width, height: f.height,
    ...(f.widthPt !== undefined ? { widthPt: f.widthPt } : {}), ...(f.heightPt !== undefined ? { heightPt: f.heightPt } : {}),
    caption: f.caption, credit: f.credit,
  }));
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
  /** Example images, each with its credit (the stored figures without their evidence). */
  figures: PubFigure[];
  /** She chose to show it as her own notes (GapMeta.asNotes): no gap box or labels, sources in small print. */
  asNotes: boolean;
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
  /** Block entry over a run of blocks (the listed block and those recorded under it): the run in order. Absent for one block. */
  blocks?: string[];
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

export type PubMedsCard = PubMedsClass | PubMedsPart;

export interface PubMedsClass {
  card: string | null;
  part?: undefined;
  title: string;
  /** Row ids, each run preceded once by its heading row id; [] for a card with no row in the system. */
  rows: string[];
  /**
   * Pharm section holding the card's first row; the "Open in <System> pharm" link goes there. A card
   * without rows takes the pharm section her pharm places it in (lib/derive/pharm.ts `panelHome`) and
   * shows the notes written for it.
   */
  section: string;
  /** The guide's system holding `section`; null when it is another guide's, so the card shows without a link. */
  system: string | null;
  /** Scroll target: the card id, or the row id for a card-less row. */
  target: string;
}

/**
 * A `topic` part of her pharm notes attached to the topic (content PharmPart `topics`), after the
 * cards: SystemJson `parts[part]`, in no pharm section, so with no link.
 */
export interface PubMedsPart {
  card: null;
  part: string;
  title: string;
  rows: [];
  section: null;
  system: null;
  /** Scroll target: the part id. */
  target: string;
}

/** Her own meds panel for a topic, as published (content MedsFile). */
export interface PubMedsEdit {
  /** Targets of the entries she took off. */
  remove: string[];
  /** The cards she added that the panel does not already show, as entries, in her order. */
  add: PubMedsClass[];
  /** Target → what the entry shows instead of its card's rows and notes, for the entries she edited that the panel shows. */
  own: Record<string, MedsPiece[]>;
}

export interface PubTopic {
  id: string;
  title: string;
  section: string | null;
  condition: boolean;
  /** The topic's rows, each run preceded once by its heading row id. */
  rows: string[];
  /** Meds panel cards as worked out from her notes (empty when there are none), before her own panel (`medsEdit`). */
  meds: PubMedsCard[];
  /** Her own meds panel for this topic (content MedsFile), or null when she has none; the panel shows lib/derive/panel.ts `panelEntries`. */
  medsEdit: PubMedsEdit | null;
  /** Her notes and pictures below the topic (after its meds panel); null when she added none. */
  below: PubBlock | null;
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
  /** The class card's own pharm file name. */
  file: string;
  /** That file's base size. */
  basePt: number;
  /** Notes blocks (keys of `notesBlocks`), in part order. */
  blocks: string[];
  /**
   * The card's pharm-notes parts in order — its own, then those of the cards shown inside it — each
   * with its blocks, its file name (labeled on the card) and that file's base size, to which its
   * blocks' `size` marks are relative; a search unit's `at` names a part id. A part with `for` was
   * written for those pharm sections' use only (its card's `for` in content/pharm/cards.json) and
   * shows only where one of them is relevant (lib/derive/trim.ts `shownParts`); a part with `diseases`
   * was written for those conditions (content PharmPart `diseases`) and shows on the meds panels of
   * conditions whose title names one, and in pharm sections only where it also has `for`. A part with
   * `column` or `rows` shows its one table block cut as the content part says (lib/derive/columns.ts
   * `noteView`); its `rows` are those still in the table.
   */
  parts: ({ id: string; blocks: string[]; file: string; basePt: number; for?: string[]; diseases?: string[] } & PartCut)[];
}

/** A pharm part's cut of its one table block (content PharmPart `rows` / `column` / `label`). */
export type { PartCut };

/**
 * A pharm-notes line judged written for one use (content/pharm/uses.json): it shows only where one
 * of the pharm sections in `for` is relevant.
 */
export interface PubUseLine {
  text: string;
  for: string[];
}

/**
 * A pharm-notes line judged already said by her guide table (content/pharm/trims.json), with the
 * rows of this page that say it and their text when judged; a label carries no rows.
 */
export interface PubTrimLine {
  text: string;
  label: boolean;
  rows: { id: string; text: string }[];
}

export interface PubPart extends PartCut {
  title: string;
  role: "overview" | "lo" | "topic";
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
  /**
   * Condition section id ("" when the system has no sections; lib/derive/pharm.ts `conditionKey`) →
   * the pharm sections relevant to its conditions (content/pharm/uses.json): its topics' meds panels
   * show only rows of those sections' tables, and only notes written for them. {} without drug tables.
   */
  panelSections: Record<string, string[]>;
  /** Class cards used on this system's pages (pharm sections and meds panels). */
  cards: Record<string, PubCard>;
  /** Overview / learning-objectives parts used by the pharm sections. */
  parts: Record<string, PubPart>;
  /** Pharm-notes blocks referenced by `cards` and `parts`. */
  notesBlocks: Record<string, PubBlock>;
  /** Cards' notes block id → its lines her guide table says on this page (lib/derive/trim.ts). */
  trims: Record<string, PubTrimLine[]>;
  /** Cards' notes block id → its lines written for one use only (lib/derive/trim.ts). */
  uses: Record<string, PubUseLine[]>;
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

/** A reference-tab link; `gap`: the sub's gap block (section) it is shown under (content RefLink). */
export interface PubRefLink extends PubLink {
  gap?: string;
}

/**
 * One of her notes on a place page (content PlaceNote): a heading, or a block of one of her Word pages
 * with that page's base size; `column` (or null): show only the table's first column and that one;
 * `rows` (or null): show only the table's first row and those of its rows (lib/derive/columns.ts).
 */
export type PubNote = { heading: string } | { block: PubBlock; basePt: number; column: number | null; rows: string[] | null };

/** A reference-tab page (content RefSub); `group` and `intro` are null when the sub has none. */
export interface PubRefSub {
  id: string;
  title: string;
  group: string | null;
  intro: string[] | null;
  notes: PubNote[];
  links: PubRefLink[];
  gaps: PubGap[];
}

export interface RefTabJson {
  tab: string;
  label: string;
  subs: PubRefSub[];
  files: DocList;
}

/**
 * An Other section's outline item as published (content OtherNote). A heading carries `id`, its part's
 * slug, unique in the section: the anchor and route its sidebar entry opens. A doc carries its
 * reference only; the page loads `docs/<d>.json` for its content. An original carries its reference
 * for the small link to its File page.
 */
export type PubOtherNote =
  | { heading: string; sub: boolean; id: string }
  | Extract<PubNote, { block: PubBlock }>
  | { doc: DocRef }
  | { original: DocRef }
  | { gap: PubGap }
  | { link: PubLink };

export interface OtherJson {
  sections: {
    id: string;
    title: string;
    lead: PubGap | null;
    /** The outline; `links`, `files` and `gaps` stay the section's whole lists (those not in the outline show after it). */
    notes: PubOtherNote[];
    links: PubLink[];
    files: DocList;
    /** Present only on sections whose stored record has `gaps` (OTHER_GAP_SECTIONS). */
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
  /** The route of its first placement (40 §40.3), where the app returns after Remove; absent when it is listed nowhere. */
  home?: string;
  /** Her last replacement of this document couldn't be processed (shown to the owner only). */
  replaceFailed?: ReplaceFailed;
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
   * paragraph markers except U+FE00–U+FE0F, control characters and the code points in `draw` (whose
   * replacement characters are listed instead). Uncovered code points map to DejaVu Sans.
   */
  map: Record<string, number>;
  /**
   * Decimal code point → the text a PDF draws in its place: a code point no vendored font has whose
   * drawn form they do (lib/fonts.ts fontCoverage) — U+FE58 SMALL EM DASH draws as U+2014, U+1806 as
   * "-". Stored text keeps the original.
   */
  draw: Record<string, string>;
}
