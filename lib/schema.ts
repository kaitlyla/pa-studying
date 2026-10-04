// The one ProseMirror schema (plan 20 §20.13). Every stored doc is validated against it by
// lib/content; the importer, build, renderer, PDF builder and editor all import this object.
import { Schema } from "prosemirror-model";
import type { NodeSpec, MarkSpec, AttributeSpec } from "prosemirror-model";
import { idRegExp } from "./content/ids.ts";

type Check = (value: unknown) => void;

function fail(what: string, value: unknown): never {
  throw new RangeError(`Invalid ${what}: ${JSON.stringify(value)}`);
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export const HEX_RE = /^[0-9A-F]{6}$/;
export const ASSET_RE = /^[0-9a-f]{32}\.(png|jpeg|jpg|gif)$/;
const ROW_ID_RE = idRegExp("r");

/** A link target the content may hold: http(s), mailto, or an internal hash route. */
export function isAllowedHref(href: unknown): boolean {
  return typeof href === "string" && (/^(https?:|mailto:)/.test(href) || href.startsWith("#/"));
}

const num: Check = (v) => { if (!isNum(v)) fail("number", v); };
const numOrNull: Check = (v) => { if (v !== null && !isNum(v)) fail("number or null", v); };
const bool: Check = (v) => { if (typeof v !== "boolean") fail("boolean", v); };
const str: Check = (v) => { if (typeof v !== "string") fail("string", v); };
const strOrNull: Check = (v) => { if (v !== null && typeof v !== "string") fail("string or null", v); };
const hex: Check = (v) => { if (typeof v !== "string" || !HEX_RE.test(v)) fail("color (6-digit uppercase hex)", v); };
const hexOrNull: Check = (v) => { if (v !== null) hex(v); };
const oneOf = (...allowed: unknown[]): Check => (v) => { if (!allowed.includes(v)) fail(`value (one of ${allowed.join(", ")})`, v); };
const asset: Check = (v) => { if (typeof v !== "string" || !ASSET_RE.test(v)) fail("asset path", v); };
const assetOrNull: Check = (v) => { if (v !== null) asset(v); };
const isNull: Check = (v) => { if (v !== null) fail("null", v); };
const posInt: Check = (v) => { if (!Number.isInteger(v) || (v as number) < 1) fail("positive integer", v); };

function shape(fields: Record<string, Check>, what: string): Check {
  return (v) => {
    if (!isObj(v)) fail(what, v);
    for (const k of Object.keys(v)) if (!Object.hasOwn(fields, k)) fail(`${what} (unknown key ${k})`, v);
    for (const [k, check] of Object.entries(fields)) {
      if (!Object.hasOwn(v, k)) fail(`${what} (missing ${k})`, v);
      check(v[k]);
    }
  };
}
const nullable = (c: Check): Check => (v) => { if (v !== null) c(v); };

const border = shape({ style: str, widthPt: num, color: hex }, "border");
const borderOrNull = nullable(border);
const sides = (keys: string[], what: string): Check => shape(Object.fromEntries(keys.map((k) => [k, borderOrNull])), what);
const tableBorders = sides(["top", "right", "bottom", "left", "insideH", "insideV"], "table borders");
const paraBorders = nullable(sides(["top", "right", "bottom", "left"], "paragraph borders"));
const cellBorders: Check = (v) => {
  if (v === null) return;
  if (!isObj(v)) fail("cell borders", v);
  for (const [k, b] of Object.entries(v)) {
    if (!["top", "right", "bottom", "left"].includes(k)) fail("cell borders (unknown side)", v);
    borderOrNull(b);
  }
};
const margins = shape({ top: num, right: num, bottom: num, left: num }, "cell margins");
const line: Check = (v) => {
  if (v === null) return;
  if (!isObj(v) || !isNum(v.value) || Object.keys(v).length !== 2) fail("line", v);
  if (v.rule !== "auto" && v.rule !== "exact" && v.rule !== "atLeast") fail("line rule", v);
};
const marker: Check = (v) => {
  if (v === null) return;
  shape({ text: str, font: strOrNull, marks: markList, tabPt: num }, "marker")(v);
};
const markList: Check = (v) => {
  if (!Array.isArray(v)) fail("mark list", v);
  for (const m of v) {
    if (!isObj(m) || typeof m.type !== "string") fail("mark", m);
    schema.markFromJSON(m); // throws on an unknown type or an invalid attribute
  }
};
const grid: Check = (v) => { if (!Array.isArray(v) || !v.every(isNum)) fail("grid", v); };
const stroke = nullable(shape({ color: hex, widthPt: num, dash: strOrNull }, "stroke"));
const drawingShape = shape({
  geom: str, x: num, y: num, w: num, h: num, rot: num, flipH: bool, flipV: bool,
  stroke, fill: hexOrNull, head: strOrNull, tail: strOrNull, asset: assetOrNull,
}, "drawing shape");
const shapes: Check = (v) => { if (!Array.isArray(v)) fail("shapes", v); v.forEach(drawingShape); };

const a = (validate: Check, dflt?: unknown): AttributeSpec =>
  dflt === undefined ? { validate } : { validate, default: dflt };

const imageAttrs: Record<string, AttributeSpec> = {
  asset: a(asset),
  widthPt: a(num),
  heightPt: a(num),
  rot: a(oneOf(0, 90, 180, 270), 0),
  flipH: a(bool, false),
  flipV: a(bool, false),
};

const nodes: Record<string, NodeSpec> = {
  doc: { content: "(block | slide_card | heading_line)+" },
  paragraph: {
    group: "block",
    content: "inline*",
    attrs: {
      indLeft: a(num, 0),
      indRight: a(num, 0),
      indFirst: a(num, 0),
      spaceBefore: a(num, 0),
      spaceAfter: a(num, 0),
      line: a(line, null),
      align: a(oneOf("left", "center", "right", "justify"), "left"),
      shade: a(hexOrNull, null),
      borders: a(paraBorders, null),
      marker: a(marker, null),
    },
  },
  heading_line: { content: "inline*" },
  text: { group: "inline" },
  hard_break: { group: "inline", inline: true, atom: true, selectable: false },
  page_break: { group: "inline", inline: true, atom: true, selectable: false },
  image: { group: "inline", inline: true, atom: true, draggable: false, attrs: imageAttrs },
  anchored: {
    group: "block",
    content: "image_block | textbox | drawing",
    attrs: { offsetPt: a(num, 0) },
  },
  image_block: { atom: true, attrs: imageAttrs },
  rule: { group: "block", atom: true, attrs: { color: a(hex), widthPt: a(num) } },
  textbox: {
    group: "block",
    content: "block+",
    attrs: { widthPt: a(num), fill: a(hexOrNull, null), border: a(borderOrNull, null), inline: a(bool, false) },
  },
  // ProseMirror requires every required content position (anchored's child, a table's rows) to admit
  // a node it can generate, i.e. one whose attributes all have defaults. `drawing` and `table_row`
  // therefore default their essential attributes to null, which the validators still reject, so a
  // stored doc always carries real values.
  drawing: {
    group: "block",
    content: "drawing_text*",
    attrs: { widthPt: a(num, null), heightPt: a(num, null), shapes: a(shapes, []) },
  },
  drawing_text: {
    content: "block+",
    attrs: { x: a(num), y: a(num), w: a(num), h: a(num), fill: a(hexOrNull, null), border: a(borderOrNull, null) },
  },
  table: {
    group: "block",
    content: "table_row+",
    tableRole: "table",
    isolating: true,
    attrs: { grid: a(grid), indentPt: a(num, 0), borders: a(tableBorders), cellMarginPt: a(margins) },
  },
  table_row: {
    content: "table_cell+",
    tableRole: "row",
    attrs: {
      id: a((v) => { if (typeof v !== "string" || !ROW_ID_RE.test(v)) fail("row id", v); }, null),
      kind: a(oneOf("heading", "content"), "content"),
      minHeightPt: a(numOrNull, null),
      repeatHeader: a(bool, false),
      cantSplit: a(bool, false),
    },
  },
  table_cell: {
    content: "block+",
    tableRole: "cell",
    isolating: true,
    attrs: {
      colspan: a(posInt, 1),
      rowspan: a(posInt, 1),
      colwidth: a(isNull, null),
      fill: a(hexOrNull, null),
      vAlign: a(oneOf("top", "center", "bottom"), "top"),
      borders: a(cellBorders, null),
    },
  },
  slide_card: { content: "paragraph+" },
};

// Mark order is precedence order (20 §20.13).
const marks: Record<string, MarkSpec> = {
  link: {
    inclusive: false,
    attrs: { href: a((v) => { if (!isAllowedHref(v)) fail("link href", v); }) },
  },
  bold: {},
  italic: {},
  underline: { attrs: { style: a(str, "single") } },
  strike: { attrs: { double: a(bool, false) } },
  vertAlign: { attrs: { value: a(oneOf("sup", "sub")) } },
  caps: {},
  smallCaps: {},
  size: { attrs: { pt: a((v) => { if (!isNum(v) || v <= 0) fail("size", v); }) } },
  color: { attrs: { hex: a(hex) } },
  highlight: { attrs: { hex: a(hex) } },
  shade: { attrs: { hex: a(hex) } },
  font: { attrs: { family: a(str) } },
};

export const schema: Schema = new Schema({ nodes, marks });
