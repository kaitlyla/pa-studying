// The duplicate-skip proof (30 §30.2) over minimal Word packages built in the test.
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { proveDuplicate } from "./duplicate.ts";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const esc = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** A paragraph of runs; a run given as `[text, true]` is bold. */
const para = (...runs: (string | [string, boolean])[]): string =>
  `<w:p>${runs.map((r) => {
    const [text, bold] = typeof r === "string" ? [r, false] : r;
    return `<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
  }).join("")}</w:p>`;

function docx(paras: string[], media: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    "word/document.xml": strToU8(`<w:document ${W}><w:body>${paras.join("")}<w:sectPr/></w:body></w:document>`),
    ...Object.fromEntries(Object.entries(media).map(([name, bytes]) => [`word/media/${name}`, bytes])),
  });
}

const PIC_A = new Uint8Array([1, 2, 3]);
const PIC_B = new Uint8Array([4, 5, 6]);

describe("proveDuplicate", () => {
  it("accepts packages with the same paragraph texts and pictures, whatever the formatting or media part names", async () => {
    const kept = docx([para("ABG ", "workbook"), para("pH 7.35")], { "image1.png": PIC_A, "image2.png": PIC_B });
    const dup = docx([para(["ABG workbook", true]), para("pH 7.35")], { "image9.png": PIC_B, "image3.png": PIC_A });
    await expect(proveDuplicate("dup.docx", dup, "kept.docx", kept)).resolves.toBeUndefined();
  });

  it("fails when a paragraph's text differs", async () => {
    const kept = docx([para("ABG workbook"), para("pH 7.35")]);
    const dup = docx([para("ABG workbook"), para("pH 7.45")]);
    await expect(proveDuplicate("dup.docx", dup, "kept.docx", kept)).rejects.toThrow(
      "dup.docx is not a duplicate of kept.docx: their paragraph texts differ",
    );
  });

  it("fails when the same text is split into different paragraphs", async () => {
    const kept = docx([para("ABG workbook")]);
    const dup = docx([para("ABG "), para("workbook")]);
    await expect(proveDuplicate("dup.docx", dup, "kept.docx", kept)).rejects.toThrow(/paragraph texts differ/);
  });

  it("fails when the paragraphs are in a different order", async () => {
    const kept = docx([para("one"), para("two")]);
    const dup = docx([para("two"), para("one")]);
    await expect(proveDuplicate("dup.docx", dup, "kept.docx", kept)).rejects.toThrow(/paragraph texts differ/);
  });

  it("fails when a picture differs or is missing", async () => {
    const kept = docx([para("x")], { "image1.png": PIC_A, "image2.png": PIC_B });
    await expect(proveDuplicate("dup.docx", docx([para("x")], { "image1.png": PIC_A, "image2.png": PIC_A }), "kept.docx", kept))
      .rejects.toThrow("dup.docx is not a duplicate of kept.docx: their pictures differ");
    await expect(proveDuplicate("dup.docx", docx([para("x")], { "image1.png": PIC_A }), "kept.docx", kept))
      .rejects.toThrow(/pictures differ/);
  });
});
