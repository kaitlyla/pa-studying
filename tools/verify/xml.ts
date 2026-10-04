// Minimal XML helpers for the verifier (independent of lib/docx).
import { DOMParser } from "@xmldom/xmldom";
import type { Element } from "@xmldom/xmldom";

export const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
export const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
export const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
export const PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture";
export const WPG = "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup";
export const WPS = "http://schemas.microsoft.com/office/word/2010/wordprocessingShape";
export const V = "urn:schemas-microsoft-com:vml";
export const O = "urn:schemas-microsoft-com:office:office";
export const W16SE = "http://schemas.microsoft.com/office/word/2015/wordml/symex";
export const P = "http://schemas.openxmlformats.org/presentationml/2006/main";

export function parse(text: string, name: string): Element {
  const doc = new DOMParser({
    onError: (level, msg) => {
      if (level !== "warning") throw new Error(`${name}: ${msg}`);
    },
  }).parseFromString(text, "text/xml");
  if (!doc.documentElement) throw new Error(`${name}: no root element`);
  return doc.documentElement;
}

export function elementsOf(e: Element | null | undefined): Element[] {
  const out: Element[] = [];
  if (!e) return out;
  for (let n = e.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n as Element);
  return out;
}

/** First w: child by local name. */
export function el(e: Element | null | undefined, local: string, ns: string = W): Element | null {
  return elementsOf(e).find((c) => c.localName === local && c.namespaceURI === ns) ?? null;
}

export function els(e: Element | null | undefined, local: string, ns: string = W): Element[] {
  return elementsOf(e).filter((c) => c.localName === local && c.namespaceURI === ns);
}

/** A w: attribute value, or null. */
export function at(e: Element | null | undefined, name: string, ns: string = W): string | null {
  if (!e || !e.hasAttributeNS(ns, name)) return null;
  return e.getAttributeNS(ns, name);
}

/** A plain (unqualified) attribute value, or null. */
export function plain(e: Element | null | undefined, name: string): string | null {
  return e && e.hasAttribute(name) ? e.getAttribute(name) : null;
}

export function num(e: Element | null | undefined, name: string, ns: string = W): number | null {
  const v = at(e, name, ns);
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function plainNum(e: Element | null | undefined, name: string): number | null {
  const v = plain(e, name);
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** An on/off property element: on unless its w:val is 0/false/off. */
export function on(e: Element): boolean {
  const v = at(e, "val");
  return v === null || !["0", "false", "off", "none"].includes(v);
}

export function hex6(v: string | null): string | null {
  if (!v) return null;
  const s = v.startsWith("#") ? v.slice(1) : v;
  if (/^[0-9a-f]{6}$/i.test(s)) return s.toUpperCase();
  if (/^[0-9a-f]{3}$/i.test(s)) return [...s].map((c) => c + c).join("").toUpperCase();
  return null;
}

export function isTrue(v: string | null): boolean {
  return v !== null && ["1", "true", "on", "t"].includes(v);
}
