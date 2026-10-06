// Validators for every stored record (plan 20). Each takes the parsed JSON, a context naming the
// file and, where the file's path fixes the record's identity, the expected id; it throws a
// ContentError on the first violation. Nothing is ever repaired. Record shapes are keyed to the
// interfaces in types.ts through `shapeOf`, so a field added to a type must be validated too.
import { Node } from "prosemirror-model";
import { ASSET_RE, schema, storedJSON } from "../schema.ts";
import {
  arr, bad, bool, ContentError, either, int, isNull, isObj, isoDate, isoUtc, ISO_MONTH_RE, nonEmpty, nullable,
  num, one, oneOf, re, record, shapeOf, str, uniqueArr,
} from "./check.ts";
import type { Checker, Ctx } from "./check.ts";
import { idRegExp, isId, memberTarget, seriesOfCiteKey, SLUG_RE } from "./ids.ts";
import type { IdPrefix } from "./ids.ts";
import { FIXED_SOURCES, GAP_CONTENT_PT, GENERAL_KEYS, GUIDE_IDS, OTHER_GAP_SECTIONS, OTHER_SECTION_IDS, UPLOAD_EXTS } from "./types.ts";
import type {
  AsIsFile, BlockFile, BlockKind, BlockNote, CardsFile, ChecksFile, ConceptsFile, DeckFile, EvidenceFile, FileText, Flag,
  FlagsFile, GapFigure, GapFile, GapMeta, GapSource, GeneralFile, GuideFile, OtherFile, OtherNote, PageSetup, PharmFile, PharmPart, PlaceNote,
  RefLink, RefSub, RefTab, RefTabsFile, Removed, ReplaceFailed, Replacing, SiteFile, SlideMeta, StructureFile, SystemFile, Track, TrackBase,
  TrimsFile, UploadFile, UsesFile, VocabFile, WordDocFile,
} from "./types.ts";

/** Every file validator: the record, the file context, and the identity its path fixes (if any). */
export type Validator = (v: unknown, ctx: Ctx, expectId?: string) => void;

const id = (...prefixes: IdPrefix[]): Checker => re(idRegExp(...prefixes), `a ${prefixes.map((p) => `${p}_`).join(" or ")} id`);
const slugC = re(SLUG_RE, "a slug");
const guideC = oneOf(...GUIDE_IDS);
const month = re(ISO_MONTH_RE, "a month (YYYY-MM)");
const sha40 = re(/^[0-9a-f]{40}$/, "a 40-hex commit sha");
const v1 = one(1);
const anyValue: Checker = () => undefined;

const page = shapeOf<PageSetup>({ widthPt: num, heightPt: num, margins: shapeOf<PageSetup["margins"]>({ top: num, right: num, bottom: num, left: num }, {}) }, {});

function expectField(ctx: Ctx, field: string, actual: unknown, expected: string | undefined): void {
  if (expected !== undefined && actual !== expected) bad(ctx, `.${field}`, `${expected} (from the file's path)`, actual);
}

/** Wrap a whole-record Checker as a Validator (records whose path fixes no identity). */
const whole = (c: Checker): Validator => (v, ctx) => c(v, "", ctx);

// ---- rich text ------------------------------------------------------------------------------

/**
 * Parse a stored doc with the schema and run `Node.check()`; also require that the stored JSON is
 * exactly its stored form (storedJSON), so every stored doc round-trips with no change.
 */
export function checkDoc(doc: unknown, at: string, ctx: Ctx): Node {
  const node = parseDoc(doc, at, ctx.file);
  if (node.type.name !== "doc") bad(ctx, at, "a doc node");
  if (JSON.stringify(storedJSON(node)) !== JSON.stringify(doc)) {
    throw new ContentError(ctx.file, `${at}: rich text does not round-trip through the schema unchanged`);
  }
  return node;
}

/**
 * Node.fromJSON silently drops keys and attributes the schema does not know; refuse them instead,
 * so normalizing on write never discards content.
 */
function checkKnownKeys(json: unknown, at: string, file: string): void {
  const fail = (what: string): never => { throw new ContentError(file, `${at}: invalid rich text: ${what}`); };
  if (!isObj(json)) return fail("a node must be an object");
  const type = typeof json.type === "string" && Object.hasOwn(schema.nodes, json.type) ? schema.nodes[json.type] : undefined;
  if (!type) return fail(`unknown node type ${JSON.stringify(json.type)}`);
  for (const k of Object.keys(json)) {
    if (!["type", "attrs", "content", "marks", "text"].includes(k)) fail(`unknown key ${k} on ${type.name}`);
  }
  const known = (attrs: unknown, spec: Record<string, unknown> | undefined, name: string): void => {
    if (attrs === undefined) return;
    if (!isObj(attrs)) return fail(`attrs of ${name} must be an object`);
    for (const k of Object.keys(attrs)) if (!spec || !Object.hasOwn(spec, k)) fail(`Unsupported attribute ${k} for ${name}`);
  };
  known(json.attrs, type.spec.attrs, type.name);
  if (Array.isArray(json.marks)) {
    for (const m of json.marks) {
      const markType = isObj(m) && typeof m.type === "string" && Object.hasOwn(schema.marks, m.type) ? schema.marks[m.type] : undefined;
      if (!markType) return fail(`unknown mark ${JSON.stringify(isObj(m) ? m.type : m)}`);
      known(m.attrs, markType.spec.attrs, markType.name);
    }
  }
  if (Array.isArray(json.content)) json.content.forEach((c, i) => checkKnownKeys(c, `${at}.content[${i}]`, file));
}

/** Build a doc with the schema and run `Node.check()`, reporting failures at field `at`. */
function parseDoc(doc: unknown, at: string, file: string): Node {
  try {
    const node = Node.fromJSON(schema, doc);
    node.check();
    return node;
  } catch (e) {
    throw new ContentError(file, `${at}: invalid rich text: ${(e as Error).message}`);
  }
}

/**
 * Parse and check the doc at field `at`, returning its stored form (storedJSON: attribute defaults
 * filled in, schema key order).
 */
export function normalizeDoc(doc: unknown, at: string, file: string): unknown {
  checkKnownKeys(doc, at, file);
  return storedJSON(parseDoc(doc, at, file));
}

function checkDocShape(node: Node, kind: BlockKind | "gapdoc", at: string, ctx: Ctx): void {
  const kids: string[] = [];
  node.forEach((n) => kids.push(n.type.name));
  switch (kind) {
    case "table":
      if (kids.length !== 1 || kids[0] !== "table") bad(ctx, at, "exactly one table node", kids);
      return;
    case "prose":
      if (kids.some((k) => k === "table" || k === "slide_card" || k === "heading_line")) {
        bad(ctx, at, "only non-table block nodes", kids);
      }
      return;
    case "gap":
    case "gapdoc":
      if (kids.some((k) => k === "slide_card" || k === "heading_line")) bad(ctx, at, "only block nodes", kids);
      return;
    case "slide":
      if (kids[0] !== "heading_line" || kids.slice(1).some((k) => k !== "paragraph" && k !== "slide_card")) {
        bad(ctx, at, "a heading_line followed by paragraphs and slide cards", kids);
      }
  }
}

// ---- block envelopes ----------------------------------------------------------------------

const emptyMeta: Checker = (v, at, ctx) => { if (!isObj(v) || Object.keys(v).length > 0) bad(ctx, at, "{}", v); };

/** A prose or table block (guides, preambles, pharm parts, Word pages): meta is `{}`. */
export const validateBlock: Validator = (v, ctx, expectId) => {
  shapeOf<BlockFile>({ v: v1, id: id("b"), kind: oneOf("prose", "table"), doc: anyValue, meta: emptyMeta }, {})(v, "", ctx);
  const b = v as BlockFile;
  expectField(ctx, "id", b.id, expectId);
  checkDocShape(checkDoc(b.doc, ".doc", ctx), b.kind, ".doc", ctx);
};

const slideMeta = shapeOf<SlideMeta>({}, {
  summarizes: uniqueArr(id("r")),
  evidence: arr(shapeOf<NonNullable<SlideMeta["evidence"]>[number]>({ item: str, row: id("r"), quote: str }, {})),
  verification: shapeOf<NonNullable<SlideMeta["verification"]>>({ verifier: nonEmpty, at: isoDate, result: oneOf("pass", "fail"), notes: arr(anyValue) }, {}),
  ownerEdits: arr(isoDate),
});

export const validateSlide: Validator = (v, ctx, expectId) => {
  shapeOf<BlockFile<SlideMeta>>({ v: v1, id: id("s"), kind: one("slide"), doc: anyValue, meta: slideMeta }, {})(v, "", ctx);
  const b = v as BlockFile<SlideMeta>;
  expectField(ctx, "id", b.id, expectId);
  checkDocShape(checkDoc(b.doc, ".doc", ctx), "slide", ".doc", ctx);
};

// ---- gap-fill (20.9) ------------------------------------------------------------------------

/** CDC/ACIP sources are never tracked (ruling CG). */
export function isCdcOrg(org: string): boolean {
  return org.includes("CDC") || org.includes("ACIP") || /Centers for Disease Control/i.test(org);
}

const yearRegex = (what: string): Checker => (v, at, ctx) => {
  if (typeof v !== "string") bad(ctx, at, what, v);
  let groups: number;
  try {
    groups = (new RegExp(`${v}|`).exec("") as RegExpExecArray).length - 1;
  } catch {
    bad(ctx, at, `${what} (a valid regular expression)`, v);
  }
  if (groups !== 1 || !v.includes("(\\d{4})")) bad(ctx, at, `${what} with exactly one (\\d{4}) group`, v);
};

type TrackOf<M extends Track["method"]> = Extract<Track, { method: M }>;
const trackBase: { [K in keyof TrackBase]-?: Checker } = { series: slugC, label: nonEmpty, org: nonEmpty, edition: int };
const track: Checker = (v, at, ctx) => {
  if (!isObj(v)) bad(ctx, at, "a track object", v);
  switch (v.method) {
    case "fixed": return shapeOf<TrackOf<"fixed">>({ ...trackBase, method: str, source: oneOf(...FIXED_SOURCES) }, {})(v, at, ctx);
    case "pubmed": return shapeOf<TrackOf<"pubmed">>({ ...trackBase, method: str, term: nonEmpty, title: yearRegex("a title regex") }, {})(v, at, ctx);
    case "page": return shapeOf<TrackOf<"page">>({ ...trackBase, method: str, url: re(/^https:\/\//, "an https URL"), pattern: yearRegex("a pattern regex") }, {})(v, at, ctx);
    case "none": return shapeOf<TrackOf<"none">>({ ...trackBase, method: str }, {})(v, at, ctx);
    default: bad(ctx, `${at}.method`, `one of "fixed", "pubmed", "page", "none"`, v.method);
  }
};

const gapSource: Checker = (v, at, ctx) => {
  shapeOf<GapSource>({
    name: nonEmpty, org: str, year: str, url: nullable(re(/^https?:\/\//, "an http(s) URL")),
    type: oneOf("guideline", "reference", "course"), track: nullable(track),
  }, {})(v, at, ctx);
  const s = v as GapSource;
  const mustTrack = s.type === "guideline" && !isCdcOrg(s.org);
  if (mustTrack && s.track === null) bad(ctx, `${at}.track`, "a track for a non-CDC guideline source", null);
  if (!mustTrack && s.track !== null) bad(ctx, `${at}.track`, "null (only non-CDC guideline sources are tracked)", s.track);
};

const posInt: Checker = (v, at, ctx) => { if (!Number.isInteger(v) || (v as number) < 1) bad(ctx, at, "a positive integer", v); };
const httpsUrl = re(/^https:\/\/\S+$/, "an https URL");
const figureWidthPt: Checker = (v, at, ctx) => {
  if (typeof v !== "number" || !(v > 0 && v <= GAP_CONTENT_PT)) bad(ctx, at, `a width in pt above 0 and at most ${GAP_CONTENT_PT}`, v);
};
const gapFigure = shapeOf<GapFigure>({
  asset: re(ASSET_RE, "a stored asset name"), width: posInt, height: posInt, caption: nonEmpty,
  credit: shapeOf<GapFigure["credit"]>({
    author: nonEmpty, license: nonEmpty, licenseUrl: nullable(httpsUrl), page: httpsUrl, changes: nullable(nonEmpty),
  }, {}),
  evidence: shapeOf<GapFigure["evidence"]>({ quote: nonEmpty, accessed: isoDate }, {}),
}, { widthPt: figureWidthPt });

export const validateGap: Validator = (v, ctx, expectId) => {
  shapeOf<GapFile>({
    v: v1, id: id("g"), kind: one("gap"), doc: anyValue,
    meta: shapeOf<GapMeta>({
      title: nonEmpty, relevantTo: str, written: month,
      differs: nullable(shapeOf<NonNullable<GapMeta["differs"]>>({ doc: anyValue }, {})),
      sources: arr(gapSource), ownerEdits: arr(isoDate),
    }, { figures: arr(gapFigure), asNotes: one(true) }),
  }, {})(v, "", ctx);
  const g = v as GapFile;
  expectField(ctx, "id", g.id, expectId);
  checkDocShape(checkDoc(g.doc, ".doc", ctx), "gap", ".doc", ctx);
  if (g.meta.differs) checkDocShape(checkDoc(g.meta.differs.doc, ".meta.differs.doc", ctx), "gapdoc", ".meta.differs.doc", ctx);
  checkTrackSeries([g]);
};

/** A track's identity: every field except the cited edition. */
function trackDescriptor(t: Track): string {
  const fields = t as unknown as Record<string, unknown>;
  return JSON.stringify(Object.keys(fields).filter((k) => k !== "edition").sort().map((k) => [k, fields[k]]));
}

/**
 * Every `track` with the same `series` must carry the same label, org, method and method fields
 * (20 §20.9). Throws naming the first gap block that disagrees with an earlier one.
 */
export function checkTrackSeries(gaps: readonly GapFile[]): void {
  const first = new Map<string, { desc: string; block: string }>();
  for (const g of gaps) {
    for (const s of g.meta.sources) {
      if (!s.track) continue;
      const desc = trackDescriptor(s.track);
      const seen = first.get(s.track.series);
      if (!seen) first.set(s.track.series, { desc, block: g.id });
      else if (seen.desc !== desc) {
        throw new ContentError(
          `content/gapfill/${g.id}.json`,
          `track for series "${s.track.series}" differs from the one in ${seen.block} (label, org, method and method fields must match)`,
        );
      }
    }
  }
}

type Verification = EvidenceFile["verification"];
export const validateEvidence: Validator = (v, ctx, expectId) => {
  shapeOf<EvidenceFile>({
    v: v1, block: id("g"), author: nonEmpty,
    claims: arr(shapeOf<EvidenceFile["claims"][number]>({ text: str, source: int, quote: str, locator: str, accessed: isoDate }, {})),
    verification: shapeOf<Verification>({
      verifier: nonEmpty, at: isoDate, result: oneOf("pass", "fail"),
      notes: arr(shapeOf<Verification["notes"][number]>({ claim: int, issue: str, resolution: str }, {})),
    }, {}),
  }, {})(v, "", ctx);
  expectField(ctx, "block", (v as EvidenceFile).block, expectId);
};

// ---- site, guides, systems --------------------------------------------------------------------

export const validateSite: Validator = whole(shapeOf<SiteFile>({
  v: v1, name: nonEmpty,
  owner: shapeOf<SiteFile["owner"]>({ login: nonEmpty, id: int, commitName: nonEmpty, commitEmail: nonEmpty }, {}),
  repo: re(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, "owner/repo"),
  tabs: uniqueArr(nonEmpty), eors: uniqueArr(guideC),
  guideNames: record(guideC, nonEmpty),
}, {}));

export const validateGuide: Validator = (v, ctx, expectId) => {
  shapeOf<GuideFile>(
    {
      v: v1, id: guideC, source: nonEmpty, page, basePt: num, preamble: uniqueArr(id("b")),
      systems: arr(shapeOf<GuideFile["systems"][number]>({ id: slugC, title: str, pct: str }, {})),
    },
    { sidebarEnd: id("d") },
  )(v, "", ctx);
  const g = v as GuideFile;
  expectField(ctx, "id", g.id, expectId);
  if (g.sidebarEnd !== undefined && g.id !== "pance") bad(ctx, ".sidebarEnd", "no sidebarEnd outside the PANCE guide");
  uniqueArr(str)(g.systems.map((s) => s.id), ".systems[].id", ctx);
};

export const validateSystem: Validator = (v, ctx, expectId) => {
  shapeOf<SystemFile>({ v: v1, id: slugC, blocks: uniqueArr(id("b")) }, {})(v, "", ctx);
  expectField(ctx, "id", (v as SystemFile).id, expectId);
};

// ---- documents (20.5) -------------------------------------------------------------------------

const removed = nullable(shapeOf<Removed>({ at: isoUtc, from: sha40 }, {}));
const replacing = shapeOf<Replacing>({ fileName: nonEmpty, at: isoUtc }, {});
const replaceFailed = shapeOf<ReplaceFailed>({ fileName: nonEmpty, at: isoUtc }, {});

export const validateWordDoc: Validator = (v, ctx, expectId) => {
  shapeOf<WordDocFile>(
    { v: v1, id: id("d"), name: nonEmpty, kind: one("word"), source: nonEmpty, page, basePt: num, blocks: uniqueArr(id("b")), removed },
    { replacing, replaceFailed },
  )(v, "", ctx);
  expectField(ctx, "id", (v as WordDocFile).id, expectId);
};

export const validateAsIsFile: Validator = (v, ctx, expectId) => {
  shapeOf<AsIsFile>(
    { v: v1, id: id("d"), name: nonEmpty, kind: oneOf("word", "pdf", "image", "slides"), original: nonEmpty, view: nullable(nonEmpty), removed },
    { pages: nullable(int), text: nullable(one("text.json")), state: oneOf("processing", "ready", "failed"), replacing, replaceFailed },
  )(v, "", ctx);
  const f = v as AsIsFile;
  expectField(ctx, "id", f.id, expectId);
  const state = f.state ?? "ready";
  if (state === "processing") {
    if (f.view !== null || f.pages !== null || f.text !== null) bad(ctx, "", "view, pages and text all null while processing");
    return;
  }
  if (state === "failed") return;
  // A ready Word document lives in docs/<d_id>/, never here.
  if (f.kind === "word") bad(ctx, ".kind", "pdf, image or slides for a ready file", f.kind);
  if (f.kind === "pdf" && (f.view !== f.original || typeof f.pages !== "number")) bad(ctx, "", "a pdf whose view is the original, with a page count");
  if (f.kind === "image" && (f.view !== f.original || f.pages != null || f.text != null)) bad(ctx, "", "an image whose view is the original, with no pages or text");
  if (f.kind === "slides" && typeof f.pages !== "number") bad(ctx, ".pages", "a slide count", f.pages);
};

export const validateFileText: Validator = whole(shapeOf<FileText>({ pages: arr(str) }, {}));

export const validateUpload: Validator = (v, ctx, expectId) => {
  shapeOf<UploadFile>({
    v: v1, id: id("d"), fileName: nonEmpty, ext: oneOf(...UPLOAD_EXTS),
    size: int, sha256: re(/^[0-9a-f]{64}$/, "a SHA-256 hex digest"), parts: int, replaces: either("null or true", isNull, one(true)),
  }, {})(v, "", ctx);
  expectField(ctx, "id", (v as UploadFile).id, expectId);
};

// ---- pharm (20.6, 20.7) ---------------------------------------------------------------------

/**
 * Parts cover the file's blocks in order, each block once: whole, in one part; or cut (`column` or
 * `rows`, one block per part) by a run of consecutive parts, each taking columns no other part of the
 * run takes, or rows. A row part lists its group's heading rows first (a part shows only the rows it
 * lists), so parts of one group share those: a row listed by more than one part of the run must come,
 * in each part listing it, before every row that part alone lists, and each part lists a row of its own.
 * A `topic` part (shown on the meds panels of its `topics`, on no card) may also cut its rows to one
 * column, beside column `label`; a `card` or `lo` part may cut its rows to `columns` grid columns from
 * `column` on (column 0 included). Either joins a run of row parts, and two parts share a row only
 * where the columns they show of it overlap (or one shows the whole row).
 */
export const validatePharmFile: Validator = (v, ctx, expectId) => {
  shapeOf<PharmFile>({
    v: v1, id: slugC, fileName: nonEmpty, basePt: num, blocks: uniqueArr(id("b")),
    parts: arr(shapeOf<PharmPart>(
      { id: id("p"), role: oneOf("overview", "lo", "card", "topic"), title: str, card: nullable(id("c")), blocks: arr(id("b")) },
      { column: labelC, columns: columnC, rows: rowsC, label: labelC, topics: topicsC },
    )),
  }, { page: id("d") })(v, "", ctx);
  const p = v as PharmFile;
  expectField(ctx, "id", p.id, expectId);
  uniqueArr(str)(p.parts.map((x) => x.id), ".parts[].id", ctx);
  let at = 0;
  /** A part's cut: its rows, and the grid columns `column` … `column + width - 1` it shows of them. */
  type Cut = { path: string; rows: readonly string[] | null; column: number | null; width: number };
  type Run = { block: string; by: "column" | "rows"; cuts: Cut[] };
  /** The block being cut by the run of cut parts just before, and each part's rows and column. */
  let cutting: Run | null = null;
  /** Whether cuts `a` and `b` of a run both show row `r`: listed by both, in overlapping columns or a whole row. */
  const share = (a: Cut, b: Cut, r: string): boolean =>
    a !== b && (b.rows?.includes(r) ?? false)
    && (a.column === null || b.column === null || (a.column < b.column + b.width && b.column < a.column + a.width));
  const endRun = (): void => {
    const run: Run | null = cutting;
    cutting = null;
    if (run === null) return;
    for (const c of run.cuts) {
      if (run.by === "column") {
        if (run.cuts.some((o) => o !== c && o.column === c.column)) bad(ctx, c.path, `a column no other part on ${run.block} takes`, c.column);
        continue;
      }
      const rows = c.rows as readonly string[];
      const shared = rows.map((r) => run.cuts.some((o) => share(c, o, r)));
      const own = shared.indexOf(false);
      if (own === -1) bad(ctx, c.path, `rows of the part's own besides those shared with other parts on ${run.block}`, rows);
      rows.forEach((r, j) => {
        if (shared[j] && own !== -1 && j > own) bad(ctx, c.path, `rows shared with another part on ${run.block} listed before the part's own rows`, r);
      });
    }
  };
  p.parts.forEach((part, i) => {
    const path = `.parts[${i}]`;
    if (part.blocks.length === 0) bad(ctx, `${path}.blocks`, "a non-empty slice");
    if ((part.role === "card") !== (part.card !== null)) bad(ctx, `${path}.card`, "a card id exactly when role is card", part.card);
    if (part.role === "overview" && i !== 0) bad(ctx, `${path}.role`, "overview only as the first part", part.role);
    if ((part.role === "topic") !== (part.topics !== undefined)) bad(ctx, `${path}.topics`, "topics exactly when role is topic", part.topics);
    const { blocks } = part;
    const cut: Omit<BlockNote, "block"> = {
      ...(part.column === undefined ? {} : { column: part.column }), ...(part.rows === undefined ? {} : { rows: part.rows }),
    };
    if (part.label !== undefined && (part.role !== "topic" || cut.column === undefined || part.label >= cut.column)) {
      bad(ctx, `${path}.label`, "a column left of `column`, only on a topic part", part.label);
    }
    const range = part.columns !== undefined;
    if (range && ((part.role !== "card" && part.role !== "lo") || cut.column === undefined || cut.rows === undefined)) {
      bad(ctx, `${path}.columns`, "a column count with `column` and `rows`, only on a card or lo part", part.columns);
    }
    // A topic part's column sits right of its label column (a place-note column is checked as one below).
    if (part.role === "topic" && cut.column !== undefined && cut.column < 1) bad(ctx, `${path}.column`, "a column number (1 or more)", cut.column);
    if (cut.column === undefined && cut.rows === undefined) {
      endRun();
      blocks.forEach((b, j) => {
        if (p.blocks[at + j] !== b) bad(ctx, `${path}.blocks[${j}]`, `the next block of the file (${p.blocks[at + j]})`, b);
      });
      at += blocks.length;
      return;
    }
    if (blocks.length !== 1) bad(ctx, `${path}.blocks`, "one block when the part has a column or rows", blocks);
    const block = blocks[0] as string;
    // Only a topic part, or a part with `columns`, cuts its rows to columns; other parts cut as a place note does.
    blockNote({ block, ...((part.role === "topic" || range) && cut.rows !== undefined ? { rows: cut.rows } : cut) }, path, ctx);
    const by = cut.rows !== undefined ? "rows" : "column";
    const take: Cut = { path, rows: cut.rows ?? null, column: cut.column ?? null, width: part.columns ?? 1 };
    const run: Run | null = cutting;
    if (run !== null && run.block === block) {
      if (run.by !== by) bad(ctx, path, `${run.by} like the parts before it on ${block}`, part);
      else run.cuts.push(take);
      return;
    }
    endRun();
    if (p.blocks[at] !== block) bad(ctx, `${path}.blocks[0]`, `the next block of the file (${p.blocks[at]})`, block);
    cutting = { block, by, cuts: [take] };
    at += 1;
  });
  endRun();
  if (at !== p.blocks.length) bad(ctx, ".parts", "parts covering every block exactly once", `${at} of ${p.blocks.length}`);
};

export const validateCards: Validator = (v, ctx) => {
  shapeOf<CardsFile>({
    v: v1,
    cards: arr(shapeOf<CardsFile["cards"][number]>({ id: id("c"), file: slugC, aliases: arr(nonEmpty), home: record(guideC, slugC) }, { in: id("c"), for: arr(slugC), classWords: arr(nonEmpty), diseases: arr(nonEmpty) })),
  }, {})(v, "", ctx);
  const cards = (v as CardsFile).cards;
  uniqueArr(str)(cards.map((c) => c.id), ".cards[].id", ctx);
  cards.forEach((c, i) => {
    if (c.for !== undefined) sectionList(c.for, `.cards[${i}].for`, ctx);
    if (c.in === undefined) return;
    const target = cards.find((x) => x.id === c.in);
    if (!target || target === c || target.in !== undefined) bad(ctx, `.cards[${i}].in`, "another card that is itself in no card", c.in);
  });
};

/** A `for` list: at least one pharm section, none twice. */
function sectionList(list: readonly string[], path: string, ctx: Ctx): void {
  if (list.length === 0) bad(ctx, path, "at least one pharm section", list);
  uniqueArr(str)(list, path, ctx);
}

export const validateUses: Validator = (v, ctx) => {
  shapeOf<UsesFile>({
    v: v1,
    lines: arr(shapeOf<UsesFile["lines"][number]>({ block: id("b"), text: nonEmpty, for: arr(slugC) }, {})),
    conditions: arr(shapeOf<UsesFile["conditions"][number]>({ guide: guideC, system: slugC, section: nullable(slugC), for: arr(slugC) }, {})),
  }, {})(v, "", ctx);
  const u = v as UsesFile;
  const seen = new Set<string>();
  u.lines.forEach((l, i) => {
    sectionList(l.for, `.lines[${i}].for`, ctx);
    const key = `${l.block}\n${l.text}`;
    if (seen.has(key)) bad(ctx, `.lines[${i}]`, "one judgment per block line", l.text);
    seen.add(key);
  });
  const sections = new Set<string>();
  u.conditions.forEach((c, i) => {
    uniqueArr(str)(c.for, `.conditions[${i}].for`, ctx);
    const key = `${c.guide}/${c.system}/${c.section}`;
    if (sections.has(key)) bad(ctx, `.conditions[${i}]`, "one entry per condition section", key);
    sections.add(key);
  });
};

export const validateTrims: Validator = (v, ctx) => {
  shapeOf<TrimsFile>({
    v: v1,
    rows: record(id("r"), str),
    lines: arr(shapeOf<TrimsFile["lines"][number]>({ block: id("b"), text: nonEmpty, label: bool, rows: arr(id("r")) }, {})),
  }, {})(v, "", ctx);
  const t = v as TrimsFile;
  const seen = new Set<string>();
  t.lines.forEach((l, i) => {
    if (l.label !== (l.rows.length === 0)) bad(ctx, `.lines[${i}].rows`, "no rows exactly when the line is a label", l.rows);
    for (const r of l.rows) if (!Object.hasOwn(t.rows, r)) bad(ctx, `.lines[${i}].rows`, "rows recorded in .rows", r);
    const key = `${l.block}\n${l.text}`;
    if (seen.has(key)) bad(ctx, `.lines[${i}]`, "one judgment per block line", l.text);
    seen.add(key);
  });
};

export const validateStructure: Validator = (v, ctx) => {
  shapeOf<StructureFile>({
    v: v1,
    sections: arr(shapeOf<StructureFile["sections"][number]>({ id: slugC, title: nonEmpty }, {})),
    members: record(id("r", "b"), str),
    listed: record(id("b"), str),
    drugTables: arr(shapeOf<StructureFile["drugTables"][number]>({ block: id("b"), pharmSection: slugC, conditionRows: uniqueArr(id("r")) }, {})),
    pharmSections: arr(shapeOf<StructureFile["pharmSections"][number]>({
      id: slugC, title: nonEmpty, tables: uniqueArr(id("b")), overview: nullable(id("p")), lo: nullable(id("p")), also: uniqueArr(id("c")),
    }, {})),
    pharmFiles: uniqueArr(id("d")),
  }, { titled: record(id("r"), either("a heading cell index or a non-empty title", int, nonEmpty)), unlisted: uniqueArr(id("r")) })(v, "", ctx);
  const s = v as StructureFile;
  for (const r of s.unlisted ?? []) {
    if (s.titled?.[r] !== undefined) bad(ctx, `.unlisted`, "rows that are not also titled", r);
  }
  const sectionIds = s.sections.map((x) => x.id);
  uniqueArr(str)(sectionIds, ".sections[].id", ctx);
  const otherAt = sectionIds.indexOf("other");
  if (otherAt !== -1 && otherAt !== sectionIds.length - 1) bad(ctx, ".sections", `"other" last`, sectionIds);
  // A value is a section id, or (rows only) the id of the topic the row is recorded under
  // (Orchestrator ruling 2026-10-04 04:44Z), or (blocks only) the listed block whose entry the block
  // is shown under; a system without sections has only the latter two.
  for (const [k, value] of Object.entries(s.members)) {
    const target = memberTarget(value);
    if ("topic" in target) {
      if (!isId("r", k) || target.topic === k) bad(ctx, `.members.${k}`, "a topic id only on another row", value);
    } else if ("listed" in target) {
      if (!isId("b", k) || s.listed[k] !== undefined || s.listed[target.listed] === undefined) {
        bad(ctx, `.members.${k}`, "a listed block id only on another, unlisted block", value);
      }
    } else if (!sectionIds.includes(target.section)) {
      bad(ctx, `.members.${k}`, sectionIds.length === 0 ? "a topic id (sections is [])" : "a section id of this system or a topic id", value);
    }
  }
  const pharmIds = s.pharmSections.map((x) => x.id);
  uniqueArr(str)(pharmIds, ".pharmSections[].id", ctx);
  uniqueArr(str)(s.drugTables.map((d) => d.block), ".drugTables[].block", ctx);
  s.drugTables.forEach((d, i) => {
    if (!pharmIds.includes(d.pharmSection)) bad(ctx, `.drugTables[${i}].pharmSection`, "a pharm section id of this system", d.pharmSection);
  });
};

// ---- places (20.8) ----------------------------------------------------------------------------

const link = shapeOf<GeneralFile["topics"][number]["links"][number]>({ target: id("r", "b"), covers: str }, {});

/** `expectId` is the guide of the file's path; the PANCE guide has no general topics. */
export const validateGeneral: Validator = (v, ctx, expectId) => {
  if (expectId === "pance") throw new ContentError(ctx.file, "the PANCE guide has no general.json");
  shapeOf<GeneralFile>({
    v: v1,
    topics: arr(shapeOf<GeneralFile["topics"][number]>({ key: oneOf(...GENERAL_KEYS), howto: nullable(nonEmpty), links: arr(link), files: uniqueArr(id("d")), gaps: uniqueArr(id("g")) }, {})),
    workup: arr(shapeOf<GeneralFile["workup"][number]>({ id: slugC, title: nonEmpty, conds: str, gap: id("g") }, {})),
  }, {})(v, "", ctx);
  const g = v as GeneralFile;
  g.topics.map((t) => GENERAL_KEYS.indexOf(t.key)).reduce((prev, k) => {
    if (k <= prev) bad(ctx, ".topics", `keys once each, in the order ${GENERAL_KEYS.join(", ")}`, g.topics.map((t) => t.key));
    return k;
  }, -1);
  uniqueArr(str)(g.workup.map((w) => w.id), ".workup[].id", ctx);
  g.workup.reduce<string | null>((prev, w) => {
    if (prev !== null && prev.localeCompare(w.title, "en", { sensitivity: "base" }) > 0) bad(ctx, ".workup", "items in alphabetical order by title", w.title);
    return w.title;
  }, null);
};

const columnC: Checker = (v, at, ctx) => {
  if (!Number.isInteger(v) || (v as number) < 1) bad(ctx, at, "a column number (1 or more)", v);
};
const rowsC: Checker = (v, at, ctx) => {
  uniqueArr(id("r"))(v, at, ctx);
  if ((v as unknown[]).length === 0) bad(ctx, at, "at least one row id", v);
};
const labelC: Checker = (v, at, ctx) => {
  if (!Number.isInteger(v) || (v as number) < 0) bad(ctx, at, "a column number (0 or more)", v);
};
const topicsC: Checker = (v, at, ctx) => {
  uniqueArr(id("r"))(v, at, ctx);
  if ((v as unknown[]).length === 0) bad(ctx, at, "at least one topic id", v);
};
/** A Word block, whole, cut to one column, or cut to some rows — not both. */
const blockNote: Checker = (v, at, ctx) => {
  shapeOf<BlockNote>({ block: id("b") }, { column: columnC, rows: rowsC })(v, at, ctx);
  const n = v as BlockNote;
  if (n.column !== undefined && n.rows !== undefined) bad(ctx, at, "column or rows, not both", v);
};
const placeNote = either(
  "a note: { heading } or { block, column? | rows? }",
  shapeOf<Extract<PlaceNote, { heading: string }>>({ heading: nonEmpty }, {}),
  blockNote,
);
const placeNotes = arr(placeNote);

const refLink = shapeOf<RefLink>({ target: id("r", "b"), covers: str }, { gap: id("g") });
/** A link's `gap` names one of its own sub's gap blocks: the section it is shown under. */
const refSub: Checker = (v, at, ctx) => {
  shapeOf<RefSub>({ id: slugC, title: nonEmpty, links: arr(refLink), gaps: uniqueArr(id("g")) }, { group: nonEmpty, intro: uniqueArr(id("g")), notes: placeNotes })(v, at, ctx);
  const sub = v as RefSub;
  sub.links.forEach((l, i) => {
    if (l.gap !== undefined && !sub.gaps.includes(l.gap)) bad(ctx, `${at}.links[${i}].gap`, "one of this sub's gaps", l.gap);
  });
  sub.intro?.forEach((g, i) => {
    if (!sub.gaps.includes(g)) bad(ctx, `${at}.intro[${i}]`, "one of this sub's gaps", g);
  });
};
/** The subs of one `group` are consecutive, so each group is listed under one heading. */
const refTab: Checker = (v, at, ctx) => {
  shapeOf<RefTab>({ subs: arr(refSub), files: uniqueArr(id("d")) }, {})(v, at, ctx);
  const ended = new Set<string>();
  (v as RefTab).subs.reduce<string | undefined>((prev, sub, i) => {
    if (sub.group !== prev) {
      if (prev !== undefined) ended.add(prev);
      if (sub.group !== undefined && ended.has(sub.group)) bad(ctx, `${at}.subs[${i}].group`, "a group's subs next to each other", sub.group);
    }
    return sub.group;
  }, undefined);
};
export const validateRefTabs: Validator = whole(shapeOf<RefTabsFile>({ v: v1, labs: refTab, imaging: refTab, ekg: refTab, anatomy: refTab }, {}));

const subFlag: Checker = (v, at, ctx) => {
  if (v !== true) bad(ctx, at, "true", v);
};
const otherNote = either(
  "an outline item: { heading, sub? }, { block, column? | rows? }, { doc }, { original }, { gap } or { link }",
  shapeOf<Extract<OtherNote, { heading: string }>>({ heading: nonEmpty }, { sub: subFlag }),
  blockNote,
  shapeOf<Extract<OtherNote, { doc: string }>>({ doc: id("d") }, {}),
  shapeOf<Extract<OtherNote, { original: string }>>({ original: id("d") }, {}),
  shapeOf<Extract<OtherNote, { gap: string }>>({ gap: id("g") }, {}),
  shapeOf<Extract<OtherNote, { link: string }>>({ link: id("r", "b") }, {}),
);

/**
 * An outline's doc, gap and link items each name an entry of the section's own list, at most once
 * per page part (an entry may recur under several headings); a sub heading follows a top heading.
 */
function checkOutline(s: OtherFile["sections"][number], at: string, ctx: Ctx): void {
  let seen = new Set<string>();
  let top = false;
  (s.notes ?? []).forEach((n, j) => {
    const here = `${at}.notes[${j}]`;
    if ("heading" in n) {
      if (n.sub && !top) bad(ctx, here, "a sub heading after a top heading", n.heading);
      if (!n.sub) top = true;
      seen = new Set();
      return;
    }
    if ("block" in n) return;
    const [list, ref] = "doc" in n ? [s.files, n.doc] : "original" in n ? [s.files, n.original] : "gap" in n ? [s.gaps ?? [], n.gap] : [s.links.map((l) => l.target), n.link];
    if (!list.includes(ref)) bad(ctx, here, "an entry of this section's own list", ref);
    if (seen.has(ref)) bad(ctx, here, "each item once per part", ref);
    seen.add(ref);
  });
}

export const validateOther: Validator = (v, ctx) => {
  shapeOf<OtherFile>({
    v: v1,
    sections: arr(shapeOf<OtherFile["sections"][number]>(
      { id: oneOf(...OTHER_SECTION_IDS), title: nonEmpty, lead: nullable(id("g")), files: uniqueArr(id("d")), links: arr(link) },
      { notes: arr(otherNote), gaps: uniqueArr(id("g")) },
    )),
  }, {})(v, "", ctx);
  const sections = (v as OtherFile).sections;
  const ids = sections.map((s) => s.id);
  if (ids.join() !== OTHER_SECTION_IDS.join()) bad(ctx, ".sections", `the 9 sections in order ${OTHER_SECTION_IDS.join(", ")}`, ids);
  sections.forEach((s, i) => {
    if (Object.hasOwn(s, "gaps") && !OTHER_GAP_SECTIONS.some((g) => g === s.id)) bad(ctx, `.sections[${i}].gaps`, `no gaps key outside ${OTHER_GAP_SECTIONS.join(", ")}`);
    if (s.lead !== null && s.id !== "vaccines") bad(ctx, `.sections[${i}].lead`, "null outside vaccines", s.lead);
    checkOutline(s, `.sections[${i}]`, ctx);
  });
};

// ---- slides (20.10), vocabulary (20.11), updates (20.12) -----------------------------------

/** `expectId` is the guide of the file's path. */
export const validateDeck: Validator = (v, ctx, expectId) => {
  shapeOf<DeckFile>({ v: v1, guide: guideC, kind: oneOf("own", "generated"), title: nonEmpty, file: nullable(id("d")), slides: uniqueArr(id("s")) }, {})(v, "", ctx);
  const d = v as DeckFile;
  expectField(ctx, "guide", d.guide, expectId);
  if ((d.kind === "own") !== (d.file !== null)) bad(ctx, ".file", "a document id exactly for an own deck", d.file);
};

export const validateVocab: Validator = whole(shapeOf<VocabFile>({
  v: v1, entries: arr(shapeOf<VocabFile["entries"][number]>({ abbr: arr(nonEmpty), meanings: arr(nonEmpty) }, {})),
}, {}));

const FLAG_SOURCES = [...FIXED_SOURCES, "cdc"] as const;
const flagSource = either(
  `${FLAG_SOURCES.join(", ")} or cite:<series>`,
  oneOf(...FLAG_SOURCES),
  (v, at, ctx) => {
    if (typeof v !== "string" || seriesOfCiteKey(v) === null) bad(ctx, at, "cite:<series>", v);
  },
);

const flagFields: { [K in keyof Omit<Flag, "locator" | "verification" | "retired">]-?: Checker } = {
  id: id("u"), kind: oneOf("rec", "edition"), source: flagSource, by: oneOf("check", "agent"), key: nonEmpty,
  subject: nullable(str), guideline: nonEmpty, org: nonEmpty, published: str, quote: nullable(str), grade: nullable(str),
  url: re(/^https?:\/\//, "an http(s) URL"), flagged: isoDate, supersededBy: nullable(id("u")),
};
/** Any flag may be retired: the guideline check found its recommendation permanently gone. */
const flagOptional = { retired: isoDate };
/** Agent-researched flags (90 §90.6) carry a locator and their verification; check flags carry neither. */
const agentFlag = shapeOf<Required<Omit<Flag, "retired">> & Pick<Flag, "retired">>({
  ...flagFields, locator: str,
  verification: shapeOf<NonNullable<Flag["verification"]>>({ verifier: nonEmpty, at: isoDate, result: oneOf("pass", "fail") }, {}),
}, flagOptional);
const checkFlag = shapeOf<Omit<Flag, "locator" | "verification">>(flagFields, flagOptional);

export const validateFlags: Validator = (v, ctx) => {
  shapeOf<FlagsFile>({ v: v1, flags: arr((f, a, c) => (isObj(f) && f.by === "agent" ? agentFlag : checkFlag)(f, a, c)) }, {})(v, "", ctx);
  uniqueArr(str)((v as FlagsFile).flags.map((f) => f.id), ".flags[].id", ctx);
};

export const validateConcepts: Validator = whole(shapeOf<ConceptsFile>({
  v: v1,
  concepts: arr(shapeOf<ConceptsFile["concepts"][number]>({ id: slugC, title: nonEmpty, sourceKeys: record(str, arr(str)), targets: arr(id("r", "b", "g", "d")) }, {})),
}, {}));

export const validateChecks: Validator = whole(shapeOf<ChecksFile>({
  v: v1, lastRun: nullable(isoDate), nextRun: nullable(isoDate),
  sources: arr(shapeOf<ChecksFile["sources"][number]>({ id: nonEmpty, lastSuccess: nullable(isoDate), lastAttempt: isoDate, status: oneOf("ok", "fail") }, {})),
  seen: record(str, (x, a, c) => { if (!isObj(x) && !Number.isInteger(x)) bad(c, a, "a year or a key → month map", x); }),
  seenUrl: record(str, str),
}, {}));
