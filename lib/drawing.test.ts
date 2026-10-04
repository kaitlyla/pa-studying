import { describe, expect, it } from "vitest";
import type { Shape } from "./drawing.ts";
import { DASH_STYLES, dashPattern, isDashStyle, isPreset, reactAttrName, shapeSvg, shapeTransform, strokeAttrs, svgMarkup } from "./drawing.ts";
import { schema } from "./schema.ts";

const base: Shape = {
  geom: "rect", x: 10, y: 20, w: 100, h: 40, rot: 0, flipH: false, flipV: false,
  stroke: { color: "112233", widthPt: 2, dash: "solid" }, fill: "FFEE00", head: null, tail: null, asset: null,
};
const noImage = (): undefined => undefined;

describe("dash styles (Orchestrator ruling zeke-69273)", () => {
  it("draws sysDash as 3:1 and the other presets from their ECMA-376 patterns, in line widths", () => {
    expect(dashPattern("sysDash", 2)).toEqual([6, 2]);
    expect(dashPattern("dot", 2)).toEqual([2, 6]);
    expect(dashPattern("dash", 1)).toEqual([4, 3]);
    expect(dashPattern("sysDot", 1)).toEqual([1, 1]);
    expect(dashPattern("lgDashDotDot", 1)).toEqual([8, 3, 1, 3, 1, 3]);
    expect(dashPattern("solid", 1)).toEqual([]);
    expect(dashPattern(null, 1)).toEqual([]);
  });

  it("puts the pattern into stroke-dasharray, with no minimum width", () => {
    expect(strokeAttrs({ color: "000000", widthPt: 0.5, dash: "sysDash" })).toEqual({ stroke: "#000000", "stroke-width": "0.5", "stroke-dasharray": "1.5 0.5" });
    expect(strokeAttrs({ color: "000000", widthPt: 1, dash: "solid" })).toEqual({ stroke: "#000000", "stroke-width": "1" });
  });

  it("an unstroked shape has stroke none, including a line", () => {
    expect(strokeAttrs(null)).toEqual({ stroke: "none" });
    const line = shapeSvg({ ...base, geom: "line", stroke: null, tail: "triangle" }, noImage)!;
    expect(line.children).toEqual([{ tag: "line", attrs: { x1: "10", y1: "20", x2: "110", y2: "60", stroke: "none" } }]);
  });

  it("lists exactly the eleven ST_PresetLineDashVal values", () => {
    expect(DASH_STYLES).toEqual(["solid", "dot", "dash", "lgDash", "dashDot", "lgDashDot", "lgDashDotDot", "sysDash", "sysDot", "sysDashDot", "sysDashDotDot"]);
    expect(isDashStyle("sysDash")).toBe(true);
    expect(isDashStyle("custDash")).toBe(false);
    expect(isDashStyle("toString")).toBe(false);
  });

  it("the schema refuses a stored dash outside the list", () => {
    const drawing = (dash: string | null) => schema.nodeFromJSON({
      type: "drawing", attrs: { widthPt: 10, heightPt: 10, shapes: [{ ...base, stroke: { color: "000000", widthPt: 1, dash } }] },
    });
    expect(() => drawing("sysDash").check()).not.toThrow();
    expect(() => drawing(null).check()).not.toThrow();
    expect(() => drawing("wavy").check()).toThrow(/dash style/);
  });
});

describe("shapeSvg geometry", () => {
  it("draws each preset with its own element and an unknown geometry as its box", () => {
    const tag = (geom: string): string | undefined => shapeSvg({ ...base, geom }, noImage)?.tag;
    expect(["line", "arc", "mathPlus", "rightBrace", "ellipse", "roundRect", "rect", "cloud"].map(tag))
      .toEqual(["g", "path", "path", "path", "ellipse", "rect", "rect", "rect"]);
    expect(isPreset("cloud")).toBe(false);
    expect(isPreset("roundRect")).toBe(true);
  });

  it("leaves open shapes unfilled and fills closed ones", () => {
    expect(shapeSvg({ ...base, geom: "arc" }, noImage)!.attrs.fill).toBe("none");
    expect(shapeSvg({ ...base, geom: "rightBrace" }, noImage)!.attrs.fill).toBe("none");
    expect(shapeSvg({ ...base, geom: "mathPlus" }, noImage)!.attrs.fill).toBe("#FFEE00");
    expect(shapeSvg(base, noImage)!.attrs).toEqual({ x: "10", y: "20", width: "100", height: "40", fill: "#FFEE00", stroke: "#112233", "stroke-width": "2" });
  });

  it("draws the arc from 270° clockwise to 0° on the shape's ellipse", () => {
    expect(shapeSvg({ ...base, geom: "arc" }, noImage)!.attrs.d).toBe("M60 20 A50 20 0 0 1 110 40");
  });

  it("gives a round rectangle its default corner radius", () => {
    const el = shapeSvg({ ...base, geom: "roundRect" }, noImage)!;
    expect([el.attrs.rx, el.attrs.ry]).toEqual(["6.667", "6.667"]);
  });

  it("adds arrowheads in the stroke color at a line's head and tail", () => {
    const el = shapeSvg({ ...base, geom: "straightConnector1", head: "triangle", tail: "arrow" }, noImage)!;
    expect(el.children!.map((c) => c.tag)).toEqual(["line", "polygon", "polygon"]);
    expect(el.children![1]!.attrs.points).toMatch(/^10,20 /);
    expect(el.children![2]!.attrs.points).toMatch(/^110,60 /);
    expect(el.children![2]!.attrs.fill).toBe("#112233");
  });

  it("rotates about the centre and applies flips", () => {
    expect(shapeTransform(base)).toBeNull();
    expect(shapeTransform({ ...base, rot: 90, flipH: true })).toBe("translate(60 40) rotate(90) scale(-1 1) translate(-60 -40)");
    expect(shapeSvg({ ...base, flipV: true }, noImage)!.attrs.transform).toBe("translate(60 40) rotate(0) scale(1 -1) translate(-60 -40)");
  });

  it("draws a picture from its asset URL, and nothing when it has none", () => {
    const pic: Shape = { ...base, geom: "picture", stroke: null, fill: null, asset: "a".repeat(32) + ".png" };
    expect(shapeSvg(pic, (a) => `/assets/${a}`)!.attrs).toEqual({ x: "10", y: "20", width: "100", height: "40", preserveAspectRatio: "none", href: `/assets/${"a".repeat(32)}.png` });
    expect(shapeSvg(pic, noImage)).toBeNull();
  });
});

describe("svgMarkup and reactAttrName", () => {
  it("serializes an element tree with escaped attributes", () => {
    const el = shapeSvg({ ...base, geom: "line", head: "triangle" }, noImage)!;
    const markup = svgMarkup(el);
    expect(markup).toMatch(/^<g><line x1="10" y1="20" x2="110" y2="60" stroke="#112233" stroke-width="2"\/><polygon points="10,20 [^"]+" fill="#112233" stroke="none"\/><\/g>$/);
    expect(svgMarkup({ tag: "image", attrs: { href: 'a"b&c<d' } })).toBe('<image href="a&quot;b&amp;c&lt;d"/>');
  });

  it("maps kebab-case SVG attributes to React's spelling", () => {
    expect(reactAttrName("stroke-dasharray")).toBe("strokeDasharray");
    expect(reactAttrName("preserveAspectRatio")).toBe("preserveAspectRatio");
  });
});
