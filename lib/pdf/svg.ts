// A stored `drawing` as an SVG string for pdfmake's `svg` node (plan 70 §70.3). Each shape is drawn
// by lib/drawing.ts, the same geometry and stroke rule the screen renderer uses. Lengths are pt in the
// drawing's group space.
import { shapeSvg, svgMarkup } from "../drawing.ts";
import type { DrawingShape } from "../schemaTypes.ts";

const n = (v: number): string => String(Math.round(v * 1000) / 1000);

/** The drawing's shapes as an SVG document of its pt extent. `image` gives an asset's data URL. */
export function drawingSvg(widthPt: number, heightPt: number, shapes: readonly DrawingShape[], image: (asset: string) => string | undefined): string {
  const body = shapes.map((s) => shapeSvg(s, image)).map((el) => (el ? svgMarkup(el) : "")).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(widthPt)}" height="${n(heightPt)}" viewBox="0 0 ${n(widthPt)} ${n(heightPt)}">${body}</svg>`;
}
