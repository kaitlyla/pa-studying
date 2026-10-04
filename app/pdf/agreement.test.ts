// The screen (app/render) and the PDF (lib/pdf) read stored Word formatting the same way.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildDocDefinition, type Content } from "../../lib/pdf/index.ts";
import { drawingSvg } from "../../lib/pdf/svg.ts";
import { ALL_BORDERS, block, cell, doc, fontmapFor, inlines, para, row, table, txt, wordDoc } from "../../lib/pdf/testing.ts";
import type { DrawingShape, DrawingStroke } from "../../lib/schemaTypes.ts";
import { Drawing } from "../render/Drawing.tsx";
import { borderCss, underlineStyle } from "../render/styles.ts";

const fontmap = fontmapFor(["xab"]);

function pdfContent(d: ReturnType<typeof doc>, kind: "prose" | "table"): Content[] {
  const w = wordDoc();
  w.blocks = [block("b_AAAAAAAAW1", kind, d)];
  return buildDocDefinition({ kind: "doc" }, { doc: w }, fontmap).content;
}

describe("screen and PDF agree", () => {
  it.each(["dotDash", "dotDotDash", "dotted", "dash", "double", "wavyHeavy", "single"])("on the line an underline of style %s draws", (style) => {
    const [run] = inlines(pdfContent(doc(para([txt("x", [{ type: "underline", attrs: { style } }])])), "prose"));
    // pdfmake draws solid when no decorationStyle is set.
    expect(run?.decorationStyle ?? "solid").toBe(underlineStyle(style));
  });

  it("on every drawing shape's geometry, fill and stroke", () => {
    const stroke = (widthPt: number, dash: DrawingStroke["dash"] = null): DrawingStroke => ({ color: "1F3864", widthPt, dash });
    const shape = (geom: string, over: Partial<DrawingShape> = {}): DrawingShape => ({ geom, x: 10, y: 5, w: 40, h: 20, rot: 0, flipH: false, flipV: false, stroke: stroke(1), fill: "FFFFFF", head: null, tail: null, asset: null, ...over });
    const shapes: DrawingShape[] = [
      shape("line", { stroke: null }), // no outline: draws nothing, with no fallback line
      shape("straightConnector1", { head: "triangle", tail: "arrow", flipH: true, stroke: stroke(1.5, "dot") }),
      shape("arc", { rot: 90 }),
      shape("mathPlus", { fill: null }), // noFill
      shape("rightBrace", { flipV: true }),
      shape("ellipse", { stroke: stroke(2, "sysDash") }),
      shape("roundRect", { stroke: stroke(0.5, "lgDashDotDot") }),
      shape("rect"),
      shape("flowChartProcess"),
      shape("picture", { asset: "a".repeat(32) + ".png", stroke: null, fill: null }),
    ];
    const href = (): string => "data:image/png;base64,AAAA";
    const pdf = new DOMParser().parseFromString(drawingSvg(200, 60, shapes, href), "image/svg+xml").documentElement;
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(Drawing, { widthPt: 200, heightPt: 60, shapes, basePt: 11, assetUrl: href }));
    const screen = host.querySelector("svg");
    if (!screen) throw new Error("no svg on screen");

    // Every element under the <svg>, in order, as its tag and its attributes.
    const flat = (root: Element): string[] =>
      [...root.querySelectorAll("*")].map((el) => `${el.tagName.toLowerCase()} ${[...el.attributes].map((a) => `${a.name}=${a.value}`).sort().join(" ")}`);
    expect(flat(screen)).toEqual(flat(pdf));
    // sysDash is 3:1 in multiples of the line width.
    expect(flat(pdf)).toContainEqual(expect.stringMatching(/^ellipse .*stroke-dasharray=6 2 /));
    expect(flat(pdf).some((e) => e.startsWith("line ") && e.includes("stroke=none"))).toBe(true);
    expect(flat(pdf)).toContainEqual(expect.stringMatching(/^path .*fill=none .*stroke=#1F3864/));
  });

  it.each(["nil", "NIL", "none"])("that a %s border draws nothing", (style) => {
    const nil = { style, widthPt: 1, color: "000000" };
    expect(borderCss(nil, 11)).toBe("none");
    const [c] = pdfContent(doc(table([50, 50], [row("r_AAAAAAAAA1", "content", [cell("a", { borders: { left: nil } }), "b"])], { borders: ALL_BORDERS })), "table");
    const first = (c?.table as { body: Content[][] }).body[0]?.[0];
    expect((first?.border as boolean[])[0]).toBe(false);
  });
});
