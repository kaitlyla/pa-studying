// Date display. Stored dates are ISO (`YYYY-MM-DD`, `YYYY-MM` or a full timestamp).

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * "Oct 4, 2026" for a day, "Apr 2024" for a month (`long`: "October 4, 2026", 80 §80.5); anything
 * else is returned unchanged.
 */
export function formatDate(iso: string | null | undefined, style: "short" | "long" = "short"): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(iso);
  if (!m) return iso;
  const full = MONTHS[Number(m[2]) - 1];
  if (!full) return iso;
  const month = style === "long" ? full : full.slice(0, 3);
  return m[3] ? `${month} ${Number(m[3])}, ${m[1]}` : `${month} ${m[1]}`;
}

/** The latest of several ISO dates (lexical order is chronological for ISO). */
export function latest(dates: readonly string[]): string | null {
  return dates.reduce<string | null>((a, b) => (a === null || b > a ? b : a), null);
}
