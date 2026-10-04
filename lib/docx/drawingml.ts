// DrawingML colors, fills and outlines for text boxes and shapes (30 §30.9). Scheme colors resolve
// through the theme and the document's color map; lumMod/lumOff/tint/shade modifiers apply.
import type { DashStyle } from "../drawing.ts";
import { isDashStyle } from "../drawing.ts";
import type { Border } from "../schemaTypes.ts";
import type { Element } from "./xml.ts";
import { NS, attr, child, children, emuToPt, hexColor, kids, numAttr } from "./xml.ts";

const PRESET: Record<string, string> = {
  black: "000000", white: "FFFFFF", red: "FF0000", green: "008000", blue: "0000FF", yellow: "FFFF00",
  cyan: "00FFFF", magenta: "FF00FF", gray: "808080", grey: "808080", darkGray: "A9A9A9", lightGray: "D3D3D3",
  orange: "FFA500", purple: "800080", navy: "000080", maroon: "800000", olive: "808000", teal: "008080",
  silver: "C0C0C0", lime: "00FF00", brown: "A52A2A", pink: "FFC0CB",
};

const DEFAULT_MAP: Record<string, string> = { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2" };
/** Word's `w:clrSchemeMapping` names the text aliases t1/t2 where DrawingML and `p:clrMap` say tx1/tx2. */
const WORD_MAP_ATTR: Record<string, string> = { bg1: "bg1", tx1: "t1", bg2: "bg2", tx2: "t2" };
const MAP_ATTRS: Record<string, string> = { light1: "lt1", dark1: "dk1", light2: "lt2", dark2: "dk2" };

export interface Theme {
  colors: Map<string, string>;
  lineWidths: number[];
}

/**
 * The theme's colors and line widths. The bg1/tx1/bg2/tx2 aliases follow `clrMap` (a PowerPoint
 * slide master's `p:clrMap`, unprefixed attributes) when given, else Word's `w:clrSchemeMapping`.
 */
export function readTheme(theme: Element | null, settings: Element | null, clrMap: Element | null = null): Theme {
  const colors = new Map<string, string>();
  const scheme = child(child(theme, NS.a, "themeElements"), NS.a, "clrScheme");
  for (const c of scheme ? kids(scheme) : []) {
    const inner = kids(c)[0];
    const hex = inner ? baseColor(inner, null) : null;
    if (hex && c.localName) colors.set(c.localName, hex);
  }
  const map = child(settings, NS.w, "clrSchemeMapping");
  for (const [k, v] of Object.entries(DEFAULT_MAP)) {
    const mapped = clrMap ? attr(clrMap, k) : map?.getAttributeNS(NS.w, WORD_MAP_ATTR[k]!);
    const key = mapped ? (MAP_ATTRS[mapped] ?? mapped) : v;
    const hex = colors.get(key);
    if (hex) colors.set(k, hex);
  }
  const lnList = child(child(child(theme, NS.a, "themeElements"), NS.a, "fmtScheme"), NS.a, "lnStyleLst");
  const lineWidths = children(lnList, NS.a, "ln").map((l) => numAttr(l, "w") ?? 9525);
  return { colors, lineWidths };
}

function baseColor(el: Element, theme: Theme | null): string | null {
  switch (el.localName) {
    case "srgbClr": return hexColor(attr(el, "val"));
    case "sysClr": return hexColor(attr(el, "lastClr")) ?? (attr(el, "val") === "window" ? "FFFFFF" : "000000");
    case "prstClr": return PRESET[attr(el, "val") ?? ""] ?? null;
    case "schemeClr": return theme?.colors.get(attr(el, "val") ?? "") ?? null;
    case "scrgbClr": {
      const c = (n: string): number => Math.round(Math.min(1, Math.max(0, (numAttr(el, n) ?? 0) / 100000)) * 255);
      return toHex([c("r"), c("g"), c("b")]);
    }
    default: return null;
  }
}

function toHex(rgb: number[]): string {
  return rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("").toUpperCase();
}

function toRgb(hex: string): number[] {
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function rgbToHsl([r, g, b]: number[]): number[] {
  const [R, G, B] = [r! / 255, g! / 255, b! / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb([h, s, l]: number[]): number[] {
  if (s === 0) return [l! * 255, l! * 255, l! * 255];
  const q = l! < 0.5 ? l! * (1 + s!) : l! + s! - l! * s!;
  const p = 2 * l! - q;
  const f = (t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h! + 1 / 3) * 255, f(h!) * 255, f(h! - 1 / 3) * 255];
}

/** The hex of a DrawingML color element (srgbClr, schemeClr, …) with its modifiers applied. */
export function drawingColor(el: Element | null, theme: Theme): string | null {
  if (!el) return null;
  const hex = baseColor(el, theme);
  if (!hex) return null;
  let rgb = toRgb(hex);
  for (const m of kids(el)) {
    const v = (numAttr(m, "val") ?? 100000) / 100000;
    switch (m.localName) {
      case "lumMod": case "lumOff": {
        const hsl = rgbToHsl(rgb);
        hsl[2] = m.localName === "lumMod" ? hsl[2]! * v : hsl[2]! + v;
        hsl[2] = Math.min(1, Math.max(0, hsl[2]));
        rgb = hslToRgb(hsl);
        break;
      }
      case "shade": rgb = rgb.map((c) => c * v); break;
      case "tint": rgb = rgb.map((c) => c + (255 - c) * (1 - v)); break;
    }
  }
  return toHex(rgb);
}

/** The color element inside a fill/line holder (solidFill, or a style reference). */
function colorChild(el: Element | null): Element | null {
  return el ? (kids(el)[0] ?? null) : null;
}

/** Shape fill: a:noFill → null; a:solidFill/gradFill → color; absent → the style's fillRef. */
export function shapeFill(spPr: Element | null, style: Element | null, theme: Theme): string | null {
  if (child(spPr, NS.a, "noFill")) return null;
  const solid = child(spPr, NS.a, "solidFill");
  if (solid) return drawingColor(colorChild(solid), theme);
  const grad = child(spPr, NS.a, "gradFill");
  if (grad) return drawingColor(colorChild(child(child(grad, NS.a, "gsLst"), NS.a, "gs")), theme);
  const ref = child(style, NS.a, "fillRef");
  if (ref && (numAttr(ref, "idx") ?? 0) > 0) return drawingColor(colorChild(ref), theme);
  return null;
}

export interface Outline {
  /** The outline as a border whose style is a DrawingML preset dash. */
  border: (Border & { style: DashStyle }) | null;
  head: string | null;
  tail: string | null;
}

/** `a:prstDash` as stored: the preset value itself (Orchestrator ruling zeke-69273); absent → solid. */
function dashStyle(v: string | null): DashStyle {
  return v && isDashStyle(v) ? v : "solid";
}

/**
 * Shape outline as Word draws it, stored explicitly so renderers apply no fallback: `a:ln/a:noFill`
 * → none; otherwise `a:ln`'s color, width and dash, each missing part taken from the style's `lnRef`
 * theme line. A shape with neither `a:ln` nor an `lnRef` has no outline. Arrow ends come from `a:ln`.
 */
export function shapeOutline(spPr: Element | null, style: Element | null, theme: Theme): Outline {
  const ln = child(spPr, NS.a, "ln");
  const lnRef = child(style, NS.a, "lnRef");
  const refIdx = numAttr(lnRef, "idx") ?? 0;
  const end = (name: string): string | null => {
    const t = attr(child(ln, NS.a, name), "type");
    return t && t !== "none" ? t : null;
  };
  const head = end("headEnd");
  const tail = end("tailEnd");
  if (child(ln, NS.a, "noFill") || (!ln && refIdx === 0)) return { border: null, head, tail };
  const solid = child(ln, NS.a, "solidFill");
  const color = (solid ? drawingColor(colorChild(solid), theme) : null)
    ?? (refIdx > 0 ? drawingColor(colorChild(lnRef), theme) : null)
    ?? "000000";
  const w = numAttr(ln, "w") ?? (refIdx > 0 ? theme.lineWidths[refIdx - 1] : undefined) ?? 9525;
  return { border: { style: dashStyle(attr(child(ln, NS.a, "prstDash"), "val")), widthPt: emuToPt(w), color }, head, tail };
}
