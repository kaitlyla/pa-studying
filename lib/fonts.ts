// The vendored fonts in fallback order (plan 70 §70.4) and the variation-selector rule, shared by the
// build's font map, search tokens, the PDF builder and the renderer's font stack. Browser-safe.

/** The font used for every code point no other font covers; it always ends FONTS. */
const LAST_RESORT = { family: "DejaVu Sans", file: "DejaVuSans.ttf" } as const;

/** The vendored fonts in fallback order (files under `app/public/fonts/`). */
export const FONTS = [
  { family: "Carlito", file: "Carlito-Regular.ttf" },
  { family: "Noto Sans Math", file: "NotoSansMath-Regular.ttf" },
  { family: "Noto Sans Symbols", file: "NotoSansSymbols-Regular.ttf" },
  { family: "Noto Sans Symbols 2", file: "NotoSansSymbols2-Regular.ttf" },
  LAST_RESORT,
] as const;

/** The font family names in fallback order. */
export const FONT_FAMILIES: readonly string[] = FONTS.map((f) => f.family);

/** Index in FONTS of the last-resort font. */
export const LAST_RESORT_INDEX = FONTS.length - 1;
/** The last-resort font's family. */
export const LAST_RESORT_FAMILY: string = LAST_RESORT.family;

/**
 * True for a variation selector (U+FE00–U+FE0F). They have no glyph of their own: search tokens
 * and PDF text drop them, and the font map does not list them.
 */
export function isVariationSelector(cp: number): boolean {
  return cp >= 0xfe00 && cp <= 0xfe0f;
}

/** A code point the font map leaves out: variation selectors and control characters have no glyph of their own. */
function glyphless(cp: number): boolean {
  return isVariationSelector(cp) || cp < 0x20 || (cp >= 0x7f && cp < 0xa0);
}

export interface FontCoverage {
  /** Decimal code point → index into FONTS of the first font with its glyph (LAST_RESORT_INDEX when none has it). */
  map: Record<string, number>;
  /**
   * Decimal code point → the text drawn in its place: for a code point no font has, its compatibility
   * form (NFKC) when every character of that form is covered — U+FE58 SMALL EM DASH draws as U+2014.
   */
  draw: Record<string, string>;
  /** Code points neither a font nor a compatibility form covers, ascending. */
  uncovered: number[];
}

/** The font map (70 §70.4) of `codePoints`, given which FONTS index has a glyph for which code point. */
export function fontCoverage(codePoints: Iterable<number>, has: (font: number, cp: number) => boolean): FontCoverage {
  const first = (cp: number): number => FONTS.findIndex((_, i) => has(i, cp));
  const out: FontCoverage = { map: {}, draw: {}, uncovered: [] };
  for (const cp of [...new Set(codePoints)].sort((a, b) => a - b)) {
    if (glyphless(cp)) continue;
    const i = first(cp);
    if (i >= 0) {
      out.map[String(cp)] = i;
      continue;
    }
    const ch = String.fromCodePoint(cp);
    const form = ch.normalize("NFKC");
    const parts = [...form].map((c) => c.codePointAt(0) ?? 0);
    if (form !== ch && parts.every((p) => !glyphless(p) && first(p) >= 0)) {
      out.draw[String(cp)] = form;
      for (const p of parts) out.map[String(p)] = first(p);
    } else {
      out.map[String(cp)] = LAST_RESORT_INDEX;
      out.uncovered.push(cp);
    }
  }
  return out;
}

const VARIATION_SELECTORS = /[\u{FE00}-\u{FE0F}]/gu;

/** `text` with every variation selector removed. */
export function stripVariationSelectors(text: string): string {
  return text.replace(VARIATION_SELECTORS, "");
}
