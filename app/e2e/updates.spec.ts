// The Updated guidelines list, source status and update-note placement (80 §80.4–§80.5).
// The spec builds its own content: the shared test fixture plus flags whose placement is fixed by
// the §80.4 rule. That content goes through the real build (tools/build), and its data/ is served
// to the page in place of dist/data. The expectations below are written out from the rule, not
// read back from the build, so a placement bug in the build or in the app fails here.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { writeContent } from "../../lib/content/fs.ts";
import type { ChecksFile, Flag, FlagsFile } from "../../lib/content/types.ts";
import { fileHash, guideViewHash, refHash, UPDATES_ROUTE } from "../../lib/derive/routes.ts";
import { build } from "../../tools/build/index.ts";
import { D, R, U, writeFixture } from "../../tools/build/test-fixture.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// The fixture's flags (tools/build/test-fixture.ts), all source "gold":
//   U1 rec, check, key k1, current: the "af" concept lists gold k1 (targets R101, G1, a deleted
//      row, and the removed document D6) → placed at R101 and G1.
//   U2 rec, agent, verification "fail", key k2 ("copd" concept) → never placed.
//   U3 edition → never placed.
//   U4 rec, key k4 ("af"), superseded by U1 → never placed.
//   U5 rec, agent, verification "pass", key k5: the "copd" concept (targets R201, D5) → placed at both.
// Added here:
//   U6 rec, check, current, key k6: no concept lists it → list only (updates/edges/nomatch).
//   U7 rec, check, current, source uspstf, key k1: "af" lists k1 under gold only → list only.
//   U8 rec, check, key k4 ("af"), retired → list only.
const extra: Flag[] = [
  { ...base(6), key: "k6", subject: "k6", published: "2026-09" },
  { ...base(7), source: "uspstf", key: "k1", subject: "k1", org: "USPSTF", url: "https://www.uspreventiveservicestaskforce.org/x", published: "2026-08" },
  { ...base(8), key: "k4", subject: "k4", published: "2022-02", retired: "2026-10-01" },
];
function base(n: number): Flag {
  return {
    id: U(n), kind: "rec", source: "gold", by: "check", key: `k${n}`, subject: `k${n}`, guideline: `Guideline ${n}`,
    org: "GOLD", published: "2024-04", quote: `Quote ${n}`, grade: null, url: "https://goldcopd.org/x", flagged: "2026-10-01", supersededBy: null,
  };
}

const checks: ChecksFile = {
  v: 1, lastRun: "2026-10-01", nextRun: "2026-11-01", seen: {}, seenUrl: {},
  sources: [
    { id: "uspstf", status: "ok", lastSuccess: "2026-10-01", lastAttempt: "2026-10-01" },
    { id: "gold", status: "fail", lastSuccess: "2026-09-01", lastAttempt: "2026-10-01" },
    { id: "hf", status: "fail", lastSuccess: null, lastAttempt: "2026-10-01" },
  ],
};

/** Every flag, newest first by `published`, ties by `flagged` descending (§80.5). */
const LIST_ORDER = [U(6), U(7), U(2), U(3), U(1), U(5), U(8), U(4)];
/** The placed flags and how many target locations each is added to (§80.4). */
const PLACED: Record<string, number> = { [U(1)]: 2, [U(5)]: 2 };
const LIST_ONLY = LIST_ORDER.filter((id) => !(id in PLACED));

/** Each page that holds a concept target, and exactly the flags whose notes it shows. */
const PAGES: { name: string; route: string; notes: string[] }[] = [
  { name: "the Cardiovascular system page (row R101)", route: guideViewHash("fm", { kind: "system", system: "cardiovascular" }), notes: [U(1)] },
  { name: "the Atrial fibrillation topic page (row R101)", route: guideViewHash("fm", { kind: "topics", ids: [R(101)] }), notes: [U(1)] },
  { name: "the Pulmonary system page (row R201)", route: guideViewHash("fm", { kind: "system", system: "pulmonary" }), notes: [U(5)] },
  { name: "the Labs general topic (gap G1)", route: guideViewHash("fm", { kind: "general", key: "labs" }), notes: [U(1)] },
  { name: "the Labs › CBC reference page (gap G1)", route: refHash("labs", "cbc"), notes: [U(1)] },
  { name: "the Thyroid notes document (D5)", route: fileHash(D(5), null), notes: [U(5)] },
  { name: "the removed Old handout document (D6)", route: fileHash(D(6), null), notes: [] },
];

let tmp = "";
let data = "";

test.beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pa-updates-e2e-"));
  await writeFixture(tmp);
  const flags = JSON.parse(await readFile(join(tmp, "content", "updates", "flags.json"), "utf8")) as FlagsFile;
  await writeContent(tmp, "content/updates/flags.json", { ...flags, flags: [...flags.flags, ...extra] });
  await writeContent(tmp, "content/updates/checks.json", checks);
  data = join(tmp, "out");
  await build({ root: tmp, out: data, fontsDir: join(ROOT, "app", "public", "fonts"), commit: "0".repeat(40), builtAt: "2026-10-04T00:00:00Z" });
});

test.afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

const TYPES: Record<string, string> = { ".json": "application/json", ".png": "image/png", ".pdf": "application/pdf" };

/** Serves the spec's build for every data request (the app reads `<base>data/<path>`). */
async function serveBuild(page: Page): Promise<void> {
  await page.route("**/pa-studying/data/**", async (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/pa-studying\/data\//, ""));
    try {
      const body = await readFile(join(data, ...rel.split("/")));
      await route.fulfill({ status: 200, body, contentType: TYPES[extname(rel)] ?? "application/octet-stream" });
    } catch {
      await route.fulfill({ status: 404, body: "" });
    }
  });
}

const pageRoot = (page: Page) => page.locator(".updates-page");
const entry = (page: Page, id: string): Locator => pageRoot(page).locator(".upd-entry").filter({ has: page.locator(`aside.upd[data-anchor="${id}"]`) });
const notesOn = (page: Page): Promise<string[]> =>
  page.locator("main aside.upd").evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("data-anchor") ?? ""))].sort());

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await serveBuild(page);
});

async function openList(page: Page): Promise<void> {
  await page.goto(`./${UPDATES_ROUTE}`);
  await expect(pageRoot(page)).toBeVisible();
}

test.describe("the list", () => {
  test("the intro gives the last and next check dates", async ({ page }) => {
    await openList(page);
    await expect(pageRoot(page).locator(".lead")).toHaveText(
      "Checked once a month against the tracked sources. Last check: October 1, 2026 · next: November 1, 2026. Newest first.",
    );
  });

  test("every flag, superseded and retired ones included, is listed newest first", async ({ page }) => {
    await openList(page);
    const asides = pageRoot(page).locator(".upd-entry > aside.upd");
    await expect(asides).toHaveCount(LIST_ORDER.length);
    expect(await asides.evaluateAll((els) => els.map((e) => e.getAttribute("data-anchor")))).toEqual(LIST_ORDER);
  });

  test("a recommendation flag is a full Updated guideline note", async ({ page }) => {
    await openList(page);
    const note = entry(page, U(1)).locator("aside.upd");
    await expect(note).toHaveAttribute("aria-label", "Updated guideline");
    await expect(note.locator(".upd-h .lab-chip")).toHaveText("Updated guideline");
    await expect(note.locator(".upd-h .ut")).toHaveText("Guideline 1");
    await expect(note.locator(":scope > .um")).toHaveText("GOLD · Published Apr 2024 · Flagged Oct 1, 2026");
    await expect(note.locator("blockquote")).toHaveText("“Quote 1”");
    await expect(note.getByRole("link", { name: "Read the guideline" })).toHaveAttribute("href", "https://goldcopd.org/x");
  });

  test("an edition flag is a 'New edition published' entry with no quote and no Added to", async ({ page }) => {
    await openList(page);
    const e = entry(page, U(3));
    const note = e.locator("aside.upd");
    await expect(note).toHaveAttribute("aria-label", "New edition published");
    await expect(note.locator(".upd-h .ut")).toHaveText("New edition published");
    await expect(note.locator(":scope > .ut")).toHaveText("Guideline 3");
    await expect(note.locator(":scope > .um")).toHaveText("GOLD · Detected Oct 2, 2026");
    await expect(note.locator("blockquote")).toHaveCount(0);
    await expect(e.locator(".added")).toHaveCount(0);
  });
});

test.describe("sources checked", () => {
  const rows: [string, string][] = [
    ["USPSTF recommendations", "Checked Oct 1, 2026"],
    ["AHA CPR & ECC (ACLS) guidelines", "Not checked yet"],
    ["ACC/AHA/HFSA heart failure guideline", "Couldn't be checked on Oct 1, 2026. Will retry next month."],
    ["ADA Standards of Care in Diabetes", "Not checked yet"],
    ["GOLD report (COPD)", "Couldn't be checked on Oct 1, 2026. Last successful check Sep 1, 2026. Will retry next month."],
    ["GINA report (asthma)", "Not checked yet"],
    ["ACC/AHA atrial fibrillation guideline", "Not checked yet"],
  ];

  test("one row per source: the fixed sources in table order, then the cited series, each with its status", async ({ page }) => {
    await openList(page);
    await expect(pageRoot(page).getByRole("heading", { name: "Sources checked", level: 2 })).toBeVisible();
    const trs = pageRoot(page).locator("table.ustat tr:has(td)");
    await expect(trs.locator("td:first-child")).toHaveText(rows.map(([name]) => name));
    await expect(trs.locator("td:nth-child(2)")).toHaveText(rows.map(([, status]) => status));
  });

  test("a checked source is marked ok and a failed one is marked failed", async ({ page }) => {
    await openList(page);
    const status = (name: string): Locator => pageRoot(page).locator("table.ustat tr", { has: page.getByRole("cell", { name, exact: true }) }).locator("td").nth(1);
    await expect(status("USPSTF recommendations")).toHaveClass(/\bst-ok\b/);
    await expect(status("GOLD report (COPD)")).toHaveClass(/\bst-fail\b/);
    await expect(status("ACC/AHA/HFSA heart failure guideline")).toHaveClass(/\bst-fail\b/);
  });
});

test.describe("placement", () => {
  for (const p of PAGES) {
    test(`${p.name} shows exactly the notes the subject map places there`, async ({ page }) => {
      await page.goto(`./${p.route}`);
      await expect(page.locator("main h1").first()).toBeVisible();
      await expect(page.locator("main .loading")).toHaveCount(0);
      for (const id of p.notes) await expect(page.locator(`main aside.upd[data-anchor="${id}"]`).first()).toBeVisible();
      expect(await notesOn(page)).toEqual([...p.notes].sort());
    });
  }

  test("flags placed nowhere (no concept, another source's key, agent-unverified, edition, superseded, retired) are listed without 'Added to:'", async ({ page }) => {
    await openList(page);
    for (const id of LIST_ONLY) {
      await expect(entry(page, id)).toBeVisible();
      await expect(entry(page, id).locator(".added")).toHaveCount(0);
    }
  });

  for (const [id, count] of Object.entries(PLACED)) {
    test(`'Added to:' of ${id} links every location it is placed at, and each opens a page showing the note`, async ({ page }) => {
      await openList(page);
      const links = entry(page, id).locator(".added li a");
      await expect(entry(page, id).locator(".added")).toContainText("Added to:");
      await expect(links).toHaveCount(count);
      const hrefs = await links.evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""));
      expect(new Set(hrefs).size).toBe(count);
      for (const [i, href] of hrefs.entries()) {
        if (i > 0) await openList(page);
        await entry(page, id).locator(".added li a").nth(i).click();
        await expect.poll(() => new URL(page.url()).hash).toBe(href);
        await expect(page.locator(`main aside.upd[data-anchor="${id}"]`).first()).toBeVisible();
      }
    });
  }
});
