// The part of fontkit 2.0.4 (which ships no type declarations) that tools/build uses.
declare module "fontkit" {
  export interface Font {
    familyName: string;
    hasGlyphForCodePoint(codePoint: number): boolean;
  }
  export function openSync(path: string): Font;
}
