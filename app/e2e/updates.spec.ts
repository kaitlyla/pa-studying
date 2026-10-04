// The Updated guidelines list, source status and update-note placement (80 §80.4–§80.5) against the
// built site. Expectations are derived from the published data, so the spec follows the content.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { FlagNote, HostsJson, PubFlag, UpdatesJson } from "../../lib/derive/published.ts";
import { UPDATES_ROUTE } from "../../lib/derive/routes.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DATA = join(ROOT, "dist", "data");

const updates = JSON.parse(readFileSync(join(DATA, "updates.json"), "utf8")) as UpdatesJson;
const hosts = JSON.parse(readFileSync(join(DATA, "hosts.json"), "utf8")) as HostsJson;

function isFlagNote(v: unknown): v is FlagNote {
  return typeof v === "object" && v !== null && "id" in v && typeof v.id === "string" && "guideline" in v && typeof v.guideline === "string" && "flagged" in v;
}

/** target id → ids of the flags placed there, from every page JSON's `notes` (a Notes record, or a gap's FlagNote[]). */
const placements = new Map<string, Set<string>>();
function place(target: string, notes: readonly unknown[]): void {
  for (const n of notes) {
    if (!isFlagNote(n)) continue;
    const set = placements.get(target) ?? new Set<string>();
    set.add(n.id);
    placements.set(target, set);
  }
}
function collect(v: unknown): void {
  if (Array.isArray(v)) {
    for (const x of v) collect(x);
    return;
  }
  if (typeof v !== "object" || v === null) return;
  if ("notes" in v) {
    const notes = v.notes;
    if (Array.isArray(notes)) {
      if ("id" in v && typeof v.id === "string") place(v.id, notes);
    } else if (typeof notes === "object" && notes !== null) {
      for (const [target, list] of Object.entries(notes)) if (Array.isArray(list)) place(target, list);
    }
  }
  for (const x of Object.values(v)) collect(x);
}
function walk(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "files" && e.name !== "assets" && e.name !== "search") walk(p);
    } else if (e.name.endsWith(".json") && e.name !== "updates.json" && e.name !== "hosts.json") {
      collect(JSON.parse(readFileSync(p, "utf8")));
    }
  }
}
walk(DATA);

/** flag id → the targets it is placed at. */
const placedAt = new Map<string, string[]>();
for (const [target, ids] of placements) for (const id of ids) placedAt.set(id, [...(placedAt.get(id) ?? []), target]);

/** Expected date text, computed independently: "Oct 4, 2026" / "October 4, 2026", "Apr 2024" for a month. */
function date(iso: string, style: "short" | "long" = "short"): string {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(iso);
  if (!m) return iso;
  const month = style === "long" ? "long" : "short";
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : 1));
  const opts: Intl.DateTimeFormatOptions = m[3] ? { timeZone: "UTC", month, day: "numeric", year: "numeric" } : { timeZone: "UTC", month, year: "numeric" };
  return new Intl.DateTimeFormat("en-US", opts).format(at);
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();
const isCurrentRec = (f: PubFlag): boolean => f.kind === "rec" && f.supersededBy === null;

const pageRoot = (page: Page) => page.locator(".updates-page");
const entry = (page: Page, id: string): Locator => pageRoot(page).locator(".upd-entry").filter({ has: page.locator(`aside.upd[data-anchor="${id}"]`) });

/** The fixed sources' names (80 §80.5 table). */
const FIXED_NAMES: Record<string, string> = {
  uspstf: "USPSTF recommendations",
  cpr: "AHA CPR & ECC (ACLS) guidelines",
  hf: "ACC/AHA/HFSA heart failure guideline",
  ada: "ADA Standards of Care in Diabetes",
  gold: "GOLD report (COPD)",
  gina: "GINA report (asthma)",
};
const sourceRows: { id: string; name: string }[] = [
  ...Object.entries(FIXED_NAMES).map(([id, name]) => ({ id, name })),
  ...updates.series.map((s) => ({ id: s.id, name: s.label })),
];
const statusCell = (page: Page, name: string): Locator =>
  pageRoot(page).locator("table.ustat tr", { has: page.getByRole("cell", { name, exact: true }) }).locator("td").nth(1);

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`./${UPDATES_ROUTE}`);
});

test.describe("the list", () => {
  test("the intro gives the last and next check dates", async ({ page }) => {
    const last = updates.lastRun ? date(updates.lastRun, "long") : "not yet";
    const next = updates.nextRun ? ` · next: ${date(updates.nextRun, "long")}` : "";
    await expect(pageRoot(page).locator(".lead")).toHaveText(`Checked once a month against the tracked sources. Last check: ${last}${next}. Newest first.`);
  });

  test("every flag, superseded ones included, is listed newest first", async ({ page }) => {
    const order = [...updates.flags].sort((a, b) => (a.published === b.published ? b.flagged.localeCompare(a.flagged) : b.published.localeCompare(a.published)));
    expect(updates.flags.map((f) => f.id)).toEqual(order.map((f) => f.id));
    const asides = pageRoot(page).locator(".upd-entry > aside.upd");
    await expect(asides).toHaveCount(updates.flags.length);
    expect(await asides.evaluateAll((els) => els.map((e) => e.getAttribute("data-anchor")))).toEqual(updates.flags.map((f) => f.id));
  });

  test("recommendation flags are full notes; edition flags are 'New edition published' entries", async ({ page }) => {
    test.skip(updates.flags.length === 0, "the published content has no flags");
    for (const f of updates.flags) {
      const e = entry(page, f.id);
      const note = e.locator("aside.upd");
      if (f.kind === "rec") {
        await expect(note).toHaveAttribute("aria-label", "Updated guideline");
        await expect(note.locator(".upd-h .lab-chip")).toHaveText("Updated guideline");
        await expect(note.locator(".upd-h .ut")).toHaveText(collapse(f.guideline));
        const meta = `${collapse(f.org)} · Published ${date(f.published)}${f.flagged ? ` · Flagged ${date(f.flagged)}` : ""}${f.grade ? ` · Grade ${f.grade}` : ""}`;
        await expect(note.locator(":scope > .um")).toHaveText(meta);
        if (f.quote) await expect(note.locator("blockquote")).toHaveText(`“${collapse(f.quote)}”`);
        else await expect(note.locator("blockquote")).toHaveCount(0);
        const read = note.getByRole("link", { name: "Read the guideline" });
        if (/^https?:\/\//.test(f.url)) await expect(read).toHaveAttribute("href", f.url);
        else await expect(read).toHaveCount(0);
      } else {
        await expect(note).toHaveAttribute("aria-label", "New edition published");
        await expect(note.locator(".upd-h .ut")).toHaveText("New edition published");
        await expect(note.locator(":scope > .ut")).toHaveText(collapse(f.guideline));
        await expect(note.locator(":scope > .um")).toHaveText(`${collapse(f.org)} · Detected ${date(f.flagged)}`);
        await expect(note.locator("blockquote")).toHaveCount(0);
      }
      const added = e.locator(".added");
      if (f.addedTo.length === 0) {
        await expect(added).toHaveCount(0);
      } else {
        await expect(added).toContainText("Added to:");
        const links = added.locator("li a");
        await expect(links).toHaveText(f.addedTo.map((p) => p.loc));
        for (const [i, p] of f.addedTo.entries()) await expect(links.nth(i)).toHaveAttribute("href", p.route);
      }
    }
  });

  test("'Added to:' names exactly the locations of the flag's placed targets", () => {
    for (const f of updates.flags) {
      const expected: { route: string; loc: string }[] = [];
      for (const t of placedAt.get(f.id) ?? []) {
        const h = hosts[t];
        expect(h, `host of ${t}`).toBeDefined();
        if (h && !expected.some((p) => p.route === h.route && p.loc === h.loc)) expected.push({ route: h.route, loc: h.loc });
      }
      const key = (p: { route: string; loc: string }): string => `${p.route}\n${p.loc}`;
      expect(f.addedTo.map(key).sort(), f.id).toEqual(expected.map(key).sort());
    }
  });
});

test.describe("sources checked", () => {
  test("every tracked source has a row: the fixed sources in 80 §80.5 table order, then the cited series by label", async ({ page }) => {
    await expect(pageRoot(page).getByRole("heading", { name: "Sources checked", level: 2 })).toBeVisible();
    const labels = updates.series.map((s) => s.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
    await expect(pageRoot(page).locator("table.ustat tr td:first-child")).toHaveText(sourceRows.map((r) => r.name));
  });

  test("a checked source shows 'Checked <date>' marked as a check", async ({ page }) => {
    const ok = sourceRows.filter((r) => updates.sources.some((s) => s.id === r.id && s.status === "ok"));
    test.skip(ok.length === 0, "no source was checked successfully");
    for (const r of ok) {
      const s = updates.sources.find((x) => x.id === r.id);
      const cell = statusCell(page, r.name);
      await expect(cell).toHaveClass(/\bst-ok\b/);
      await expect(cell).toHaveText(`Checked ${date(s?.lastSuccess ?? "")}`);
    }
  });

  test("a source that failed says when it couldn't be checked and that it will be retried", async ({ page }) => {
    const failed = sourceRows.filter((r) => updates.sources.some((s) => s.id === r.id && s.status === "fail"));
    test.skip(failed.length === 0, "every source was checked successfully");
    for (const r of failed) {
      const s = updates.sources.find((x) => x.id === r.id);
      const on = date(updates.lastRun ?? s?.lastAttempt ?? "");
      const last = s?.lastSuccess ? ` Last successful check ${date(s.lastSuccess)}.` : "";
      const cell = statusCell(page, r.name);
      await expect(cell).toHaveClass(/\bst-fail\b/);
      await expect(cell).toHaveText(`Couldn't be checked on ${on}.${last} Will retry next month.`);
    }
  });

  test("a source with no check record says 'Not checked yet'", async ({ page }) => {
    const unchecked = sourceRows.filter((r) => !updates.sources.some((s) => s.id === r.id));
    test.skip(unchecked.length === 0, "every source has a check record");
    for (const r of unchecked) await expect(statusCell(page, r.name)).toHaveText("Not checked yet");
  });
});

test.describe("placement", () => {
  test("only current recommendation flags are placed; superseded and edition flags only in the list", () => {
    const byId = new Map(updates.flags.map((f) => [f.id, f]));
    for (const id of placedAt.keys()) {
      const f = byId.get(id);
      expect(f, `placed flag ${id} is listed`).toBeDefined();
      if (f) expect(isCurrentRec(f), `placed flag ${id} is a current rec`).toBe(true);
    }
  });

  test("superseded flags stay listed without 'Added to:'", async ({ page }) => {
    const superseded = updates.flags.filter((f) => f.supersededBy !== null);
    test.skip(superseded.length === 0, "the published content has no superseded flag");
    for (const f of superseded) {
      expect(placedAt.has(f.id), f.id).toBe(false);
      await expect(entry(page, f.id)).toBeVisible();
      await expect(entry(page, f.id).locator(".added")).toHaveCount(0);
    }
  });

  test("a recommendation placed nowhere appears only in the list", async ({ page }) => {
    const unplaced = updates.flags.filter((f) => isCurrentRec(f) && f.addedTo.length === 0);
    test.skip(unplaced.length === 0, "every current recommendation flag is placed");
    for (const f of unplaced) {
      expect(placedAt.has(f.id), f.id).toBe(false);
      await expect(entry(page, f.id)).toBeVisible();
      await expect(entry(page, f.id).locator(".added")).toHaveCount(0);
    }
  });

  // One test per route that hosts placed targets: every flag placed at a target there is shown on it.
  const byRoute = new Map<string, Set<string>>();
  for (const [target, ids] of placements) {
    const h = hosts[target];
    if (!h) continue;
    const set = byRoute.get(h.route) ?? new Set<string>();
    for (const id of ids) set.add(id);
    byRoute.set(h.route, set);
  }
  test("every placed target has a host route", () => {
    test.skip(placements.size === 0, "the published content places no flag");
    for (const target of placements.keys()) expect(hosts[target], target).toBeDefined();
  });
  for (const [route, ids] of byRoute) {
    test(`placed notes show beside their targets on ${route}`, async ({ page }) => {
      await page.goto(`./${route}`);
      for (const id of ids) await expect(page.locator(`main aside.upd[data-anchor="${id}"]`).first()).toBeVisible();
    });
  }

  for (const f of updates.flags.filter((x) => x.addedTo.length > 0)) {
    test(`'Added to:' links of ${f.id} open the target with the note`, async ({ page }) => {
      for (const [i, p] of f.addedTo.entries()) {
        if (i > 0) await page.goto(`./${UPDATES_ROUTE}`);
        await entry(page, f.id).locator(".added li a").nth(i).click();
        await expect.poll(() => new URL(page.url()).hash).toBe(p.route);
        await expect(page.locator(`main aside.upd[data-anchor="${f.id}"]`).first()).toBeVisible();
      }
    });
  }
});
