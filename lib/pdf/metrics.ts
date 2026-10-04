// Carlito metrics the PDF builder needs without loading a font: advance widths of U+0020–U+007E
// (for tab stops, 70 §70.3) and the line-height factor (for exact/at-least line spacing). Values
// are font units of the vendored app/public/fonts/Carlito-*.ttf (2048 per em); pdf.test.ts checks
// them against those files with fontkit.

export const CARLITO_UNITS_PER_EM = 2048;

/** pdfkit's line height for a Carlito run is (ascent − descent) / unitsPerEm × size. */
export const CARLITO_ASCENT = 1950;
export const CARLITO_DESCENT = -550;
export const CARLITO_LINE_FACTOR = (CARLITO_ASCENT - CARLITO_DESCENT) / CARLITO_UNITS_PER_EM;

export type Face = "Regular" | "Bold" | "Italic" | "BoldItalic";

/** Advance widths of U+0020 … U+007E, in order. */
export const CARLITO_ASCII_WIDTHS: Record<Face, readonly number[]> = {
  Regular: [463, 667, 821, 1020, 1038, 1464, 1397, 452, 621, 621, 1020, 1020, 511, 627, 517, 791, 1038, 1038, 1038, 1038, 1038, 1038, 1038, 1038, 1038, 1038, 548, 548, 1020, 1020, 1020, 949, 1831, 1185, 1114, 1092, 1260, 1000, 941, 1292, 1276, 516, 653, 1064, 861, 1751, 1322, 1356, 1058, 1378, 1112, 941, 998, 1314, 1162, 1822, 1063, 998, 959, 628, 791, 628, 1020, 1020, 596, 981, 1076, 866, 1076, 1019, 625, 964, 1076, 470, 490, 931, 470, 1636, 1076, 1080, 1076, 1076, 714, 801, 686, 1076, 925, 1464, 887, 927, 809, 644, 943, 644, 1020],
  Bold: [463, 667, 898, 1020, 1038, 1493, 1443, 478, 638, 638, 1020, 1020, 528, 627, 547, 880, 1038, 1038, 1038, 1038, 1038, 1038, 1038, 1038, 1038, 1038, 565, 565, 1020, 1020, 1020, 949, 1840, 1241, 1148, 1084, 1291, 999, 940, 1305, 1292, 546, 678, 1120, 866, 1790, 1349, 1385, 1090, 1405, 1153, 968, 1014, 1337, 1211, 1856, 1128, 1064, 979, 665, 880, 665, 1020, 1020, 615, 1011, 1099, 857, 1099, 1031, 648, 971, 1099, 503, 523, 983, 503, 1666, 1099, 1101, 1099, 1099, 728, 817, 710, 1099, 969, 1526, 941, 970, 814, 704, 973, 704, 1020],
  Italic: [463, 667, 821, 1020, 1038, 1464, 1397, 452, 621, 621, 1020, 1020, 511, 627, 517, 794, 1038, 1038, 1038, 1038, 1038, 1038, 1038, 1038, 1038, 1038, 548, 548, 1020, 1020, 1020, 949, 1831, 1185, 1114, 1070, 1260, 1000, 941, 1292, 1276, 516, 653, 1064, 861, 1751, 1320, 1340, 1058, 1360, 1112, 926, 998, 1314, 1162, 1823, 1063, 998, 959, 628, 787, 628, 1020, 1020, 596, 1053, 1053, 852, 1053, 978, 625, 1053, 1053, 470, 490, 931, 470, 1620, 1053, 1051, 1053, 1053, 702, 797, 686, 1053, 913, 1464, 887, 916, 809, 644, 943, 644, 1020],
  BoldItalic: [463, 667, 898, 1020, 1038, 1493, 1443, 478, 638, 638, 1020, 1020, 528, 627, 547, 889, 1038, 1038, 1038, 1038, 1038, 1038, 1038, 1038, 1038, 1038, 565, 565, 1020, 1020, 1020, 949, 1840, 1241, 1148, 1062, 1291, 999, 940, 1305, 1292, 546, 678, 1120, 866, 1790, 1344, 1369, 1090, 1387, 1153, 953, 1014, 1337, 1211, 1857, 1128, 1064, 979, 665, 870, 665, 1020, 1020, 615, 1081, 1081, 843, 1081, 1006, 648, 1081, 1080, 503, 523, 983, 503, 1646, 1080, 1080, 1081, 1081, 721, 807, 710, 1080, 961, 1526, 941, 963, 814, 704, 973, 704, 1020],
};

/** Width assumed for a character outside U+0020–U+007E: Carlito's digit advance (half an em). */
const OTHER_WIDTH = 1038;

export function faceOf(bold: boolean, italic: boolean): Face {
  if (bold) return italic ? "BoldItalic" : "Bold";
  return italic ? "Italic" : "Regular";
}

/** Estimated width of `text` in pt at `size` in the given Carlito face. */
export function textWidth(text: string, size: number, face: Face): number {
  const table = CARLITO_ASCII_WIDTHS[face];
  let units = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    units += cp >= 0x20 && cp <= 0x7e ? (table[cp - 0x20] ?? OTHER_WIDTH) : OTHER_WIDTH;
  }
  return (units / CARLITO_UNITS_PER_EM) * size;
}

/** Width of one space in pt. */
export function spaceWidth(size: number, face: Face): number {
  return textWidth(" ", size, face);
}
