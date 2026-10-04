// The font map (plan 70 §70.4): for every code point in the content, the first vendored font whose cmap has it.
import { join } from "node:path";
import { openSync } from "fontkit";
import type { FontMapJson } from "../../lib/derive/published.ts";
import { FONTS, isVariationSelector } from "../../lib/fonts.ts";

/** Code points with no glyph of their own in any font: variation selectors (omitted from PDF text) and controls. */
const skipped = (cp: number): boolean => isVariationSelector(cp) || cp < 0x20 || (cp >= 0x7f && cp < 0xa0);

const hex = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

export function buildFontMap(codePoints: Iterable<number>, fontsDir: string): { fontmap: FontMapJson; uncovered: string[] } {
  const fonts = FONTS.map((f) => openSync(join(fontsDir, f.file)));
  const fallback = FONTS.length - 1;
  const map: Record<string, number> = {};
  const uncovered: string[] = [];
  for (const cp of [...new Set(codePoints)].sort((a, b) => a - b)) {
    if (skipped(cp)) continue;
    const i = fonts.findIndex((f) => f.hasGlyphForCodePoint(cp));
    map[String(cp)] = i < 0 ? fallback : i;
    if (i < 0) uncovered.push(hex(cp));
  }
  return { fontmap: { fonts: FONTS.map((f) => ({ family: f.family, file: f.file })), map }, uncovered };
}
