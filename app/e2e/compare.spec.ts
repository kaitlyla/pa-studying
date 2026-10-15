// The compare view (40 §40.3, guide-reader/compare) against the built site: the diagnoses of one guide —
// two per row on desktop, stacked on a phone — each quadrant scrolling on its own, its card drawn stacked,
// filled by the sidebar's +, each with its picker and its ✕, with no limit on how many she compares. Her
// favorite pairs (site/compare) and her named comparisons (public: a visitor sees the list, read-only) are
// saved to the site through the fake GitHub and read back on a fresh load. Routes and diagnoses are chosen
// from the published data, so the spec follows the content.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { commitMessage, comparisonsPath, favoritesPath, parseFile, type ComparisonsFile, type FavoritesFile, type GuideId } from "../../lib/content/index.ts";
import {
  BUILD_PATH, comparisonsPath as comparisonsDataPath, navPath, SITE_PATH, systemPath,
  type BuildJson, type ComparisonsJson, type NavEntry, type NavJson, type SiteJson, type SystemJson,
} from "../../lib/derive/published.ts";
import { guideViewHash } from "../../lib/derive/routes.ts";
import { FakeGithub, routeFakeGithub } from "./fake-github.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DATA = join(ROOT, "dist", "data");
const CONTENT = join(ROOT, "content");
const IMPORT_DATE = "2026-10-01T00:00:00Z";

function readWorkerOrigin(): string {
  const config: unknown = JSON.parse(readFileSync(join(ROOT, "app", "auth-config.json"), "utf8"));
  if (typeof config === "object" && config !== null && "workerOrigin" in config && typeof config.workerOrigin === "string") {
    return config.workerOrigin;
  }
  throw new Error("app/auth-config.json has no workerOrigin");
}

const WORKER_ORIGIN = readWorkerOrigin();

const readData = <T>(path: string): T => JSON.parse(readFileSync(join(DATA, path), "utf8")) as T;

const site = readData<SiteJson>(SITE_PATH);
const navs = [...site.eors.map((e) => ({ g: e.id, nav: readData<NavJson>(navPath(e.id)) })), { g: site.pance.id, nav: readData<NavJson>(navPath(site.pance.id)) }];

function need<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`the published content has no ${what}`);
  return v;
}

interface Diagnosis {
  id: string;
  title: string;
  system: string;
  /** The sidebar group its row belongs to: its section id, or the system's own list. */
  group: string;
  /** Rows and meds, so the spec can pick quadrants whose cards overflow their quadrant. */
  size: number;
}

const navOf = (g: string): NavJson => need(navs.find((x) => x.g === g), `the ${g} guide`).nav;

/** Every diagnosis of a guide's sidebar, in sidebar order, with the group its row sits in and its size. */
function topicsOf(g: string): Diagnosis[] {
  const nav = navOf(g);
  const sizes = new Map<string, Map<string, number>>();
  const sizeOf = (system: string, id: string): number => {
    let byId = sizes.get(system);
    if (!byId) {
      byId = new Map(readData<SystemJson>(systemPath(g, system)).topics.map((t) => [t.id, t.rows.length + t.meds.length]));
      sizes.set(system, byId);
    }
    return byId.get(id) ?? 0;
  };
  const out: Diagnosis[] = [];
  const add = (system: string, group: string, e: NavEntry): void => {
    if (e.kind === "topic") out.push({ id: e.id, title: e.title, system, group, size: sizeOf(system, e.id) });
  };
  for (const s of nav.systems) {
    for (const e of s.entries) add(s.id, s.id, e);
    for (const sec of s.sections) for (const e of sec.entries) add(s.id, sec.id, e);
  }
  return out;
}

/** The first guide (site order) whose sidebar lists six diagnoses, its diagnoses biggest first. */
function guideForCompare(): { g: GuideId; topics: Diagnosis[] } {
  for (const { g } of navs) {
    const topics = topicsOf(g);
    if (topics.length >= 6) return { g, topics: [...topics].sort((a, b) => b.size - a.size) };
  }
  throw new Error("no guide's sidebar lists six diagnoses to compare");
}

const pick = guideForCompare();
const A = need(pick.topics[0], "a first diagnosis");
const B = need(pick.topics[1], "a second diagnosis");
const C = need(pick.topics[2], "a third diagnosis");
const D = need(pick.topics[3], "a fourth diagnosis");
const E = need(pick.topics[4], "a fifth diagnosis");
const F = need(pick.topics[5], "a sixth diagnosis");
const idsOfFour = pick.topics.slice(0, 4).map((t) => t.id);
const idsOfSix = pick.topics.slice(0, 6).map((t) => t.id);
const compareHash = (...ids: string[]): string => guideViewHash(pick.g, { kind: "compare", ids });
/** Her example is FM's; the picked guide's hash helper is not hers. */
const fmCompareHash = (...ids: string[]): string => guideViewHash("fm", { kind: "compare", ids });
const side = (page: Page) => page.locator("aside.side");
const quadrants = (page: Page) => page.locator(".cmp-q");
const hashOf = (page: Page): string => new URL(page.url()).hash;

/** The first group holding at least three diagnoses: the sidebar's + needs a row beside the open one. */
const trio = ((): Diagnosis[] => {
  const groups = new Map<string, Diagnosis[]>();
  for (const t of pick.topics) groups.set(`${t.system}/${t.group}`, [...(groups.get(`${t.system}/${t.group}`) ?? []), t]);
  for (const [, v] of groups) if (v.length >= 3) return v;
  throw new Error(`${pick.g} has no sidebar group holding three diagnoses`);
})();
const P1 = need(trio[0], "the first diagnosis of a three-diagnosis group");
const P2 = need(trio[1], "the second diagnosis of a three-diagnosis group");

/** A diagnosis beside a quadrant's row: rendered with that quadrant's group open, so its + is in reach. */
const beside = need(
  pick.topics.find((t) => t.system === B.system && t.group === B.group && ![A, B, C, D, E, F].some((u) => u.id === t.id)),
  "a diagnosis in the second biggest diagnosis's group",
);

/** Her example: DM Type 1 beside Cushing's, the Addisonian crisis and adrenal insufficiency, all FM Endocrine. */
const herExample = ((): { four: Diagnosis[]; dm: Diagnosis } => {
  const diagnosisName = (t: Diagnosis): string => t.title.replace(/^\*/, "");
  const all = topicsOf("fm");
  const system = need(
    [...new Set(all.map((t) => t.system))].find((s) => all.some((t) => t.system === s && /^Cushing/.test(diagnosisName(t)))),
    "FM's system holding Cushing's syndrome",
  );
  const inSystem = all.filter((t) => t.system === system);
  const wanted = [/^DM Type 1\b/, /^Cushing/, /^Adrenal \(Addisonian\)/, /^Adrenal Insufficiency/];
  const four = wanted.map((re) => need(inSystem.find((t) => re.test(diagnosisName(t))), `FM Endocrine: ${re.source}`));
  return { four, dm: need(four[0], "the DM Type 1 diagnosis") };
})();

/** The sidebar's diagnosis entries of the picked guide, as the quadrant picker lists them. */
const guideTopics = (): NavEntry[] =>
  navOf(pick.g).systems.flatMap((s) => [...s.entries, ...s.sections.flatMap((x) => x.entries)].filter((e) => e.kind === "topic"));

interface Box {
  x: number;
  y: number;
  w: number;
}

const boxesOf = (page: Page): Promise<Box[]> =>
  quadrants(page).evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width };
    }),
  );

// ---- the fake GitHub, build.json and sign-in (the scaffolding app/e2e/edit.spec.ts uses for Git) ----

let seedCache: Record<string, Uint8Array> | null = null;

/** Every file under content/ except content/assets, keyed by its repository path. */
function contentFiles(): Record<string, Uint8Array> {
  if (seedCache) return seedCache;
  const out: Record<string, Uint8Array> = {};
  const assets = join(CONTENT, "assets");
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (p !== assets) walk(p);
      } else {
        out[`content/${relative(CONTENT, p).split(sep).join("/")}`] = readFileSync(p);
      }
    }
  };
  walk(CONTENT);
  seedCache = out;
  return out;
}

/**
 * GitHub Pages answers a missing data file (an unpublished document's docs/<d>.json) with 404;
 * `vite preview` would answer it with index.html.
 */
async function missingDataIs404(context: BrowserContext): Promise<void> {
  await context.route(
    (url) => {
      const rel = /\/data\/(.+)$/.exec(decodeURIComponent(url.pathname))?.[1];
      return rel !== undefined && rel !== BUILD_PATH && !existsSync(join(DATA, ...rel.split("/")));
    },
    (route) => route.fulfill({ status: 404, body: "" }),
  );
}

/** The site's Git as the fake holds it: main at the import commit of the checkout's content/ tree. */
async function world(context: BrowserContext, baseURL: string | undefined): Promise<FakeGithub> {
  if (!baseURL) throw new Error("the Playwright config sets no baseURL");
  const [owner, repo] = site.repo.split("/");
  const fake = new FakeGithub({
    owner,
    repo,
    workerOrigin: WORKER_ORIGIN,
    user: { login: site.owner.login, id: site.owner.id, avatar_url: `https://avatars.githubusercontent.com/u/${site.owner.id}` },
  });
  const seed = fake.commitFiles(contentFiles(), { message: commitMessage("Import her source files", { kind: "import" }), date: IMPORT_DATE });
  // Context routes: the sign-in popup's first navigation happens before its Page exists.
  await routeFakeGithub(context, fake, { workerOrigin: WORKER_ORIGIN, returnUrl: baseURL });
  await context.route((url) => url.pathname.endsWith(`/data/${BUILD_PATH}`), async (route) => {
    const body: BuildJson = { commit: seed, builtAt: IMPORT_DATE, siteBytes: 300_000_000, dropped: [], uncoveredGlyphs: [] };
    await route.fulfill({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  });
  await missingDataIs404(context);
  return fake;
}

/** Opens a hash route as a fresh document and waits for its page heading. */
async function open(page: Page, hash: string): Promise<void> {
  await page.goto("about:blank");
  await page.goto(`./${hash}`);
  await expect(page.locator("main h1").first()).toBeVisible();
}

/** Opens a route that must be a real page (not the not-found or error page). */
async function openPage(page: Page, hash: string): Promise<void> {
  await open(page, hash);
  await expect(page.locator("main h1").first()).not.toHaveText(/isn't on the site|couldn't load/);
}

async function signIn(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Owner sign-in" }).click();
  const dialog = page.getByRole("dialog", { name: "Sign in to edit" });
  const go = dialog.getByRole("button", { name: "Continue with GitHub" });
  await expect(go).toBeEnabled();
  const popup = page.waitForEvent("popup");
  await go.click();
  await popup;
  await expect(page.locator('[data-ref="signed-in-indicator"]')).toBeVisible();
  await expect(dialog).toBeHidden();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
});

test.describe("compare", () => {
  test("a diagnosis page opens the view, and the sidebar's + adds the diagnosis beside it", async ({ page }) => {
    await openPage(page, guideViewHash(pick.g, { kind: "topics", ids: [P1.id] }));
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await expect.poll(() => hashOf(page)).toBe(compareHash(P1.id));
    const q = quadrants(page);
    await expect(q).toHaveCount(1);
    await expect(q.first().locator(`[data-topic="${P1.id}"]`)).toBeVisible();
    // The picker offers this guide's diagnoses only, and a visitor sees no favorites.
    await expect(page.getByLabel("Diagnosis 1").locator("option")).toHaveCount(guideTopics().length);
    await expect(page.locator(".favm")).toHaveCount(0);

    // The sidebar's + adds the diagnosis beside the one on screen — no empty quadrant, no extra button.
    await side(page).getByRole("link", { name: `Add ${P2.title} to the comparison`, exact: true }).click();
    await expect.poll(() => hashOf(page)).toBe(compareHash(P1.id, P2.id));
    await expect(q).toHaveCount(2);
    await expect(q.nth(1)).toHaveAttribute("aria-label", `${P2.title} (quadrant 2)`);
    await expect(q.nth(1).locator(`[data-topic="${P2.id}"]`)).toBeVisible();
    await expect(page.locator(".cmp-body")).toHaveCount(2);
    // The diagnosis on screen is not offered again: its row keeps no +.
    await expect(side(page).getByRole("link", { name: `Add ${P2.title} to the comparison`, exact: true })).toHaveCount(0);
    const boxes = await boxesOf(page);
    expect(need(boxes[1], "the second quadrant").x).toBeGreaterThan(need(boxes[0], "the first quadrant").x);
    expect(Math.abs(need(boxes[1], "the second quadrant").y - need(boxes[0], "the first quadrant").y)).toBeLessThan(2);

    // Any diagnosis of the EOR can be chosen from a quadrant's picker, replacing just that quadrant.
    await page.getByLabel("Diagnosis 2").selectOption(C.id);
    await expect.poll(() => hashOf(page)).toBe(compareHash(P1.id, C.id));
    await expect(q.nth(1).locator(`[data-topic="${C.id}"]`)).toBeVisible();
    await expect(q.nth(0).locator(`[data-topic="${P1.id}"]`)).toBeVisible();

    // ✕ takes that one off and the rest stay; with one quadrant left there is no ✕.
    await page.getByRole("button", { name: "Remove quadrant 2" }).click();
    await expect.poll(() => hashOf(page)).toBe(compareHash(P1.id));
    await expect(q).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^Remove quadrant/ })).toHaveCount(0);
  });

  test("four quadrants form a 2 x 2 grid, each scrolling on its own, and stack on a phone", async ({ page }) => {
    await openPage(page, compareHash(...idsOfFour));
    const q = quadrants(page);
    await expect(q).toHaveCount(4);
    for (const id of idsOfFour) await expect(page.locator(`[data-topic="${id}"]`)).toBeVisible();
    const boxes = await boxesOf(page);
    const xs = [...new Set(boxes.map((b) => Math.round(b.x)))].sort((p, r) => p - r);
    const ys = [...new Set(boxes.map((b) => Math.round(b.y)))].sort((p, r) => p - r);
    expect(xs).toHaveLength(2);
    expect(ys).toHaveLength(2);
    for (const y of ys) expect(boxes.filter((b) => Math.round(b.y) === y)).toHaveLength(2);
    // No quadrant may spill past the window: each one fits its half of the page and scrolls inside it.
    const view = need(page.viewportSize(), "the viewport size");
    for (const b of boxes) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(view.width);
    }

    // Each quadrant is its own scroll box: scrolling one leaves the others where they are.
    const bodies = page.locator(".cmp-body");
    await expect(bodies).toHaveCount(4);
    const overflow = await bodies.evaluateAll((els) => els.map((e) => getComputedStyle(e).overflowY));
    expect(overflow).toEqual(["auto", "auto", "auto", "auto"]);
    const afterFirst = await bodies.evaluateAll((els) => {
      (els[0] as HTMLElement).scrollTop = (els[0] as HTMLElement).scrollHeight;
      return els.map((e) => e.scrollTop);
    });
    expect(need(afterFirst[0], "the first quadrant's scroll position")).toBeGreaterThan(0);
    expect(afterFirst.slice(1)).toEqual([0, 0, 0]);
    const afterSecond = await bodies.evaluateAll((els) => {
      (els[1] as HTMLElement).scrollTop = (els[1] as HTMLElement).scrollHeight;
      return els.map((e) => e.scrollTop);
    });
    expect(need(afterSecond[1], "the second quadrant's scroll position")).toBeGreaterThan(0);
    expect(need(afterSecond[0], "the first quadrant's scroll position")).toBeGreaterThan(0);
    expect(afterSecond.slice(2)).toEqual([0, 0]);

    // A phone stacks them, each full width, in order.
    await page.setViewportSize({ width: 420, height: 900 });
    await expect(page.locator(".site")).toHaveClass(/\bis-phone\b/);
    const stacked = await boxesOf(page);
    expect([...new Set(stacked.map((b) => Math.round(b.x)))]).toHaveLength(1);
    expect([...new Set(stacked.map((b) => Math.round(b.w)))]).toHaveLength(1);
    const tops = stacked.map((b) => b.y);
    expect([...tops].sort((p, r) => p - r)).toEqual(tops);
    expect(new Set(tops.map((y) => Math.round(y))).size).toBe(4);
  });

  test("six quadrants go two per row, the page scrolls, and each card is drawn stacked", async ({ page }) => {
    await openPage(page, compareHash(...idsOfSix));
    const q = quadrants(page);
    await expect(q).toHaveCount(6);
    for (const t of [A, B, C, D, E, F]) await expect(page.locator(`[data-topic="${t.id}"]`)).toBeVisible();

    // Two per row: three rows of two, and the page itself scrolls down to the later rows.
    const boxes = await boxesOf(page);
    const xs = [...new Set(boxes.map((b) => Math.round(b.x)))].sort((p, r) => p - r);
    const ys = [...new Set(boxes.map((b) => Math.round(b.y)))].sort((p, r) => p - r);
    expect(xs).toHaveLength(2);
    expect(ys).toHaveLength(3);
    for (const y of ys) expect(boxes.filter((b) => Math.round(b.y) === y)).toHaveLength(2);
    await expect.poll(() => page.locator("main").evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

    // Each quadrant keeps its own scroll box: scrolling the first leaves the other five where they are.
    const bodies = page.locator(".cmp-body");
    await expect(bodies).toHaveCount(6);
    expect(await bodies.evaluateAll((els) => els.map((e) => getComputedStyle(e).overflowY))).toEqual(["auto", "auto", "auto", "auto", "auto", "auto"]);
    const scrolled = await bodies.evaluateAll((els) => {
      (els[0] as HTMLElement).scrollTop = (els[0] as HTMLElement).scrollHeight;
      return els.map((e) => e.scrollTop);
    });
    expect(need(scrolled[0], "the first quadrant's scroll position")).toBeGreaterThan(0);
    expect(scrolled.slice(1)).toEqual([0, 0, 0, 0, 0]);

    // Every quadrant draws her card stacked — the phone's Stacked layout — while the diagnosis's own page
    // on a laptop keeps the table layout.
    for (let i = 0; i < 6; i++) await expect(q.nth(i).locator(".notes .stacked").first()).toBeVisible();
    await openPage(page, guideViewHash(pick.g, { kind: "topics", ids: [A.id] }));
    await expect(page.locator(".tcard .notes table.nt").first()).toBeVisible();
    await expect(page.locator(".tcard .stacked")).toHaveCount(0);
  });

  test("the owner's menu saves any diagnosis, stays open, and fills quadrants past four", async ({ page, context, baseURL }) => {
    const fake = await world(context, baseURL);
    await openPage(page, compareHash(A.id, B.id));
    await signIn(page);
    await expect(page.locator(".favm")).toHaveCount(2);

    const menu = page.getByRole("menu", { name: `Favorites for ${A.title}` });
    await quadrants(page).first().getByRole("button", { name: "Favorites" }).click();

    // The save list holds every diagnosis of the guide — E is not open — and the open one comes first.
    const names = await menu.getByRole("menuitem").allInnerTexts();
    const at = (text: string): number => names.indexOf(text);
    expect(at(`Save ${B.title} as a favorite`)).toBeGreaterThanOrEqual(0);
    expect(at(`Save ${E.title} as a favorite`)).toBeGreaterThan(at(`Save ${B.title} as a favorite`));
    await expect(menu.getByText("Open now", { exact: true })).toBeVisible();

    // Saving leaves the menu open: two favorites go in one after another.
    await menu.getByRole("menuitem", { name: `Save ${E.title} as a favorite` }).click();
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: `Save ${C.title} as a favorite` }).click();
    const path = favoritesPath(pick.g);
    const pairKey = (x: string, y: string): string => (x < y ? `${x},${y}` : `${y},${x}`);
    const savedPairs = (): string[] => {
      const saved = fake.readFile(path);
      return saved === undefined ? [] : parseFile<FavoritesFile>(path, saved).pairs.map(([x, y]) => pairKey(x, y)).sort();
    };
    await expect.poll(savedPairs).toEqual([pairKey(A.id, C.id), pairKey(A.id, E.id)].sort());
    expect(need(fake.commit(fake.head()), "the save commit").message).toContain("Pa-Studying-Kind: favorites");

    // A saved favorite fills the next quadrant; on screen, it is no longer offered, and the menu stays open.
    await menu.getByRole("menuitem", { name: `Compare with ${C.title}` }).click();
    await expect.poll(() => hashOf(page)).toBe(compareHash(A.id, B.id, C.id));
    await expect(quadrants(page)).toHaveCount(3);
    await expect(quadrants(page).nth(2).locator(`[data-topic="${C.id}"]`)).toBeVisible();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: `Compare with ${C.title}` })).toHaveCount(0);

    // The fourth quadrant from the menu.
    await expect(side(page).getByRole("link", { name: `Add ${beside.title} to the comparison`, exact: true })).toHaveCount(1);
    await menu.getByRole("menuitem", { name: `Save ${D.title} as a favorite` }).click();
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: `Compare with ${D.title}` }).click();
    await expect.poll(() => hashOf(page)).toBe(compareHash(A.id, B.id, C.id, D.id));
    await expect(quadrants(page)).toHaveCount(4);
    await expect.poll(savedPairs).toEqual([pairKey(A.id, C.id), pairKey(A.id, D.id), pairKey(A.id, E.id)].sort());

    // No cap: with four quadrants up the favorites left are still offered, and the sidebar's + beside the
    // quadrants' rows still adds one — the fifth from the menu, the sixth from the +.
    await expect(menu.getByRole("menuitem", { name: `Compare with ${E.title}` })).toBeEnabled();
    await menu.getByRole("menuitem", { name: `Compare with ${E.title}` }).click();
    await expect.poll(() => hashOf(page)).toBe(compareHash(A.id, B.id, C.id, D.id, E.id));
    await expect(quadrants(page)).toHaveCount(5);
    await expect(quadrants(page).nth(4).locator(`[data-topic="${E.id}"]`)).toBeVisible();
    await expect(menu).toBeVisible();
    await side(page).getByRole("link", { name: `Add ${beside.title} to the comparison`, exact: true }).click();
    await expect.poll(() => hashOf(page)).toBe(compareHash(A.id, B.id, C.id, D.id, E.id, beside.id));
    await expect(quadrants(page)).toHaveCount(6);
    await expect(quadrants(page).nth(5).locator(`[data-topic="${beside.id}"]`)).toBeVisible();
    // A diagnosis now on screen offers no + of its own again.
    await expect(side(page).getByRole("link", { name: `Add ${beside.title} to the comparison`, exact: true })).toHaveCount(0);
    // The save list still works with six quadrants up. The sidebar click closed the menu, the way any click
    // outside it does, so it is opened again first.
    await quadrants(page).first().getByRole("button", { name: "Favorites" }).click();
    await expect(menu.getByRole("menuitem", { name: `Save ${B.title} as a favorite` })).toBeEnabled();

    // The pair works both ways: on a fresh load, C's menu offers comparing with A.
    await openPage(page, compareHash(C.id, D.id));
    await quadrants(page).first().getByRole("button", { name: "Favorites" }).click();
    const menuC = page.getByRole("menu", { name: `Favorites for ${C.title}` });
    await menuC.getByRole("menuitem", { name: `Compare with ${A.title}` }).click();
    await expect.poll(() => hashOf(page)).toBe(compareHash(C.id, D.id, A.id));
    await expect(menuC).toBeVisible();
    await expect(quadrants(page)).toHaveCount(3);
    await expect(quadrants(page).nth(2).locator(`[data-topic="${A.id}"]`)).toBeVisible();
  });

  test("removing a quadrant keeps the others' cards, and one can be replaced from its picker", async ({ page }) => {
    await openPage(page, compareHash(...idsOfFour));
    const q = quadrants(page);
    await expect(q).toHaveCount(4);
    for (const t of [A, B, C, D]) await expect(page.locator(`[data-topic="${t.id}"]`)).toBeVisible();
    // The cards of the three that stay, as they stand before anything moves.
    const stay = [A, C, D];
    const before = await Promise.all([0, 2, 3].map((i) => q.nth(i).locator(".cmp-body").innerText()));

    await page.getByRole("button", { name: "Remove quadrant 2" }).click();
    await expect.poll(() => hashOf(page)).toBe(compareHash(A.id, C.id, D.id));
    await expect(q).toHaveCount(3);
    for (const [j, t] of stay.entries()) {
      await expect(q.nth(j).locator(`[data-topic="${t.id}"]`)).toBeVisible();
      expect(await q.nth(j).locator(".cmp-body").innerText()).toBe(before[j]);
    }

    // Replacing one from its picker leaves the other two as they were.
    await page.getByLabel("Diagnosis 2").selectOption(E.id);
    await expect.poll(() => hashOf(page)).toBe(compareHash(A.id, E.id, D.id));
    await expect(q.nth(1).locator(`[data-topic="${E.id}"]`)).toBeVisible();
    expect(await q.nth(0).locator(".cmp-body").innerText()).toBe(before[0]);
    expect(await q.nth(2).locator(".cmp-body").innerText()).toBe(before[2]);
  });

  test("her example: removing the DM quadrant keeps Cushing's, the Addisonian crisis and the rest", async ({ page }) => {
    const { four, dm } = herExample;
    await openPage(page, fmCompareHash(...four.map((t) => t.id)));
    const q = quadrants(page);
    await expect(q).toHaveCount(4);
    const stay = four.filter((t) => t.id !== dm.id);
    const before = await q.evaluateAll((els) => els.map((e) => (e.querySelector(".cmp-body") as HTMLElement).innerText));
    const at = need(four.map((t) => t.id).indexOf(dm.id), "DM's quadrant");

    await page.getByRole("button", { name: `Remove quadrant ${at + 1}` }).click();
    await expect.poll(() => hashOf(page)).toBe(fmCompareHash(...stay.map((t) => t.id)));
    await expect(q).toHaveCount(3);
    for (const [j, t] of stay.entries()) {
      const from = need(four.map((x) => x.id).indexOf(t.id), "its old quadrant");
      await expect(q.nth(j).locator(`[data-topic="${t.id}"]`)).toBeVisible();
      expect(await q.nth(j).locator(".cmp-body").innerText()).toBe(need(before[from], "the staying card's text"));
    }
  });

  test("she saves a comparison, leaves, and returns to it from the sidebar — and renames and deletes it", async ({ page, context, baseURL }) => {
    const fake = await world(context, baseURL);
    // Six quadrants: a saved comparison carries as many as she put on the view.
    await openPage(page, compareHash(...idsOfSix));
    await signIn(page);

    await page.getByRole("button", { name: "Save comparison" }).click();
    await page.getByLabel("Name").fill("Adrenal");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    const path = comparisonsPath(pick.g);
    const saved = (): ComparisonsFile["comparisons"] => {
      const text = fake.readFile(path);
      return text === undefined ? [] : parseFile<ComparisonsFile>(path, text).comparisons;
    };
    await expect.poll(saved).toEqual([{ name: "Adrenal", ids: idsOfSix }]);
    expect(need(fake.commit(fake.head()), "the save commit").message).toContain("Pa-Studying-Kind: comparisons");

    // The sidebar lists it under Comparisons, right under the guide's name, and clicking it restores those
    // quadrants — after leaving the comparison and coming back.
    await expect(side(page).getByText("Comparisons", { exact: true })).toBeVisible();
    const row = side(page).getByRole("link", { name: "Adrenal", exact: true });
    await expect(row).toHaveAttribute("href", compareHash(...idsOfSix));
    await openPage(page, guideViewHash(pick.g, { kind: "home" }));
    await side(page).getByRole("link", { name: "Adrenal", exact: true }).click();
    await expect.poll(() => hashOf(page)).toBe(compareHash(...idsOfSix));
    await expect(quadrants(page)).toHaveCount(6);

    // Rename it from the sidebar; the row follows, and a fresh load reads the new name from her file.
    await side(page).getByRole("button", { name: "Rename Adrenal" }).click();
    await side(page).getByLabel("New name for Adrenal").fill("Adrenal insufficiency");
    await side(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect(side(page).getByRole("link", { name: "Adrenal insufficiency", exact: true })).toBeVisible();
    await expect.poll(saved).toEqual([{ name: "Adrenal insufficiency", ids: idsOfSix }]);

    // Delete it: the row goes and, with nothing saved, the section stays up for her with the line that
    // says how to make one; her file keeps no comparisons.
    await side(page).getByRole("button", { name: "Delete Adrenal insufficiency" }).click();
    await expect(side(page).getByRole("link", { name: "Adrenal insufficiency", exact: true })).toHaveCount(0);
    await expect(side(page).getByText("Comparisons", { exact: true })).toBeVisible();
    await expect(side(page).getByText("None saved yet. Open Compare and press Save comparison.", { exact: true })).toBeVisible();
    await expect.poll(saved).toEqual([]);
  });

  test("a visitor sees the saved comparisons listed and can open one, with no owner controls", async ({ page, context }) => {
    // A guide with none: the build publishes an empty list, so the sidebar shows no Comparisons section.
    await openPage(page, compareHash(A.id));
    await expect(side(page).getByText("Comparisons", { exact: true })).toHaveCount(0);
    await expect(page.locator(".favm")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save comparison" })).toHaveCount(0);

    // What the build writes when she has saved comparisons: the list is published for visitors too.
    const body: ComparisonsJson = { guide: pick.g, comparisons: [{ name: "Adrenal", ids: idsOfSix }] };
    await context.route((url) => url.pathname.endsWith(`/data/${comparisonsDataPath(pick.g)}`), (route) => route.fulfill({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    await openPage(page, guideViewHash(pick.g, { kind: "home" }));
    await expect(side(page).getByText("Comparisons", { exact: true })).toBeVisible();
    const row = side(page).getByRole("link", { name: "Adrenal", exact: true });
    await expect(row).toHaveAttribute("href", compareHash(...idsOfSix));
    await expect(side(page).getByRole("button", { name: "Rename Adrenal" })).toHaveCount(0);
    await expect(side(page).getByRole("button", { name: "Delete Adrenal" })).toHaveCount(0);

    await row.click();
    await expect.poll(() => hashOf(page)).toBe(compareHash(...idsOfSix));
    await expect(quadrants(page)).toHaveCount(6);
    await expect(page.getByRole("button", { name: "Save comparison" })).toHaveCount(0);
    await expect(page.locator(".favm")).toHaveCount(0);
  });
});
