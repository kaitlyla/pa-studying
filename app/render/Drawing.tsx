// Word drawings as inline SVG built from React elements (40 §40.6), in a viewBox of the drawing's
// pt extent. Geometry and stroke come from lib/drawing.ts, which the PDF draws from as well.
import { createElement, type ReactNode } from "react";
import { reactAttrName, shapeSvg, type Shape, type SvgEl } from "../../lib/drawing.ts";
import { em } from "./styles.ts";

export type { Shape } from "../../lib/drawing.ts";

const r = (n: number): number => Math.round(n * 1000) / 1000;

function svgElement(el: SvgEl, key: number): ReactNode {
  const props: Record<string, string | number> = { key };
  for (const [k, v] of Object.entries(el.attrs)) props[reactAttrName(k)] = v;
  return createElement(el.tag, props, ...(el.children ?? []).map((c, i) => svgElement(c, i)));
}

export interface DrawingProps {
  widthPt: number;
  heightPt: number;
  shapes: readonly Shape[];
  basePt: number;
  assetUrl: (asset: string) => string;
  /** The drawing's text frames, already rendered (each a positioned `<foreignObject>`). */
  children?: ReactNode;
}

export function Drawing({ widthPt, heightPt, shapes, basePt, assetUrl, children }: DrawingProps): ReactNode {
  const elements = shapes.map((s) => shapeSvg(s, assetUrl));
  return (
    <svg
      className="drawing"
      viewBox={`0 0 ${r(widthPt)} ${r(heightPt)}`}
      style={{ width: em(widthPt, basePt), maxWidth: "100%", height: "auto", display: "block", overflow: "visible" }}
    >
      {elements.map((el, i) => (el ? svgElement(el, i) : null))}
      {children}
    </svg>
  );
}
