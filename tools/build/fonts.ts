// The font map (plan 70 §70.4): for every code point in the content, the first vendored font whose cmap has it.
import { join } from "node:path";
import { openSync } from "fontkit";
import type { FontMapJson } from "../../lib/derive/published.ts";
import { FONTS, fontCoverage } from "../../lib/fonts.ts";

const hex = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

export function buildFontMap(codePoints: Iterable<number>, fontsDir: string): { fontmap: FontMapJson; uncovered: string[] } {
  const fonts = FONTS.map((f) => openSync(join(fontsDir, f.file)));
  const { map, draw, uncovered } = fontCoverage(codePoints, (i, cp) => fonts[i]?.hasGlyphForCodePoint(cp) ?? false);
  return { fontmap: { fonts: FONTS.map((f) => ({ family: f.family, file: f.file })), map, draw }, uncovered: uncovered.map(hex) };
}
