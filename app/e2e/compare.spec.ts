// The compare view (40 §40.3, guide-reader/compare) against the built site: up to four diagnoses of one
// guide — 2 x 2 on desktop, stacked on a phone — each quadrant scrolling on its own, and her favorite
// pairs (site/compare) saved to the site through the fake GitHub and read back on a fresh load. Routes
// and diagnoses are chosen from the published data, so the spec follows the content.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { commitMessage, favoritesPath, parseFile, type FavoritesFile } from "../../lib/content/index.ts";
import {
  BUILD_PATH, navPath, SITE_PATH, systemPath,
  type BuildJson, type NavEntry, type NavJson, type SiteJson, type SystemJson,
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
const navs = [...site.eors.map((e) => e.id), site.pance.id].map((g) => ({ g, nav: readData<NavJson>(navPath(g)) }));

function need<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`the published content has no ${what}`);
  return v;
}

interface Diagnosis {
  id: string;
  title: string;
  system: string;
  /** Rows and meds, so the spec can pick quadrants whose cards overflow their quadrant. */
  size: number;
}

/** The first guide (site order) whose sidebar lists four diagnoses, its diagnoses biggest first. */
function guideForCompare(): { g: string; topics: Diagnosis[] } {
  for (const { g, nav } of navs) {
    const topics = nav.systems.flatMap((s) =>
      [...s.entries, ...s.sections.flatMap((x) => x.entries)]
        .filter((e) => e.kind === "topic")
        .map((e) => ({ id: e.id, title: e.title, system: s.id })),
    );
    if (topics.length < 4) continue;
    const sized = topics.map((t) => {
      const topic = readData<SystemJson>(systemPath(g, t.system)).topics.find((x) => x.id === t.id);
      return { ...t, size: (topic?.rows.length ?? 0) + (topic?.meds.length ?? 0) };
    });
    return { g, topics: [...sized].sort((a, b) => b.size - a.size) };
  }
  throw new Error("no guide's sidebar lists four diagnoses to compare");
}

const pick = guideForCompare();
const A = need(pick.topics[0], "a first diagnosis");
const B = need(pick.topics[1], "a second diagnosis");
const idsOfFour = pick.topics.slice(0, 4).map((t) => t.id);
const compareHash = (...ids: string[]): string => guideViewHash(pick.g, { kind: "compare", ids });

/** The sidebar's diagnosis entries of the picked guide, as the quadrant picker lists them. */
const guideTopics = (): NavEntry[] =>
  need(navs.find((x) => x.g === pick.g), `the ${pick.g} guide`).nav.systems.flatMap((s) =>
    [...s.entries, ...s.sections.flatMap((x) => x.entries)].filter((e) => e.kind === "topic"),
  );

const hashOf = (page: Page): string => new URL(page.url()).hash;
const quadrants = (page: Page) => page.locator(".cmp-q");

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
  test("a diagnosis page opens the view, and the picker adds the next diagnosis beside it", async ({ page }) => {
    await openPage(page, guideViewHash(pick.g, { kind: "topics", ids: [A.id] }));
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await expect.poll(() => hashOf(page)).toBe(compareHash(A.id));
    const q = quadrants(page);
    await expect(q).toHaveCount(1);
    await expect(q.first().locator(`[data-topic="${A.id}"]`)).toBeVisible();
    // The picker offers this guide's diagnoses only (plus the placeholder), and a visitor sees no favorites.
    const options = page.getByLabel("Diagnosis 1").locator("option");
    await expect(options).toHaveCount(guideTopics().length + 1);
    await expect(page.locator(".favm")).toHaveCount(0);

    await page.getByRole("button", { name: "Add quadrant" }).click();
    await expect.poll(() => hashOf(page)).toBe(compareHash(A.id, ""));
    await expect(q).toHaveCount(2);
    await expect(q.nth(1)).toHaveAttribute("aria-label", "Quadrant 2");
    await expect(page.locator(".cmp-body")).toHaveCount(1);

    await page.getByLabel("Diagnosis 2").selectOption(B.id);
    await expect.poll(() => hashOf(page)).toBe(compareHash(A.id, B.id));
    await expect(q.nth(1).locator(`[data-topic="${B.id}"]`)).toBeVisible();
    await expect(page.locator(".cmp-body")).toHaveCount(2);
    const side = await boxesOf(page);
    expect(need(side[1], "the second quadrant").x).toBeGreaterThan(need(side[0], "the first quadrant").x);
    expect(Math.abs(need(side[1], "the second quadrant").y - need(side[0], "the first quadrant").y)).toBeLessThan(2);

    await page.getByRole("button", { name: "Remove quadrant 2" }).click();
    await expect.poll(() => hashOf(page)).toBe(compareHash(A.id));
    await expect(q).toHaveCount(1);
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

  test("the owner saves a favorite pair, and a fresh load offers it both ways", async ({ page, context, baseURL }) => {
    const fake = await world(context, baseURL);
    const hash = compareHash(A.id, B.id);
    await openPage(page, hash);
    await signIn(page);
    await expect(page.locator(".favm")).toHaveCount(2);

    await quadrants(page).first().getByRole("button", { name: "Favorites" }).click();
    await page.getByRole("menuitem", { name: `Save ${B.title} as a favorite` }).click();
    const path = favoritesPath(pick.g);
    await expect.poll(() => fake.readFile(path) ?? null).not.toBeNull();
    const pair = A.id < B.id ? [A.id, B.id] : [B.id, A.id];
    expect(parseFile<FavoritesFile>(path, need(fake.readFile(path), "the saved favorites file"))).toEqual({ v: 1, pairs: [pair] });
    expect(need(fake.commit(fake.head()), "the save commit").message).toContain("Pa-Studying-Kind: favorites");

    // A fresh load reads the pair back from the site, and it works both ways: B offers comparing with A.
    await openPage(page, hash);
    await expect(page.locator(".favm")).toHaveCount(2);
    await quadrants(page).nth(1).getByRole("button", { name: "Favorites" }).click();
    await page.getByRole("menuitem", { name: `Compare with ${A.title}` }).click();
    await expect.poll(() => hashOf(page)).toBe(compareHash(A.id, B.id, A.id));
    await expect(quadrants(page)).toHaveCount(3);
    await expect(quadrants(page).nth(2).locator(`[data-topic="${A.id}"]`)).toBeVisible();
  });
});
