// The font map rule (plan 70 §70.4): first covering font, else a covered compatibility form, else DejaVu Sans.
import { describe, expect, it } from "vitest";
import { fontCoverage, LAST_RESORT_INDEX } from "./fonts.ts";

const cp = (s: string): number => s.codePointAt(0) ?? 0;

describe("fontCoverage", () => {
  // Font 0 has "A" and "—"; font 1 has "⊕". Nothing has "﹘" (U+FE58, NFKC "—"), "ｈ" (U+FF48, NFKC "h") or "★".
  const has = (font: number, c: number): boolean => (font === 0 && (c === cp("A") || c === 0x2014)) || (font === 1 && c === cp("⊕"));

  it("maps each code point to the first font with its glyph", () => {
    expect(fontCoverage([cp("⊕"), cp("A"), cp("A")], has)).toEqual({ map: { [cp("A")]: 0, [cp("⊕")]: 1 }, draw: {}, uncovered: [] });
  });

  it("draws an uncovered code point as its compatibility form when that form is covered, mapping the form's characters instead", () => {
    expect(fontCoverage([0xfe58], has)).toEqual({ map: { [0x2014]: 0 }, draw: { [0xfe58]: "—" }, uncovered: [] });
  });

  it("reports a code point with no covered font or compatibility form as uncovered, mapped to the last-resort font", () => {
    expect(fontCoverage([cp("★"), 0xff48], has)).toEqual({ map: { [cp("★")]: LAST_RESORT_INDEX, [0xff48]: LAST_RESORT_INDEX }, draw: {}, uncovered: [cp("★"), 0xff48] });
  });

  it("leaves out variation selectors and control characters", () => {
    expect(fontCoverage([0xfe0f, 0x0a, 0x09, 0x85], has)).toEqual({ map: {}, draw: {}, uncovered: [] });
  });
});
