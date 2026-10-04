// Comparison (30 §30.13): the extractor's expected atoms against the stored content, read through
// lib/content. Every difference is a discrepancy; the report lists them all.
import { createHash } from "node:crypto";
import sharp from "sharp";
import type { DocJSON } from "../../lib/content/types.ts";
import type { Atoms, CharAtom, PicAtom, Story } from "./extract.ts";

export interface Discrepancy {
  kind: string;
  story: string;
  index: number;
  expected: unknown;
  actual: unknown;
}

export interface Counts {
  stories: number;
  paragraphs: number;
  characters: number;
  pictures: number;
  tables: number;
  rows: number;
  textboxes: number;
  drawings: number;
  markers: number;
}

type N = Record<string, unknown>;

interface SPara {
  text: string;
  marker: string | null;
  indLeft: number;
  indFirst: number;
  indRight: number;
  chars: { s: string; marks: N[] | null }[];
}

interface SPic {
  asset: string;
  widthPt: number | null;
  heightPt: number | null;
}

interface STable {
  depth: number;
  rows: number[];
  fills: (string | null)[][];
}

interface SStory {
  paragraphs: SPara[];
  pictures: SPic[];
  tables: STable[];
}

interface Stored {
  main: SStory;
  textboxes: SStory[];
  groupTexts: SStory[];
  drawings: number;
}

const newStory = (): SStory => ({ paragraphs: [], pictures: [], tables: [] });

/** Reads stored docs into stories: the main flow, then text boxes and group texts in document order. */
export function readStored(docs: DocJSON[]): Stored {
  const out: Stored = { main: newStory(), textboxes: [], groupTexts: [], drawings: 0 };
  const para = (n: N, story: SStory): void => {
    const attrs = (n.attrs ?? {}) as N;
    const chars: SPara["chars"] = [];
    for (const c of (n.content ?? []) as N[]) {
      if (c.type === "text") for (const u of (c.text as string).split("")) chars.push({ s: u, marks: (c.marks ?? []) as N[] });
      else if (c.type === "hard_break" || c.type === "page_break") chars.push({ s: "\n", marks: null });
      else if (c.type === "image") {
        const a = c.attrs as N;
        story.pictures.push({ asset: a.asset as string, widthPt: a.widthPt as number, heightPt: a.heightPt as number });
      }
    }
    const marker = attrs.marker as N | null | undefined;
    story.paragraphs.push({
      text: chars.map((c) => c.s).join("").normalize("NFC"),
      marker: marker ? (marker.text as string) : null,
      indLeft: (attrs.indLeft as number) ?? 0,
      indFirst: (attrs.indFirst as number) ?? 0,
      indRight: (attrs.indRight as number) ?? 0,
      chars,
    });
  };
  const walk = (nodes: N[], story: SStory, depth: number): void => {
    for (const n of nodes) {
      switch (n.type) {
        case "paragraph": case "heading_line":
          para(n, story);
          break;
        case "table": {
          const rows = (n.content ?? []) as N[];
          story.tables.push({
            depth,
            rows: rows.map((r) => ((r.content ?? []) as N[]).length),
            fills: rows.map((r) => ((r.content ?? []) as N[]).map((c) => ((c.attrs as N | undefined)?.fill as string | null) ?? null)),
          });
          for (const r of rows) for (const c of (r.content ?? []) as N[]) walk((c.content ?? []) as N[], story, depth + 1);
          break;
        }
        case "image_block": {
          const a = n.attrs as N;
          story.pictures.push({ asset: a.asset as string, widthPt: a.widthPt as number, heightPt: a.heightPt as number });
          break;
        }
        case "textbox": {
          const s = newStory();
          out.textboxes.push(s);
          walk((n.content ?? []) as N[], s, 0);
          break;
        }
        case "drawing": {
          out.drawings++;
          for (const sh of ((n.attrs as N).shapes ?? []) as N[]) {
            if (sh.asset) story.pictures.push({ asset: sh.asset as string, widthPt: null, heightPt: null });
          }
          for (const t of (n.content ?? []) as N[]) {
            const s = newStory();
            out.groupTexts.push(s);
            walk((t.content ?? []) as N[], s, 0);
          }
          break;
        }
        default:
          walk((n.content ?? []) as N[], story, depth);
      }
    }
  };
  for (const d of docs) walk(d.content as N[], out.main, 0);
  return out;
}

/**
 * Greedy alignment with look-ahead: pairs equal keys and reports unmatched items on either side. When
 * neither item recurs within the window the two are paired as a substitution, so callers must compare
 * each pair's contents.
 */
export function align(a: string[], b: string[], window = 200): { pairs: [number, number][]; missing: number[]; extra: number[] } {
  const pairs: [number, number][] = [];
  const missing: number[] = [];
  const extra: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { pairs.push([i++, j++]); continue; }
    let da = -1;
    let db = -1;
    for (let d = 1; d <= window && (da < 0 || db < 0); d++) {
      if (da < 0 && i + d < a.length && a[i + d] === b[j]) da = d;
      if (db < 0 && j + d < b.length && a[i] === b[j + d]) db = d;
    }
    if (da > 0 && (db < 0 || da <= db)) { for (let k = 0; k < da; k++) missing.push(i++); }
    else if (db > 0) { for (let k = 0; k < db; k++) extra.push(j++); }
    else { pairs.push([i++, j++]); }
  }
  while (i < a.length) missing.push(i++);
  while (j < b.length) extra.push(j++);
  return { pairs, missing, extra };
}

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const close = (x: number, y: number, tol = 0.05): boolean => Math.abs(x - y) <= tol;

function markOf(marks: N[], type: string): N | undefined {
  return marks.find((m) => m.type === type);
}

function attrOf(marks: N[], type: string, key: string): unknown {
  const m = markOf(marks, type);
  return m ? ((m.attrs ?? {}) as N)[key] : null;
}

/** The first formatting field on which a stored character differs from the expected one, or null. */
function fmtDiff(e: CharAtom, marks: N[], basePt: number): { field: string; expected: unknown; actual: unknown } | null {
  const f = e.fmt!;
  const flags: [string, boolean][] = [["bold", f.bold], ["italic", f.italic], ["strike", f.strike], ["caps", f.caps], ["smallCaps", f.smallCaps]];
  for (const [name, want] of flags) if (!!markOf(marks, name) !== want) return { field: name, expected: want, actual: !want };
  const pairs: [string, unknown, unknown][] = [
    ["underline", f.underline, attrOf(marks, "underline", "style")],
    ["vertAlign", f.vertAlign, attrOf(marks, "vertAlign", "value")],
    ["size", f.size === basePt ? null : f.size, attrOf(marks, "size", "pt")],
    ["color", f.color, attrOf(marks, "color", "hex")],
    ["highlight", f.highlight, attrOf(marks, "highlight", "hex")],
    ["shade", f.shade, attrOf(marks, "shade", "hex")],
  ];
  for (const [name, want, got] of pairs) if ((want ?? null) !== (got ?? null)) return { field: name, expected: want ?? null, actual: got ?? null };
  return null;
}

export type ReadAsset = (name: string) => Promise<Uint8Array | null>;

interface Ctx {
  out: Discrepancy[];
  basePt: number;
  media: Record<string, Uint8Array>;
  readAsset: ReadAsset;
}

function storyLabel(stories: Story[], index: number): { label: string; index: number } {
  let i = index;
  for (const s of stories) {
    if (i < s.paragraphs.length) return { label: s.label, index: i };
    i -= s.paragraphs.length;
  }
  return { label: stories[stories.length - 1]?.label ?? "body", index: i };
}

async function compareStory(ctx: Ctx, exp: Story[], got: SStory, name: string): Promise<void> {
  const eParas = exp.flatMap((s) => s.paragraphs);
  const ePics = exp.flatMap((s) => s.pictures);
  const eTables = exp.flatMap((s) => s.tables);
  const at = (i: number): { label: string; index: number } => (exp.length > 1 ? storyLabel(exp, i) : { label: name, index: i });

  const { pairs, missing, extra } = align(eParas.map((p) => p.text), got.paragraphs.map((p) => p.text));
  for (const i of missing) ctx.out.push({ kind: "paragraph", story: at(i).label, index: at(i).index, expected: eParas[i]!.text, actual: null });
  for (const j of extra) ctx.out.push({ kind: "paragraph", story: name, index: j, expected: null, actual: got.paragraphs[j]!.text });
  for (const [i, j] of pairs) {
    const e = eParas[i]!;
    const g = got.paragraphs[j]!;
    const where = at(i);
    const push = (kind: string, expected: unknown, actual: unknown): void => {
      ctx.out.push({ kind, story: where.label, index: where.index, expected, actual });
    };
    if (e.text !== g.text) { push("paragraph", e.text, g.text); continue; }
    if (e.marker !== g.marker) push("marker", e.marker, g.marker);
    if (!close(e.indLeft, g.indLeft) || !close(e.indFirst, g.indFirst) || !close(e.indRight, g.indRight)) {
      push("indent", { indLeft: e.indLeft, indFirst: e.indFirst, indRight: e.indRight }, { indLeft: g.indLeft, indFirst: g.indFirst, indRight: g.indRight });
    }
    const es = e.chars.map((c) => c.s).join("");
    const gs = g.chars.map((c) => c.s).join("");
    if (es !== gs) { push("format", `character positions differ: ${JSON.stringify(es)}`, gs); continue; }
    let fmtDone = false;
    let linkDone = false;
    for (let k = 0; k < e.chars.length && !(fmtDone && linkDone); k++) {
      const ec = e.chars[k]!;
      const gc = g.chars[k]!;
      if (!ec.fmt || !gc.marks) continue;
      if (!fmtDone) {
        const d = fmtDiff(ec, gc.marks, ctx.basePt);
        if (d) { push("format", { char: k, text: ec.s, [d.field]: d.expected }, { [d.field]: d.actual }); fmtDone = true; }
      }
      if (!linkDone) {
        const href = (attrOf(gc.marks, "link", "href") as string | null) ?? null;
        if (href !== ec.link) { push("link", { char: k, href: ec.link }, { href }); linkDone = true; }
      }
    }
  }

  await comparePictures(ctx, ePics, got.pictures, name);

  if (eTables.length !== got.tables.length) ctx.out.push({ kind: "table", story: name, index: -1, expected: { tables: eTables.length }, actual: { tables: got.tables.length } });
  for (let t = 0; t < Math.min(eTables.length, got.tables.length); t++) {
    const e = eTables[t]!;
    const g = got.tables[t]!;
    if (e.depth !== g.depth || JSON.stringify(e.rows) !== JSON.stringify(g.rows)) {
      ctx.out.push({ kind: "table", story: name, index: t, expected: { depth: e.depth, rows: e.rows }, actual: { depth: g.depth, rows: g.rows } });
    } else if (JSON.stringify(e.fills) !== JSON.stringify(g.fills)) {
      ctx.out.push({ kind: "table", story: name, index: t, expected: { fills: e.fills }, actual: { fills: g.fills } });
    }
  }
}

async function comparePictures(ctx: Ctx, exp: PicAtom[], got: SPic[], name: string): Promise<void> {
  const cropped = (p: PicAtom): boolean => p.crop.some((v) => v > 0);
  const uncroppedNames = new Map<string, string>();
  const key = (p: PicAtom): string => {
    if (cropped(p)) return "cropped";
    let k = uncroppedNames.get(p.media);
    if (!k) {
      const bytes = ctx.media[p.media];
      k = bytes ? sha256(bytes).slice(0, 32) : `missing:${p.media}`;
      uncroppedNames.set(p.media, k);
    }
    return k;
  };
  const eKeys = exp.map(key);
  const known = new Set(eKeys);
  const gKeys = got.map((g) => {
    const k = g.asset.slice(0, 32);
    return known.has(k) ? k : "cropped";
  });
  const { pairs, missing, extra } = align(eKeys, gKeys);
  for (const i of missing) ctx.out.push({ kind: "picture", story: name, index: i, expected: exp[i]!.media, actual: null });
  for (const j of extra) ctx.out.push({ kind: "picture", story: name, index: j, expected: null, actual: got[j]!.asset });
  for (const [i, j] of pairs) {
    const e = exp[i]!;
    const g = got[j]!;
    const media = ctx.media[e.media];
    const stored = await ctx.readAsset(g.asset);
    if (!media || !stored) {
      ctx.out.push({ kind: "picture", story: name, index: i, expected: e.media, actual: stored ? g.asset : `${g.asset} (asset file missing)` });
      continue;
    }
    if (!cropped(e)) {
      if (sha256(media) !== sha256(stored)) ctx.out.push({ kind: "picture", story: name, index: i, expected: `sha256 of ${e.media}`, actual: g.asset });
    } else {
      const [m, s] = await Promise.all([sharp(media).metadata(), sharp(stored).metadata()]);
      const W = m.width ?? 0;
      const H = m.height ?? 0;
      const [l, t, r, b] = e.crop.map((v) => Math.max(0, v) / 100000);
      const ew = W - W * l! - W * r!;
      const eh = H - H * t! - H * b!;
      if (Math.abs((s.width ?? 0) - ew) > 1 || Math.abs((s.height ?? 0) - eh) > 1) {
        ctx.out.push({ kind: "picture", story: name, index: i, expected: { width: Math.round(ew), height: Math.round(eh) }, actual: { width: s.width, height: s.height } });
      }
    }
    if (e.widthPt !== null && g.widthPt !== null && (!close(e.widthPt, g.widthPt) || !close(e.heightPt ?? 0, g.heightPt ?? 0))) {
      ctx.out.push({ kind: "picture", story: name, index: i, expected: { widthPt: e.widthPt, heightPt: e.heightPt }, actual: { widthPt: g.widthPt, heightPt: g.heightPt } });
    }
  }
}

async function compareSideStories(ctx: Ctx, exp: Story[], got: SStory[], kind: string): Promise<void> {
  const key = (ps: { text: string }[]): string => ps.map((p) => p.text).join("\u0001");
  const { pairs, missing, extra } = align(exp.map((s) => key(s.paragraphs)), got.map((s) => key(s.paragraphs)));
  for (const i of missing) ctx.out.push({ kind: "story", story: `${kind} ${i + 1}`, index: i, expected: key(exp[i]!.paragraphs).slice(0, 200), actual: null });
  for (const j of extra) ctx.out.push({ kind: "story", story: `${kind} ${j + 1}`, index: j, expected: null, actual: key(got[j]!.paragraphs).slice(0, 200) });
  for (const [i, j] of pairs) await compareStory(ctx, [exp[i]!], got[j]!, `${kind} ${i + 1}`);
}

/** Compares a Word source's atoms with its stored docs (one per block, in order). */
export async function compareDocx(
  atoms: Atoms, docs: DocJSON[], basePt: number, readAsset: ReadAsset,
): Promise<{ discrepancies: Discrepancy[]; counts: Counts }> {
  const ctx: Ctx = { out: [], basePt, media: atoms.media, readAsset };
  const stored = readStored(docs);
  if (atoms.basePt !== basePt) ctx.out.push({ kind: "format", story: "document", index: -1, expected: { basePt: atoms.basePt }, actual: { basePt } });
  const flow = atoms.stories.filter((s) => !["textbox", "grouptext"].includes(s.kind));
  await compareStory(ctx, flow, stored.main, "body");
  await compareSideStories(ctx, atoms.stories.filter((s) => s.kind === "textbox"), stored.textboxes, "text box");
  await compareSideStories(ctx, atoms.stories.filter((s) => s.kind === "grouptext"), stored.groupTexts, "group text");
  const paras = atoms.stories.flatMap((s) => s.paragraphs);
  const tables = atoms.stories.flatMap((s) => s.tables);
  return {
    discrepancies: ctx.out,
    counts: {
      stories: atoms.stories.length,
      paragraphs: paras.length,
      characters: paras.reduce((n, p) => n + p.text.length, 0),
      pictures: atoms.stories.reduce((n, s) => n + s.pictures.length, 0),
      tables: tables.length,
      rows: tables.reduce((n, t) => n + t.rows.length, 0),
      textboxes: atoms.stories.filter((s) => s.kind === "textbox").length,
      drawings: stored.drawings,
      markers: paras.filter((p) => p.marker !== null).length,
    },
  };
}
