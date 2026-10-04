// Opening a Word package (30 §30.3): unzip with fflate, parse parts with xmldom, resolve relationships.
import { unzipSync } from "fflate";
import type { Document, Element } from "./xml.ts";
import { NS, attr, children, parseXml } from "./xml.ts";

export interface Rel {
  type: string;
  target: string;
  external: boolean;
}

export interface Part {
  name: string;
  root: Element;
  rels: Map<string, Rel>;
}

export interface WordPackage {
  files: Record<string, Uint8Array>;
  main: Part;
  styles: Element | null;
  numbering: Element | null;
  theme: Element | null;
  settings: Element | null;
  footnotes: Part | null;
  endnotes: Part | null;
  /** Parts referenced by the main part, by relationship id (headers and footers). */
  part(relId: string, from?: Part): Part | null;
}

const decoder = new TextDecoder("utf-8");

function dir(name: string): string {
  const i = name.lastIndexOf("/");
  return i < 0 ? "" : name.slice(0, i + 1);
}

/** Resolves a relationship target against the part that owns the relationship. */
export function resolveTarget(fromPart: string, target: string): string {
  const raw = target.startsWith("/") ? target.slice(1) : dir(fromPart) + target;
  const out: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "..") out.pop();
    else if (seg !== "." && seg !== "") out.push(seg);
  }
  return out.join("/");
}

function relsName(part: string): string {
  return `${dir(part)}_rels/${part.slice(dir(part).length)}.rels`;
}

export function openPackage(bytes: Uint8Array): WordPackage {
  const files = unzipSync(bytes);
  const xml = (name: string): Document | null => {
    const data = files[name];
    return data ? parseXml(decoder.decode(data), name) : null;
  };
  const relsOf = (part: string): Map<string, Rel> => {
    const map = new Map<string, Rel>();
    const doc = xml(relsName(part));
    if (!doc?.documentElement) return map;
    for (const r of children(doc.documentElement, NS.rel, "Relationship")) {
      const id = attr(r, "Id");
      const target = attr(r, "Target");
      if (id === null || target === null) continue;
      const external = attr(r, "TargetMode") === "External";
      map.set(id, { type: attr(r, "Type") ?? "", target: external ? target : resolveTarget(part, target), external });
    }
    return map;
  };
  const loadPart = (name: string): Part | null => {
    const doc = xml(name);
    return doc?.documentElement ? { name, root: doc.documentElement, rels: relsOf(name) } : null;
  };

  const pkgRels = relsOf("");
  const officeDoc = [...pkgRels.values()].find((r) => r.type.endsWith("/officeDocument"));
  const mainName = officeDoc?.target ?? "word/document.xml";
  const main = loadPart(mainName);
  if (!main) throw new Error(`Not a Word document: ${mainName} is missing`);

  const byType = (suffix: string): string | null => {
    for (const r of main.rels.values()) if (!r.external && r.type.endsWith(suffix)) return r.target;
    return null;
  };
  const rootOf = (name: string | null): Element | null => (name ? (xml(name)?.documentElement ?? null) : null);
  const partOf = (name: string | null): Part | null => (name ? loadPart(name) : null);

  return {
    files,
    main,
    styles: rootOf(byType("/styles")),
    numbering: rootOf(byType("/numbering")),
    theme: rootOf(byType("/theme")),
    settings: rootOf(byType("/settings")),
    footnotes: partOf(byType("/footnotes")),
    endnotes: partOf(byType("/endnotes")),
    part(relId: string, from: Part = main): Part | null {
      const rel = from.rels.get(relId);
      return rel && !rel.external ? loadPart(rel.target) : null;
    },
  };
}
