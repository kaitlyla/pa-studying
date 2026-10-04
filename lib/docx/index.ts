// lib/docx: the Word converter (plan 30 §30.3–§30.9), shared by the importer and the inbox job.
export { convertDocx, segmentGuide, toBlocks } from "./convert.ts";
export type { ConvertedDoc, ConvertOptions, J, ReportEntry, TopElement } from "./convert.ts";
export { isSymbolFont, mapSymbol } from "./symbols.ts";
