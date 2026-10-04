import { describe, expect, it } from "vitest";
import { drawingColor, readTheme, shapeFill, shapeOutline } from "./drawingml.ts";
import type { Element } from "./xml.ts";
import { parseXml } from "./xml.ts";

const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const root = (xml: string): Element => parseXml(xml, "test").documentElement!;
/** An element of DrawingML children inside a holder carrying the `a` namespace. */
const holder = (inner: string): Element => root(`<h ${A}>${inner}</h>`);

const THEME = root(`<a:theme ${A}><a:themeElements><a:clrScheme name="t">` +
  '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
  '<a:lt1><a:sysClr val="window"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="44546A"/></a:dk2>' +
  '<a:lt2><a:prstClr val="silver"/></a:lt2>' +
  '<a:accent1><a:scrgbClr r="100000" g="50000" b="0"/></a:accent1>' +
  '<a:accent2><a:hslClr hue="0" sat="0" lum="0"/></a:accent2>' +
  "</a:clrScheme><a:fmtScheme><a:lnStyleLst>" +
  '<a:ln w="6350"/><a:ln w="12700"/><a:ln/>' +
  "</a:lnStyleLst></a:fmtScheme></a:themeElements></a:theme>");

const theme = readTheme(THEME, null);
const color = (xml: string): string | null => drawingColor(holder(xml).firstChild as Element, theme);

describe("readTheme", () => {
  it("resolves every scheme color form, skipping ones it cannot read", () => {
    expect(theme.colors.get("dk1")).toBe("000000");
    expect(theme.colors.get("lt1")).toBe("FFFFFF");
    expect(theme.colors.get("dk2")).toBe("44546A");
    expect(theme.colors.get("lt2")).toBe("C0C0C0");
    expect(theme.colors.get("accent1")).toBe("FF8000");
    expect(theme.colors.has("accent2")).toBe(false);
  });

  it("maps bg1/tx1/bg2/tx2 to lt1/dk1/lt2/dk2 without a color map", () => {
    expect(["bg1", "tx1", "bg2", "tx2"].map((k) => theme.colors.get(k))).toEqual(["FFFFFF", "000000", "C0C0C0", "44546A"]);
  });

  it("follows Word's w:clrSchemeMapping, whose text aliases are w:t1 and w:t2", () => {
    const settings = root(`<w:settings ${W}><w:clrSchemeMapping w:bg1="dark1" w:t1="light1" w:bg2="dark2" w:t2="light2"/></w:settings>`);
    const t = readTheme(THEME, settings);
    expect(["bg1", "tx1", "bg2", "tx2"].map((k) => t.colors.get(k))).toEqual(["000000", "FFFFFF", "44546A", "C0C0C0"]);
  });

  it("follows a PowerPoint p:clrMap when one is given", () => {
    const t = readTheme(THEME, null, root('<clrMap bg1="lt1" tx1="dk2" bg2="lt2" tx2="accent1"/>'));
    expect(["bg1", "tx1", "tx2"].map((k) => t.colors.get(k))).toEqual(["FFFFFF", "44546A", "FF8000"]);
  });

  it("reads the theme line widths, defaulting a missing width to 9525 EMU", () => {
    expect(theme.lineWidths).toEqual([6350, 12700, 9525]);
    expect(readTheme(null, null)).toEqual({ colors: new Map(), lineWidths: [] });
  });
});

describe("drawingColor", () => {
  it("applies shade, tint, lumMod and lumOff", () => {
    expect(color('<a:schemeClr val="accent1"><a:shade val="50000"/></a:schemeClr>')).toBe("804000");
    expect(color('<a:srgbClr val="000000"><a:tint val="50000"/></a:srgbClr>')).toBe("808080");
    expect(color('<a:srgbClr val="FFFFFF"><a:lumMod val="50000"/></a:srgbClr>')).toBe("808080");
    expect(color('<a:srgbClr val="FF0000"><a:lumOff val="25000"/></a:srgbClr>')).toBe("FF8080");
  });

  it("keeps a hue through an identity lumMod for red-, green- and blue-dominant colors", () => {
    for (const hex of ["FF0080", "00FF00", "2040C0", "C08020"]) {
      expect(color(`<a:srgbClr val="${hex}"><a:lumMod val="100000"/></a:srgbClr>`)).toBe(hex);
    }
  });

  it("returns null for an unknown scheme slot, an unsupported form or no element", () => {
    expect(color('<a:schemeClr val="accent6"/>')).toBeNull();
    expect(color('<a:hslClr hue="0" sat="0" lum="0"/>')).toBeNull();
    expect(drawingColor(null, theme)).toBeNull();
  });
});

describe("shapeFill", () => {
  const fill = (spPr: string, style = ""): string | null => shapeFill(holder(spPr), style ? holder(style) : null, theme);

  it("reads noFill, solidFill, the first gradient stop, and the style's fillRef", () => {
    expect(fill('<a:noFill/><a:solidFill><a:srgbClr val="123456"/></a:solidFill>')).toBeNull();
    expect(fill('<a:solidFill><a:srgbClr val="123456"/></a:solidFill>')).toBe("123456");
    expect(fill('<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="ABCDEF"/></a:gs><a:gs pos="100000"><a:srgbClr val="000000"/></a:gs></a:gsLst></a:gradFill>')).toBe("ABCDEF");
    expect(fill("", '<a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef>')).toBe("FF8000");
    expect(fill("", '<a:fillRef idx="0"><a:schemeClr val="accent1"/></a:fillRef>')).toBeNull();
    expect(fill("")).toBeNull();
  });
});

describe("shapeOutline", () => {
  const outline = (spPr: string, style = "") => shapeOutline(holder(spPr), style ? holder(style) : null, theme);

  it("takes color and width from the lnRef theme line when a:ln gives none", () => {
    expect(outline("", '<a:lnRef idx="2"><a:schemeClr val="dk2"/></a:lnRef>').border).toEqual({ style: "solid", widthPt: 1, color: "44546A" });
  });

  it("defaults an a:ln without color or width to 0.75pt black", () => {
    expect(outline('<a:ln><a:prstDash val="lgDashDot"/></a:ln>').border).toEqual({ style: "lgDashDot", widthPt: 0.75, color: "000000" });
  });

  it("stores an unknown dash preset as solid", () => {
    expect(outline('<a:ln w="12700"><a:prstDash val="wavy"/></a:ln>').border!.style).toBe("solid");
  });

  it("reads arrow ends, ignoring type none, even when the line is unfilled", () => {
    const o = outline('<a:ln><a:noFill/><a:headEnd type="triangle"/><a:tailEnd type="none"/></a:ln>');
    expect(o).toEqual({ border: null, head: "triangle", tail: null });
  });
});
