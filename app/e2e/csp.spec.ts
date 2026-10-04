// Content Security Policy (10 §10.6 control 3) against the built site: the CSP meta of dist/index.html
// is exactly the planned policy with the Worker origin of app/auth-config.json (10 §10.7), and
// reading every kind of page, a PDF, a slide deck, search and the sign-in round trip through the fake
// raise no violation. Routes and documents are chosen from the published data, so the spec follows
// the content.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext, type Locator, type Page, type Route } from "@playwright/test";
import type { DocJson, NavEntry, NavJson, OtherJson, RefTabJson, SiteJson } from "../../lib/derive/published.ts";
import { fileHash, guideViewHash, otherHash, REF_TABS, refHash, UPDATES_ROUTE, type GuideView } from "../../lib/derive/routes.ts";
import { tokens, type SearchUnit } from "../../lib/search/index.ts";
import { FakeGithub, routeFakeGithub, type FakeRequest } from "./fake-github.ts";

interface CspViolation {
  violatedDirective: string;
  blockedURI: string;
}

declare global {
  interface Window {
    __cspViolations?: CspViolation[];
    __cspReport?: (v: CspViolation) => Promise<void>;
  }
}

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DATA = join(ROOT, "dist", "data");
const PLACEHOLDER = "__PA_WORKER_ORIGIN__";

function readWorkerOrigin(): string {
  const config: unknown = JSON.parse(readFileSync(join(ROOT, "app", "auth-config.json"), "utf8"));
  if (typeof config === "object" && config !== null && "workerOrigin" in config && typeof config.workerOrigin === "string") {
    return config.workerOrigin;
  }
  throw new Error("app/auth-config.json has no workerOrigin");
}

const WORKER_ORIGIN = readWorkerOrigin();
const EXPECTED_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: https://avatars.githubusercontent.com; font-src 'self'; " +
  `connect-src 'self' https://api.github.com ${WORKER_ORIGIN}; worker-src 'self' blob:; ` +
  "object-src 'none'; base-uri 'self'; form-action 'none'";

const readData = <T>(path: string): T => JSON.parse(readFileSync(join(DATA, path), "utf8")) as T;

const site = readData<SiteJson>("site.json");
const navs = [...site.eors.map((e) => e.id), site.pance.id].map((g) => ({ g, nav: readData<NavJson>(`g/${g}/nav.json`) }));
const docs = readdirSync(join(DATA, "docs"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => readData<DocJson>(`docs/${f}`));
const other = readData<OtherJson>("other.json");
const units = readData<SearchUnit[]>(join("search", "units-0.json"));

/** The first non-undefined result of `pick` over the guides, in site order. */
function inGuides(pick: (g: string, nav: NavJson) => string | undefined): string | null {
  for (const { g, nav } of navs) {
    const hit = pick(g, nav);
    if (hit !== undefined) return hit;
  }
  return null;
}

function systemEntries(nav: NavJson): NavEntry[] {
  return nav.systems.flatMap((s) => [...s.entries, ...s.sections.flatMap((sec) => sec.entries)]);
}

const view = (g: string, v: GuideView): string => guideViewHash(g, v);

// ---- recording violations ------------------------------------------------------------------------

/** Violations from every page of the context (popups included), reported through a binding. */
let reported: CspViolation[] = [];
/** Console errors that mention the CSP. */
let cspConsole: string[] = [];

async function recordViolations(context: BrowserContext): Promise<void> {
  reported = [];
  cspConsole = [];
  await context.exposeBinding("__cspReport", (_source, v: CspViolation) => {
    reported.push(v);
  });
  await context.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener(
      "securitypolicyviolation",
      (e) => {
        const v = { violatedDirective: e.violatedDirective, blockedURI: e.blockedURI };
        window.__cspViolations?.push(v);
        void window.__cspReport?.(v);
      },
      true,
    );
  });
  context.on("console", (msg) => {
    if (msg.type() === "error" && msg.text().includes("Content Security Policy")) cspConsole.push(msg.text());
  });
}

/** The page's own record; null (a failure) if the recorder was not installed in this document. */
async function expectNoViolations(page: Page, where: string): Promise<void> {
  expect(await page.evaluate(() => window.__cspViolations ?? null), where).toEqual([]);
}

test.beforeEach(async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await recordViolations(context);
});

test.afterEach(() => {
  expect(reported, "securitypolicyviolation events").toEqual([]);
  expect(cspConsole, "console errors about the Content Security Policy").toEqual([]);
});

/** Opens a hash route as a fresh document and waits for its page heading (not the not-found or error page). */
async function open(page: Page, hash: string, title?: string): Promise<void> {
  await page.goto("about:blank");
  await page.goto(`./${hash}`);
  const h1 = page.locator("main h1").first();
  await expect(h1).toBeVisible();
  await expect(h1).not.toHaveText(/isn't on the site|couldn't load/);
  if (title !== undefined) await expect(h1).toHaveText(title);
}

/** True once pdf.js has painted the canvas (its pages are drawn on an opaque background). */
async function painted(canvas: Locator): Promise<boolean> {
  return canvas.evaluate((c) => {
    if (!(c instanceof HTMLCanvasElement) || c.width === 0 || c.height === 0) return false;
    const ctx = c.getContext("2d");
    if (!ctx) return false;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return true;
    return false;
  });
}

// ---- the policy ----------------------------------------------------------------------------------

test("the built index.html carries the planned CSP with the Worker origin, and the recorder catches a violation", async ({ page }) => {
  const built = readFileSync(join(ROOT, "dist", "index.html"), "utf8");
  expect(built).not.toContain(PLACEHOLDER);
  expect(built).toContain(EXPECTED_CSP);

  await page.goto("./#/");
  const meta = page.locator('meta[http-equiv="Content-Security-Policy"]');
  await expect(meta).toHaveCount(1);
  expect(await meta.getAttribute("content")).toBe(EXPECTED_CSP);
  expect(await page.content()).not.toContain(PLACEHOLDER);
  await expect(page.locator("main h1").first()).toBeVisible();
  await expectNoViolations(page, "picker");

  // Canary: an image from an origin outside img-src is blocked and recorded, so an empty record means
  // no violation rather than a recorder that never fires. The request never leaves the browser.
  await page.evaluate(() => {
    const img = new Image();
    img.src = "https://example.invalid/csp-canary.png";
    document.body.append(img);
  });
  await expect.poll(() => page.evaluate(() => (window.__cspViolations ?? []).map((v) => v.violatedDirective))).toContain("img-src");
  await expect.poll(() => reported.map((v) => v.violatedDirective)).toContain("img-src");
  await expect.poll(() => cspConsole.length).toBeGreaterThan(0);
  reported = [];
  cspConsole = [];
});

// ---- every route kind ----------------------------------------------------------------------------

interface RouteCase {
  name: string;
  hash: string | null;
  title?: string;
  /** Content beyond the heading that must have rendered before violations are read. */
  ready?: (page: Page) => Promise<void>;
  /** Document routes: skipped when the published content has no document of the kind. */
  doc?: boolean;
}

function docCase(kind: DocJson["kind"], ready: (page: Page) => Promise<void>): RouteCase {
  const d = docs.find((x) => x.kind === kind);
  return { name: `a ${kind} document's file page`, hash: d ? fileHash(d.id, null) : null, title: d?.name, ready, doc: true };
}

const firstCanvasPainted = (scope: string) => async (page: Page): Promise<void> => {
  const canvas = page.locator(`${scope} canvas`).first();
  await expect(canvas).toBeVisible();
  await expect.poll(() => painted(canvas)).toBe(true);
};

const eor = site.eors[0]?.id;
const otherSection = other.sections[0];
const refWithSub = REF_TABS.map((tab) => ({ tab, ref: readData<RefTabJson>(`ref/${tab}.json`) })).find((r) => r.ref.subs.length > 0);

const routeCases: RouteCase[] = [
  { name: "the picker (#/)", hash: "#/" },
  { name: "the picker (#/eor)", hash: "#/eor" },
  { name: "an EOR guide home", hash: eor === undefined ? null : view(eor, { kind: "home" }) },
  { name: "the PANCE home", hash: view(site.pance.id, { kind: "home" }) },
  {
    name: "a system page",
    hash: inGuides((g, n) => {
      const s = n.systems[0];
      return s ? view(g, { kind: "system", system: s.id }) : undefined;
    }),
  },
  {
    name: "a section page",
    hash: inGuides((g, n) => {
      const s = n.systems.find((x) => x.sections.length > 0);
      const sec = s?.sections[0];
      return s && sec ? view(g, { kind: "section", system: s.id, section: sec.id }) : undefined;
    }),
  },
  {
    name: "a topic page",
    hash: inGuides((g, n) => {
      const e = systemEntries(n).find((x) => x.kind === "topic");
      return e ? view(g, { kind: "topics", ids: [e.id] }) : undefined;
    }),
  },
  {
    name: "a listed block page",
    hash: inGuides((g, n) => {
      const e = systemEntries(n).find((x) => x.kind === "block");
      return e ? view(g, { kind: "block", id: e.id }) : undefined;
    }),
  },
  {
    name: "a pharm page",
    hash: inGuides((g, n) => {
      const s = n.systems.find((x) => x.pharm !== null);
      return s ? view(g, { kind: "pharm", system: s.id, section: s.pharm?.sections[0]?.id ?? null, target: null }) : undefined;
    }),
  },
  {
    name: "a general topic page",
    hash: inGuides((g, n) => {
      const t = n.general[0];
      return t ? view(g, { kind: "general", key: t.key }) : undefined;
    }),
  },
  { name: "the initial workup page", hash: inGuides((g) => (existsSync(join(DATA, "g", g, "workup.json")) ? view(g, { kind: "workup", item: null }) : undefined)) },
  {
    name: "a review slides deck",
    hash: inGuides((g, n) => (n.slides ? view(g, { kind: "slides", n: 1 }) : undefined)),
    ready: async (page) => {
      await expect(page.locator(".slides-page .slide .sd-main")).toBeVisible();
    },
  },
  { name: "a reference tab", hash: refHash(REF_TABS[0]) },
  { name: "a reference sub-tab", hash: refWithSub ? refHash(refWithSub.tab, refWithSub.ref.subs[0]?.id ?? null) : null },
  { name: "the Other tab", hash: otherHash() },
  { name: "an Other section", hash: otherSection ? otherHash(otherSection.id) : null },
  { name: "the Updated guidelines list", hash: UPDATES_ROUTE },
  docCase("pdf", firstCanvasPainted(".pdfv .pdfpage")),
  docCase("slides", firstCanvasPainted(".slides-file .slide")),
  docCase("image", async (page) => {
    const img = page.locator(".imgv img");
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((i) => (i instanceof HTMLImageElement ? i.naturalWidth : 0))).toBeGreaterThan(0);
  }),
  docCase("word", async (page) => {
    await expect(page.locator(".wordpage")).toBeVisible();
  }),
];

test.describe("no violation on", () => {
  for (const c of routeCases) {
    test(c.name, async ({ page }) => {
      if (c.doc) test.skip(c.hash === null, `the published content has no document of this kind (${c.name})`);
      if (c.hash === null) throw new Error(`the published content has no ${c.name}`);
      await open(page, c.hash, c.title);
      await c.ready?.(page);
      await expectNoViolations(page, c.hash);
    });
  }
});

// ---- search --------------------------------------------------------------------------------------

const box = (page: Page) => page.getByRole("search").getByRole("textbox", { name: "Search all notes" });
const panel = (page: Page) => page.getByRole("region", { name: "Search results" });

test("searching, loading results and opening one raises no violation", async ({ page }) => {
  const q = units.flatMap((u) => tokens(u.text)).find((t) => /^\p{L}{5,}$/u.test(t));
  if (!q) throw new Error("the first search shard has no 5-letter word");
  await open(page, "#/eor");
  await box(page).click();
  await box(page).fill(q);
  const first = panel(page).locator(".srch-row").first();
  await expect(first).toBeVisible();
  await first.scrollIntoViewIfNeeded();
  await expect(first).not.toHaveClass(/pending/);
  await expectNoViolations(page, `search for ${q}`);
  await first.click();
  await expect(panel(page)).toBeHidden();
  await expect(page.locator("main mark.hit").first()).toBeVisible();
  await expectNoViolations(page, `opened result for ${q}`);
});

// ---- sign-in through the fake --------------------------------------------------------------------

/**
 * The popup's first navigation (the authorize page) happens before Playwright hands over the popup's
 * Page, so page routes cannot catch it; the popup's requests are routed on the context instead.
 */
async function routeFakeGithubForPopups(context: BrowserContext, fake: FakeGithub, returnUrl: string): Promise<void> {
  const forward = async (route: Route): Promise<void> => {
    const r = route.request();
    const req: FakeRequest = { method: r.method(), url: r.url(), headers: r.headers(), body: r.postData() };
    const res = await fake.handle(req);
    await route.fulfill({
      status: res.status,
      headers: res.headers,
      body: res.body === null ? undefined : typeof res.body === "string" ? Buffer.from(res.body, "utf8") : Buffer.from(res.body),
    });
  };
  await context.route("https://api.github.com/**", forward);
  await context.route(`${WORKER_ORIGIN}/**`, forward);
  // The popup closes itself after the exchange; its avatar (if it renders one first) never goes out.
  await context.route("https://avatars.githubusercontent.com/**", (route) => route.fulfill({ status: 204 }));
  await context.route("https://github.com/login/oauth/authorize**", async (route) => {
    const state = new URL(route.request().url()).searchParams.get("state") ?? "";
    await route.fulfill({ status: 302, headers: { location: `${returnUrl}?code=fake-code&state=${encodeURIComponent(state)}` } });
  });
}

test("signing in through the fake GitHub and Worker raises no violation", async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error("the Playwright config sets no baseURL");
  const [owner, repo] = site.repo.split("/");
  const fake = new FakeGithub({
    owner,
    repo,
    workerOrigin: WORKER_ORIGIN,
    user: { login: site.owner.login, id: site.owner.id, avatar_url: `https://avatars.githubusercontent.com/u/${site.owner.id}` },
  });
  await routeFakeGithub(page, fake, { workerOrigin: WORKER_ORIGIN, returnUrl: baseURL });
  await routeFakeGithubForPopups(context, fake, baseURL);

  await open(page, "#/eor");
  await page.getByRole("button", { name: "Owner sign-in" }).click();
  const dialog = page.getByRole("dialog", { name: "Sign in to edit" });
  const go = dialog.getByRole("button", { name: "Continue with GitHub" });
  await expect(go).toBeEnabled();
  const popupOpened = page.waitForEvent("popup");
  await go.click();
  const popup = await popupOpened;

  const signedIn = page.locator('[data-ref="signed-in-indicator"]');
  await expect(signedIn).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect.poll(() => popup.isClosed()).toBe(true);
  expect(fake.tokenRequests.map((t) => t.code)).toEqual(["fake-code"]);
  const avatar = signedIn.locator("img.avatar");
  await expect(avatar).toBeVisible();
  await expect.poll(() => avatar.evaluate((i) => (i instanceof HTMLImageElement ? i.naturalWidth : 0))).toBeGreaterThan(0);
  await expectNoViolations(page, "after sign-in");
});
