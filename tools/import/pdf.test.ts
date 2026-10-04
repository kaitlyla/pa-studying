// PDF page count and search text (30 §30.10) over PDFs built in the test.
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { joinTextItems, pdfText } from "./pdf.ts";

async function makePdf(pages: string[][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([400, 400]);
    lines.forEach((line, i) => page.drawText(line, { x: 40, y: 340 - i * 40, size: 14, font }));
  }
  return doc.save();
}

describe("joinTextItems", () => {
  it("puts \\n after an item with hasEOL and a space after any other, nothing after the last", () => {
    const items = [
      { str: "STAGE A", hasEOL: true },
      { str: "At high", hasEOL: false },
      { type: "beginMarkedContent" },
      { str: "risk", hasEOL: true },
    ];
    expect(joinTextItems(items)).toBe("STAGE A\nAt high risk");
    expect(joinTextItems([])).toBe("");
  });
});

describe("pdfText", () => {
  it("returns one entry per page, with the page's text and \"\" for a page with no text", async () => {
    const bytes = await makePdf([["Stage A heart failure", "Stage B"], [], ["Third page"]]);
    const pages = await pdfText(bytes);
    expect(pages).toHaveLength(3);
    expect(pages[0]).toContain("Stage A heart failure");
    expect(pages[0]?.indexOf("Stage B")).toBeGreaterThan(pages[0]?.indexOf("Stage A heart failure") ?? Infinity);
    expect(pages[1]).toBe("");
    expect(pages[2]).toBe("Third page");
  });

  it("leaves the caller's bytes usable (pdf.js gets a copy)", async () => {
    const bytes = await makePdf([["Once"]]);
    const before = bytes.length;
    await pdfText(bytes);
    expect(bytes.length).toBe(before);
    expect(await pdfText(bytes)).toEqual(["Once"]);
  });

  it("rejects bytes that are not a PDF", async () => {
    await expect(pdfText(new TextEncoder().encode("not a pdf"))).rejects.toThrow();
  });
});
