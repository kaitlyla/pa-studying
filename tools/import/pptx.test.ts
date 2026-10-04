// PowerPoint reading (30 §30.10) over minimal packages built in the test.
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { Node } from "prosemirror-model";
import { validateFile } from "../../lib/content/index.ts";
import type { DocJSON } from "../../lib/content/index.ts";
import { schema } from "../../lib/schema.ts";
import { applyPsychEdit, convertDeck, editPsychDeck, PSYCH_REMOVED_LINE, slideParts, slideTexts } from "./pptx.ts";

/** The schema's canonical form of a doc with this content (defaults filled in, schema mark order). */
const canon = (content: unknown[]): DocJSON => Node.fromJSON(schema, { type: "doc", content }).toJSON() as DocJSON;

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const esc = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** A run; `rPr` is the inner XML of a:rPr, `attrs` its attributes. */
const r = (text: string, attrs = "", rPr = ""): string => `<a:r><a:rPr lang="en-US"${attrs ? ` ${attrs}` : ""}>${rPr}</a:rPr><a:t>${esc(text)}</a:t></a:r>`;
const p = (runs: string, lvl?: number): string => `<a:p>${lvl === undefined ? "" : `<a:pPr lvl="${lvl}"/>`}${runs}</a:p>`;
const sp = (...paras: string[]): string => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="x"/></p:nvSpPr><p:txBody><a:bodyPr/>${paras.join("")}</p:txBody></p:sp>`;
const slideXml = (shapes: string): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/></p:nvGrpSpPr>${shapes}</p:spTree></p:cSld></p:sld>`;

interface DeckOptions {
  /** Order of slide files in sldIdLst (1-based file numbers); defaults to file order. */
  order?: number[];
  extra?: Record<string, Uint8Array>;
}

function pptx(slides: string[], { order = slides.map((_, i) => i + 1), extra = {} }: DeckOptions = {}): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    "ppt/presentation.xml": strToU8(`<p:presentation ${NS}><p:sldIdLst>${order.map((n, i) => `<p:sldId id="${256 + i}" r:id="rId${n + 1}"/>`).join("")}</p:sldIdLst></p:presentation>`),
    "ppt/_rels/presentation.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, i) => `<Relationship Id="rId${i + 2}" Type="slide" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>`),
    ...extra,
  };
  slides.forEach((s, i) => { files[`ppt/slides/slide${i + 1}.xml`] = strToU8(slideXml(s)); });
  return zipSync(files);
}

/** Wingdings code F0E0 (her arrows) and F0FC (in no mapping), as PowerPoint stores them. */
const WINGDINGS_ARROW = String.fromCodePoint(0xf0e0);
const WINGDINGS_UNMAPPED = String.fromCodePoint(0xf0fc);
const WD = '<a:sym typeface="Wingdings" panose="05000000000000000000" pitchFamily="2" charset="2"/>';

describe("slideParts", () => {
  it("follows p:sldIdLst, not part names", () => {
    const entries = unzipSync(pptx([sp(p(r("one"))), sp(p(r("two")))], { order: [2, 1] }));
    expect(slideParts(entries)).toEqual(["ppt/slides/slide2.xml", "ppt/slides/slide1.xml"]);
  });

  it("fails on a missing presentation part, a dangling relationship or a missing slide part", () => {
    expect(() => slideParts({})).toThrow(/no ppt\/presentation.xml/);
    const entries = unzipSync(pptx([sp(p(r("one")))], { order: [3] }));
    expect(() => slideParts(entries)).toThrow(/slide relationship rId4 not found/);
    const noSlide = unzipSync(pptx([sp(p(r("one")))]));
    delete noSlide["ppt/slides/slide1.xml"];
    expect(() => slideParts(noSlide)).toThrow(/no ppt\/slides\/slide1.xml/);
    const malformed = { ...unzipSync(pptx([sp(p(r("one")))])), "ppt/presentation.xml": strToU8(`<p:presentation ${NS}><p:sldIdLst>&bogus;</p:sldIdLst></p:presentation>`) };
    expect(() => slideParts(malformed)).toThrow(/ppt\/presentation.xml: XML/);
  });

  it("is empty for a presentation with no slide list", () => {
    expect(slideParts({ "ppt/presentation.xml": strToU8(`<p:presentation ${NS}/>`), "ppt/_rels/presentation.xml.rels": strToU8("<Relationships/>") })).toEqual([]);
  });
});

describe("slideTexts (text.json of a deck shown as-is)", () => {
  it("joins each slide's paragraphs with \\n in shape order, maps Wingdings U+F0E0 to →, and keeps line breaks", () => {
    const deck = pptx([
      sp(p(r("Title"))) + sp(p(r("QTc ") + r(WINGDINGS_ARROW, "", WD) + r(" Torsades"), 2), p(""), p(`${r("a")}<a:br/>${r("b")}`)),
      `<p:grpSp>${sp(p(r("in a group")))}</p:grpSp>`,
    ]);
    expect(slideTexts(deck)).toEqual(["Title\nQTc → Torsades\n\na\nb", "in a group"]);
  });
});

describe("convertDeck", () => {
  it("builds the heading line, lead paragraphs and slide cards with the 30 §30.10 indents and bullets", () => {
    const [doc] = convertDeck(pptx([
      sp(p(r("SSRIs and more"))) + sp(
        p(r("Lead line")),
        p(""),
        p(r("SSRIs")),
        p(r("Fluoxetine"), 1),
        p(r("Risk"), 2),
        p(r("Second lead"), 0),
      ),
    ]));
    const bullet = (indLeft: number) => ({ indLeft, marker: { text: "•", font: null, marks: [], tabPt: 12 } });
    expect(doc).toEqual(canon([
      { type: "heading_line", content: [{ type: "text", text: "SSRIs and more" }] },
      { type: "paragraph", content: [{ type: "text", text: "Lead line" }] },
      { type: "slide_card", content: [
        { type: "paragraph", content: [{ type: "text", text: "SSRIs" }] },
        { type: "paragraph", attrs: bullet(0), content: [{ type: "text", text: "Fluoxetine" }] },
        { type: "paragraph", attrs: bullet(18), content: [{ type: "text", text: "Risk" }] },
      ] },
      { type: "paragraph", content: [{ type: "text", text: "Second lead" }] },
    ]));
    // Canonical as emitted: a valid slide block that round-trips through the schema unchanged.
    expect(() => validateFile("content/slides/psy/blocks/s_0000000001.json", { v: 1, id: "s_0000000001", kind: "slide", doc, meta: {} })).not.toThrow();
  });

  it("keeps a deeper paragraph with no level-0 paragraph before it as a bulleted paragraph", () => {
    const [doc] = convertDeck(pptx([sp(p(r("T"))) + sp(p(r("orphan"), 2), p(r("after"), 0))]));
    expect(doc?.content.slice(1)).toEqual(canon([
      { type: "paragraph", attrs: { indLeft: 18, marker: { text: "•", font: null, marks: [], tabPt: 12 } }, content: [{ type: "text", text: "orphan" }] },
      { type: "paragraph", content: [{ type: "text", text: "after" }] },
    ]).content);
  });

  it("joins a multi-paragraph title with hard breaks, and gives a slide with no text an empty heading line", () => {
    const docs = convertDeck(pptx([sp(p(r("Line 1")), p(""), p(r("Line 2"))), sp(p(""))]));
    expect(docs[0]).toEqual(canon([{ type: "heading_line", content: [{ type: "text", text: "Line 1" }, { type: "hard_break" }, { type: "text", text: "Line 2" }] }]));
    expect(docs[1]).toEqual(canon([{ type: "heading_line" }]));
  });

  it("keeps bold, italic, underline, color and highlight as marks, and an unmapped symbol with its font", () => {
    const rich = r("B", 'b="1" i="1" u="sng"', '<a:solidFill><a:srgbClr val="c00000"/></a:solidFill><a:highlight><a:srgbClr val="FFFF00"/></a:highlight>')
      + r("D", 'u="dbl" b="0"') + r(WINGDINGS_UNMAPPED, "", WD) + r("x", "", '<a:latin typeface="Wingdings"/>');
    const [doc] = convertDeck(pptx([sp(p(r("T"))) + sp(p(rich))]));
    expect(doc?.content[1]).toEqual(canon([{ type: "paragraph", content: [
      { type: "text", text: "B", marks: [{ type: "bold" }, { type: "italic" }, { type: "underline", attrs: { style: "single" } }, { type: "color", attrs: { hex: "C00000" } }, { type: "highlight", attrs: { hex: "FFFF00" } }] },
      { type: "text", text: "D", marks: [{ type: "underline", attrs: { style: "double" } }] },
      { type: "text", text: WINGDINGS_UNMAPPED, marks: [{ type: "font", attrs: { family: "Wingdings" } }] },
      { type: "text", text: "x", marks: [{ type: "font", attrs: { family: "Wingdings" } }] },
    ] }]).content[0]);
  });

  it("resolves theme colors through the master's color map, applying lumMod/lumOff", () => {
    const theme = strToU8(`<a:theme ${NS}><a:themeElements><a:clrScheme name="x"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme></a:themeElements></a:theme>`);
    const master = strToU8(`<p:sldMaster ${NS}><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2"/></p:sldMaster>`);
    const fill = (inner: string) => `<a:solidFill>${inner}</a:solidFill>`;
    const runs = r("a", "", fill('<a:schemeClr val="accent1"/>'))
      + r("b", "", fill('<a:schemeClr val="tx1"/>'))
      + r("c", "", fill('<a:schemeClr val="accent1"><a:lumMod val="50000"/></a:schemeClr>'))
      + r("d", "", fill('<a:schemeClr val="tx1"><a:lumMod val="50000"/><a:lumOff val="50000"/></a:schemeClr>'))
      + r("e", "", fill('<a:schemeClr val="accent6"/>'));
    const [doc] = convertDeck(pptx([sp(p(r("T"))) + sp(p(runs))], { extra: { "ppt/theme/theme1.xml": theme, "ppt/slideMasters/slideMaster1.xml": master } }));
    const colors = ((doc?.content[1] as { content: { marks?: { attrs: { hex: string } }[] }[] }).content).map((t) => t.marks?.[0]?.attrs.hex ?? null);
    // accent1 4472C4 with its HSL lightness halved is 203864; black with lightness 0 × 0.5 + 0.5 is mid gray.
    expect(colors).toEqual(["4472C4", "000000", "203864", "808080", null]);
  });
});

describe("applyPsychEdit", () => {
  it("removes the line and moves the next paragraph up one level", () => {
    const out = applyPsychEdit([{ text: "SSRIs", level: 0 }, { text: PSYCH_REMOVED_LINE, level: 1 }, { text: "Risk causing mania", level: 2 }, { text: "Next", level: 1 }]);
    expect(out).toEqual([{ text: "SSRIs", level: 0 }, { text: "Risk causing mania", level: 1 }, { text: "Next", level: 1 }]);
  });
  it("refuses an outline without exactly one such line or whose next paragraph is at level 0", () => {
    expect(() => applyPsychEdit([{ text: "x", level: 0 }])).toThrow(/exactly one/);
    expect(() => applyPsychEdit([{ text: PSYCH_REMOVED_LINE, level: 1 }, { text: "a", level: 2 }, { text: PSYCH_REMOVED_LINE, level: 1 }, { text: "b", level: 2 }])).toThrow(/exactly one/);
    expect(() => applyPsychEdit([{ text: PSYCH_REMOVED_LINE, level: 1 }, { text: "a", level: 0 }])).toThrow(/level 1 or deeper/);
    expect(() => applyPsychEdit([{ text: PSYCH_REMOVED_LINE, level: 1 }])).toThrow(/level 1 or deeper/);
  });
});

describe("editPsychDeck", () => {
  const slide2 = sp(p(r("High-Yield Psychopharmacology"))) + sp(
    p(r("SSRIs")),
    p(r("First line"), 1),
    p(r(PSYCH_REMOVED_LINE), 1),
    p(r("Risk causing mania"), 2),
    p(r("Generally benign"), 1),
  );
  const picture = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 250]);
  const deck = () => pptx([sp(p(r("EOC Review"))), slide2, sp(p(r("Last")))], { extra: { "ppt/media/image1.png": picture } });

  it("deletes the paragraph, lowers the next one's level, and leaves every other entry byte-identical", async () => {
    const original = deck();
    const { bytes, slidePart } = await editPsychDeck(original);
    expect(slidePart).toBe("ppt/slides/slide2.xml");
    const before = unzipSync(original);
    const after = unzipSync(bytes);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    for (const name of Object.keys(before)) if (name !== slidePart) expect(after[name]).toEqual(before[name]);
    const xml = strFromU8(after[slidePart] as Uint8Array);
    expect(xml).not.toContain(PSYCH_REMOVED_LINE);
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8" standalone="yes"\?>/);
    expect(xml).toContain('<a:p><a:pPr lvl="1"/><a:r><a:rPr lang="en-US"/><a:t>Risk causing mania</a:t>');

    const card = convertDeck(bytes)[1]?.content[1] as { type: string; content: { attrs: { indLeft: number; marker: unknown }; content: { text: string }[] }[] };
    expect(card.type).toBe("slide_card");
    expect(card.content.map((c) => [c.content[0]?.text, c.attrs.indLeft, c.attrs.marker !== null]))
      .toEqual([["SSRIs", 0, false], ["First line", 0, true], ["Risk causing mania", 0, true], ["Generally benign", 0, true]]);
    // Her original deck is not changed by the conversion of a replacement (no edit outside editPsychDeck).
    expect(JSON.stringify(convertDeck(original))).toContain(PSYCH_REMOVED_LINE);
  });

  it("removes the lvl attribute when the next paragraph reaches level 0", async () => {
    const s2 = sp(p(r("T"))) + sp(p(r(PSYCH_REMOVED_LINE), 0), p(r("Risk causing mania"), 1));
    const { bytes } = await editPsychDeck(pptx([sp(p(r("A"))), s2]));
    expect(strFromU8(unzipSync(bytes)["ppt/slides/slide2.xml"] as Uint8Array)).toContain("<a:p><a:pPr/><a:r><a:rPr lang=\"en-US\"/><a:t>Risk causing mania");
  });

  it.each([
    ["has no slide 2", [sp(p(r("only")))], /no slide 2/],
    ["lacks the line", [sp(p(r("A"))), sp(p(r("B")))], /found 0/],
    ["has the line twice", [sp(p(r("A"))), sp(p(r(PSYCH_REMOVED_LINE), 1), p(r(PSYCH_REMOVED_LINE), 1), p(r("x"), 2))], /found 2/],
    ["has nothing after the line", [sp(p(r("A"))), sp(p(r(PSYCH_REMOVED_LINE), 1))], /no paragraph follows/],
    ["has a level-0 paragraph after the line", [sp(p(r("A"))), sp(p(r(PSYCH_REMOVED_LINE), 1), p(r("x")))], /not at level 1 or deeper/],
  ])("refuses a deck that %s", async (_, slides, error) => {
    await expect(editPsychDeck(pptx(slides))).rejects.toThrow(error);
  });
});
