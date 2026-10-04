// PDF page count and search text (30 §30.10), with pdfjs-dist's legacy Node build.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

interface TextPiece {
  str: string;
  hasEOL: boolean;
}

const isPiece = (item: unknown): item is TextPiece => typeof item === "object" && item !== null && "str" in item;

/**
 * Join one page's text items: an item with `hasEOL` is followed by `\n`, any other by a space.
 * Nothing follows the last item; a page with no items is "".
 */
export function joinTextItems(items: readonly unknown[]): string {
  const pieces = items.filter(isPiece);
  let out = "";
  pieces.forEach((p, i) => {
    out += p.str;
    if (i < pieces.length - 1) out += p.hasEOL ? "\n" : " ";
  });
  return out;
}

/** Each page's extracted text, in page order; its length is the PDF's page count. */
export async function pdfText(bytes: Uint8Array): Promise<string[]> {
  // pdf.js takes ownership of (and detaches) the buffer it is given, so it gets a copy. pdfjs-dist
  // 6.4.299 has no `isEvalSupported` option: its builds contain no eval or Function constructor.
  const task = getDocument({ data: bytes.slice(), verbosity: 0 });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      pages.push(joinTextItems((await page.getTextContent()).items));
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
