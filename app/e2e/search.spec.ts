// Search (60 §60.5, search/*) against the built site and the content the import and curation
// produced. Queries are chosen from the published search data, so the spec follows the content.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import { expect, test, type Page } from "@playwright/test";
import { isWordToken, SHARD_SIZE, tokens, Vocab, type SearchUnit } from "../../lib/search/index.ts";
import type { VocabFile } from "../../lib/content/types.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DATA = join(ROOT, "dist", "data");

function readUnits(): SearchUnit[] {
  const out: SearchUnit[] = [];
  for (let k = 0; existsSync(join(DATA, "search", `units-${k}.json`)); k++) {
    out.push(...(JSON.parse(readFileSync(join(DATA, "search", `units-${k}.json`), "utf8")) as SearchUnit[]));
  }
  return out;
}

const units = readUnits();
const vocabFile = JSON.parse(readFileSync(join(DATA, "search", "vocab.json"), "utf8")) as VocabFile;
const vocab = new Vocab(vocabFile.entries);

/** Number of units each word token occurs in. */
const docFreq = new Map<string, number>();
const unitTokens = units.map((u) => new Set(tokens(`${u.title} ${u.text}`)));
for (const set of unitTokens) for (const t of set) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);

/** How many units a single-token query (prefix rule) matches. */
function prefixHits(q: string): number {
  return unitTokens.filter((set) => [...set].some((t) => t.startsWith(q))).length;
}

/** A plain query word: 6+ letters and not a vocabulary key (so no concept widens its matches). */
const plainWord = (t: string): boolean => /^\p{L}{6,}$/u.test(t) && vocab.entriesForSpan([t]).length === 0;

/** The unit's rarest word token of 6+ letters in its text, as a query that finds it. */
function distinctiveQuery(n: number): string {
  const u = units[n];
  if (!u) throw new Error(`no unit ${n}`);
  const candidates = [...new Set(tokens(u.text))].filter((t) => isWordToken(t) && /^\p{L}{6,}$/u.test(t));
  candidates.sort((a, b) => (docFreq.get(a) ?? 0) - (docFreq.get(b) ?? 0) || a.localeCompare(b));
  const q = candidates[0];
  if (!q) throw new Error(`unit ${n} (${u.title}) has no 6-letter word`);
  return q;
}

function firstUnit(pred: (u: SearchUnit) => boolean, what: string): number {
  const n = units.findIndex(pred);
  if (n < 0) throw new Error(`the published content has no ${what}`);
  return n;
}

const box = (page: Page) => page.getByRole("search").getByRole("textbox", { name: "Search all notes" });
const panel = (page: Page) => page.getByRole("region", { name: "Search results" });
const row = (page: Page, n: number) => panel(page).locator(`.srch-row[data-unit="${n}"]`);

async function search(page: Page, q: string): Promise<void> {
  await box(page).click();
  await box(page).fill(q);
  await expect(panel(page).locator(".srch-row").first().or(panel(page).getByText(/^No matches for/))).toBeVisible();
}

/** Scroll a result row into view (which loads its unit) and wait for it to fill in. */
async function reveal(page: Page, n: number) {
  const r = row(page, n);
  await r.scrollIntoViewIfNeeded();
  await expect(r).not.toHaveClass(/pending/);
  return r;
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("./#/eor");
});

test.describe("states", () => {
  test("an empty box says what search covers, one character asks for more, no matches keeps the text", async ({ page }) => {
    await box(page).click();
    await expect(panel(page)).toContainText("Search every tab:");
    await box(page).fill("e");
    await expect(panel(page)).toContainText("Keep typing — searches start at 2 characters.");
    await box(page).fill("⊕");
    await expect(panel(page)).toContainText("Keep typing — searches start at 2 characters.");
    await box(page).fill("qqzzxxjjvv");
    await expect(panel(page)).toContainText("No matches for “qqzzxxjjvv”");
    await expect(box(page)).toHaveValue("qqzzxxjjvv");
  });
});

test.describe("results", () => {
  test("topics named the query come before mentions, each with title, location and a highlighted excerpt", async ({ page }) => {
    // A topic title word that some other unit mentions only in its text.
    const mentionedOnly = (t: string): boolean =>
      units.some((x) => !tokens(x.title).some((y) => y.startsWith(t)) && tokens(x.text).some((y) => y.startsWith(t)));
    const titleWord = (u: SearchUnit): string | undefined => tokens(u.title).find((t) => plainWord(t) && mentionedOnly(t));
    const n = firstUnit((u) => u.tab === "eor" && u.label === "notes" && /\/t\//.test(u.route) && titleWord(u) !== undefined, "topic whose title word is mentioned elsewhere");
    const u = units[n] as SearchUnit;
    const q = titleWord(u) as string;
    await search(page, q);
    const headings = panel(page).locator(".srch-grp");
    await expect(headings.first()).toHaveText(`Topics named “${q}”`);
    await expect(headings.last()).toHaveText("Mentions");
    const r = await reveal(page, n);
    await expect(r.locator(".srch-title")).toHaveText(u.title);
    await expect(r.locator(".srch-loc")).toHaveText(u.loc);
    await expect(r.locator(".srch-title mark").first()).toBeVisible();
    const mention = panel(page).locator('.srch-grp:has-text("Mentions") ~ .srch-row').first();
    await mention.scrollIntoViewIfNeeded();
    await expect(mention.locator(".srch-ex mark").first()).toBeVisible();
    // The live region announces the result count.
    await expect(panel(page).locator('[aria-live="polite"]')).toContainText(/\d+ results?/);
  });

  test("every result is listed, with no cap", async ({ page }) => {
    // The most widespread 6+-letter token: far more units than one page of results.
    const [q] = [...docFreq.entries()].filter(([t]) => plainWord(t)).sort((a, b) => b[1] - a[1])[0] ?? [];
    if (!q) throw new Error("no word tokens");
    const expected = prefixHits(q);
    await search(page, q);
    await expect(panel(page).locator(".srch-row")).toHaveCount(expected);
    await expect(panel(page).getByRole("button", { name: `All ${expected}`, exact: true })).toBeVisible();
  });

  test("gap units carry the blue-box marking, labeled 'Not from your notes' only for the owner; update units say 'Updated guideline'", async ({ page }) => {
    const gap = firstUnit((u) => u.label === "gap", "gap block");
    await search(page, distinctiveQuery(gap));
    const g = await reveal(page, gap);
    await expect(g).toHaveClass(/\bgap\b/);
    await expect(g.getByText("Not from your notes")).toBeHidden();
    // The owner view is keyed on html[data-owner], which the owner check sets after sign-in.
    await page.evaluate(() => document.documentElement.setAttribute("data-owner", ""));
    await expect(g.getByText("Not from your notes")).toBeVisible();
    await page.evaluate(() => document.documentElement.removeAttribute("data-owner"));

    const upd = firstUnit((u) => u.label === "update", "update flag");
    await box(page).fill(distinctiveQuery(upd));
    const r = await reveal(page, upd);
    await expect(r.locator(".srch-chip.upd")).toHaveText("Updated guideline");
  });

  test("tab chips count results per tab, filter to one tab, and are disabled for tabs with none", async ({ page }) => {
    // A query with results in at least two tabs but not all seven.
    const q = [...docFreq.keys()].find((t) => {
      if (!plainWord(t)) return false;
      const tabs = new Set(units.filter((_, i) => [...(unitTokens[i] ?? [])].some((x) => x.startsWith(t))).map((u) => u.tab));
      return tabs.size >= 2 && tabs.size < 7;
    });
    if (!q) throw new Error("no query spanning 2–6 tabs");
    const counts = new Map<string, number>();
    units.forEach((u, i) => {
      if ([...(unitTokens[i] ?? [])].some((x) => x.startsWith(q))) counts.set(u.tab, (counts.get(u.tab) ?? 0) + 1);
    });
    await search(page, q);
    const labels: Record<string, string> = { eor: "EOR", pance: "PANCE", labs: "Labs", imaging: "Imaging", ekg: "EKG", anatomy: "Anatomy", other: "Other" };
    for (const [tab, label] of Object.entries(labels)) {
      const n = counts.get(tab) ?? 0;
      const chip = panel(page).getByRole("group", { name: "Limit to a tab" }).getByRole("button", { name: n ? `${label} ${n}` : label, exact: true });
      if (n === 0) await expect(chip).toBeDisabled();
      else await expect(chip).toBeEnabled();
    }
    const [tab, n] = [...counts.entries()][0] as [string, number];
    await panel(page).getByRole("button", { name: `${labels[tab]} ${n}`, exact: true }).click();
    await expect(panel(page).locator(".srch-row")).toHaveCount(n);
  });

  test("a vocabulary abbreviation shows the 'abbr = meaning' line", async ({ page }) => {
    let pick: { n: number; abbr: string } | null = null;
    for (const [k, e] of vocabFile.entries.entries()) {
      const abbr = e.abbr.find((a) => /^\p{L}[\p{L}\p{N}]+$/u.test(a));
      if (!abbr) continue;
      const n = units.findIndex((u) => vocab.conceptsOf(`${u.title}\n${u.text}`).includes(k));
      if (n >= 0) {
        pick = { n, abbr };
        break;
      }
    }
    if (!pick) throw new Error("no vocabulary entry occurs in the content");
    await search(page, pick.abbr);
    const r = await reveal(page, pick.n);
    await expect(r.locator(".srch-via")).toContainText(`${pick.abbr}`);
    await expect(r.locator(".srch-via")).toContainText(" = ");
  });
});

test.describe("what is and is not found", () => {
  const found: [string, (u: SearchUnit) => boolean][] = [
    ["a pharm card", (u) => u.label === "notes" && /\/pharm\//.test(u.route) && / pharm$/.test(u.loc) && !/\/r_[^/]+$/.test(u.route)],
    ["a gap block", (u) => u.label === "gap"],
    ["an update note", (u) => u.label === "update"],
    ["a PDF page", (u) => / · p\. \d+$/.test(u.title)],
    ["a review slide", (u) => /› Review slides$/.test(u.loc) && u.label !== "gap"],
  ];
  for (const [what, pred] of found) {
    test(`text of ${what} is found`, async ({ page }) => {
      const n = firstUnit(pred, what);
      await search(page, distinctiveQuery(n));
      await reveal(page, n);
    });
  }

  test("the abbreviation vocabulary is not a page", async ({ page }) => {
    // An entry whose words occur nowhere in the content would be found only if the vocabulary were indexed.
    const entry = vocabFile.entries.find((e) => [...e.abbr, ...e.meanings].every((p) => tokens(p).every((t) => !docFreq.has(t))) && e.abbr.some((a) => [...a].length >= 2));
    test.skip(!entry, "every vocabulary entry occurs somewhere in the content");
    const abbr = entry?.abbr.find((a) => [...a].length >= 2) as string;
    await search(page, abbr);
    await expect(panel(page)).toContainText(`No matches for “${abbr}”`);
  });

  test("text of her other course notes is not found", async ({ page }) => {
    // Her source files live only on her machine, never in the repo, so CI has no course notes to read.
    const dir = join(ROOT, "Clin Med_Examples");
    test.skip(!existsSync(dir), "her course notes are not in this checkout");
    const file = readdirSync(dir).find((f) => f.endsWith(".docx")) as string;
    const xml = strFromU8(unzipSync(readFileSync(join(dir, file)))["word/document.xml"] as Uint8Array);
    const paragraphs = xml.split("</w:p>").map((p) => [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(""));
    const words = paragraphs.map((p) => tokens(p).filter((t) => /^\p{L}{4,}$/u.test(t))).find((ts) => ts.length >= 8);
    if (!words) throw new Error(`${file} has no paragraph of 8 words`);
    const q = words.slice(0, 8).join(" ");
    await search(page, q);
    await expect(panel(page)).toContainText("No matches for");
  });

  test("owner-only wording and removed documents are not in the search data", () => {
    const ownerOnly = ["Not from your notes", "not from your notes", "made from your notes", "From your Pharm notes", "Your notes and files cover this", "Not covered by your notes", "Edited by you"];
    for (const phrase of ownerOnly) {
      expect(units.filter((u) => u.text.includes(phrase) || u.title.includes(phrase)).map((u) => u.title), phrase).toEqual([]);
    }
    const removed = new Set<string>();
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "files" && e.name !== "assets" && e.name !== "search") walk(p);
        } else if (e.name.endsWith(".json")) {
          const raw = readFileSync(p, "utf8");
          for (const m of raw.matchAll(/"removed":\[(.*?)\]/g)) for (const n of (m[1] ?? "").matchAll(/"id":"(d_[^"]+)"/g)) removed.add(n[1] as string);
        }
      }
    };
    walk(DATA);
    test.skip(removed.size === 0, "the published content has no removed documents");
    const routes = units.map((u) => u.route);
    for (const id of removed) expect(routes.filter((r) => r.includes(id)), id).toEqual([]);
  });
});

test.describe("landing and closing", () => {
  test("opening a result highlights every match, scrolls to the first, shows the bar and keeps the query", async ({ page }) => {
    const n = firstUnit((u) => u.tab === "eor" && u.label === "notes" && /^#\/eor\/[^/]+\/t\//.test(u.route), "EOR topic");
    const u = units[n] as SearchUnit;
    const q = distinctiveQuery(n);
    await search(page, q);
    const r = await reveal(page, n);
    await r.click();
    await expect.poll(() => new URL(page.url()).hash).toBe(`${u.route}?q=${encodeURIComponent(q)}${u.at === null ? "" : `&at=${encodeURIComponent(u.at)}`}`);
    await expect(panel(page)).toBeHidden();
    const marks = page.locator("main mark.hit");
    await expect(marks.first()).toBeVisible();
    await expect(marks.first()).toBeInViewport();
    expect(await marks.count()).toBeGreaterThanOrEqual(1);
    await expect(page.locator(".hitbar")).toContainText(`Showing matches for “${q}”`);
    await expect(box(page)).toHaveValue(q);
    await page.locator(".hitbar").getByRole("button", { name: "Clear highlights" }).click();
    await expect.poll(() => new URL(page.url()).hash).toBe(u.route);
    await expect(page.locator("main mark.hit")).toHaveCount(0);
  });

  test("a later result on a route shared with earlier results lands on its own match", async ({ page }) => {
    // Two units on one route (e.g. two pages of a document), where the query matches both.
    let pick: { n: number; q: string } | null = null;
    const byRoute = new Map<string, number[]>();
    units.forEach((u, i) => {
      if (u.at !== null) byRoute.set(u.route, [...(byRoute.get(u.route) ?? []), i]);
    });
    for (const ns of byRoute.values()) {
      if (ns.length < 2) continue;
      const [first, ...later] = ns as [number, ...number[]];
      for (const n of later) {
        const q = [...new Set(tokens((units[n] as SearchUnit).text))].find(
          (t) => plainWord(t) && tokens((units[first] as SearchUnit).text).some((x) => x.startsWith(t)),
        );
        if (q) {
          pick = { n, q };
          break;
        }
      }
      if (pick) break;
    }
    if (!pick) throw new Error("no route with two units sharing a word");
    const u = units[pick.n] as SearchUnit;
    await search(page, pick.q);
    await (await reveal(page, pick.n)).click();
    const own = page.locator(`main [data-anchor="${u.at}"] mark.hit`).first();
    await expect(own).toBeVisible();
    await expect(own).toBeInViewport();
  });

  test("Esc, ✕ and an outside click close the panel and leave the route unchanged", async ({ page }) => {
    const q = distinctiveQuery(firstUnit((u) => u.label === "notes", "notes unit"));
    await search(page, q);
    await box(page).press("Escape");
    await expect(panel(page)).toBeHidden();
    await expect(page).toHaveURL(/#\/eor$/);

    await search(page, q);
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(panel(page)).toBeHidden();
    await expect(page).toHaveURL(/#\/eor$/);

    await search(page, q);
    await page.locator("main").dispatchEvent("mousedown");
    await expect(panel(page)).toBeHidden();
    await expect(box(page)).toHaveValue(q);
    await expect(page).toHaveURL(/#\/eor$/);
  });

  test("on a phone the magnifier opens a full-screen search", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("./#/eor");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const full = page.locator(".srch-panel.full");
    await expect(full).toBeVisible();
    await expect(full.getByRole("textbox", { name: "Search all notes" })).toBeFocused();
    await full.getByRole("button", { name: "Close search" }).click();
    await expect(full).toBeHidden();
  });
});

test("unit numbering matches the shards", () => {
  // Guards the shard arithmetic the client relies on (60 §60.4).
  expect(units.every((u, i) => u.ord === i)).toBe(true);
  expect(Math.ceil(units.length / SHARD_SIZE)).toBe(readdirSync(join(DATA, "search")).filter((f) => /^units-\d+\.json$/.test(f)).length);
});
