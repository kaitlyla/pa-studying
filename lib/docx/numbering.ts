// List markers (30 §30.6): counters per abstractNumId and level, lvlRestart, startOverride, numFmt.
import type { Element } from "./xml.ts";
import { NS, child, children, onOff, wAttr, wNum } from "./xml.ts";

export interface Level {
  start: number;
  numFmt: string;
  lvlText: string;
  /** w:lvlRestart: null = default (restart after any shallower level); 0 = never; k = after level k−1. */
  restart: number | null;
  isLgl: boolean;
  pPr: Element | null;
  rPr: Element | null;
}

interface Num {
  abstractId: string;
  overrides: Map<number, { start: number | null; level: Level | null }>;
}

export const SUPPORTED_FORMATS = new Set(["decimal", "lowerLetter", "upperLetter", "lowerRoman", "upperRoman", "decimalZero", "bullet", "none"]);

function readLevel(l: Element): Level {
  return {
    start: wNum(child(l, NS.w, "start"), "val") ?? 1,
    numFmt: wAttr(child(l, NS.w, "numFmt"), "val") ?? "decimal",
    lvlText: wAttr(child(l, NS.w, "lvlText"), "val") ?? "",
    restart: wNum(child(l, NS.w, "lvlRestart"), "val"),
    isLgl: onOff(child(l, NS.w, "isLgl")) ?? false,
    pPr: child(l, NS.w, "pPr"),
    rPr: child(l, NS.w, "rPr"),
  };
}

function roman(n: number): string {
  const table: [number, string][] = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
    [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let out = "";
  let v = n;
  for (const [k, s] of table) while (v >= k) { out += s; v -= k; }
  return out;
}

function letters(n: number): string {
  if (n < 1) return String(n);
  return String.fromCharCode(97 + ((n - 1) % 26)).repeat(Math.floor((n - 1) / 26) + 1);
}

/** Formats a counter value in a numFmt; unsupported formats fall back to decimal. */
export function formatNumber(n: number, fmt: string): string {
  switch (fmt) {
    case "lowerLetter": return letters(n);
    case "upperLetter": return letters(n).toUpperCase();
    case "lowerRoman": return roman(n);
    case "upperRoman": return roman(n).toUpperCase();
    case "decimalZero": return n < 10 ? `0${n}` : String(n);
    case "none": return "";
    default: return String(n);
  }
}

export interface MarkerResult {
  text: string;
  level: Level;
  /** Set when the level's numFmt is not one this converter formats (reported as unsupportedNumFmt). */
  unsupported: string | null;
}

export class Numbering {
  private readonly abstracts = new Map<string, Map<number, Level>>();
  private readonly styleLinks = new Map<string, string>();
  private readonly nums = new Map<string, Num>();
  private readonly counters = new Map<string, Map<number, number>>();
  private readonly usedNums = new Set<string>();
  private readonly styleNumId: (styleId: string) => string | null;

  constructor(root: Element | null, styleNumId: (styleId: string) => string | null) {
    this.styleNumId = styleNumId;
    for (const a of children(root, NS.w, "abstractNum")) {
      const id = wAttr(a, "abstractNumId");
      if (id === null) continue;
      const levels = new Map<number, Level>();
      for (const l of children(a, NS.w, "lvl")) levels.set(wNum(l, "ilvl") ?? 0, readLevel(l));
      this.abstracts.set(id, levels);
      const link = wAttr(child(a, NS.w, "numStyleLink"), "val");
      if (link) this.styleLinks.set(id, link);
    }
    for (const n of children(root, NS.w, "num")) {
      const id = wAttr(n, "numId");
      const abstractId = wAttr(child(n, NS.w, "abstractNumId"), "val");
      if (id === null || abstractId === null) continue;
      const overrides = new Map<number, { start: number | null; level: Level | null }>();
      for (const o of children(n, NS.w, "lvlOverride")) {
        const lvl = child(o, NS.w, "lvl");
        overrides.set(wNum(o, "ilvl") ?? 0, {
          start: wNum(child(o, NS.w, "startOverride"), "val"),
          level: lvl ? readLevel(lvl) : null,
        });
      }
      this.nums.set(id, { abstractId, overrides });
    }
  }

  /** The abstract definition a num uses, following a numStyleLink to the numbering style's num. */
  private abstractOf(numId: string, depth = 0): string | null {
    const num = this.nums.get(numId);
    if (!num) return null;
    const link = this.styleLinks.get(num.abstractId);
    if (link && depth < 4 && (this.abstracts.get(num.abstractId)?.size ?? 0) === 0) {
      const linked = this.styleNumId(link);
      if (linked && linked !== numId) return this.abstractOf(linked, depth + 1);
    }
    return num.abstractId;
  }

  /** The level definition a paragraph with (numId, ilvl) uses, without advancing counters. */
  level(numId: string, ilvl: number): Level | null {
    const num = this.nums.get(numId);
    const abs = this.abstractOf(numId);
    if (!num || abs === null) return null;
    return num.overrides.get(ilvl)?.level ?? this.abstracts.get(abs)?.get(ilvl) ?? null;
  }

  /** Advances the counters for a numbered paragraph and returns its marker. */
  next(numId: string, ilvl: number): MarkerResult | null {
    if (numId === "0") return null;
    const num = this.nums.get(numId);
    const abs = this.abstractOf(numId);
    const level = this.level(numId, ilvl);
    if (!num || abs === null || !level) return null;
    let counters = this.counters.get(abs);
    if (!counters) {
      counters = new Map();
      this.counters.set(abs, counters);
    }
    const levelDef = (i: number): Level | null => this.level(numId, i);
    // A startOverride is this num's start value for the level, at first use and at every restart.
    const startOf = (i: number): number => num.overrides.get(i)?.start ?? levelDef(i)?.start ?? 1;

    if (!this.usedNums.has(numId)) {
      this.usedNums.add(numId);
      for (const [i, o] of num.overrides) if (o.start !== null) counters.set(i, o.start - 1);
    }
    const cur = counters.get(ilvl);
    counters.set(ilvl, cur === undefined ? startOf(ilvl) : cur + 1);
    for (const d of [...counters.keys()]) {
      if (d <= ilvl) continue;
      const restart = levelDef(d)?.restart ?? null;
      const k = restart === null ? d : restart;
      if (k !== 0 && ilvl <= k - 1) counters.delete(d);
    }

    const valueAt = (i: number): number => counters.get(i) ?? startOf(i);
    let unsupported: string | null = null;
    const text = level.lvlText.replace(/%([1-9])/g, (_m, d: string) => {
      const i = Number(d) - 1;
      const def = levelDef(i);
      const fmt = level.isLgl ? "decimal" : (def?.numFmt ?? "decimal");
      if (!SUPPORTED_FORMATS.has(fmt)) unsupported = fmt;
      return formatNumber(valueAt(i), fmt === "bullet" ? "decimal" : fmt);
    });
    if (!SUPPORTED_FORMATS.has(level.numFmt)) unsupported = level.numFmt;
    return { text, level, unsupported };
  }
}
