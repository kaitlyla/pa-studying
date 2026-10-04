// USPSTF pages (80 §80.1, §80.3.1): the A and B recommendations table and a recommendation's own page.
import { attr, cellsOf, elements, norm, parseHtml, rowsOf, textOf } from "./html.ts";
import type { Element } from "./html.ts";

export const USPSTF_ORIGIN = "https://www.uspreventiveservicestaskforce.org";
export const USPSTF_AB_URL = `${USPSTF_ORIGIN}/uspstf/recommendation-topics/uspstf-a-and-b-recommendations`;
export const USPSTF_ORG = "U.S. Preventive Services Task Force (USPSTF)";

export const AB_HEADERS = ["Topic", "Description", "Grade", "Release Date of Current Recommendation"] as const;
export const AB_MIN_ROWS = 30;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December",
];
const MONTH_ALT = MONTH_NAMES.join("|");

/** One row of the A and B list, before it is keyed. */
export interface UspstfRow {
  subject: string;
  quote: string;
  grade: string;
  /** YYYY-MM */
  published: string;
  url: string;
}

export interface UspstfRecord extends UspstfRow {
  /** The recommendation's identity: see `assignUspstfKeys`. */
  key: string;
}

const monthNumber = (name: string): string => String(MONTH_NAMES.indexOf(name) + 1).padStart(2, "0");

/** A recommendation page's identity path: lower-cased, with no host, query, fragment or trailing slash. */
export function identityPath(url: string): string {
  return new URL(url).pathname.toLowerCase().replace(/\/+$/, "");
}
const NO_SUP = new Set(["sup"]);

/** What identifies a stored recommendation when the rows of its page are matched again. */
export interface StoredRecommendation {
  subject: string;
  quote: string;
}

const KEY_RE = /^(.*)#(\d+)$/;

/**
 * Key USPSTF recommendation rows (Orchestrator rulings, 2026-10-04 03:06Z and 04:40Z, deviating
 * from 80 §80.3.1 and superseding 90 §90.6's `subject + "#1"`). A key is the row's `identityPath`
 * plus `#n`. Keys stay bound to their rows: within a path, the current rows (in table order) take
 * the `stored` keys of that path by
 * 1. exact population (the subject), preferring a stored key whose statement matches too;
 * 2. exact statement;
 * 3. table order, for the leftovers, only when as many stored keys as rows are left over.
 * Otherwise the unmatched stored keys are not given out (the caller retires them), and each
 * unmatched row takes the next ordinal of its path above every stored and `reserved` key.
 * With nothing stored, the rows of a path are keyed #1, #2, … in table order.
 */
export function assignUspstfKeys<T extends { url: string; subject: string; quote: string }>(
  rows: readonly T[],
  stored: Readonly<Record<string, StoredRecommendation>> = {},
  reserved: Iterable<string> = [],
): (T & { key: string })[] {
  const highest = new Map<string, number>();
  const storedByPath = new Map<string, string[]>();
  for (const key of [...Object.keys(stored), ...reserved]) {
    const m = KEY_RE.exec(key);
    if (!m) continue;
    highest.set(m[1]!, Math.max(highest.get(m[1]!) ?? 0, Number(m[2])));
  }
  for (const key of Object.keys(stored).sort((a, b) => Number(KEY_RE.exec(a)?.[2]) - Number(KEY_RE.exec(b)?.[2]))) {
    const path = KEY_RE.exec(key)?.[1];
    if (path !== undefined) storedByPath.set(path, [...(storedByPath.get(path) ?? []), key]);
  }
  const rowsByPath = new Map<string, number[]>();
  rows.forEach((row, i) => {
    const path = identityPath(row.url);
    rowsByPath.set(path, [...(rowsByPath.get(path) ?? []), i]);
  });

  const keys: string[] = [];
  for (const [path, indices] of rowsByPath) {
    const free = [...(storedByPath.get(path) ?? [])];
    let open = [...indices];
    const take = (same: (was: StoredRecommendation, row: T) => boolean): void => {
      open = open.filter((i) => {
        const k = free.findIndex((key) => same(stored[key]!, rows[i]!));
        if (k < 0) return true;
        keys[i] = free.splice(k, 1)[0]!;
        return false;
      });
    };
    take((was, row) => was.subject === row.subject && was.quote === row.quote);
    take((was, row) => was.subject === row.subject);
    take((was, row) => was.quote === row.quote);
    if (free.length === open.length) {
      open.forEach((i, j) => { keys[i] = free[j]!; });
    } else {
      let n = highest.get(path) ?? 0;
      for (const i of open) keys[i] = `${path}#${++n}`;
    }
  }
  return rows.map((row, i) => ({ ...row, key: keys[i]! }));
}

/**
 * Parse and key the A and B list (see `assignUspstfKeys` for `stored` and `reserved`). Throws when
 * the table fails its sanity checks or a row cannot be read.
 */
export function parseAbPage(html: string, stored?: Readonly<Record<string, StoredRecommendation>>, reserved?: Iterable<string>): UspstfRecord[] {
  return assignUspstfKeys(parseAbRows(html), stored, reserved);
}

/** Parse the A and B list's rows in table order. Throws when the table fails its sanity checks or a row cannot be read. */
export function parseAbRows(html: string): UspstfRow[] {
  const table = elements(parseHtml(html), "table").next().value;
  if (!table) throw new Error("USPSTF: no table on the A and B page");
  const rows = rowsOf(table);
  const header = rows.map((r) => cellsOf(r, "th")).find((cells) => cells.length > 0) ?? [];
  const headerText = header.map((c) => norm(textOf(c)));
  if (headerText.join("\u0000") !== AB_HEADERS.join("\u0000")) {
    throw new Error(`USPSTF: unexpected header cells ${JSON.stringify(headerText)}`);
  }
  const dataRows = rows.filter((r) => cellsOf(r, "td").length > 0);
  if (dataRows.length < AB_MIN_ROWS) throw new Error(`USPSTF: ${dataRows.length} data rows, expected at least ${AB_MIN_ROWS}`);
  return dataRows.map((row, i) => {
    const cells = cellsOf(row, "td");
    if (cells.length !== 4) throw new Error(`USPSTF: row ${i + 1} has ${cells.length} cells`);
    const [topic, statement, grade, date] = cells as [Element, Element, Element, Element];
    const link = elements(topic, "a").next().value;
    const href = link ? attr(link, "href") : null;
    if (!link || href === null) throw new Error(`USPSTF: row ${i + 1} has no topic link`);
    const url = new URL(href, USPSTF_ORIGIN).href;
    const released = new RegExp(`^(${MONTH_ALT})\\s+(\\d{4})`).exec(norm(textOf(date)));
    if (!released) throw new Error(`USPSTF: row ${i + 1} has no release month`);
    const record: UspstfRow = {
      subject: norm(textOf(link)),
      quote: norm(textOf(statement, NO_SUP)),
      grade: norm(textOf(grade)),
      published: `${released[2]}-${monthNumber(released[1]!)}`,
      url,
    };
    if (record.subject === "" || record.quote === "" || record.grade === "") throw new Error(`USPSTF: row ${i + 1} is incomplete`);
    return record;
  });
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

export interface RecommendationRow {
  quote: string;
  grade: string;
  published: string;
}

/**
 * Read the row for `subject` from a recommendation page's "Recommendation Summary" table: the row
 * whose Population equals the text after the subject's last ": ". Null when the page has no such
 * table or no row matches (the recommendation is gone from the page). Throws when the matched row's
 * release date cannot be found.
 */
export function parseRecommendationPage(html: string, subject: string): RecommendationRow | null {
  const doc = parseHtml(html);
  let afterHeading = false;
  let table: Element | undefined;
  for (const el of elements(doc)) {
    if (!afterHeading) afterHeading = /^h[1-6]$/.test(el.tagName) && norm(textOf(el)) === "Recommendation Summary";
    else if (el.tagName === "table") {
      table = el;
      break;
    }
  }
  if (!table) return null;
  const population = collapse(subject.slice(subject.lastIndexOf(": ") + 2));
  const row = rowsOf(table)
    .map((r) => cellsOf(r, "td"))
    .find((cells) => cells.length >= 3 && collapse(textOf(cells[0]!)) === population);
  if (!row) return null;
  const date = new RegExp(`\\b(${MONTH_ALT})\\s+\\d{1,2},\\s+(\\d{4})\\b`).exec(textOf(doc).replace(/\s+/g, " "));
  if (!date) throw new Error("USPSTF: no release date on the recommendation page");
  return {
    quote: norm(textOf(row[1]!, NO_SUP)),
    grade: norm(textOf(row[2]!)),
    published: `${date[2]}-${monthNumber(date[1]!)}`,
  };
}
