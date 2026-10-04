// Stored `drawing` shapes as SVG elements (20 §20.13, 30 §30.9, 40 §40.6). One geometry and stroke
// rule shared by the screen renderer (app/render/Drawing.tsx) and the PDF (lib/pdf/svg.ts): both
// draw what `shapeSvg` returns, so a shape looks the same on screen and in her download. Lengths are
// pt in the drawing's group space. React-free.

import type { DrawingShape, DrawingStroke } from "./schemaTypes.ts";

/**
 * A shape outline as stored: the importer has already resolved Word's theme line (30 §30.9), so a
 * null stroke means no outline and renderers apply no fallback. `dash` is one of DASH_STYLES.
 */
export type Stroke = DrawingStroke;
export type Shape = DrawingShape;

/** The DrawingML presets drawn with their own geometry (30 §30.9); any other preset is drawn as `rect`. */
export const PRESETS = ["line", "straightConnector1", "arc", "mathPlus", "rightBrace", "rect", "roundRect", "ellipse"] as const;
export type Preset = (typeof PRESETS)[number];

export function isPreset(geom: string): geom is Preset {
  return (PRESETS as readonly string[]).includes(geom);
}

/**
 * Word's preset dashes (ECMA-376 ST_PresetLineDashVal): dash and gap lengths in multiples of the line
 * width, read from each preset's binary pattern (sysDash 1110 → 3:1). `solid` has no pattern.
 */
const DASHES = {
  solid: [],
  dot: [1, 3],
  dash: [4, 3],
  lgDash: [8, 3],
  dashDot: [4, 3, 1, 3],
  lgDashDot: [8, 3, 1, 3],
  lgDashDotDot: [8, 3, 1, 3, 1, 3],
  sysDash: [3, 1],
  sysDot: [1, 1],
  sysDashDot: [3, 1, 1, 1],
  sysDashDotDot: [3, 1, 1, 1, 1, 1],
} as const satisfies Record<string, readonly number[]>;

export type DashStyle = keyof typeof DASHES;

/** Every value `stroke.dash` may hold (Orchestrator ruling zeke-69273: `a:prstDash` stored as-is). */
export const DASH_STYLES = Object.keys(DASHES) as DashStyle[];

export function isDashStyle(v: unknown): v is DashStyle {
  return typeof v === "string" && Object.hasOwn(DASHES, v);
}

/** A dash style's pattern in pt for a line width; empty for solid. */
export function dashPattern(dash: string | null, widthPt: number): number[] {
  return dash && isDashStyle(dash) ? DASHES[dash].map((d) => d * widthPt) : [];
}

/** An SVG element: tag, attributes in SVG (kebab-case) spelling, children. */
export interface SvgEl {
  tag: "g" | "line" | "path" | "rect" | "ellipse" | "image" | "polygon";
  attrs: Record<string, string>;
  children?: SvgEl[];
}

const n = (v: number): string => String(Math.round(v * 1000) / 1000);

/** Stroke paint attributes: `none` when the shape has no outline. */
export function strokeAttrs(s: Stroke | null): Record<string, string> {
  if (!s) return { stroke: "none" };
  const out: Record<string, string> = { stroke: `#${s.color}`, "stroke-width": n(s.widthPt) };
  const dash = dashPattern(s.dash, s.widthPt);
  if (dash.length) out["stroke-dasharray"] = dash.map(n).join(" ");
  return out;
}

const fillAttrs = (fill: string | null): Record<string, string> => ({ fill: fill ? `#${fill}` : "none" });

/** Rotation about the shape's centre, then its flips (applied first to the geometry). */
export function shapeTransform(s: Shape): string | null {
  if (!s.rot && !s.flipH && !s.flipV) return null;
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  return `translate(${n(cx)} ${n(cy)}) rotate(${n(s.rot)}) scale(${s.flipH ? -1 : 1} ${s.flipV ? -1 : 1}) translate(${n(-cx)} ${n(-cy)})`;
}

/** Point on the ellipse inscribed in the box at `deg` (clockwise from 3 o'clock). */
function onEllipse(x: number, y: number, w: number, h: number, deg: number): [number, number] {
  const t = (deg * Math.PI) / 180;
  return [x + w / 2 + (w / 2) * Math.cos(t), y + h / 2 + (h / 2) * Math.sin(t)];
}

/** `arc` at its default adjust values: adj1 16200000 (270°) clockwise to adj2 0 (0°). */
export function arcPath(x: number, y: number, w: number, h: number): string {
  const [x1, y1] = onEllipse(x, y, w, h, 270);
  const [x2, y2] = onEllipse(x, y, w, h, 0);
  return `M${n(x1)} ${n(y1)} A${n(w / 2)} ${n(h / 2)} 0 0 1 ${n(x2)} ${n(y2)}`;
}

/** `mathPlus` at its default adjust value adj1 23520. */
export function plusPath(x: number, y: number, w: number, h: number): string {
  const ss = Math.min(w, h);
  const hc = x + w / 2;
  const vc = y + h / 2;
  const dx1 = (w * 73490) / 200000;
  const dy1 = (h * 73490) / 200000;
  const d2 = (ss * 23520) / 200000;
  const [xa, xb, xc, xd] = [hc - dx1, hc - d2, hc + d2, hc + dx1];
  const [ya, yb, yc, yd] = [vc - dy1, vc - d2, vc + d2, vc + dy1];
  const pts: [number, number][] = [[xa, yb], [xb, yb], [xb, ya], [xc, ya], [xc, yb], [xd, yb], [xd, yc], [xc, yc], [xc, yd], [xb, yd], [xb, yc], [xa, yc]];
  return `M${pts.map(([px, py]) => `${n(px)} ${n(py)}`).join(" L")} Z`;
}

/** `rightBrace` at its default adjust values adj1 8333 (pinned to 25000·h/ss) and adj2 50000. */
export function rightBracePath(x: number, y: number, w: number, h: number): string {
  const ss = Math.min(w, h);
  const a1 = Math.min(8333, (25000 * h) / ss);
  const rx = w / 2;
  const ry = (ss * a1) / 100000;
  const hc = x + rx;
  const yc = y + h / 2;
  return [
    `M${n(x)} ${n(y)}`,
    `A${n(rx)} ${n(ry)} 0 0 1 ${n(hc)} ${n(y + ry)}`,
    `L${n(hc)} ${n(yc - ry)}`,
    `A${n(rx)} ${n(ry)} 0 0 0 ${n(x + w)} ${n(yc)}`,
    `A${n(rx)} ${n(ry)} 0 0 0 ${n(hc)} ${n(yc + ry)}`,
    `L${n(hc)} ${n(y + h - ry)}`,
    `A${n(rx)} ${n(ry)} 0 0 1 ${n(x)} ${n(y + h)}`,
  ].join(" ");
}

/** `roundRect`'s corner radius at its default adjust value adj 16667. */
export const roundRectRadius = (w: number, h: number): number => (Math.min(w, h) * 16667) / 100000;

/** An arrowhead at (x, y) pointing away from (fromX, fromY), filled in the stroke color. */
function arrow(x: number, y: number, fromX: number, fromY: number, s: Stroke): SvgEl {
  const len = Math.max(3 * s.widthPt, 3);
  const angle = Math.atan2(y - fromY, x - fromX);
  const spread = Math.PI / 7;
  const p1 = [x - len * Math.cos(angle - spread), y - len * Math.sin(angle - spread)] as const;
  const p2 = [x - len * Math.cos(angle + spread), y - len * Math.sin(angle + spread)] as const;
  return { tag: "polygon", attrs: { points: `${n(x)},${n(y)} ${n(p1[0])},${n(p1[1])} ${n(p2[0])},${n(p2[1])}`, fill: `#${s.color}`, stroke: "none" } };
}

const withTransform = (s: Shape, el: SvgEl): SvgEl => {
  const tf = shapeTransform(s);
  return tf ? { ...el, attrs: { ...el.attrs, transform: tf } } : el;
};

/** The SVG element of one stored shape; null for a picture whose image is unavailable. */
export function shapeSvg(s: Shape, href: (asset: string) => string | undefined): SvgEl | null {
  const box = { x: n(s.x), y: n(s.y), width: n(s.w), height: n(s.h) };
  const paint = { ...fillAttrs(s.fill), ...strokeAttrs(s.stroke) };
  const open = { fill: "none", ...strokeAttrs(s.stroke) };
  switch (s.geom) {
    case "line":
    case "straightConnector1": {
      const x2 = s.x + s.w;
      const y2 = s.y + s.h;
      const children: SvgEl[] = [{ tag: "line", attrs: { x1: n(s.x), y1: n(s.y), x2: n(x2), y2: n(y2), ...strokeAttrs(s.stroke) } }];
      if (s.stroke && s.head) children.push(arrow(s.x, s.y, x2, y2, s.stroke));
      if (s.stroke && s.tail) children.push(arrow(x2, y2, s.x, s.y, s.stroke));
      return withTransform(s, { tag: "g", attrs: {}, children });
    }
    case "arc":
      return withTransform(s, { tag: "path", attrs: { d: arcPath(s.x, s.y, s.w, s.h), ...open } });
    case "mathPlus":
      return withTransform(s, { tag: "path", attrs: { d: plusPath(s.x, s.y, s.w, s.h), ...paint } });
    case "rightBrace":
      return withTransform(s, { tag: "path", attrs: { d: rightBracePath(s.x, s.y, s.w, s.h), ...open } });
    case "ellipse":
      return withTransform(s, { tag: "ellipse", attrs: { cx: n(s.x + s.w / 2), cy: n(s.y + s.h / 2), rx: n(s.w / 2), ry: n(s.h / 2), ...paint } });
    case "roundRect": {
      const r = n(roundRectRadius(s.w, s.h));
      return withTransform(s, { tag: "rect", attrs: { ...box, rx: r, ry: r, ...paint } });
    }
    case "picture": {
      const url = s.asset ? href(s.asset) : undefined;
      return url ? withTransform(s, { tag: "image", attrs: { ...box, preserveAspectRatio: "none", href: url } }) : null;
    }
    default:
      // rect, and any preset without a rule of its own, keeps its box, fill and outline.
      return withTransform(s, { tag: "rect", attrs: { ...box, ...paint } });
  }
}

const escAttr = (v: string): string => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Serializes an element tree to SVG markup. */
export function svgMarkup(el: SvgEl): string {
  const attrs = Object.entries(el.attrs).map(([k, v]) => ` ${k}="${escAttr(v)}"`).join("");
  const kids = (el.children ?? []).map(svgMarkup).join("");
  return kids ? `<${el.tag}${attrs}>${kids}</${el.tag}>` : `<${el.tag}${attrs}/>`;
}

/** An attribute name in React's spelling (`stroke-width` → `strokeWidth`). */
export const reactAttrName = (k: string): string => k.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
