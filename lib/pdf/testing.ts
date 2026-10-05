// Test fixtures for lib/pdf and tools/pdf: published data shaped as tools/build writes it (40 §40.8),
// a font map built from the vendored fonts' cmaps the way 70 §70.4 specifies, and text extraction
// from a document definition.
import { join } from "node:path";
import * as fontkit from "fontkit";
import type { DocJSON, PageSetup } from "../content/types.ts";
import type { DocJson, FontMapJson, HomeJson, NavJson, PubBlock, PubRow, SystemJson } from "../derive/published.ts";
import { FONTS, isVariationSelector } from "../fonts.ts";
import type { Content } from "./types.ts";

export const FONTS_DIR = join(import.meta.dirname, "..", "..", "app", "public", "fonts");

/** For every code point of `texts` (variation selectors and line breaks excluded), the first font whose cmap has it. */
export function fontmapFor(texts: readonly string[]): FontMapJson {
  const fonts = FONTS.map((f) => fontkit.openSync(join(FONTS_DIR, f.file)));
  const map: Record<string, number> = {};
  for (const t of texts) {
    for (const ch of t) {
      const cp = ch.codePointAt(0) ?? 0;
      if (isVariationSelector(cp) || cp === 9 || cp === 10) continue;
      const i = fonts.findIndex((f) => f.hasGlyphForCodePoint(cp));
      map[String(cp)] = i === -1 ? FONTS.length - 1 : i;
    }
  }
  return { fonts: FONTS.map((f) => ({ ...f })), map };
}

// ---- rich text builders -------------------------------------------------------------------------

type Mark = { type: string; attrs?: Record<string, unknown> };
type Node = { type: string; attrs?: Record<string, unknown>; content?: Node[]; text?: string; marks?: Mark[] };

export const txt = (text: string, marks?: Mark[]): Node => (marks ? { type: "text", text, marks } : { type: "text", text });
export const para = (content: string | Node[], attrs: Record<string, unknown> = {}): Node => ({
  type: "paragraph",
  attrs,
  content: typeof content === "string" ? (content === "" ? [] : [txt(content)]) : content,
});
export const doc = (...content: Node[]): DocJSON => ({ type: "doc", content });

const BORDER = { style: "single", widthPt: 0.5, color: "000000" };
export const ALL_BORDERS = { top: BORDER, right: BORDER, bottom: BORDER, left: BORDER, insideH: BORDER, insideV: BORDER };

export const cell = (text: string, attrs: Record<string, unknown> = {}): Node => ({ type: "table_cell", attrs, content: [para(text)] });
export const row = (id: string, kind: "heading" | "content", cells: (string | Node)[], attrs: Record<string, unknown> = {}): Node => ({
  type: "table_row",
  attrs: { id, kind, ...attrs },
  content: cells.map((c) => (typeof c === "string" ? cell(c) : c)),
});
export const table = (grid: number[], rows: Node[], attrs: Record<string, unknown> = {}): Node => ({
  type: "table",
  attrs: { grid, indentPt: 0, borders: ALL_BORDERS, cellMarginPt: { top: 0, right: 5.4, bottom: 0, left: 5.4 }, ...attrs },
  content: rows,
});

export const block = (id: string, kind: PubBlock["kind"], d: DocJSON): PubBlock => ({ id, kind, doc: d });

// ---- a published guide ----------------------------------------------------------------------------

export const PAGE: PageSetup = { widthPt: 792, heightPt: 612, margins: { top: 36, right: 36, bottom: 36, left: 36 } };

/** Text that must never reach a PDF: site labels, section names, meds panels, update notes, gap blocks, slides. */
export const FORBIDDEN = [
  "SECTIONNAME",
  "PHARMSECTIONTITLE",
  "CARDTITLE",
  "PARTTITLE",
  "MEDSPANEL",
  "UPDATENOTE",
  "UPDATEQUOTE",
  "GAPBLOCK",
  "SLIDETEXT",
  "drug table — in",
  "Treats",
  "Pharm files",
];

export const R = {
  h1: "r_AAAAAAAAH1",
  a: "r_AAAAAAAAA1",
  a2: "r_AAAAAAAAA2",
  b: "r_AAAAAAAAB1",
  dh: "r_AAAAAAAADH",
  d1: "r_AAAAAAAAD1",
  d2: "r_AAAAAAAAD2",
  eh: "r_AAAAAAAAEH",
  e1: "r_AAAAAAAAE1",
};

export function fmNav(): NavJson {
  return {
    guide: "fm",
    title: "Family Medicine",
    source: "Family Medicine EOR.docx",
    page: PAGE,
    basePt: 10,
    systems: [
      { id: "cardiovascular", title: "Cardiovascular", pct: "15%", sections: [], entries: [], pharm: null },
      { id: "pulmonary", title: "Pulmonary", pct: "12%", sections: [], entries: [], pharm: null },
    ],
    general: [],
    slides: null,
    sidebarEnd: null,
    removed: [],
    pending: [],
  };
}

export function fmHome(): HomeJson {
  return {
    guide: "fm",
    title: "Family Medicine",
    preamble: [block("b_AAAAAAAPR1", "prose", doc(para("Preamble title page")))],
    systems: [],
    notes: {},
  };
}

/** Cardiovascular: prose, a topic table, a drug table, a listed prose block, a second drug table. */
export function cardioSystem(): SystemJson {
  const blocks: PubBlock[] = [
    block("b_AAAAAAAAP1", "prose", doc(para("Intro ⊕ → ➀ ▪️ item"))),
    block(
      "b_AAAAAAAAT1",
      "table",
      doc(
        table([72, 216, 216], [
          row(R.h1, "heading", ["CARDIO LABEL", "About", "Dx"], { repeatHeader: true }),
          row(R.a, "content", ["Angina", "chest pain", "ECG"]),
          row(R.a2, "content", ["", "radiates", "troponin"]),
          row(R.b, "content", ["Myocarditis: viral/other", "viral", "MRI"]),
        ]),
      ),
    ),
    block("b_AAAAAAAAD1", "table", doc(table([100, 200], [row(R.dh, "heading", ["ANTIANGINAL", "Use"]), row(R.d1, "content", ["Nitrates", "angina"]), row(R.d2, "content", ["CCB", "HTN"])]))),
    block("b_AAAAAAAAP2", "prose", doc(para("Murmurs note"))),
    block("b_AAAAAAAAD2", "table", doc(table([100, 200], [row(R.eh, "heading", ["HF PHARM", "Use"]), row(R.e1, "content", ["Loop diuretics", "edema"])]))),
    // Kinds that never belong in a guide PDF, present to prove the filter.
    block("g_AAAAAAAAG1", "gap", doc(para("GAPBLOCK text"))),
    block("s_AAAAAAAAS1", "slide", doc(para("SLIDETEXT"))),
  ];
  const rowInfo = (blockId: string, kind: "heading" | "content", heading: string | null, topic: string | null): PubRow => ({ block: blockId, kind, heading, topic });
  return {
    guide: "fm",
    id: "cardiovascular",
    title: "Cardiovascular",
    pct: "15%",
    blocks,
    rows: {
      [R.h1]: rowInfo("b_AAAAAAAAT1", "heading", R.h1, null),
      [R.a]: rowInfo("b_AAAAAAAAT1", "content", R.h1, R.a),
      [R.a2]: rowInfo("b_AAAAAAAAT1", "content", R.h1, R.a),
      [R.b]: rowInfo("b_AAAAAAAAT1", "content", R.h1, R.b),
      [R.dh]: rowInfo("b_AAAAAAAAD1", "heading", R.dh, null),
      [R.d1]: rowInfo("b_AAAAAAAAD1", "content", R.dh, null),
      [R.d2]: rowInfo("b_AAAAAAAAD1", "content", R.dh, null),
      [R.eh]: rowInfo("b_AAAAAAAAD2", "heading", R.eh, null),
      [R.e1]: rowInfo("b_AAAAAAAAD2", "content", R.eh, null),
    },
    headings: { [R.h1]: { label: "CARDIO LABEL", columns: ["About", "Dx"] } },
    topics: [
      { id: R.a, title: "Angina", section: "cad", condition: false, rows: [R.h1, R.a, R.a2], meds: [{ card: "c_AAAAAAAAC1", title: "MEDSPANEL Nitrates", rows: [R.dh, R.d1], section: "antianginals", target: "c_AAAAAAAAC1" }], below: null },
      { id: R.b, title: "Myocarditis: viral/other", section: "inf", condition: false, rows: [R.h1, R.b], meds: [], below: null },
    ],
    stubs: {
      b_AAAAAAAAD1: { label: "ANTIANGINAL", section: "antianginals" },
      b_AAAAAAAAD2: { label: "HF PHARM", section: "hf" },
    },
    sections: [
      { id: "cad", title: "Coronary artery disease SECTIONNAME", items: [{ block: "b_AAAAAAAAT1", rows: [R.h1, R.a, R.a2] }, { block: "b_AAAAAAAAP2", rows: null }] },
      { id: "inf", title: "Inflammatory SECTIONNAME", items: [{ block: "b_AAAAAAAAT1", rows: [R.h1, R.b] }] },
    ],
    pharm: {
      sections: [
        { id: "antianginals", title: "Antianginals PHARMSECTIONTITLE", tables: ["b_AAAAAAAAD1"], cards: ["c_AAAAAAAAC1", "c_AAAAAAAAC2"], alsoFrom: 1, overview: "p_AAAAAAAAOV", lo: "p_AAAAAAAALO", treats: [R.a] },
        { id: "hf", title: "Heart failure PHARMSECTIONTITLE", tables: ["b_AAAAAAAAD2"], cards: ["c_AAAAAAAAC1"], alsoFrom: 1, overview: null, lo: null, treats: [] },
      ],
      files: { files: [{ id: "d_AAAAAAAAF1", name: "Pharm files doc", kind: "pdf", route: "#/file/d_AAAAAAAAF1" }], removed: [], pending: [] },
    },
    cards: {
      c_AAAAAAAAC1: { title: "CARDTITLE Nitrates", file: "cardio med list", basePt: 11, blocks: ["b_AAAAAAAAN1"], parts: [{ id: "p_AAAAAAAAN1", blocks: ["b_AAAAAAAAN1"], file: "cardio med list", basePt: 11 }] },
      c_AAAAAAAAC2: { title: "CARDTITLE Also", file: "cardio med list", basePt: 11, blocks: ["b_AAAAAAAAN2"], parts: [{ id: "p_AAAAAAAAN2", blocks: ["b_AAAAAAAAN2"], file: "cardio med list", basePt: 11 }] },
    },
    parts: {
      p_AAAAAAAAOV: { title: "Overview PARTTITLE", role: "overview", file: "cardio med list", basePt: 11, blocks: ["b_AAAAAAAAOV"] },
      p_AAAAAAAALO: { title: "LO PARTTITLE", role: "lo", file: "cardio med list", basePt: 11, blocks: ["b_AAAAAAAALO"] },
    },
    notesBlocks: {
      b_AAAAAAAAN1: block("b_AAAAAAAAN1", "prose", doc(para("Nitrates notes"))),
      b_AAAAAAAAN2: block("b_AAAAAAAAN2", "prose", doc(para("Also class notes"))),
      b_AAAAAAAAOV: block("b_AAAAAAAAOV", "prose", doc(para("Overview notes"))),
      b_AAAAAAAALO: block("b_AAAAAAAALO", "prose", doc(para("Learning objectives notes"))),
    },
    trims: {},
    notes: { [R.a]: [{ id: "u_AAAAAAAAU1", guideline: "UPDATENOTE guideline", org: "USPSTF", published: "2024-04", quote: "UPDATEQUOTE", grade: "B", url: "https://example.org", flagged: "2026-10-01" }] },
  };
}

/** Pulmonary: one prose block. */
export function pulmSystem(): SystemJson {
  return {
    guide: "fm",
    id: "pulmonary",
    title: "Pulmonary",
    pct: "12%",
    blocks: [block("b_AAAAAAAPU1", "prose", doc(para("Asthma notes")))],
    rows: {},
    headings: {},
    topics: [],
    stubs: {},
    sections: [],
    pharm: null,
    cards: {},
    parts: {},
    notesBlocks: {},
    trims: {},
    notes: {},
  };
}

export function wordDoc(): DocJson {
  return {
    id: "d_AAAAAAAAW1",
    name: "Vaccine notes: 2024/25",
    kind: "word",
    basePt: 11,
    page: { widthPt: 612, heightPt: 792, margins: { top: 72, right: 72, bottom: 72, left: 72 } },
    blocks: [block("b_AAAAAAAAW1", "prose", doc(para("Vaccine page text")))],
    notes: {},
  };
}

// ---- reading a definition ---------------------------------------------------------------------------

/** Every text inline of a definition, in document order. */
export function inlines(node: unknown, out: Content[] = []): Content[] {
  if (Array.isArray(node)) {
    for (const n of node) inlines(n, out);
  } else if (node && typeof node === "object") {
    const n = node as Content;
    if (typeof n.text === "string") out.push(n);
    else if (n.text !== undefined) inlines(n.text, out);
    for (const key of ["content", "stack", "columns", "table", "body"]) if (n[key] !== undefined) inlines(n[key], out);
  }
  return out;
}

/** The text of each paragraph-level text node, trimmed, empty ones dropped. */
export function lines(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const n of node) lines(n, out);
  } else if (node && typeof node === "object") {
    const n = node as Content;
    if (Array.isArray(n.text)) {
      const s = (n.text as Content[]).map((i) => String(i.text)).join("").trim();
      if (s !== "") out.push(s);
    }
    for (const key of ["content", "stack", "columns", "table", "body"]) if (n[key] !== undefined) lines(n[key], out);
  }
  return out;
}
