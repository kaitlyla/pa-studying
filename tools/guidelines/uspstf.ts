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

export interface UspstfRecord {
  /** `subject#n`: n counts earlier rows with the same subject, from 1. */
  key: string;
  subject: string;
  quote: string;
  grade: string;
  /** YYYY-MM */
  published: string;
  url: string;
}

const monthNumber = (name: string): string => String(MONTH_NAMES.indexOf(name) + 1).padStart(2, "0");
const NO_SUP = new Set(["sup"]);

/** Parse the A and B list. Throws when the table fails its sanity checks or a row cannot be read. */
export function parseAbPage(html: string): UspstfRecord[] {
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
  const occurrences = new Map<string, number>();
  return dataRows.map((row, i) => {
    const cells = cellsOf(row, "td");
    if (cells.length !== 4) throw new Error(`USPSTF: row ${i + 1} has ${cells.length} cells`);
    const [topic, statement, grade, date] = cells as [Element, Element, Element, Element];
    const link = elements(topic, "a").next().value;
    const href = link ? attr(link, "href") : null;
    if (!link || href === null) throw new Error(`USPSTF: row ${i + 1} has no topic link`);
    const subject = norm(textOf(link));
    const n = (occurrences.get(subject) ?? 0) + 1;
    occurrences.set(subject, n);
    const released = new RegExp(`^(${MONTH_ALT})\\s+(\\d{4})`).exec(norm(textOf(date)));
    if (!released) throw new Error(`USPSTF: row ${i + 1} has no release month`);
    const record: UspstfRecord = {
      key: `${subject}#${n}`,
      subject,
      quote: norm(textOf(statement, NO_SUP)),
      grade: norm(textOf(grade)),
      published: `${released[2]}-${monthNumber(released[1]!)}`,
      url: new URL(href, USPSTF_ORIGIN).href,
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
 * whose Population equals the text after the subject's last ": ". Null when no row matches. Throws
 * when the page has no such table, or the matched row's release date cannot be found.
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
  if (!table) throw new Error("USPSTF: no Recommendation Summary table");
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
