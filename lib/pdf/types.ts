// Inputs and outputs of the PDF builder (plan 70).
import { cropOrNull } from "../crop.ts";
import type { DocJson, HomeJson, NavJson, SystemJson } from "../derive/published.ts";
import type { Crop } from "../schemaTypes.ts";

/** One menu scope (70 §70.2). The whole guide is built by tools/pdf from `preamble` and `system`. */
export type PdfScope =
  | { kind: "topics"; ids: string[] }
  | { kind: "section"; id: string }
  | { kind: "system" }
  | { kind: "pharmSection"; id: string }
  | { kind: "systemPharm" }
  | { kind: "doc" }
  | { kind: "preamble" };

/** An image as it must appear in the PDF: its asset with its crop, rotation and flips baked in. */
export interface ImageVariant {
  asset: string;
  rot: number;
  flipH: boolean;
  flipV: boolean;
  /** The part of the file it keeps (cut before it is turned or flipped); absent or null: all of it. */
  crop?: Crop | null;
}

/** Image key → data URL (PNG or JPEG) of that variant. */
export type ImageData = Record<string, string>;

/** Published data a scope reads: a guide page (`nav` + `system`), the guide home, or a Word page. */
export type PdfInput =
  | { nav: NavJson; system: SystemJson; images?: ImageData }
  | { nav: NavJson; home: HomeJson; images?: ImageData }
  | { doc: DocJson; images?: ImageData };

/** A pdfmake document-definition node. pdfmake ships no types; the builder emits plain objects. */
export type Content = Record<string, unknown>;

export interface DocDefinition {
  pageSize: { width: number; height: number };
  pageMargins: [number, number, number, number];
  content: Content[];
  defaultStyle: { font: string; fontSize: number };
  images: ImageData;
  info: { title: string };
}

export function imageKey(v: ImageVariant): string {
  const key = `${v.asset}|${v.rot}|${v.flipH ? "h" : "-"}${v.flipV ? "v" : "-"}`;
  const c = cropOrNull(v.crop);
  return c ? `${key}|${c.l},${c.t},${c.r},${c.b}` : key;
}
