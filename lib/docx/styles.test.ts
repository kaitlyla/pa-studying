import { describe, expect, it } from "vitest";
import { Styles, readPPr, readRPr, readTblPr, readTcPr } from "./styles.ts";
import type { Element } from "./xml.ts";
import { parseXml } from "./xml.ts";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const el = (tag: string, inner: string): Element => parseXml(`<w:${tag} ${W}>${inner}</w:${tag}>`, "test").documentElement!;

describe("readRPr", () => {
  it("reads toggles, underline, vertical alignment, size, colors and fonts", () => {
    const r = readRPr(el("rPr",
      '<w:b/><w:i w:val="0"/><w:dstrike/><w:u/><w:vertAlign w:val="subscript"/><w:sz w:val="21"/><w:color w:val="auto"/>' +
      '<w:highlight w:val="darkYellow"/><w:shd w:val="clear" w:fill="auto"/><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsi="Arial"/><w:rStyle w:val="Emph"/>'));
    expect(r).toEqual({
      bold: true, italic: false, dstrike: true, underline: "single", vertAlign: "sub", sizePt: 10.5,
      color: null, highlight: "808000", shade: null, font: "", fontH: "Arial", rStyle: "Emph",
    });
  });

  it("keeps an explicit baseline and an unknown highlight as overrides", () => {
    expect(readRPr(el("rPr", '<w:vertAlign w:val="baseline"/><w:highlight w:val="none"/><w:u w:val="none"/>')))
      .toEqual({ vertAlign: "baseline", highlight: null, underline: "none" });
    expect(readRPr(null)).toEqual({});
  });
});

describe("readPPr", () => {
  it("reads logical indents, spacing, alignment, shading, borders, numbering and tabs", () => {
    const p = readPPr(el("pPr",
      '<w:pStyle w:val="Body"/><w:numPr><w:ilvl w:val="2"/><w:numId w:val="4"/></w:numPr>' +
      '<w:pBdr><w:top w:val="single" w:sz="4" w:color="FF0000"/><w:start w:val="nil"/></w:pBdr><w:shd w:fill="D9D9D9"/>' +
      '<w:tabs><w:tab w:val="left" w:pos="1440"/><w:tab w:val="clear" w:pos="720"/></w:tabs>' +
      '<w:spacing w:before="120" w:after="240" w:line="360" w:lineRule="auto"/><w:ind w:start="720" w:end="360" w:firstLine="180"/><w:jc w:val="both"/>'));
    expect(p).toEqual({
      indLeft: 36, indRight: 18, indFirst: 9, spaceBefore: 6, spaceAfter: 12, line: { rule: "auto", value: 1.5 },
      jc: "both", shade: "D9D9D9", borders: { top: { style: "single", widthPt: 0.5, color: "FF0000" }, right: null, bottom: null, left: null },
      numId: "4", ilvl: 2, pStyle: "Body", tabs: [72],
    });
  });

  it("lets a hanging indent win over firstLine, reads exact spacing, and drops all-nil borders", () => {
    const p = readPPr(el("pPr", '<w:ind w:left="720" w:hanging="360" w:firstLine="100"/><w:spacing w:line="280" w:lineRule="exact"/><w:pBdr><w:left w:val="none"/></w:pBdr>'));
    expect(p).toEqual({ indLeft: 36, indFirst: -18, line: { rule: "exact", value: 14 }, borders: null });
  });
});

describe("readTblPr / readTcPr", () => {
  it("reads table indent, borders (nil kept as null), cell margins and band sizes", () => {
    const t = readTblPr(el("tblPr",
      '<w:tblInd w:w="144" w:type="dxa"/><w:tblBorders><w:insideH w:val="single" w:sz="8"/><w:end w:val="none"/></w:tblBorders>' +
      '<w:tblCellMar><w:start w:w="108"/><w:top w:w="0"/></w:tblCellMar><w:tblStyleRowBandSize w:val="2"/><w:tblStyleColBandSize w:val="3"/>'));
    expect(t).toEqual({
      indentPt: 7.2, borders: { insideH: { style: "single", widthPt: 1, color: "000000" }, right: null },
      cellMargin: { left: 5.4, top: 0 }, rowBand: 2, colBand: 3,
    });
    expect(readTblPr(el("tblPr", '<w:tblInd w:w="500" w:type="pct"/>'))).toEqual({});
  });

  it("reads cell fill, vertical alignment and borders", () => {
    expect(readTcPr(el("tcPr", '<w:shd w:fill="ffff00"/><w:vAlign w:val="center"/><w:tcBorders><w:bottom w:val="double" w:sz="12" w:color="0000FF"/></w:tcBorders>')))
      .toEqual({ fill: "FFFF00", vAlign: "center", borders: { bottom: { style: "double", widthPt: 1.5, color: "0000FF" } } });
    expect(readTcPr(null)).toEqual({});
  });
});

describe("Styles", () => {
  const styles = new Styles(el("styles",
    '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:rPr><w:color w:val="111111"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="H1"><w:basedOn w:val="Normal"/><w:pPr><w:pStyle w:val="H1"/><w:jc w:val="center"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="LoopA"><w:basedOn w:val="LoopB"/><w:rPr><w:i/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="LoopB"><w:basedOn w:val="LoopA"/><w:rPr><w:caps/></w:rPr></w:style>' +
    '<w:style w:type="character" w:styleId="Em"><w:rPr><w:rStyle w:val="Em"/><w:i/></w:rPr></w:style>' +
    '<w:style w:type="table" w:styleId="Grid"><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="8"/></w:tblBorders><w:tblCellMar><w:left w:w="100"/></w:tblCellMar></w:tblPr>' +
    '<w:tcPr><w:shd w:fill="EEEEEE"/></w:tcPr><w:tblStylePr w:type="firstRow"><w:rPr><w:b/></w:rPr><w:tcPr><w:shd w:fill="333333"/></w:tcPr></w:tblStylePr></w:style>' +
    '<w:style w:type="table" w:styleId="Grid2"><w:basedOn w:val="Grid"/><w:tblPr><w:tblBorders><w:bottom w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>' +
    '<w:tblStylePr w:type="firstRow"><w:pPr><w:jc w:val="center"/></w:pPr></w:tblStylePr></w:style>' +
    '<w:style w:type="numbering" w:styleId="ListNum"><w:pPr><w:numPr><w:numId w:val="7"/></w:numPr></w:pPr></w:style>' +
    '<w:style w:type="paragraph"><w:name w:val="no id"/></w:style>'));

  it("reads the document defaults", () => {
    expect(styles.docR).toEqual({ sizePt: 11 });
    expect(styles.docP).toEqual({ spaceAfter: 8 });
  });

  it("flattens a paragraph style chain, later wins, without the style's own pStyle", () => {
    expect(styles.paragraph("H1")).toEqual({ p: { jc: "center" }, r: { color: "111111", bold: true } });
  });

  it("falls back to the default paragraph style for no id or an id of another type", () => {
    expect(styles.paragraph(undefined).r).toEqual({ color: "111111" });
    expect(styles.paragraph("Em").r).toEqual({ color: "111111" });
  });

  it("stops at a basedOn cycle", () => {
    expect(styles.paragraph("LoopA").r).toEqual({ caps: true, italic: true });
  });

  it("resolves character styles only for character-type ids", () => {
    expect(styles.character("Em")).toEqual({ italic: true });
    expect(styles.character("H1")).toEqual({});
    expect(styles.character(undefined)).toEqual({});
  });

  it("merges table styles through basedOn, including conditional formats", () => {
    const t = styles.table("Grid2");
    expect(t.table).toEqual({
      borders: { top: { style: "single", widthPt: 1, color: "000000" }, bottom: { style: "single", widthPt: 0.5, color: "000000" } },
      cellMargin: { left: 5 },
    });
    expect(t.base.tc).toEqual({ fill: "EEEEEE" });
    expect(t.cond.get("firstRow")).toEqual({ p: { jc: "center" }, r: { bold: true }, tc: { fill: "333333" } });
  });

  it("finds a numbering style's numId", () => {
    expect(styles.numberingStyleNumId("ListNum")).toBe("7");
    expect(styles.numberingStyleNumId("Missing")).toBeNull();
  });
});
