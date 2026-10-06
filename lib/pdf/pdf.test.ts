// PDF content (plan 99 §99.1 lib/pdf/pdf.test.ts; 70 §70.2–§70.4).
import { describe, expect, it } from "vitest";
import { schema } from "../schema.ts";
import { buildDocDefinition, imageRequests, pdfFileName, scopeTitle, wholeGuideAsset, wholeGuideUrl, type PdfInput, type PdfScope } from "./index.ts";
import { FontSplitter } from "./fonts.ts";
import { block, cardioSystem, doc, FORBIDDEN, fmHome, fmNav, fontmapFor, inlines, lines, para, pulmSystem, R, row, table, wordDoc } from "./testing.ts";

const nav = fmNav();
const system = cardioSystem();
const guideInput: PdfInput = { nav, system };

/** All text the fixtures hold, so the font map covers it as the build's map would. */
const allText = JSON.stringify([system, pulmSystem(), fmHome(), wordDoc()]).match(/"text":"((?:[^"\\]|\\.)*)"/g)?.map((m) => JSON.parse(`{${m}}`).text as string) ?? [];
const fontmap = fontmapFor(allText);

const INTRO = "Intro ⊕ → ➀ ▪ item";
const T1_HEAD = ["CARDIO LABEL", "About", "Dx"];
const T1_A = ["Angina", "chest pain", "ECG", "radiates", "troponin"];
const T1_B = ["Myocarditis: viral/other", "viral", "MRI"];
const D1 = ["ANTIANGINAL", "Use", "Nitrates", "angina", "CCB", "HTN"];
const D2 = ["HF PHARM", "Use", "Loop diuretics", "edema"];
const ANTIANGINALS = [...D1, "Overview notes", "Nitrates notes", "Also class notes", "Learning objectives notes"];

const scopes: { name: string; scope: PdfScope; input: PdfInput; expected: string[] }[] = [
  { name: "topic", scope: { kind: "topics", ids: ["r_AAAAAAAAA1"] }, input: guideInput, expected: [...T1_HEAD, ...T1_A] },
  { name: "compare page", scope: { kind: "topics", ids: ["r_AAAAAAAAA1", "r_AAAAAAAAB1"] }, input: guideInput, expected: [...T1_HEAD, ...T1_A, ...T1_HEAD, ...T1_B] },
  { name: "section", scope: { kind: "section", id: "cad" }, input: guideInput, expected: [...T1_HEAD, ...T1_A, "Murmurs note"] },
  { name: "second section", scope: { kind: "section", id: "inf" }, input: guideInput, expected: [...T1_HEAD, ...T1_B] },
  { name: "system", scope: { kind: "system" }, input: guideInput, expected: [INTRO, ...T1_HEAD, ...T1_A, ...T1_B, ...D1, "Murmurs note", ...D2] },
  { name: "pharm section", scope: { kind: "pharmSection", id: "antianginals" }, input: guideInput, expected: ANTIANGINALS },
  { name: "system's pharm", scope: { kind: "systemPharm" }, input: guideInput, expected: [...ANTIANGINALS, ...D2, "Nitrates notes"] },
  { name: "Word page", scope: { kind: "doc" }, input: { doc: wordDoc() }, expected: ["Vaccine page text"] },
  { name: "guide preamble", scope: { kind: "preamble" }, input: { nav, home: fmHome() }, expected: ["Preamble title page"] },
];

describe("fixtures", () => {
  it("are schema-valid stored docs", () => {
    const docs = [...system.blocks, ...Object.values(system.notesBlocks), ...pulmSystem().blocks, ...fmHome().preamble, ...(wordDoc().blocks ?? [])].map((b) => b.doc);
    for (const d of docs) expect(() => schema.nodeFromJSON(d).check()).not.toThrow();
  });
});

describe("scope content", () => {
  it.each(scopes)("$name holds exactly its content, in order", ({ scope, input, expected }) => {
    expect(lines(buildDocDefinition(scope, input, fontmap).content)).toEqual(expected);
  });

  it.each(scopes)("$name holds no gap block, update note, slide, meds panel, site label or section name", ({ scope, input }) => {
    const def = buildDocDefinition(scope, input, fontmap);
    const text = inlines(def.content).map((i) => String(i.text)).join("\n");
    for (const f of FORBIDDEN) expect(text).not.toContain(f);
  });

  it("puts a topic's below block after its rows on its page, and after the table holding its last row in its section and system", () => {
    const s = cardioSystem();
    const angina = s.topics.find((t) => t.id === "r_AAAAAAAAA1");
    if (!angina) throw new Error("no Angina topic");
    angina.below = block("b_AAAAAAAABW", "prose", doc(para("BELOW note")));
    const input: PdfInput = { nav, system: s };
    const scoped = (scope: PdfScope): string[] => lines(buildDocDefinition(scope, input, fontmap).content);
    expect(scoped({ kind: "topics", ids: ["r_AAAAAAAAA1"] })).toEqual([...T1_HEAD, ...T1_A, "BELOW note"]);
    expect(scoped({ kind: "section", id: "cad" })).toEqual([...T1_HEAD, ...T1_A, "BELOW note", "Murmurs note"]);
    // Myocarditis' section shows the same table but not Angina's last row.
    expect(scoped({ kind: "section", id: "inf" })).toEqual([...T1_HEAD, ...T1_B]);
    expect(scoped({ kind: "system" })).toEqual([INTRO, ...T1_HEAD, ...T1_A, ...T1_B, "BELOW note", ...D1, "Murmurs note", ...D2]);
  });

  it("uses the guide's page, margins and base size", () => {
    const def = buildDocDefinition({ kind: "system" }, guideInput, fontmap);
    expect(def.pageSize).toEqual({ width: 792, height: 612 });
    expect(def.pageMargins).toEqual([36, 36, 36, 36]);
    expect(def.defaultStyle).toEqual({ font: "Carlito", fontSize: 10 });
  });

  it("sizes pharm notes at their file's base size and guide tables at the guide's", () => {
    const def = buildDocDefinition({ kind: "pharmSection", id: "antianginals" }, guideInput, fontmap);
    const all = inlines(def.content);
    expect(all.find((i) => i.text === "Nitrates notes")?.fontSize).toBe(11);
    expect(all.find((i) => i.text === "ANTIANGINAL")?.fontSize).toBe(10);
  });

  it("leaves out of a card the lines the section's table already says, as the page does", () => {
    const sys = cardioSystem();
    sys.notesBlocks.b_AAAAAAAAN1 = block("b_AAAAAAAAN1", "prose", doc(para("Nitrates"), para("Use: angina", { indLeft: 27 }), para("Headache", { indLeft: 27 })));
    const said = { text: "Use: angina", label: false, rows: [{ id: R.d1, text: "Nitrates | angina" }] };
    sys.trims = { b_AAAAAAAAN1: [{ text: "Nitrates", label: true, rows: [] }, said] };
    const section = (): string[] => lines(buildDocDefinition({ kind: "pharmSection", id: "antianginals" }, { nav, system: sys }, fontmap).content);
    expect(section()).toEqual([...D1, "Overview notes", "Nitrates", "Headache", "Also class notes", "Learning objectives notes"]);
    // Once every line is said, the card's notes are left out entirely.
    sys.trims = { b_AAAAAAAAN1: [{ text: "Nitrates", label: true, rows: [] }, said, { ...said, text: "Headache" }] };
    expect(section()).toEqual([...D1, "Overview notes", "Also class notes", "Learning objectives notes"]);
  });

  it("prints a class card's notes from each file at that file's size, leaving out a line the card already printed", () => {
    const sys = cardioSystem();
    sys.notesBlocks.b_AAAAAAAAN1 = block("b_AAAAAAAAN1", "prose", doc(para("Nitrates"), para("Adverse: headache", { indLeft: 27 })));
    sys.notesBlocks.b_AAAAAAAAN3 = block("b_AAAAAAAAN3", "prose", doc(para("Organic nitrates"), para("Adverse: headache", { indLeft: 27 }), para("Tolerance", { indLeft: 27 })));
    const c1 = sys.cards.c_AAAAAAAAC1;
    if (!c1) throw new Error("no card C1");
    c1.blocks = ["b_AAAAAAAAN1", "b_AAAAAAAAN3"];
    c1.parts = [...c1.parts, { id: "p_AAAAAAAAN3", blocks: ["b_AAAAAAAAN3"], file: "Cardio II Med List", basePt: 9 }];
    const def = buildDocDefinition({ kind: "pharmSection", id: "antianginals" }, { nav, system: sys }, fontmap);
    expect(lines(def.content)).toEqual([...D1, "Overview notes", "Nitrates", "Adverse: headache", "Organic nitrates", "Tolerance", "Also class notes", "Learning objectives notes"]);
    const all = inlines(def.content);
    expect(all.find((i) => i.text === "Adverse: headache")?.fontSize).toBe(11);
    expect(all.find((i) => i.text === "Organic nitrates")?.fontSize).toBe(9);
    expect(all.find((i) => i.text === "Tolerance")?.fontSize).toBe(9);
  });

  it("prints only the notes written for the section's use, as the page does", () => {
    const sys = cardioSystem();
    sys.notesBlocks.b_AAAAAAAAN1 = block("b_AAAAAAAAN1", "prose", doc(para("Nitrates"), para("Effort induced angina", { indLeft: 27 }), para("Headache", { indLeft: 27 })));
    sys.notesBlocks.b_AAAAAAAAN3 = block("b_AAAAAAAAN3", "prose", doc(para("Class IV"), para("AV nodal block", { indLeft: 27 })));
    const c1 = sys.cards.c_AAAAAAAAC1;
    if (!c1) throw new Error("no card C1");
    c1.blocks = ["b_AAAAAAAAN1", "b_AAAAAAAAN3"];
    c1.parts = [...c1.parts, { id: "p_AAAAAAAAN3", blocks: ["b_AAAAAAAAN3"], file: "Cardio II Med List", basePt: 9, for: ["hf"] }];
    sys.uses = { b_AAAAAAAAN1: [{ text: "Effort induced angina", for: ["antianginals"] }] };
    const section = (id: string): string[] => lines(buildDocDefinition({ kind: "pharmSection", id }, { nav, system: sys }, fontmap).content);
    expect(section("antianginals")).toEqual([...D1, "Overview notes", "Nitrates", "Effort induced angina", "Headache", "Also class notes", "Learning objectives notes"]);
    // Heart failure: the part written for it shows; the angina line does not.
    expect(section("hf")).toEqual(["HF PHARM", "Use", "Loop diuretics", "edema", "Nitrates", "Headache", "Class IV", "AV nodal block"]);
  });

  it("prints a part cutting her table as the page shows it: her heading row and its rows, or one column under its heading", () => {
    const sys = cardioSystem();
    sys.notesBlocks.b_AAAAAAAAT9 = block("b_AAAAAAAAT9", "table", doc(table([60, 100, 100], [
      row("r_AAAAAAAAH9", "heading", ["ANTICOAGULANTS", "Warfarin", "Apixaban"]),
      row("r_AAAAAAAAM9", "content", ["MOA", "VKA", "Xa inhibitor"]),
      row("r_AAAAAAAAN9", "content", ["Monitor", "INR", "none needed"]),
    ])));
    const c1 = sys.cards.c_AAAAAAAAC1;
    if (!c1) throw new Error("no card C1");
    c1.blocks = ["b_AAAAAAAAT9"];
    c1.parts = [
      { id: "p_AAAAAAAAR9", blocks: ["b_AAAAAAAAT9"], file: "pharm review", basePt: 11, rows: ["r_AAAAAAAAH9", "r_AAAAAAAAN9"] },
      { id: "p_AAAAAAAAB9", blocks: ["b_AAAAAAAAT9"], file: "pharm review", basePt: 11, rows: ["r_AAAAAAAAM9"] },
      { id: "p_AAAAAAAAK9", blocks: ["b_AAAAAAAAT9"], file: "pharm review", basePt: 11, column: 2 },
    ];
    // Lines of her table named for another section: a table's lines are never hidden, so no part goes.
    sys.uses = { b_AAAAAAAAT9: [{ text: "ANTICOAGULANTS", for: ["hf"] }, { text: "Monitor", for: ["hf"] }] };
    const def = buildDocDefinition({ kind: "pharmSection", id: "antianginals" }, { nav, system: sys }, fontmap);
    expect(lines(def.content)).toEqual([
      ...D1, "Overview notes",
      "ANTICOAGULANTS", "Warfarin", "Apixaban", "Monitor", "INR", "none needed",
      "MOA", "VKA", "Xa inhibitor",
      "Apixaban", "MOA", "Xa inhibitor", "Monitor", "none needed",
      "Also class notes", "Learning objectives notes",
    ]);
  });

  it("uses the Word page's own page setup", () => {
    const def = buildDocDefinition({ kind: "doc" }, { doc: wordDoc() }, fontmap);
    expect(def.pageSize).toEqual({ width: 612, height: 792 });
    expect(def.pageMargins).toEqual([72, 72, 72, 72]);
  });

  it("rejects a topic the page does not hold", () => {
    expect(() => buildDocDefinition({ kind: "topics", ids: ["r_ZZZZZZZZZ9"] }, guideInput, fontmap)).toThrow(/topic r_ZZZZZZZZZ9/);
    expect(() => buildDocDefinition({ kind: "section", id: "nope" }, guideInput, fontmap)).toThrow(/section nope/);
    expect(() => buildDocDefinition({ kind: "pharmSection", id: "nope" }, guideInput, fontmap)).toThrow(/pharm section nope/);
    expect(() => buildDocDefinition({ kind: "doc" }, guideInput, fontmap)).toThrow(/does not read system data/);
    expect(() => buildDocDefinition({ kind: "system" }, { doc: wordDoc() }, fontmap)).toThrow(/needs guide data/);
  });
});

describe("fonts", () => {
  it.each(scopes)("every text segment of $name is in the font map's font for its code points, without variation selectors", ({ scope, input }) => {
    const splitter = new FontSplitter(fontmap);
    const segs = inlines(buildDocDefinition(scope, input, fontmap).content);
    expect(segs.length).toBeGreaterThan(0);
    for (const seg of segs) {
      const text = String(seg.text);
      expect(text).not.toMatch(/[︀-️]/);
      for (const ch of text.replace(/\n/g, "")) expect([ch, seg.font]).toEqual([ch, splitter.familyOf(ch.codePointAt(0) ?? 0)]);
    }
  });

  it("splits symbols into their vendored fonts (70 §70.4 measured coverage)", () => {
    const segs = inlines(buildDocDefinition({ kind: "system" }, guideInput, fontmap).content);
    const fontOf = (s: string): unknown => segs.find((x) => String(x.text).includes(s))?.font;
    expect(fontOf("⊕")).toBe("Noto Sans Math");
    expect(fontOf("➀")).toBe("Noto Sans Symbols");
    expect(fontOf("→")).toBe("Carlito");
    expect(fontOf("Intro")).toBe("Carlito");
  });

  it("draws a character no vendored font has as its compatibility form in that form's font", () => {
    // U+FE58 SMALL EM DASH (a list marker in her pharm notes) is in none of the fonts; NFKC gives U+2014, which Carlito has.
    const small = String.fromCodePoint(0xfe58);
    const fm = fontmapFor([`${small} Keppra`]);
    expect(fm.draw).toEqual({ [String(0xfe58)]: String.fromCodePoint(0x2014) });
    expect(new FontSplitter(fm).split(`${small} Keppra`)).toEqual([{ text: `${String.fromCodePoint(0x2014)} Keppra`, family: "Carlito" }]);
  });

  it("draws U+1806, a dash list marker in her notes that no vendored font has, as a hyphen in Carlito", () => {
    const marker = String.fromCodePoint(0x1806);
    const fm = fontmapFor([`${marker} Ovarian cyst`]);
    expect(fm.draw).toEqual({ [String(0x1806)]: "-" });
    expect(new FontSplitter(fm).split(`${marker} Ovarian cyst`)).toEqual([{ text: "- Ovarian cyst", family: "Carlito" }]);
  });

  it("strips variation selectors from PDF text only, leaving the stored text intact", () => {
    const s = cardioSystem();
    const def = buildDocDefinition({ kind: "system" }, { nav, system: s }, fontmap);
    expect(JSON.stringify(s.blocks[0]?.doc)).toContain("▪️ item");
    expect(lines(def.content)[0]).toBe(INTRO);
  });
});

describe("file names (70 §70.2)", () => {
  it("names browser downloads <source without extension> - <scope title>.pdf", () => {
    expect(pdfFileName({ kind: "system" }, guideInput)).toBe("Family Medicine EOR - Cardiovascular.pdf");
    expect(pdfFileName({ kind: "topics", ids: ["r_AAAAAAAAA1"] }, guideInput)).toBe("Family Medicine EOR - Angina.pdf");
    expect(pdfFileName({ kind: "topics", ids: ["r_AAAAAAAAA1", "r_AAAAAAAAB1"] }, guideInput)).toBe("Family Medicine EOR - 2 topics.pdf");
    expect(pdfFileName({ kind: "section", id: "inf" }, guideInput)).toBe("Family Medicine EOR - Inflammatory SECTIONNAME.pdf");
    expect(pdfFileName({ kind: "pharmSection", id: "hf" }, guideInput)).toBe("Family Medicine EOR - Heart failure PHARMSECTIONTITLE.pdf");
    expect(pdfFileName({ kind: "systemPharm" }, guideInput)).toBe("Family Medicine EOR - Cardiovascular pharm.pdf");
  });

  it("replaces \\ / : * ? \" < > | with - in the scope title", () => {
    expect(pdfFileName({ kind: "topics", ids: ["r_AAAAAAAAB1"] }, guideInput)).toBe("Family Medicine EOR - Myocarditis- viral-other.pdf");
    const s = cardioSystem();
    (s.topics[0] as { title: string }).title = 'a\\b/c:d*e?f"g<h>i|j';
    expect(pdfFileName({ kind: "topics", ids: ["r_AAAAAAAAA1"] }, { nav, system: s })).toBe("Family Medicine EOR - a-b-c-d-e-f-g-h-i-j.pdf");
  });

  it("cuts the scope title to 80 characters", () => {
    const s = cardioSystem();
    (s.topics[0] as { title: string }).title = "x".repeat(79) + "yz" + "w".repeat(20);
    expect(pdfFileName({ kind: "topics", ids: ["r_AAAAAAAAA1"] }, { nav, system: s })).toBe(`Family Medicine EOR - ${"x".repeat(79)}y.pdf`);
    expect(scopeTitle({ kind: "topics", ids: ["r_AAAAAAAAA1"] }, { nav, system: s })).toHaveLength(101);
  });

  it("names a Word page <name>.pdf", () => {
    expect(pdfFileName({ kind: "doc" }, { doc: wordDoc() })).toBe("Vaccine notes- 2024-25.pdf");
  });

  it("names the whole-guide asset after the source with spaces as -, and links its release download", () => {
    expect(wholeGuideAsset("Family Medicine EOR.docx")).toBe("Family-Medicine-EOR.pdf");
    expect(wholeGuideAsset("PANCE_EOC-SG.docx")).toBe("PANCE_EOC-SG.pdf");
    expect(wholeGuideUrl("kaitlyla/pa-studying", "fm", "Family Medicine EOR.docx")).toBe("https://github.com/kaitlyla/pa-studying/releases/download/pdf-fm/Family-Medicine-EOR.pdf");
  });
});

describe("images in scopes", () => {
  it("requests no images for text-only scopes and embeds none", () => {
    expect(imageRequests({ kind: "system" }, guideInput)).toEqual([]);
    expect(buildDocDefinition({ kind: "system" }, guideInput, fontmap).images).toEqual({});
  });
});
