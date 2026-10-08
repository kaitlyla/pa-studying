// The PDF document builder (plan 70): one pure function from a menu scope and the published data a
// page has loaded to a pdfmake document definition, used unchanged by the browser (app/pdf) and by
// the publish workflow (tools/pdf).
import type { DocJSON, PageSetup } from "../content/types.ts";
import { keepTableRows, noteView } from "../derive/columns.ts";
import type { FontMapJson, PartCut, PubBlock, SystemJson } from "../derive/published.ts";
import { belowUnder } from "../derive/topics.ts";
import { allLinesHidden, hiddenLines, shownParts, tableRows, withoutLines } from "../derive/trim.ts";
import type { PMNode } from "../schemaTypes.ts";
import { FontSplitter, TEXT_FAMILY } from "./fonts.ts";
import { docContent, FLOAT_ID, imagesOf, type RichEnv } from "./rich.ts";
import type { DocDefinition, ImageVariant, LaidNode, PdfInput, PdfScope } from "./types.ts";

export type { Content, DocDefinition, ImageData, ImageVariant, LaidNode, PdfInput, PdfScope } from "./types.ts";
export { imageKey } from "./types.ts";
export { EMBED_MIME, embedsAsStored, storedMime } from "./images.ts";
export { pdfFonts, CARLITO_FACES } from "./fonts.ts";

/** One stored doc with the base size its `size` marks are relative to. */
interface Part {
  doc: DocJSON;
  basePt: number;
}

interface Selection {
  page: PageSetup;
  /** The document's base size (pharm notes parts carry their own). */
  basePt: number;
  parts: Part[];
}

/** Block kinds that are her notes; gap blocks and slides never enter a PDF (70 §70.2). */
const NOTE_KINDS = new Set(["prose", "table"]);

function blockOf(system: SystemJson, id: string): PubBlock {
  const b = system.blocks.find((x) => x.id === id);
  if (!b) throw new Error(`PDF: block ${id} is not in ${system.guide}/${system.id}`);
  return b;
}

/** A table block reduced to the given rows, cut as the screen draws them (keepTableRows). */
export function keepRows(doc: DocJSON, keep: ReadonlySet<string>): DocJSON {
  const content = (doc.content as PMNode[]).map((node) =>
    node.type === "table" ? keepTableRows(node, (node.content ?? []).map((r) => keep.has(String(r.attrs?.id)))) : node);
  return { ...doc, content };
}

/** Rows grouped by their table block, blocks in the order the rows first appear. */
function rowsByBlock(system: SystemJson, rowIds: readonly string[]): { block: string; rows: Set<string> }[] {
  const groups: { block: string; rows: Set<string> }[] = [];
  for (const id of rowIds) {
    const block = system.rows[id]?.block;
    if (block === undefined) throw new Error(`PDF: row ${id} is not in ${system.guide}/${system.id}`);
    let g = groups.find((x) => x.block === block);
    if (!g) groups.push((g = { block, rows: new Set() }));
    g.rows.add(id);
  }
  return groups;
}

function pharmSectionParts(system: SystemJson, sectionId: string, guideBasePt: number): Part[] {
  const ps = system.pharm?.sections.find((s) => s.id === sectionId);
  if (!ps) throw new Error(`PDF: pharm section ${sectionId} is not in ${system.guide}/${system.id}`);
  /** A part's notes blocks as the page shows them: cut as the part says (noteView), less the hidden lines. */
  const notes = (p: { blocks: readonly string[]; basePt: number } & PartCut, hidden?: ReadonlyMap<string, ReadonlySet<number>>): Part[] =>
    p.blocks.flatMap((id) => {
      const b = system.notesBlocks[id];
      if (!b) throw new Error(`PDF: pharm notes block ${id} is missing from ${system.guide}/${system.id}`);
      const view = noteView(withoutLines(b.doc, hidden?.get(id)), p, { firstRow: false });
      if (!view) return [];
      // A column cut is shown under its column's first-row text, as on the page.
      const title: Part[] = view.title === null ? [] : [{ doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: view.title }] }] }, basePt: p.basePt }];
      return [...title, { doc: view.doc, basePt: p.basePt }];
    });
  const part = (id: string | null): Part[] => {
    if (id === null) return [];
    const p = system.parts[id];
    if (!p) throw new Error(`PDF: pharm part ${id} is missing from ${system.guide}/${system.id}`);
    return notes(p);
  };
  const out: Part[] = [];
  // Her drug tables in full, then Overview, the class cards (table cards then "also"), then the LO block.
  for (const t of ps.tables) out.push({ doc: blockOf(system, t).doc, basePt: guideBasePt });
  out.push(...part(ps.overview));
  // Each card brings only the notes written for this section's use, less what the tables above
  // already say, as on the page.
  const shown = tableRows(system, ps.tables);
  const at = new Set([ps.id]);
  for (const c of ps.cards) {
    const card = system.cards[c];
    if (!card) throw new Error(`PDF: card ${c} is missing from ${system.guide}/${system.id}`);
    const parts = shownParts(card, at);
    const blocks = parts.flatMap((p) => p.blocks);
    const hidden = hiddenLines(system, blocks, shown, at);
    if (allLinesHidden(system, blocks, hidden)) continue;
    for (const p of parts) out.push(...notes(p, hidden));
  }
  out.push(...part(ps.lo));
  return out;
}

function select(scope: PdfScope, input: PdfInput): Selection {
  if ("doc" in input) {
    if (scope.kind !== "doc") throw new Error(`PDF: scope ${scope.kind} needs guide data`);
    const { doc } = input;
    if (!doc.blocks || !doc.page || doc.basePt === undefined) throw new Error(`PDF: document ${doc.id} is not a Word page`);
    return { page: doc.page, basePt: doc.basePt, parts: doc.blocks.filter((b) => NOTE_KINDS.has(b.kind)).map((b) => ({ doc: b.doc, basePt: doc.basePt as number })) };
  }
  const { nav } = input;
  const base = { page: nav.page, basePt: nav.basePt };
  if ("home" in input) {
    if (scope.kind !== "preamble") throw new Error(`PDF: scope ${scope.kind} needs system data`);
    return { ...base, parts: input.home.preamble.filter((b) => NOTE_KINDS.has(b.kind)).map((b) => ({ doc: b.doc, basePt: nav.basePt })) };
  }
  const { system } = input;
  const guideBlock = (b: PubBlock): Part => ({ doc: b.doc, basePt: nav.basePt });
  const rowsPart = (rowIds: readonly string[]): Part[] =>
    rowsByBlock(system, rowIds).map((g) => ({ doc: keepRows(blockOf(system, g.block).doc, g.rows), basePt: nav.basePt }));
  switch (scope.kind) {
    case "topics":
      return {
        ...base,
        parts: scope.ids.flatMap((id) => {
          const topic = system.topics.find((t) => t.id === id);
          if (!topic) throw new Error(`PDF: topic ${id} is not in ${system.guide}/${system.id}`);
          // Her below block follows the topic's rows (meds panels are never in PDFs).
          return topic.below ? [...rowsPart(topic.rows), guideBlock(topic.below)] : rowsPart(topic.rows);
        }),
      };
    case "section": {
      const section = system.sections.find((s) => s.id === scope.id);
      if (!section) throw new Error(`PDF: section ${scope.id} is not in ${system.guide}/${system.id}`);
      return {
        ...base,
        parts: section.items.flatMap((item) =>
          item.rows === null ? [guideBlock(blockOf(system, item.block))] : [...rowsPart(item.rows), ...belowUnder(system.topics, item.rows).map(guideBlock)]),
      };
    }
    case "system": {
      // Every block in guide order; drug tables in full at their place (pdf/rules/druginpdf), each
      // table followed by the below blocks of the topics ending in it.
      const rows = new Map<string, string[]>();
      for (const [id, r] of Object.entries(system.rows)) rows.set(r.block, [...(rows.get(r.block) ?? []), id]);
      return {
        ...base,
        parts: system.blocks.filter((b) => NOTE_KINDS.has(b.kind)).flatMap((b) => [guideBlock(b), ...belowUnder(system.topics, rows.get(b.id) ?? []).map(guideBlock)]),
      };
    }
    case "pharmSection":
      return { ...base, parts: pharmSectionParts(system, scope.id, nav.basePt) };
    case "systemPharm":
      return { ...base, parts: (system.pharm?.sections ?? []).flatMap((s) => pharmSectionParts(system, s.id, nav.basePt)) };
    default:
      throw new Error(`PDF: scope ${scope.kind} does not read system data`);
  }
}

/** Every image variant the scope's content references, for the environment to load. */
export function imageRequests(scope: PdfScope, input: PdfInput): ImageVariant[] {
  const found = new Map<string, ImageVariant>();
  for (const p of select(scope, input).parts) imagesOf(p.doc, found);
  return [...found.values()];
}

const FORBIDDEN = /[\\/:*?"<>|]/g;

function cleanName(s: string, max?: number): string {
  const cleaned = s.replace(FORBIDDEN, "-");
  return max === undefined ? cleaned : Array.from(cleaned).slice(0, max).join("");
}

const stem = (file: string): string => file.replace(/\.[^.]+$/, "");

/** The scope's title as used in its file name (70 §70.2). */
export function scopeTitle(scope: PdfScope, input: PdfInput): string {
  if ("doc" in input) return input.doc.name;
  if ("home" in input) return input.nav.title;
  const { system } = input;
  switch (scope.kind) {
    case "topics":
      return scope.ids.length === 1 ? (system.topics.find((t) => t.id === scope.ids[0])?.title ?? "") : `${scope.ids.length} topics`;
    case "section":
      return system.sections.find((s) => s.id === scope.id)?.title ?? "";
    case "pharmSection":
      return system.pharm?.sections.find((s) => s.id === scope.id)?.title ?? "";
    case "systemPharm":
      return `${system.title} pharm`;
    default:
      return system.title;
  }
}

/** `<guide source name without extension> - <scope title>.pdf`; a Word page is `<name>.pdf`. */
export function pdfFileName(scope: PdfScope, input: PdfInput): string {
  if ("doc" in input) return `${cleanName(input.doc.name)}.pdf`;
  return `${stem(input.nav.source)} - ${cleanName(scopeTitle(scope, input), 80)}.pdf`;
}

/** The whole-guide release asset: the guide's source name, spaces as "-" (70 §70.5). */
export function wholeGuideAsset(source: string): string {
  return `${stem(source).replace(/ /g, "-")}.pdf`;
}

/** The "Whole guide" link: the latest release asset of `pdf-<g>`. */
export function wholeGuideUrl(repo: string, guide: string, source: string): string {
  return `https://github.com/${repo}/releases/download/pdf-${guide}/${encodeURIComponent(wholeGuideAsset(source))}`;
}

function definition(scope: PdfScope, data: PdfInput, fontmap: FontMapJson, lifts: ReadonlyMap<string, number>): { def: DocDefinition; floats: number } {
  const sel = select(scope, data);
  const { page } = sel;
  const env: RichEnv = { fonts: new FontSplitter(fontmap), images: data.images ?? {}, used: new Set(), pendingBreak: false, floats: 0, lifts };
  const width = page.widthPt - page.margins.left - page.margins.right;
  const content = sel.parts.flatMap((p) => docContent(p.doc, p.basePt, width, env));
  const images: Record<string, string> = {};
  for (const key of env.used) images[key] = env.images[key] as string;
  const def: DocDefinition = {
    pageSize: { width: page.widthPt, height: page.heightPt },
    pageMargins: [page.margins.left, page.margins.top, page.margins.right, page.margins.bottom],
    content,
    defaultStyle: { font: TEXT_FAMILY, fontSize: sel.basePt },
    images,
    info: { title: "doc" in data ? data.doc.name : `${stem(data.nav.source)} - ${scopeTitle(scope, data)}` },
  };
  return { def, floats: env.floats };
}

/**
 * The pdfmake document definition of a scope (70 §70.1–§70.4). `lifts`: how far up each floating
 * picture is drawn so that it ends on its page (floatLifts of a first layout; see renderPdf).
 */
export function buildDocDefinition(scope: PdfScope, data: PdfInput, fontmap: FontMapJson, lifts: ReadonlyMap<string, number> = new Map()): DocDefinition {
  return definition(scope, data, fontmap, lifts).def;
}

/**
 * How far up each floating picture laid out at `laid` (by id) must be drawn to end within its page's
 * inner area: by as much as it runs past the bottom, but never above the top. Pictures that fit are
 * not listed.
 */
export function floatLifts(laid: ReadonlyMap<string, LaidNode>): Map<string, number> {
  const lifts = new Map<string, number>();
  for (const [id, node] of laid) {
    const at = node.startPosition;
    const innerTop = at.top - at.verticalRatio * at.pageInnerHeight;
    const over = at.top + (node.height ?? 0) - (innerTop + at.pageInnerHeight);
    const lift = Math.min(over, at.top - innerTop);
    if (lift > 0.01) lifts.set(id, lift);
  }
  return lifts;
}

/**
 * Makes a scope's PDF with pdfmake (`create`, whose result renders on getBuffer and keeps what it
 * rendered). Floating pictures are drawn on their anchors' pages wherever they fall, so where one runs
 * past its page's end is known only once laid out: such a PDF is laid out once to read back where each
 * picture fell, and made again with those pictures lifted (moving them moves nothing else, as they take
 * no room). One without floating pictures, or whose pictures all fit, is made once.
 */
export async function renderPdf<T extends { getBuffer(): Promise<unknown> }>(scope: PdfScope, data: PdfInput, fontmap: FontMapJson, create: (def: DocDefinition) => T): Promise<T> {
  const { def, floats } = definition(scope, data, fontmap, new Map());
  if (floats === 0) return create(def);
  const laid = new Map<string, LaidNode>();
  def.pageBreakBefore = (node) => {
    if (node.id?.startsWith(FLOAT_ID)) laid.set(node.id, node);
    return false;
  };
  const first = create(def);
  await first.getBuffer();
  const lifts = floatLifts(laid);
  return lifts.size === 0 ? first : create(buildDocDefinition(scope, data, fontmap, lifts));
}
