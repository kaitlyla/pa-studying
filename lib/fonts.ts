// The vendored fonts in fallback order (plan 70 §70.4) and the variation-selector rule, shared by the
// build's font map, search tokens, the PDF builder and the renderer's font stack. Browser-safe.

/** The vendored fonts in fallback order (files under `app/public/fonts/`). DejaVu Sans is last. */
export const FONTS = [
  { family: "Carlito", file: "Carlito-Regular.ttf" },
  { family: "Noto Sans Math", file: "NotoSansMath-Regular.ttf" },
  { family: "Noto Sans Symbols", file: "NotoSansSymbols-Regular.ttf" },
  { family: "Noto Sans Symbols 2", file: "NotoSansSymbols2-Regular.ttf" },
  { family: "DejaVu Sans", file: "DejaVuSans.ttf" },
] as const;

/** The font family names in fallback order. */
export const FONT_FAMILIES: readonly string[] = FONTS.map((f) => f.family);

/**
 * True for a variation selector (U+FE00–U+FE0F). They have no glyph of their own: search tokens
 * and PDF text drop them, and the font map does not list them.
 */
export function isVariationSelector(cp: number): boolean {
  return cp >= 0xfe00 && cp <= 0xfe0f;
}

const VARIATION_SELECTORS = /[\u{FE00}-\u{FE0F}]/gu;

/** `text` with every variation selector removed. */
export function stripVariationSelectors(text: string): string {
  return text.replace(VARIATION_SELECTORS, "");
}
