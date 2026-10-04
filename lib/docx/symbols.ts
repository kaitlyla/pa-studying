// Symbol-font character map (30 §30.5). Shared with the PowerPoint text extraction (30 §30.10).

const SYMBOL_FONTS = ["symbol", "wingdings", "wingdings 2", "wingdings 3", "webdings"];

/** Font (lower case) → code (as U+F0xx) → stored character. Covers every pair found in her sources. */
const MAP: Record<string, Record<number, string>> = {
  wingdings: {
    0xf0e0: "→", // →
    0xf0a7: "▪", // ▪ (typed as "§")
    0xf06e: "■", // ■ (typed as "n")
    0xf0d8: "➢", // ➢
  },
  symbol: {
    0xf0b7: "•", // •
  },
};

export function isSymbolFont(font: string | null | undefined): boolean {
  return !!font && SYMBOL_FONTS.includes(font.trim().toLowerCase());
}

/**
 * Whether a character in a symbol-font run is a symbol code (U+0000–00FF or U+F000–F0FF). Other
 * characters are ordinary Unicode that Word shows through font fallback (e.g. U+1F86A in a Wingdings run).
 */
export function isSymbolCode(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return cp <= 0xff || (cp >= 0xf000 && cp <= 0xf0ff);
}

/** The code point of a symbol-font character in its U+F0xx form (U+00xx and U+F0xx denote the same glyph). */
export function symbolCode(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  return cp < 0x100 ? 0xf000 + cp : cp;
}

/** The stored character for a symbol-font character, or null when the pair is not mapped. */
export function mapSymbol(font: string, ch: string): string | null {
  return MAP[font.trim().toLowerCase()]?.[symbolCode(ch)] ?? null;
}
