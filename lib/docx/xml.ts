// XML access for Word packages (30 §30.3): namespaces, element walking, attribute and length helpers.
import { DOMParser } from "@xmldom/xmldom";
import type { Document, Element } from "@xmldom/xmldom";

export type { Document, Element };

export const NS = {
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  pic: "http://schemas.openxmlformats.org/drawingml/2006/picture",
  wps: "http://schemas.microsoft.com/office/word/2010/wordprocessingShape",
  wpg: "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup",
  mc: "http://schemas.openxmlformats.org/markup-compatibility/2006",
  v: "urn:schemas-microsoft-com:vml",
  o: "urn:schemas-microsoft-com:office:office",
  w16se: "http://schemas.microsoft.com/office/word/2015/wordml/symex",
  rel: "http://schemas.openxmlformats.org/package/2006/relationships",
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
} as const;

export const INK_URI = "http://schemas.microsoft.com/office/word/2010/wordprocessingInk";

/** Namespace prefixes whose Choice branch is taken (30 §30.3). */
export const CHOICE_PREFIXES = new Set(["wps", "wpg", "wpc", "w14", "w15", "w16se", "a14", "wp14"]);

const ELEMENT_NODE = 1;

export function parseXml(text: string, part: string): Document {
  return new DOMParser({
    onError: (level, msg) => {
      if (level !== "warning") throw new Error(`${part}: XML ${level}: ${msg}`);
    },
  }).parseFromString(text, "text/xml");
}

/** Element children, in document order. */
export function kids(el: Element): Element[] {
  const out: Element[] = [];
  const nodes = el.childNodes;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes.item(i);
    if (n && n.nodeType === ELEMENT_NODE) out.push(n as Element);
  }
  return out;
}

export function is(el: Element, ns: string, local: string): boolean {
  return el.namespaceURI === ns && el.localName === local;
}

/** First element child with the given name. */
export function child(el: Element | null | undefined, ns: string, local: string): Element | null {
  if (!el) return null;
  for (const k of kids(el)) if (is(k, ns, local)) return k;
  return null;
}

export function children(el: Element | null | undefined, ns: string, local: string): Element[] {
  return el ? kids(el).filter((k) => is(k, ns, local)) : [];
}

/** Every descendant element with the given name, in document order. */
export function descendants(el: Element, ns: string, local: string): Element[] {
  const out: Element[] = [];
  const walk = (e: Element): void => {
    for (const k of kids(e)) {
      if (is(k, ns, local)) out.push(k);
      walk(k);
    }
  };
  walk(el);
  return out;
}

/** First descendant with the given name (depth-first, document order). */
export function descendant(el: Element | null | undefined, ns: string, local: string): Element | null {
  if (!el) return null;
  for (const k of kids(el)) {
    if (is(k, ns, local)) return k;
    const d = descendant(k, ns, local);
    if (d) return d;
  }
  return null;
}

/** A `w:` attribute (WordprocessingML attributes are namespaced). */
export function wAttr(el: Element | null | undefined, name: string): string | null {
  if (!el) return null;
  const v = el.getAttributeNS(NS.w, name);
  return v === null || v === "" ? (el.hasAttributeNS(NS.w, name) ? "" : null) : v;
}

/** An unqualified attribute (DrawingML, VML). */
export function attr(el: Element | null | undefined, name: string): string | null {
  if (!el || !el.hasAttribute(name)) return null;
  return el.getAttribute(name);
}

export function numAttr(el: Element | null | undefined, name: string): number | null {
  const v = attr(el, name);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A numeric `w:` attribute; null when absent or not a number. */
export function wNum(el: Element | null | undefined, name: string): number | null {
  const v = wAttr(el, name);
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** OOXML on/off value: null when the element is absent; absent `w:val` means on; "0", "false", "off" and "none" mean off. */
export function onOff(el: Element | null | undefined): boolean | null {
  if (!el) return null;
  const v = wAttr(el, "val");
  return !(v === "0" || v === "false" || v === "off" || v === "none");
}

/** An on/off XML attribute value ("1", "true", "on"; "t" in VML). */
export function truthy(v: string | null): boolean {
  return v === "1" || v === "true" || v === "on" || v === "t";
}

/** 6-digit uppercase hex, or null for `auto`, empty or malformed values. */
export function hexColor(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(s)) return s.toUpperCase();
  if (/^[0-9a-fA-F]{3}$/.test(s)) return s.split("").map((c) => c + c).join("").toUpperCase();
  return null;
}

export const twipsToPt = (v: number): number => v / 20;
export const emuToPt = (v: number): number => v / 12700;

/** A CSS-style length (VML `style` values) in pt. */
export function cssLengthPt(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^\s*(-?[0-9.]+)\s*(pt|in|cm|mm|px|pc|emu)?\s*$/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case "in": return n * 72;
    case "cm": return (n * 72) / 2.54;
    case "mm": return (n * 72) / 25.4;
    case "px": return n * 0.75;
    case "pc": return n * 12;
    case "emu": return emuToPt(n);
    default: return n;
  }
}

/** Parses a VML `style` attribute into a property map. */
export function parseStyle(style: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (style ?? "").split(";")) {
    const i = part.indexOf(":");
    if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}
