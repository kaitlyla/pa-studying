// Minimal Word packages for the converter and verifier tests (99 §99.1). Each fixture is built in
// memory and zipped with fflate, so no source document is committed.
import { zipSync, strToU8 } from "fflate";
import sharp from "sharp";

const NS_DECL = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
  'xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'xmlns:v="urn:schemas-microsoft-com:vml"',
  'xmlns:o="urn:schemas-microsoft-com:office:office"',
].join(" ");

const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export interface ExtraRel {
  id: string;
  type: string;
  target: string;
  external?: boolean;
}

export interface PackageParts {
  /** Inner XML of w:body, before the final w:sectPr. */
  body: string;
  /** Inner XML of the final w:sectPr. */
  sectPr?: string;
  /** Inner XML of w:styles. */
  styles?: string;
  /** Inner XML of w:numbering. */
  numbering?: string;
  /** Inner XML of w:footnotes / w:endnotes, after the separator notes. */
  footnotes?: string;
  endnotes?: string;
  /** Inner XML of w:hdr / w:ftr, related as rIdHdr / rIdFtr. */
  header?: string;
  footer?: string;
  /** Extra relationships of word/document.xml. */
  rels?: ExtraRel[];
  /** Files under word/media/. */
  media?: Record<string, Uint8Array>;
}

const xml = (body: string): Uint8Array => strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`);

function relsXml(rels: ExtraRel[]): Uint8Array {
  const items = rels.map((r) => `<Relationship Id="${r.id}" Type="${REL_TYPE}/${r.type}" Target="${r.target}"${r.external ? ' TargetMode="External"' : ""}/>`);
  return xml(`<Relationships xmlns="${REL_NS}">${items.join("")}</Relationships>`);
}

const SEPARATORS = (tag: string): string =>
  `<w:${tag} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:${tag}>` +
  `<w:${tag} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:${tag}>`;

/** Zips a Word package from its parts. */
export function buildDocx(p: PackageParts): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const rels: ExtraRel[] = [...(p.rels ?? [])];
  const types: string[] = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Default Extension="png" ContentType="image/png"/>',
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
  ];
  const part = (name: string, rel: string, root: string, inner: string | undefined): void => {
    if (inner === undefined) return;
    files[`word/${name}`] = xml(`<w:${root} ${NS_DECL}>${inner}</w:${root}>`);
    rels.push({ id: `rId_${rel}`, type: rel, target: name });
  };
  part("styles.xml", "styles", "styles", p.styles);
  part("numbering.xml", "numbering", "numbering", p.numbering);
  part("footnotes.xml", "footnotes", "footnotes", p.footnotes === undefined ? undefined : SEPARATORS("footnote") + p.footnotes);
  part("endnotes.xml", "endnotes", "endnotes", p.endnotes === undefined ? undefined : SEPARATORS("endnote") + p.endnotes);
  if (p.header !== undefined) {
    files["word/header1.xml"] = xml(`<w:hdr ${NS_DECL}>${p.header}</w:hdr>`);
    rels.push({ id: "rIdHdr", type: "header", target: "header1.xml" });
  }
  if (p.footer !== undefined) {
    files["word/footer1.xml"] = xml(`<w:ftr ${NS_DECL}>${p.footer}</w:ftr>`);
    rels.push({ id: "rIdFtr", type: "footer", target: "footer1.xml" });
  }
  for (const [name, bytes] of Object.entries(p.media ?? {})) files[`word/media/${name}`] = bytes;
  files["word/document.xml"] = xml(`<w:document ${NS_DECL}><w:body>${p.body}<w:sectPr>${p.sectPr ?? ""}</w:sectPr></w:body></w:document>`);
  files["word/_rels/document.xml.rels"] = relsXml(rels);
  files["_rels/.rels"] = relsXml([{ id: "rId1", type: "officeDocument", target: "word/document.xml" }]);
  files["[Content_Types].xml"] = xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${types.join("")}</Types>`);
  return zipSync(files);
}

// ---------------------------------------------------------------------------------------------
// XML snippets

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A run: `<w:r>` with optional rPr inner XML and text (spaces preserved). */
export const run = (text: string, rPr = ""): string =>
  `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;

/** A paragraph from pPr inner XML and inline XML. */
export const para = (inline: string, pPr = ""): string => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${inline}</w:p>`;

/** A numbered paragraph. */
export const listPara = (text: string, numId: number, ilvl: number): string =>
  para(run(text), `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`);

/** A table from rows of cell XML (each cell: tcPr inner XML and content XML). */
export function tbl(rows: { trPr?: string; cells: { tcPr?: string; content: string }[] }[], tblPr = "", cols = 2): string {
  const grid = Array.from({ length: cols }, () => '<w:gridCol w:w="2000"/>').join("");
  const body = rows.map((r) =>
    `<w:tr>${r.trPr ? `<w:trPr>${r.trPr}</w:trPr>` : ""}${r.cells.map((c) => `<w:tc>${c.tcPr ? `<w:tcPr>${c.tcPr}</w:tcPr>` : ""}${c.content}</w:tc>`).join("")}</w:tr>`).join("");
  return `<w:tbl><w:tblPr>${tblPr}</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`;
}

export const lvl = (ilvl: number, numFmt: string, text: string, extra = ""): string =>
  `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${numFmt}"/><w:lvlText w:val="${esc(text)}"/>${extra}</w:lvl>`;

export const abstractNum = (id: number, levels: string): string => `<w:abstractNum w:abstractNumId="${id}">${levels}</w:abstractNum>`;

export const num = (id: number, abstractId: number, overrides = ""): string =>
  `<w:num w:numId="${id}"><w:abstractNumId w:val="${abstractId}"/>${overrides}</w:num>`;

/** A wps text box drawing (inline or anchored) holding the given paragraphs. */
export function textboxDrawing(paras: string, anchor: boolean): string {
  const graphic = `<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp>` +
    `<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"/><a:solidFill><a:srgbClr val="FFFF00"/></a:solidFill></wps:spPr>` +
    `<wps:txbx><w:txbxContent>${paras}</w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic>`;
  return anchor
    ? `<w:drawing><wp:anchor><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:extent cx="1270000" cy="635000"/>${graphic}</wp:anchor></w:drawing>`
    : `<w:drawing><wp:inline><wp:extent cx="1270000" cy="635000"/>${graphic}</wp:inline></w:drawing>`;
}

/** An inline textless wps shape with the given preset, extra spPr XML and wps:style XML. */
export function shapeDrawing(prst: string, spPr = "", style = ""): string {
  return `<w:drawing><wp:inline><wp:extent cx="1270000" cy="127000"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp>` +
    `<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="127000"/></a:xfrm><a:prstGeom prst="${prst}"/>${spPr}</wps:spPr>` +
    `${style ? `<wps:style>${style}</wps:style>` : ""}<wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing>`;
}

/** A pic:pic drawing referencing a media relationship. */
export function pictureDrawing(relId: string, opts: { anchor?: { relativeFrom: string; posOffset: number }; srcRect?: string; cx?: number; cy?: number } = {}): string {
  const cx = opts.cx ?? 1270000;
  const cy = opts.cy ?? 635000;
  const graphic = `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>` +
    `<pic:nvPicPr><pic:cNvPr id="1" name="p"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}"/>${opts.srcRect ? `<a:srcRect ${opts.srcRect}/>` : ""}<a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr></pic:pic></a:graphicData></a:graphic>`;
  if (opts.anchor) {
    return `<w:drawing><wp:anchor><wp:positionH relativeFrom="${opts.anchor.relativeFrom}"><wp:posOffset>${opts.anchor.posOffset}</wp:posOffset></wp:positionH>` +
      `<wp:extent cx="${cx}" cy="${cy}"/>${graphic}</wp:anchor></w:drawing>`;
  }
  return `<w:drawing><wp:inline><wp:extent cx="${cx}" cy="${cy}"/>${graphic}</wp:inline></w:drawing>`;
}

/** A solid-colour PNG of the given size. */
export async function png(width: number, height: number, rgb: [number, number, number] = [200, 30, 30]): Promise<Uint8Array> {
  const buf = await sharp({ create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer();
  return new Uint8Array(buf);
}

const imageRel = (id: string, name: string): ExtraRel => ({ id, type: "image", target: `media/${name}` });

// ---------------------------------------------------------------------------------------------
// The 99 §99.1 scenario table

const TWO_LEVEL = abstractNum(0, lvl(0, "decimal", "%1.") + lvl(1, "lowerLetter", "%2)"));

export interface Fixture {
  name: string;
  build(): Promise<Uint8Array>;
}

const sync = (name: string, parts: PackageParts): Fixture => ({ name, build: async () => buildDocx(parts) });

/** Every 99 §99.1 converter scenario, plus the Inspector-required restart-after-override and nil-border cases. */
export const FIXTURES: Record<string, Fixture> = {
  symbolMap: sync("symbol map", { body: para(`<w:r><w:sym w:font="Wingdings" w:char="F0E0"/></w:r>`) }),
  unmappedSymbol: sync("unmapped symbol", { body: para(`<w:r><w:sym w:font="Wingdings" w:char="F0FC"/></w:r>`) }),
  breaks: sync("breaks", {
    body: para(`<w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t><w:br w:type="page"/><w:t>d</w:t><w:softHyphen/><w:t>e</w:t></w:r>`),
  }),
  numbering: sync("numbering", {
    numbering: TWO_LEVEL + num(1, 0),
    body: [listPara("one", 1, 0), listPara("a", 1, 1), listPara("b", 1, 1), listPara("two", 1, 0), listPara("three", 1, 0)].join(""),
  }),
  restart: sync("restart", {
    numbering: abstractNum(0, lvl(0, "decimal", "%1.") + lvl(1, "lowerLetter", "%2)").replace('<w:lvl w:ilvl="1"><w:start w:val="1"/>', '<w:lvl w:ilvl="1"><w:start w:val="3"/>')) + num(1, 0),
    body: [listPara("one", 1, 0), listPara("c", 1, 1), listPara("d", 1, 1), listPara("two", 1, 0), listPara("c again", 1, 1)].join(""),
  }),
  bulletFont: sync("bullet font", {
    numbering: abstractNum(0, lvl(0, "bullet", "o", '<w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/></w:rPr>')) + num(1, 0),
    body: listPara("item", 1, 0),
  }),
  vMerge: sync("vMerge", {
    body: tbl([
      { cells: [{ tcPr: '<w:vMerge w:val="restart"/>', content: para(run("top")) }, { content: para(run("r1")) }] },
      { cells: [{ tcPr: "<w:vMerge/>", content: para("") }, { content: para(run("r2")) }] },
      { cells: [{ tcPr: "<w:vMerge/>", content: para(run("x")) }, { content: para(run("r3")) }] },
    ]),
  }),
  tblHeader: sync("tblHeader", {
    body: tbl([
      { trPr: "<w:tblHeader/>", cells: [{ content: para(run("h1")) }, { content: para(run("h2")) }] },
      { trPr: '<w:tblHeader w:val="0"/>', cells: [{ content: para(run("c1")) }, { content: para(run("c2")) }] },
    ]),
  }),
  textboxInCell: sync("text box in a cell", {
    body: tbl([{ cells: [{ content: para(run("anchor") + `<w:r>${textboxDrawing(para(run("boxed")), true)}</w:r>`) }, { content: para(run("other")) }] }]),
  }),
  choiceFallback: sync("Choice/Fallback", {
    body: para(run("host") + `<w:r><mc:AlternateContent><mc:Choice Requires="wps">${textboxDrawing(para(run("from choice")), false)}</mc:Choice>` +
      `<mc:Fallback><w:pict><v:shape style="width:100pt;height:50pt"><v:textbox><w:txbxContent>${para(run("from fallback"))}</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>`),
  }),
  crop: {
    name: "crop",
    build: async () => buildDocx({
      rels: [imageRel("rIdImg", "wide.png")],
      media: { "wide.png": await png(200, 100) },
      body: para(`<w:r>${pictureDrawing("rIdImg", { srcRect: 'l="25000" r="25000"' })}</w:r>`),
    }),
  },
  uncropped: {
    name: "uncropped",
    build: async () => buildDocx({
      rels: [imageRel("rIdImg", "plain.png")],
      media: { "plain.png": await png(30, 20, [10, 120, 40]) },
      body: para(`<w:r>${pictureDrawing("rIdImg")}</w:r>`),
    }),
  },
  anchoredPicture: {
    name: "anchored picture",
    build: async () => buildDocx({
      rels: [imageRel("rIdImg", "a.png")],
      media: { "a.png": await png(20, 20, [0, 0, 200]) },
      body: para(run("text") + `<w:r>${pictureDrawing("rIdImg", { anchor: { relativeFrom: "column", posOffset: 127000 } })}</w:r>`),
    }),
  },
  themeColor: sync("theme color", {
    body: para(run("themed", '<w:color w:val="1F3864" w:themeColor="accent1" w:themeShade="BF"/>') + run("auto", '<w:color w:val="auto"/>')),
  }),
  rule: sync("rule", {
    body: para(`<w:r><w:pict><v:rect style="width:0;height:1.5pt" o:hr="t" o:hrstd="t" fillcolor="#A0A0A0" stroked="f"/></w:pict></w:r>`),
  }),
  footnote: sync("footnote", {
    body: para(run("Body text") + `<w:r><w:footnoteReference w:id="1"/></w:r>`),
    footnotes: `<w:footnote w:id="1">${para(`<w:r><w:footnoteRef/></w:r>${run(" Note text")}`)}</w:footnote>`,
  }),
  endnote: sync("endnote", {
    sectPr: '<w:endnotePr><w:numFmt w:val="decimal"/></w:endnotePr>',
    body: para(run("Body") + `<w:r><w:footnoteReference w:id="1"/></w:r>` + run(" more") + `<w:r><w:endnoteReference w:id="1"/></w:r>`),
    footnotes: `<w:footnote w:id="1">${para(`<w:r><w:footnoteRef/></w:r>${run(" Foot text")}`)}</w:footnote>`,
    endnotes: `<w:endnote w:id="1">${para(`<w:r><w:endnoteRef/></w:r>${run(" End text")}`)}</w:endnote>`,
  }),
  endnoteDefault: sync("endnote default format", {
    body: para(run("Body") + `<w:r><w:endnoteReference w:id="1"/></w:r>`),
    endnotes: `<w:endnote w:id="1">${para(`<w:r><w:endnoteRef/></w:r>${run(" End text")}`)}</w:endnote>`,
  }),
  headerFooter: sync("header/footer", {
    sectPr: '<w:headerReference w:type="default" r:id="rIdHdr"/><w:footerReference w:type="default" r:id="rIdFtr"/>',
    header: para(run("H")),
    footer: para(run("F")),
    body: para(run("middle")),
  }),
  hyperlink: sync("hyperlink", {
    rels: [
      { id: "rIdL1", type: "hyperlink", target: "https://example.org/x", external: true },
      { id: "rIdL2", type: "hyperlink", target: "javascript:alert(1)", external: true },
    ],
    body: para(`<w:hyperlink r:id="rIdL1">${run("safe")}</w:hyperlink>${run(" and ")}<w:hyperlink r:id="rIdL2">${run("unsafe")}</w:hyperlink>`),
  }),
  tblStylePr: sync("tblStylePr", {
    styles: `<w:style w:type="table" w:styleId="T"><w:name w:val="T"/><w:tblStylePr w:type="firstRow"><w:rPr><w:b/></w:rPr></w:tblStylePr></w:style>`,
    body: tbl([
      { cells: [{ content: para(run("head1")) }, { content: para(run("head2")) }] },
      { cells: [{ content: para(run("body1")) }, { content: para(run("body2")) }] },
    ], '<w:tblStyle w:val="T"/><w:tblLook w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/>'),
  }),
  startOverride: sync("lvlOverride/startOverride", {
    numbering: TWO_LEVEL + num(2, 0, '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride>'),
    body: [listPara("five", 2, 0), listPara("six", 2, 0), listPara("seven", 2, 0)].join(""),
  }),
  lvlRestart: sync("lvlRestart", {
    numbering: abstractNum(0, lvl(0, "decimal", "%1.") + lvl(1, "lowerLetter", "%2)", '<w:lvlRestart w:val="0"/>')) + num(1, 0),
    body: [listPara("one", 1, 0), listPara("a", 1, 1), listPara("two", 1, 0), listPara("b", 1, 1)].join(""),
  }),
  hMerge: sync("hMerge", {
    body: tbl([
      { cells: [{ tcPr: '<w:hMerge w:val="restart"/>', content: para(run("wide")) }, { tcPr: '<w:hMerge w:val="continue"/>', content: para("") }] },
      { cells: [{ content: para(run("l")) }, { content: para(run("r")) }] },
    ]),
  }),
  restartAfterOverride: sync("restart after startOverride", {
    numbering: TWO_LEVEL + num(3, 0, '<w:lvlOverride w:ilvl="1"><w:startOverride w:val="5"/></w:lvlOverride>'),
    body: [listPara("one", 3, 0), listPara("e", 3, 1), listPara("f", 3, 1), listPara("two", 3, 0), listPara("e again", 3, 1)].join(""),
  }),
  shapeStrokes: sync("shape strokes", {
    body: para(run("shapes") +
      `<w:r>${shapeDrawing("line", "", '<a:lnRef idx="1"><a:srgbClr val="4472C4"/></a:lnRef><a:fillRef idx="0"><a:srgbClr val="FFFFFF"/></a:fillRef>')}</w:r>` +
      `<w:r>${shapeDrawing("ellipse", "<a:ln><a:noFill/></a:ln>", '<a:lnRef idx="1"><a:srgbClr val="4472C4"/></a:lnRef>')}</w:r>` +
      `<w:r>${shapeDrawing("rect", '<a:ln w="25400"><a:solidFill><a:srgbClr val="00AA00"/></a:solidFill><a:prstDash val="sysDot"/></a:ln>')}</w:r>` +
      `<w:r>${shapeDrawing("cloud")}</w:r>`),
  }),
  nilLeftBorder: sync("nil left border", {
    styles: `<w:style w:type="table" w:styleId="G"><w:name w:val="G"/><w:tblPr><w:tblBorders><w:left w:val="single" w:sz="8" w:color="FF0000"/><w:top w:val="single" w:sz="8" w:color="FF0000"/></w:tblBorders></w:tblPr>` +
      `<w:tcPr><w:tcBorders><w:left w:val="single" w:sz="8" w:color="00FF00"/></w:tcBorders></w:tcPr></w:style>`,
    body: tbl([{
      cells: [
        { tcPr: '<w:tcBorders><w:left w:val="nil"/></w:tcBorders>', content: para(run("no left")) },
        { content: para(run("styled left")) },
      ],
    }], '<w:tblStyle w:val="G"/><w:tblBorders><w:left w:val="nil"/></w:tblBorders>'),
  }),
  emptyTextbox: sync("empty text box", {
    body: para(run("host") + `<w:r>${textboxDrawing("", true)}</w:r>`),
  }),
  group: {
    name: "group drawing",
    build: async () => buildDocx({
      rels: [imageRel("rIdImg", "g.png")],
      media: { "g.png": await png(10, 10, [0, 90, 0]) },
      body: para(run("grouped") + `<w:r>${groupDrawing}</w:r>`),
    }),
  },
  vml: {
    name: "VML shapes",
    build: async () => buildDocx({
      rels: [imageRel("rIdImg", "v.png")],
      media: { "v.png": await png(10, 10, [90, 0, 0]) },
      body: para(run("rule follows") + `<w:r><w:pict><v:rect style="width:0;height:2pt" o:hr="t" fillcolor="#ff0000"/></w:pict></w:r>`) +
        para(run("boxes") + `<w:r><w:pict><v:shapetype id="t202"/>` +
          `<v:shape style="position:absolute;margin-left:10pt;width:100pt;height:40pt" fillcolor="#00ff00" strokecolor="#0000ff" strokeweight="2pt">` +
          `<v:textbox><w:txbxContent>${para(run("vml box"))}</w:txbxContent></v:textbox></v:shape>` +
          `<v:shape style="width:80pt;height:30pt" filled="f" stroked="f"><v:textbox><w:txbxContent>${para(run("plain box"))}</w:txbxContent></v:textbox></v:shape>` +
          `</w:pict></w:r>`) +
        para(run("picture") + `<w:r><w:pict><v:group style="width:50pt;height:20pt"><v:shape style="width:50pt;height:20pt;rotation:90;flip:x">` +
          `<v:imagedata r:id="rIdImg"/></v:shape></v:group></w:pict></w:r>`),
    }),
  },
};

/**
 * A wpg group drawn at half its frame size: a stroked rect, a text box, a rotated and flipped picture,
 * and a nested group scaled by a further half holding an unfilled, unstroked ellipse.
 */
const groupDrawing = `<w:drawing><wp:inline><wp:extent cx="1270000" cy="635000"/><a:graphic>` +
  `<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"><wpg:wgp>` +
  `<wpg:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2540000" cy="1270000"/><a:chOff x="0" y="0"/><a:chExt cx="2540000" cy="1270000"/></a:xfrm></wpg:grpSpPr>` +
  `<wps:wsp><wps:spPr><a:xfrm><a:off x="254000" y="127000"/><a:ext cx="508000" cy="254000"/></a:xfrm><a:prstGeom prst="rect"/>` +
  `<a:ln w="12700"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln></wps:spPr><wps:bodyPr/></wps:wsp>` +
  `<wps:wsp><wps:spPr><a:xfrm><a:off x="1270000" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"/></wps:spPr>` +
  `<wps:txbx><w:txbxContent>${para(run("in group"))}</w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp>` +
  `<pic:pic><pic:nvPicPr><pic:cNvPr id="2" name="gp"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
  `<pic:spPr><a:xfrm rot="5400000" flipH="1"><a:off x="0" y="635000"/><a:ext cx="254000" cy="254000"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr></pic:pic>` +
  `<wpg:grpSp><wpg:grpSpPr><a:xfrm><a:off x="1270000" y="635000"/><a:ext cx="1270000" cy="635000"/><a:chOff x="0" y="0"/><a:chExt cx="2540000" cy="1270000"/></a:xfrm></wpg:grpSpPr>` +
  `<wps:wsp><wps:spPr><a:xfrm><a:off x="254000" y="254000"/><a:ext cx="508000" cy="508000"/></a:xfrm><a:prstGeom prst="ellipse"/><a:noFill/><a:ln><a:noFill/></a:ln></wps:spPr><wps:bodyPr/></wps:wsp>` +
  `</wpg:grpSp></wpg:wgp></a:graphicData></a:graphic></wp:inline></w:drawing>`;
