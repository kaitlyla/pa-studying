// Validators for every stored record (plan 20). Each takes the parsed JSON, a context naming the
// file and, where the file's path fixes the record's identity, the expected id; it throws a
// ContentError on the first violation. Nothing is ever repaired. Record shapes are keyed to the
// interfaces in types.ts through `shapeOf`, so a field added to a type must be validated too.
import { Node } from "prosemirror-model";
import { schema } from "../schema.ts";
import {
  arr, bad, ContentError, either, int, isNull, isObj, isoDate, isoUtc, ISO_MONTH_RE, nonEmpty, nullable,
  num, one, oneOf, re, record, shapeOf, str, uniqueArr,
} from "./check.ts";
import type { Checker, Ctx } from "./check.ts";
import { idRegExp, isId, memberTarget, seriesOfCiteKey, SLUG_RE } from "./ids.ts";
import type { IdPrefix } from "./ids.ts";
import { FIXED_SOURCES, GENERAL_KEYS, GUIDE_IDS, OTHER_SECTION_IDS, UPLOAD_EXTS } from "./types.ts";
import type {
  AsIsFile, BlockFile, BlockKind, CardsFile, ChecksFile, ConceptsFile, DeckFile, EvidenceFile, FileText, Flag,
  FlagsFile, GapFile, GapMeta, GapSource, GeneralFile, GuideFile, OtherFile, PageSetup, PharmFile, PharmPart,
  RefTab, RefTabsFile, Removed, Replacing, SiteFile, SlideMeta, StructureFile, SystemFile, Track, TrackBase,
  UploadFile, VocabFile, WordDocFile,
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
 * exactly what the schema serializes back, so every stored doc round-trips with no change.
 */
export function checkDoc(doc: unknown, at: string, ctx: Ctx): Node {
  const node = parseDoc(doc, at, ctx.file);
  if (node.type.name !== "doc") bad(ctx, at, "a doc node");
  if (JSON.stringify(node.toJSON()) !== JSON.stringify(doc)) {
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
 * Parse and check the doc at field `at`, returning the schema's own serialization (attribute
 * defaults filled in, schema key order).
 */
export function normalizeDoc(doc: unknown, at: string, file: string): unknown {
  checkKnownKeys(doc, at, file);
  return parseDoc(doc, at, file).toJSON();
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

export const validateGap: Validator = (v, ctx, expectId) => {
  shapeOf<GapFile>({
    v: v1, id: id("g"), kind: one("gap"), doc: anyValue,
    meta: shapeOf<GapMeta>({
      title: nonEmpty, relevantTo: str, written: month,
      differs: nullable(shapeOf<NonNullable<GapMeta["differs"]>>({ doc: anyValue }, {})),
      sources: arr(gapSource), ownerEdits: arr(isoDate),
    }, {}),
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

export const validateWordDoc: Validator = (v, ctx, expectId) => {
  shapeOf<WordDocFile>(
    { v: v1, id: id("d"), name: nonEmpty, kind: one("word"), source: nonEmpty, page, basePt: num, blocks: uniqueArr(id("b")), removed },
    { replacing },
  )(v, "", ctx);
  expectField(ctx, "id", (v as WordDocFile).id, expectId);
};

export const validateAsIsFile: Validator = (v, ctx, expectId) => {
  shapeOf<AsIsFile>(
    { v: v1, id: id("d"), name: nonEmpty, kind: oneOf("word", "pdf", "image", "slides"), original: nonEmpty, view: nullable(nonEmpty), removed },
    { pages: nullable(int), text: nullable(one("text.json")), state: oneOf("processing", "ready", "failed"), replacing },
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

export const validatePharmFile: Validator = (v, ctx, expectId) => {
  shapeOf<PharmFile>({
    v: v1, id: slugC, fileName: nonEmpty, basePt: num, blocks: uniqueArr(id("b")),
    parts: arr(shapeOf<PharmPart>({ id: id("p"), role: oneOf("overview", "lo", "card"), title: str, card: nullable(id("c")), blocks: arr(id("b")) }, {})),
  }, {})(v, "", ctx);
  const p = v as PharmFile;
  expectField(ctx, "id", p.id, expectId);
  uniqueArr(str)(p.parts.map((x) => x.id), ".parts[].id", ctx);
  let at = 0;
  p.parts.forEach((part, i) => {
    if (part.blocks.length === 0) bad(ctx, `.parts[${i}].blocks`, "a non-empty slice");
    if ((part.role === "card") !== (part.card !== null)) bad(ctx, `.parts[${i}].card`, "a card id exactly when role is card", part.card);
    if (part.role === "overview" && i !== 0) bad(ctx, `.parts[${i}].role`, "overview only as the first part", part.role);
    part.blocks.forEach((b, j) => {
      if (p.blocks[at + j] !== b) bad(ctx, `.parts[${i}].blocks[${j}]`, `the next block of the file (${p.blocks[at + j]})`, b);
    });
    at += part.blocks.length;
  });
  if (at !== p.blocks.length) bad(ctx, ".parts", "parts covering every block exactly once", `${at} of ${p.blocks.length}`);
};

export const validateCards: Validator = (v, ctx) => {
  shapeOf<CardsFile>({
    v: v1,
    cards: arr(shapeOf<CardsFile["cards"][number]>({ id: id("c"), file: slugC, aliases: arr(nonEmpty), home: record(guideC, slugC) }, {})),
  }, {})(v, "", ctx);
  uniqueArr(str)((v as CardsFile).cards.map((c) => c.id), ".cards[].id", ctx);
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
  }, {})(v, "", ctx);
  const s = v as StructureFile;
  const sectionIds = s.sections.map((x) => x.id);
  uniqueArr(str)(sectionIds, ".sections[].id", ctx);
  const otherAt = sectionIds.indexOf("other");
  if (otherAt !== -1 && otherAt !== sectionIds.length - 1) bad(ctx, ".sections", `"other" last`, sectionIds);
  // A value is a section id, or (rows only) the id of the topic the row is recorded under
  // (Orchestrator ruling 2026-10-04 04:44Z); a system without sections has only the latter.
  for (const [k, value] of Object.entries(s.members)) {
    const target = memberTarget(value);
    if ("topic" in target) {
      if (!isId("r", k) || target.topic === k) bad(ctx, `.members.${k}`, "a topic id only on another row", value);
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

const refTab = shapeOf<RefTab>({ subs: arr(shapeOf<RefTab["subs"][number]>({ id: slugC, title: nonEmpty, links: arr(link), gaps: uniqueArr(id("g")) }, {})), files: uniqueArr(id("d")) }, {});
export const validateRefTabs: Validator = whole(shapeOf<RefTabsFile>({ v: v1, labs: refTab, imaging: refTab, ekg: refTab, anatomy: refTab }, {}));

export const validateOther: Validator = (v, ctx) => {
  shapeOf<OtherFile>({
    v: v1,
    sections: arr(shapeOf<OtherFile["sections"][number]>(
      { id: oneOf(...OTHER_SECTION_IDS), title: nonEmpty, lead: nullable(id("g")), files: uniqueArr(id("d")), links: arr(link) },
      { gaps: uniqueArr(id("g")) },
    )),
  }, {})(v, "", ctx);
  const sections = (v as OtherFile).sections;
  const ids = sections.map((s) => s.id);
  if (ids.join() !== OTHER_SECTION_IDS.join()) bad(ctx, ".sections", `the 9 sections in order ${OTHER_SECTION_IDS.join(", ")}`, ids);
  sections.forEach((s, i) => {
    if (Object.hasOwn(s, "gaps") && s.id !== "legal" && s.id !== "screenings") bad(ctx, `.sections[${i}].gaps`, "no gaps key outside legal and screenings");
    if (s.lead !== null && s.id !== "vaccines") bad(ctx, `.sections[${i}].lead`, "null outside vaccines", s.lead);
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
