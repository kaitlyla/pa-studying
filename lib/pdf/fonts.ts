// Font selection for PDF text (plan 70 §70.4). pdfmake has no per-glyph fallback, so every run is
// split into segments by the font fontmap.json assigns to each code point.
import type { FontMapJson } from "../derive/published.ts";
import { FONTS, isVariationSelector, LAST_RESORT_FAMILY } from "../fonts.ts";

/** The text family, with all four faces vendored; the symbol fonts have a Regular face only. */
export const TEXT_FAMILY: string = FONTS[0].family;

/** Carlito's face files under app/public/fonts/ (70 §70.4). */
export const CARLITO_FACES = {
  normal: "Carlito-Regular.ttf",
  bold: "Carlito-Bold.ttf",
  italics: "Carlito-Italic.ttf",
  bolditalics: "Carlito-BoldItalic.ttf",
} as const;

export interface Segment {
  text: string;
  family: string;
}

/** Splits text into runs of one font each, from the build's code-point map. */
export class FontSplitter {
  private readonly families: string[];
  private readonly map: Record<string, number>;
  private readonly lastResort: string;

  constructor(fontmap: FontMapJson) {
    this.families = fontmap.fonts.map((f) => f.family);
    this.map = fontmap.map;
    this.lastResort = this.families.includes(LAST_RESORT_FAMILY) ? LAST_RESORT_FAMILY : (this.families.at(-1) ?? TEXT_FAMILY);
  }

  /**
   * The family for a code point. The map covers every code point of the published content; one
   * absent from it (text typed after the last build, or a control character) falls back to the
   * text font for Latin and whitespace and to the last-resort font otherwise.
   */
  familyOf(cp: number): string {
    const index = this.map[String(cp)];
    if (index !== undefined) return this.families[index] ?? this.lastResort;
    return cp <= 0x024f ? TEXT_FAMILY : this.lastResort;
  }

  /** Variation selectors removed, then consecutive characters of one family grouped. */
  split(text: string): Segment[] {
    const out: Segment[] = [];
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0;
      if (isVariationSelector(cp)) continue;
      const last = out.at(-1);
      // A line break draws no glyph, so it stays in the run it ends.
      if (last && ch === "\n") {
        last.text += ch;
        continue;
      }
      const family = this.familyOf(cp);
      if (last && last.family === family) last.text += ch;
      else out.push({ text: ch, family });
    }
    return out;
  }
}

/** pdfmake's font dictionary: Carlito with four faces, every other family with Regular only. */
export function pdfFonts(fontmap: FontMapJson, locate: (file: string) => string): Record<string, Record<string, string>> {
  const fonts: Record<string, Record<string, string>> = {};
  for (const f of fontmap.fonts) {
    if (f.family === TEXT_FAMILY) {
      fonts[f.family] = {
        normal: locate(CARLITO_FACES.normal),
        bold: locate(CARLITO_FACES.bold),
        italics: locate(CARLITO_FACES.italics),
        bolditalics: locate(CARLITO_FACES.bolditalics),
      };
    } else {
      fonts[f.family] = { normal: locate(f.file) };
    }
  }
  return fonts;
}
