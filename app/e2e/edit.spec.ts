// Editing, Versions and Documents against the built site (99 §edit.spec), signed in through the fake
// GitHub and Worker. Tests that read or write Git seed the fake with the repository's content/ tree
// (assets excluded) as one import commit, which becomes every page's Original. Routes and targets are
// chosen from the published data and content/, so the spec follows the content; a target the content
// does not have fails with "the published content has no …" rather than skipping.
import { createHash } from "node:crypto";
import { closeSync, existsSync, ftruncateSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { buildPageKey } from "../edit/pageKey.ts";
import { CELL_MARGIN_STEP_PT, COLUMN_STEP_PT, moveColumnBorder } from "../edit/editor/commands.ts";
import { MIN_FIRST_COLUMN_PCT, tableColumns } from "../render/styles.ts";
import type { TableAttrs } from "../../lib/schemaTypes.ts";
import { commitMessage, inboxItemDir, partName, serializeFile } from "../../lib/content/index.ts";
import {
  BUILD_PATH, docPath, generalPath, navPath, OTHER_PATH, refPath, SITE_PATH, slidesPath, systemPath, workupPath,
  type BuildJson, type DocJson, type DocRef, type GeneralJson, type NavEntry, type NavJson, type OtherJson, type RefTabJson,
  type SiteJson, type SlidesJson, type SystemJson, type WorkupJson,
} from "../../lib/derive/published.ts";
import { fileHash, guideViewHash, otherHash, PANCE, REF_TABS, refHash, versionsHash } from "../../lib/derive/routes.ts";
import { FakeGithub, routeFakeGithub, type FakeRequest } from "./fake-github.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DATA = join(ROOT, "dist", "data");
const CONTENT = join(ROOT, "content");
const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const MiB = 1024 * 1024;

function readWorkerOrigin(): string {
  const config: unknown = JSON.parse(readFileSync(join(ROOT, "app", "auth-config.json"), "utf8"));
  if (typeof config === "object" && config !== null && "workerOrigin" in config && typeof config.workerOrigin === "string") {
    return config.workerOrigin;
  }
  throw new Error("app/auth-config.json has no workerOrigin");
}

const WORKER_ORIGIN = readWorkerOrigin();

const readData = <T>(path: string): T => JSON.parse(readFileSync(join(DATA, path), "utf8")) as T;
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

const site = readData<SiteJson>(SITE_PATH);
const navs = [...site.eors.map((e) => e.id), site.pance.id].map((g) => ({ g, nav: readData<NavJson>(navPath(g)) }));
const docs = readdirSync(join(DATA, "docs"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => readData<DocJson>(docPath(f.slice(0, -".json".length))));
const other = readData<OtherJson>(OTHER_PATH);

function need<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`the published content has no ${what}`);
  return v;
}

/** The first non-undefined result of `pick` over the guides, in site order. */
function inGuides<T>(pick: (g: string, nav: NavJson) => T | undefined): T | null {
  for (const { g, nav } of navs) {
    const hit = pick(g, nav);
    if (hit !== undefined) return hit;
  }
  return null;
}

function systemEntries(nav: NavJson): (NavEntry & { system: string })[] {
  return nav.systems.flatMap((s) => [...s.entries, ...s.sections.flatMap((sec) => sec.entries)].map((e) => ({ ...e, system: s.id })));
}

// ---- JSON walking ---------------------------------------------------------------------------------

type Path = (string | number)[];
type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** The path of the first node (depth first, document order) that satisfies `pred`. */
function findPath(v: unknown, pred: (n: Rec) => boolean, path: Path = []): Path | null {
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const hit = findPath(v[i], pred, [...path, i]);
      if (hit) return hit;
    }
    return null;
  }
  if (!isRec(v)) return null;
  if (pred(v)) return path;
  for (const [k, x] of Object.entries(v)) {
    const hit = findPath(x, pred, [...path, k]);
    if (hit) return hit;
  }
  return null;
}

function nodeAt(v: unknown, path: Path): Rec {
  let cur: unknown = v;
  for (const k of path) cur = Array.isArray(cur) ? cur[k as number] : isRec(cur) ? cur[k as string] : undefined;
  if (!isRec(cur)) throw new Error(`no node at ${path.join("/")}`);
  return cur;
}

function textOf(n: unknown): string {
  if (!isRec(n)) return "";
  if (typeof n.text === "string") return n.text;
  return Array.isArray(n.content) ? n.content.map(textOf).join("") : "";
}

const attrsOf = (n: Rec): Rec => (isRec(n.attrs) ? n.attrs : {});
const numAttr = (n: Rec, k: string): number => {
  const v = attrsOf(n)[k];
  return typeof v === "number" ? v : 0;
};
const sizeMark = (textNode: Rec): number | null => {
  const marks = Array.isArray(textNode.marks) ? textNode.marks : [];
  const m = marks.find((x): x is Rec => isRec(x) && x.type === "size");
  return m && typeof attrsOf(m).pt === "number" ? (attrsOf(m).pt as number) : null;
};
const firstText = (n: Rec): Rec => nodeAt(n, need(findPath(n, (x) => x.type === "text"), "text node in the paragraph"));
const roundHalf = (x: number): number => Math.round(x * 2) / 2;

// ---- content on disk ------------------------------------------------------------------------------

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

const repoPath = (abs: string): string => `content/${relative(CONTENT, abs).split(sep).join("/")}`;

interface TopicTarget {
  g: string;
  id: string;
  title: string;
  hash: string;
  key: string;
  /** The topic's system page. */
  systemHash: string;
  /** Repository path of the table block that holds the topic's first row. */
  blockPath: string;
}

/** The first published topic whose first row is in a block file on disk and that `fits`. */
const findTopic = (fits: (g: string, system: string, id: string) => boolean = () => true): TopicTarget | null => inGuides((g, nav) => {
  for (const e of systemEntries(nav)) {
    if (e.kind !== "topic" || !fits(g, e.system, e.id)) continue;
    const dir = join(CONTENT, "guides", g, e.system, "blocks");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const json = readJson(join(dir, f));
      if (findPath(json, (n) => n.type === "table_row" && attrsOf(n).id === e.id)) {
        return { g, id: e.id, title: e.title, hash: guideViewHash(g, { kind: "topics", ids: [e.id] }), key: buildPageKey("topic", g, e.id), systemHash: guideViewHash(g, { kind: "system", system: e.system }), blockPath: repoPath(join(dir, f)) };
      }
    }
  }
  return undefined;
});

/** A published topic whose first row is in a block file on disk. */
const topic = findTopic();
/** Such a topic with a meds panel. */
const medsTopic = findTopic((g, system, id) => (readData<SystemJson>(systemPath(g, system)).topics.find((t) => t.id === id)?.meds.length ?? 0) > 0);

interface PictureTarget {
  g: string;
  system: string;
  hash: string;
  blockPath: string;
  asset: string;
  widthPt: number;
  heightPt: number;
  /** The width the picture may grow to: its table cell's grid width, else the guide's page content width. */
  limit: number;
}

/**
 * A picture on a system page (non-drug block) whose asset appears once in that system, either in a
 * table cell of a table with no merged rows (`cell`) or outside any table and text box (`page`).
 */
function findPicture(where: "cell" | "page"): PictureTarget | null {
  const guidesDir = join(CONTENT, "guides");
  for (const g of readdirSync(guidesDir)) {
    const guideFile = join(guidesDir, g, "guide.json");
    if (!existsSync(guideFile)) continue;
    const guide = readJson(guideFile);
    if (!isRec(guide) || !isRec(guide.page)) continue;
    const page = guide.page;
    const margins = isRec(page.margins) ? page.margins : {};
    const pageContent = Number(page.widthPt) - Number(margins.left) - Number(margins.right);
    for (const system of readdirSync(join(guidesDir, g))) {
      if (system === "_preamble") continue;
      const sysDir = join(guidesDir, g, system);
      const structure = join(sysDir, "structure.json");
      const blocksDir = join(sysDir, "blocks");
      if (!existsSync(structure) || !existsSync(blocksDir)) continue;
      const st = readJson(structure);
      const drug = new Set(isRec(st) && Array.isArray(st.drugTables) ? st.drugTables.map((d) => (isRec(d) ? d.block : null)) : []);
      const seen = new Map<string, number>();
      const found: Omit<PictureTarget, "g" | "system" | "hash">[] = [];
      for (const f of readdirSync(blocksDir)) {
        const block = readJson(join(blocksDir, f));
        if (!isRec(block) || drug.has(block.id)) continue;
        const visit = (n: unknown, limit: number | null, inBox: boolean): void => {
          if (!isRec(n)) return;
          if (n.type === "image" || n.type === "image_block") {
            const a = attrsOf(n);
            const asset = String(a.asset);
            seen.set(asset, (seen.get(asset) ?? 0) + 1);
            const ok = where === "cell" ? limit !== null : limit === null && !inBox;
            if (ok) {
              found.push({ blockPath: repoPath(join(blocksDir, f)), asset, widthPt: Number(a.widthPt), heightPt: Number(a.heightPt), limit: limit ?? pageContent });
            }
            return;
          }
          if (n.type === "table") {
            const grid = Array.isArray(attrsOf(n).grid) ? (attrsOf(n).grid as number[]) : [];
            const rows = Array.isArray(n.content) ? n.content.filter(isRec) : [];
            const merged = rows.some((r) => (Array.isArray(r.content) ? r.content : []).some((c) => isRec(c) && numAttr(c, "rowspan") > 1));
            for (const r of rows) {
              let col = 0;
              for (const c of Array.isArray(r.content) ? r.content.filter(isRec) : []) {
                const span = Math.max(1, numAttr(c, "colspan"));
                const w = grid.slice(col, col + span).reduce((s, x) => s + x, 0);
                // A merged-row table's columns can't be read off one row: its pictures are skipped (never a case).
                for (const x of Array.isArray(c.content) ? c.content : []) visit(x, merged ? Number.NaN : w, inBox);
                col += span;
              }
            }
            return;
          }
          const box = inBox || n.type === "textbox" || n.type === "drawing";
          for (const x of Array.isArray(n.content) ? n.content : []) visit(x, limit, box);
        };
        visit(block.doc, null, false);
      }
      const pick = found.find((p) => seen.get(p.asset) === 1 && !Number.isNaN(p.limit) && p.limit > 30 && p.widthPt > 30);
      if (pick) return { ...pick, g, system, hash: guideViewHash(g, { kind: "system", system }) };
    }
  }
  return null;
}

// ---- the fake GitHub, build.json and sign-in ---------------------------------------------------------

const IMPORT_DATE = "2026-10-01T00:00:00Z";
const OTHER_DEVICE = "0000000000";

interface World {
  fake: FakeGithub;
  /** The import commit (every page's Original); the fake's first commit when not seeded. */
  seed: string;
  /** What the routed build.json reports; tests change it between loads. */
  build: { commit: string; siteBytes: number };
  /** build.json fetches so far. */
  buildFetches: () => number;
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

async function world(context: BrowserContext, baseURL: string | undefined, opts: { seed?: boolean; login?: string; siteBytes?: number } = {}): Promise<World> {
  if (!baseURL) throw new Error("the Playwright config sets no baseURL");
  const [owner, repo] = site.repo.split("/");
  const id = opts.login === undefined ? site.owner.id : site.owner.id + 1;
  const fake = new FakeGithub({
    owner,
    repo,
    workerOrigin: WORKER_ORIGIN,
    user: { login: opts.login ?? site.owner.login, id, avatar_url: `https://avatars.githubusercontent.com/u/${id}` },
  });
  const seed = opts.seed
    ? fake.commitFiles(contentFiles(), { message: commitMessage("Import her source files", { kind: "import" }), date: IMPORT_DATE })
    : fake.head();
  const build = { commit: seed, siteBytes: opts.siteBytes ?? 300_000_000 };
  let fetches = 0;
  // Context routes: the sign-in popup's first navigation happens before its Page exists.
  await routeFakeGithub(context, fake, { workerOrigin: WORKER_ORIGIN, returnUrl: baseURL });
  await context.route((url) => url.pathname.endsWith(`/data/${BUILD_PATH}`), async (route) => {
    fetches += 1;
    const body: BuildJson = { commit: build.commit, builtAt: IMPORT_DATE, siteBytes: build.siteBytes, dropped: [], uncoveredGlyphs: [] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await missingDataIs404(context);
  return { fake, seed, build, buildFetches: () => fetches };
}

const ref = (scope: Page | Locator, name: string): Locator => scope.locator(`[data-ref="${name}"]`);
const toast = (page: Page): Locator => page.locator(".toast-region .toast");
const NOT_ON_SITE = "This page isn't on the site";

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
  await expect(ref(page, "signed-in-indicator")).toBeVisible();
  await expect(dialog).toBeHidden();
}

/** What versionTime shows for `iso` in the page's (UTC) zone, computed in the browser. */
const shownTime = (page: Page, iso: string): Promise<string> =>
  page.evaluate((t) => new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }), iso);

let markerCount = 0;
/** A word no page contains: letters only, so nothing reformats it. */
function newMarker(): string {
  markerCount += 1;
  const letters = (n: number): string => String.fromCharCode(...[...n.toString(26)].map((c) => 97 + parseInt(c, 26)));
  return `Zqx${letters(Date.now() % 1e9)}${letters(markerCount)}`;
}

async function startEditing(page: Page): Promise<Locator> {
  await ref(page, "edit-page").click();
  const area = ref(page, "edit-area");
  await expect(area.locator(".edit-slot").first()).toBeVisible();
  await expect(ref(page, "edit-dirty-state")).toHaveText("No changes yet");
  return area;
}

/**
 * Types `marker` at the start of the first paragraph in the second cell of the topic's first row
 * (not the name cell, which would rename the topic).
 */
async function typeMarker(page: Page, marker: string): Promise<void> {
  const slot = ref(page, "edit-area").locator(".edit-slot").first();
  const p = slot.locator("table.nt > tbody > tr:not(.hrow)").first().locator(":scope > td").nth(1).locator("p").first();
  await p.click({ position: { x: 1, y: 2 } });
  await page.keyboard.press("Home");
  await page.keyboard.type(marker);
  await expect(ref(page, "edit-dirty-state")).toHaveText("Unsaved changes");
  await expect(slot).toContainText(marker);
}

async function clickN(target: Locator, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await target.click();
}

/** The files the commit `sha` changed (against its first parent), with their text at `sha`. */
function changedFiles(fake: FakeGithub, sha = fake.head()): Map<string, string> {
  const c = need(fake.commit(sha), `commit ${sha}`);
  const before = c.parents[0] === undefined ? new Map<string, string>() : fake.listFiles(c.parents[0]);
  const out = new Map<string, string>();
  for (const [path, blob] of fake.listFiles(sha)) {
    if (before.get(path) !== blob) out.set(path, fake.readFile(path, sha) ?? "");
  }
  return out;
}

/** The saved file holding a paragraph with `marker`, the paragraph's path, and the file before and after. */
function savedParagraph(fake: FakeGithub, marker: string): { path: Path; after: unknown; before: unknown } {
  const head = fake.head();
  for (const [file, text] of changedFiles(fake, head)) {
    if (!file.endsWith(".json") || !text.includes(marker)) continue;
    const after: unknown = JSON.parse(text);
    const path = findPath(after, (n) => n.type === "paragraph" && textOf(n).includes(marker));
    if (!path) continue;
    const parent = need(fake.commit(head), "head commit").parents[0] ?? "";
    return { path, after, before: JSON.parse(need(fake.readFile(file, parent), `${file} before the save`)) };
  }
  throw new Error(`the save holds no paragraph with ${marker}`);
}

const blobPosts = (fake: FakeGithub, contentPrefix: string): FakeRequest[] =>
  fake.requests.filter((r) => r.method === "POST" && r.url.endsWith("/git/blobs") && (r.body ?? "").includes(`"content":"${contentPrefix}`));

test.use({ timezoneId: "UTC", permissions: ["clipboard-read", "clipboard-write"] });

test.beforeEach(async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1280, height: 900 });
});

const needTopic = (): TopicTarget => need(topic, "topic whose first row is in a block file under content/");

// ---- 1. owner check -----------------------------------------------------------------------------------

const firstOtherHash = (): string => otherHash(need(other.sections[0], "Other section").id);

test.describe("owner check", () => {
  test("a visitor sees no avatar, Sign out, Edit, Versions or Add document", async ({ page }) => {
    const sectionHash = firstOtherHash();
    await openPage(page, sectionHash);
    await expect(page.getByRole("button", { name: "Owner sign-in" })).toBeVisible();
    await expect(ref(page, "signed-in-indicator")).toHaveCount(0);
    await expect(ref(page, "sign-out")).toHaveCount(0);
    await expect(ref(page, "edit-page")).toHaveCount(0);
    await expect(ref(page, "edit-versions")).toHaveCount(0);
    await expect(ref(page, "add-doc")).toHaveCount(0);
    await openPage(page, needTopic().hash);
    await expect(ref(page, "edit-page")).toHaveCount(0);
    await expect(ref(page, "edit-versions")).toHaveCount(0);
  });

  test("the owner sees her avatar, Sign out, Edit, Versions and Add document", async ({ page, context, baseURL }) => {
    await world(context, baseURL);
    await openPage(page, firstOtherHash());
    await signIn(page);
    await expect(toast(page)).toContainText("Signed in. Edit and Versions buttons now appear on your notes.");
    const avatar = ref(page, "signed-in-indicator").locator("img.avatar");
    await expect(avatar).toBeVisible();
    await expect.poll(() => avatar.evaluate((i) => (i instanceof HTMLImageElement ? i.naturalWidth : 0))).toBeGreaterThan(0);
    await expect(ref(page, "sign-out")).toBeVisible();
    await expect(ref(page, "add-doc")).toBeVisible();
    await expect(ref(page, "edit-page")).toBeVisible();
    await expect(ref(page, "edit-versions")).toBeVisible();
    await openPage(page, needTopic().hash);
    await expect(ref(page, "edit-page")).toBeVisible();
    await expect(ref(page, "edit-versions")).toBeVisible();
  });

  test("a different GitHub account is signed out again and the sign-in dialog stays open", async ({ page, context, baseURL }) => {
    const { fake } = await world(context, baseURL, { login: "someone-else" });
    await openPage(page, firstOtherHash());
    await page.getByRole("button", { name: "Owner sign-in" }).click();
    const dialog = page.getByRole("dialog", { name: "Sign in to edit" });
    const go = dialog.getByRole("button", { name: "Continue with GitHub" });
    await expect(go).toBeEnabled();
    const popup = page.waitForEvent("popup");
    await go.click();
    await popup;
    // The token was issued and the account read, so the sign-out below follows a real owner check.
    await expect.poll(() => fake.tokenRequests.length).toBe(1);
    await expect.poll(() => fake.requests.some((r) => r.method === "GET" && r.url === "https://api.github.com/user")).toBe(true);
    await expect.poll(() => page.evaluate(() => localStorage.getItem("pa.auth"))).toBeNull();
    await expect(dialog).toBeVisible();
    await expect(ref(page, "signed-in-indicator")).toHaveCount(0);
    await expect(ref(page, "add-doc")).toHaveCount(0);
    await expect(ref(page, "edit-page")).toHaveCount(0);
  });
});

// ---- 2. page coverage -------------------------------------------------------------------------------

interface CoverageCase {
  name: string;
  hash: string | null;
  edit: boolean;
  /** Absent cases: an owner-only control that proves the owner UI rendered on the page. */
  ownerProof?: string;
}

const own = inGuides((g, nav) => (nav.slides && readData<SlidesJson>(slidesPath(g)).kind === "own" ? g : undefined));
const generated = inGuides((g, nav) => (nav.slides && readData<SlidesJson>(slidesPath(g)).kind === "generated" ? g : undefined));
const refWithSub = REF_TABS.map((tab) => ({ tab, ref: readData<RefTabJson>(refPath(tab)) })).find((r) => r.ref.subs.length > 0);
const workup = inGuides((g) => {
  if (!existsSync(join(DATA, workupPath(g)))) return undefined;
  const item = readData<WorkupJson>(workupPath(g)).items[0];
  return item ? guideViewHash(g, { kind: "workup", item: item.id }) : undefined;
});
const docOfKind = (kind: DocJson["kind"]): DocJson | undefined => docs.find((d) => d.kind === kind);

const coverage: CoverageCase[] = [
  { name: "a topic page", edit: true, hash: topic?.hash ?? null },
  {
    name: "a section page",
    edit: true,
    hash: inGuides((g, n) => {
      const s = n.systems.find((x) => x.sections.length > 0);
      const sec = s?.sections[0];
      return s && sec ? guideViewHash(g, { kind: "section", system: s.id, section: sec.id }) : undefined;
    }),
  },
  { name: "a system page", edit: true, hash: inGuides((g, n) => (n.systems[0] ? guideViewHash(g, { kind: "system", system: n.systems[0].id }) : undefined)) },
  {
    name: "a listed block page",
    edit: true,
    hash: inGuides((g, n) => {
      const e = systemEntries(n).find((x) => x.kind === "block");
      return e ? guideViewHash(g, { kind: "block", id: e.id }) : undefined;
    }),
  },
  {
    name: "a pharm section page",
    edit: true,
    hash: inGuides((g, n) => {
      const s = n.systems.find((x) => (x.pharm?.sections.length ?? 0) > 0);
      const sec = s?.pharm?.sections[0];
      return s && sec ? guideViewHash(g, { kind: "pharm", system: s.id, section: sec.id, target: null }) : undefined;
    }),
  },
  { name: "a general topic page", edit: true, hash: inGuides((g, n) => (n.general[0] ? guideViewHash(g, { kind: "general", key: n.general[0].key }) : undefined)) },
  { name: "a workup item page", edit: true, hash: workup },
  { name: "a reference sub-topic page", edit: true, hash: refWithSub?.ref.subs[0] ? refHash(refWithSub.tab, refWithSub.ref.subs[0].id) : null },
  { name: "an Other section page", edit: true, hash: other.sections[0] ? otherHash(other.sections[0].id) : null },
  { name: "a generated review slide", edit: true, hash: generated === null ? null : guideViewHash(generated, { kind: "slides", n: 2 }) },
  { name: "a Word page", edit: true, hash: docOfKind("word") ? fileHash(need(docOfKind("word"), "Word document").id, null) : null },
  { name: "a slide of her own psych deck", edit: false, ownerProof: "deck-versions", hash: own === null ? null : guideViewHash(own, { kind: "slides", n: 2 }) },
  { name: "a PDF's file page", edit: false, ownerProof: "doc-rename", hash: docOfKind("pdf") ? fileHash(need(docOfKind("pdf"), "PDF").id, null) : null },
  { name: "an image's file page", edit: false, ownerProof: "doc-rename", hash: docOfKind("image") ? fileHash(need(docOfKind("image"), "image").id, null) : null },
];

test.describe("Edit is offered", () => {
  for (const c of coverage) {
    test(`${c.edit ? "on" : "not on"} ${c.name}`, async ({ page, context, baseURL }) => {
      const hash = need(c.hash, c.name);
      await world(context, baseURL);
      await openPage(page, hash);
      await signIn(page);
      if (c.edit) {
        await expect(ref(page, "edit-page")).toBeVisible();
        await expect(ref(page, "edit-versions")).toBeVisible();
      } else {
        await expect(ref(page, need(c.ownerProof, "owner control"))).toBeVisible();
        await expect(ref(page, "edit-page")).toHaveCount(0);
      }
    });
  }
});

// ---- 3. unsaved changes -------------------------------------------------------------------------------

test.describe("unsaved changes", () => {
  test("in-app navigation asks: Keep editing stays, Discard changes leaves without saving", async ({ page, context, baseURL }) => {
    const t = needTopic();
    const { fake, seed } = await world(context, baseURL, { seed: true });
    await openPage(page, t.hash);
    await signIn(page);
    await startEditing(page);
    const marker = newMarker();
    await typeMarker(page, marker);

    const crumb = page.locator("nav.crumbs a").first();
    const target = need(await crumb.getAttribute("href"), "crumb link");
    const unsaved = page.getByRole("dialog", { name: "You have unsaved changes" });
    await crumb.click();
    await expect(unsaved).toBeVisible();
    await ref(unsaved, "unsaved-stay").click();
    await expect(unsaved).toBeHidden();
    expect(new URL(page.url()).hash).toBe(t.hash);
    await expect(ref(page, "edit-dirty-state")).toHaveText("Unsaved changes");
    await expect(ref(page, "edit-area")).toContainText(marker);

    await crumb.click();
    await expect(unsaved).toBeVisible();
    await ref(unsaved, "unsaved-discard").click();
    await expect.poll(() => new URL(page.url()).hash).toBe(target);
    await expect(ref(page, "edit-area")).toHaveCount(0);
    expect(fake.head()).toBe(seed);
    await openPage(page, t.hash);
    await expect(page.locator("main")).toContainText(t.title);
    await expect(page.locator("main")).not.toContainText(marker);
  });

  test("Done asks, and Save and continue saves and closes the edit", async ({ page, context, baseURL }) => {
    const t = needTopic();
    const { fake, seed } = await world(context, baseURL, { seed: true });
    await openPage(page, t.hash);
    await signIn(page);
    await startEditing(page);
    const marker = newMarker();
    await typeMarker(page, marker);
    await ref(page, "edit-done").click();
    const unsaved = page.getByRole("dialog", { name: "You have unsaved changes" });
    await expect(unsaved).toBeVisible();
    await ref(unsaved, "unsaved-save").click();
    await expect(ref(page, "save-success")).toBeVisible();
    await expect(ref(page, "edit-area")).toHaveCount(0);
    expect(fake.head()).not.toBe(seed);
    expect(need(fake.commit(fake.head()), "save").message.startsWith(`Edit: ${t.title}`)).toBe(true);
    expect([...changedFiles(fake).values()].some((text) => text.includes(marker))).toBe(true);
  });

  test("Sign out asks: Keep editing stays signed in, Save and continue saves then signs out", async ({ page, context, baseURL }) => {
    const t = needTopic();
    const { fake, seed } = await world(context, baseURL, { seed: true });
    await openPage(page, t.hash);
    await signIn(page);
    await startEditing(page);
    const marker = newMarker();
    await typeMarker(page, marker);
    const unsaved = page.getByRole("dialog", { name: "You have unsaved changes" });

    await ref(page, "sign-out").click();
    await expect(unsaved).toBeVisible();
    await ref(unsaved, "unsaved-stay").click();
    await expect(unsaved).toBeHidden();
    await expect(ref(page, "signed-in-indicator")).toBeVisible();
    await expect(ref(page, "edit-area")).toContainText(marker);
    expect(fake.head()).toBe(seed);

    await ref(page, "sign-out").click();
    await expect(unsaved).toBeVisible();
    await ref(unsaved, "unsaved-save").click();
    await expect(toast(page)).toContainText("Signed out.");
    await expect(page.getByRole("button", { name: "Owner sign-in" })).toBeVisible();
    await expect(ref(page, "signed-in-indicator")).toHaveCount(0);
    expect(fake.head()).not.toBe(seed);
    expect([...changedFiles(fake).values()].some((text) => text.includes(marker))).toBe(true);
  });

  test("a dirty edit survives the full-page sign-in fallback and its save completes", async ({ page, context, baseURL }) => {
    const t = needTopic();
    const { fake, seed } = await world(context, baseURL, { seed: true });
    page.on("dialog", (d) => void (d.type() === "beforeunload" ? d.accept() : d.dismiss()));
    await openPage(page, t.hash);
    await signIn(page);
    await startEditing(page);
    const marker = newMarker();
    await typeMarker(page, marker);

    // The sign-in has expired (refresh refused), and the popup is blocked: the app signs in by leaving the page.
    fake.validTokens.clear();
    fake.refreshTokens.clear();
    await ref(page, "edit-save").click();
    const again = page.getByRole("dialog", { name: "Sign in again to finish saving" });
    await expect(again).toBeVisible();
    await page.evaluate(() => {
      window.open = () => null;
    });
    const tokensBefore = fake.tokenRequests.length;
    await again.getByRole("button", { name: "Continue with GitHub" }).click();

    await expect.poll(() => fake.tokenRequests.length).toBe(tokensBefore + 1);
    await expect.poll(() => new URL(page.url()).hash).toBe(t.hash);
    await expect(ref(page, "save-success")).toBeVisible();
    expect(fake.head()).not.toBe(seed);
    expect([...changedFiles(fake).values()].some((text) => text.includes(marker))).toBe(true);
    await expect(page.locator("main")).toContainText(marker);
  });
});

// ---- 4. toolbar limits ------------------------------------------------------------------------------

test.describe("toolbar limits", () => {
  test("A− floors at 4 pt, Tighter at 0.8 × font size, Above/Below at 0, and the indent goes negative", async ({ page, context, baseURL }) => {
    const t = needTopic();
    const { fake } = await world(context, baseURL, { seed: true });
    await openPage(page, t.hash);
    await signIn(page);
    await startEditing(page);
    const marker = newMarker();
    await typeMarker(page, marker);
    for (let i = 0; i < marker.length; i++) await page.keyboard.press("Shift+ArrowLeft");

    // Enough moves to take any of her indents (well under 180 pt) past zero.
    const leftMoves = 20;

    await clickN(ref(page, "tb-smaller"), 30);
    await clickN(ref(page, "tb-tighter"), 80);
    await clickN(ref(page, "tb-above-less"), 30);
    await clickN(ref(page, "tb-below-less"), 30);
    await clickN(ref(page, "tb-left"), leftMoves);
    await ref(page, "edit-save").click();
    await expect(ref(page, "save-success")).toBeVisible();

    const saved = savedParagraph(fake, marker);
    const p = nodeAt(saved.after, saved.path);
    const original = nodeAt(saved.before, saved.path);
    const run = firstText(p);
    expect(String(run.text).startsWith(marker)).toBe(true);
    expect(sizeMark(run)).toBe(4);
    expect(attrsOf(p).line).toEqual({ rule: "exact", value: roundHalf(0.8 * 4) });
    expect(numAttr(p, "spaceBefore")).toBe(0);
    expect(numAttr(p, "spaceAfter")).toBe(0);
    let indent = numAttr(original, "indLeft");
    for (let i = 0; i < leftMoves; i++) indent = roundHalf(indent - 9);
    expect(numAttr(p, "indLeft")).toBe(indent);
    expect(numAttr(p, "indLeft")).toBeLessThan(0);
  });

  test("the size box sets 7.5 pt, and the save keeps it", async ({ page, context, baseURL }) => {
    const t = needTopic();
    const { fake } = await world(context, baseURL, { seed: true });
    await openPage(page, t.hash);
    await signIn(page);
    await startEditing(page);
    const marker = newMarker();
    // As typeMarker does, at the start of the topic row's second cell, but with 7.5 chosen first: what
    // she types next takes it.
    const slot = ref(page, "edit-area").locator(".edit-slot").first();
    await slot.locator("table.nt > tbody > tr:not(.hrow)").first().locator(":scope > td").nth(1).locator("p").first().click({ position: { x: 1, y: 2 } });
    await page.keyboard.press("Home");
    await ref(page, "tb-size").selectOption("7.5");
    await expect(ref(page, "tb-size")).toHaveValue("7.5");
    await page.keyboard.type(marker);
    await expect(slot).toContainText(marker);
    await ref(page, "edit-save").click();
    await expect(ref(page, "save-success")).toBeVisible();
    const saved = savedParagraph(fake, marker);
    const run = firstText(nodeAt(saved.after, saved.path));
    expect(String(run.text).startsWith(marker)).toBe(true);
    expect(sizeMark(run)).toBe(7.5);
  });

  test("Column Wider widens the cursor's column, and the save keeps the widths and the page shows them", async ({ page, context, baseURL }) => {
    const t = needTopic();
    const { fake } = await world(context, baseURL, { seed: true });
    await openPage(page, t.hash);
    await signIn(page);
    await startEditing(page);
    const tableWith = (json: unknown): Rec => {
      const tablePath = need(findPath(json, (n) => n.type === "table" && findPath(n, (r) => r.type === "table_row" && attrsOf(r).id === t.id) !== null), "the topic's table");
      return nodeAt(json, tablePath);
    };
    const beforeTable = attrsOf(tableWith(JSON.parse(need(fake.readFile(t.blockPath), t.blockPath)))) as TableAttrs;
    const before = beforeTable.grid;
    const sum = before.reduce((a, b) => a + b, 0);
    const shown = tableColumns(beforeTable).map((p) => (p * sum) / 100);

    // The topic row's second cell, as typeMarker uses (the first is the topic's name).
    const slot = ref(page, "edit-area").locator(".edit-slot").first();
    const cell = slot.locator("table.nt > tbody > tr:not(.hrow)").first().locator(":scope > td").nth(1);
    const cellWidth = (): Promise<number> => cell.evaluate((td) => td.getBoundingClientRect().width);
    const widthBefore = await cellWidth();
    await cell.locator("p").first().click({ position: { x: 1, y: 2 } });
    await expect(ref(page, "tb-col-wider")).toBeVisible();
    await clickN(ref(page, "tb-col-wider"), 3);
    await expect(ref(page, "edit-dirty-state")).toHaveText("Unsaved changes");
    // On screen before saving, the column is wider.
    expect(await cellWidth()).toBeGreaterThan(widthBefore + 10);
    await ref(page, "edit-save").click();
    await expect(ref(page, "save-success")).toBeVisible();

    const savedTable = attrsOf(tableWith(JSON.parse(need(changedFiles(fake).get(t.blockPath), `${t.blockPath} in the save`)))) as TableAttrs;
    const saved = savedTable.grid;
    expect(savedTable.ownWidths).toBe(true);
    expect(saved).toHaveLength(before.length);
    expect(saved.reduce((a, b) => a + b, 0)).toBeCloseTo(sum, 0);
    expect((saved[1] ?? 0) - (shown[1] ?? 0)).toBeCloseTo(3 * COLUMN_STEP_PT, 1);
    // Exactly one other column paid for it.
    const others = saved.map((w, i) => w - (shown[i] ?? 0)).filter((d, i) => i !== 1 && Math.abs(d) > 0.1);
    expect(others).toHaveLength(1);
    expect(others[0]).toBeCloseTo(-3 * COLUMN_STEP_PT, 1);

    // The page, now read, draws the saved widths.
    const shownTable = page.locator("main table.nt").filter({ has: page.locator(`[data-anchor="${t.id}"]`) }).first();
    const widths = await shownTable.locator(":scope > colgroup > col").evaluateAll((cols) => cols.map((c) => parseFloat((c as HTMLElement).style.width)));
    expect(widths).toHaveLength(saved.length);
    tableColumns(savedTable).forEach((pct, i) => expect(widths[i]).toBeCloseTo(pct, 1));
  });

  test("Column Wider greys out once the column beside it is at its narrowest, while Narrower still works", async ({ page, context, baseURL }) => {
    const t = needTopic();
    await world(context, baseURL, { seed: true });
    await openPage(page, t.hash);
    await signIn(page);
    await startEditing(page);
    const slot = ref(page, "edit-area").locator(".edit-slot").first();
    await slot.locator("table.nt > tbody > tr:not(.hrow)").first().locator(":scope > td").nth(1).locator("p").first().click({ position: { x: 1, y: 2 } });
    const wider = ref(page, "tb-col-wider");
    await expect(wider).toBeEnabled();
    for (let i = 0; i < 300 && (await wider.isEnabled()); i++) await wider.click();
    await expect(wider).toBeDisabled();
    await expect(ref(page, "tb-col-narrower")).toBeEnabled();
    await ref(page, "tb-col-narrower").click();
    await expect(wider).toBeEnabled();
  });

  test("dragging a column border resizes the two columns beside it, and the save keeps the widths and the page shows them", async ({ page, context, baseURL }) => {
    const t = needTopic();
    const { fake } = await world(context, baseURL, { seed: true });
    await openPage(page, t.hash);
    await signIn(page);
    await startEditing(page);
    const tableWith = (json: unknown): Rec => {
      const tablePath = need(findPath(json, (n) => n.type === "table" && findPath(n, (r) => r.type === "table_row" && attrsOf(r).id === t.id) !== null), "the topic's table");
      return nodeAt(json, tablePath);
    };
    const beforeTable = attrsOf(tableWith(JSON.parse(need(fake.readFile(t.blockPath), t.blockPath)))) as TableAttrs;
    const before = beforeTable.grid;
    expect(before.length).toBeGreaterThan(1);
    const sum = before.reduce((a, b) => a + b, 0);

    // The border between the topic's name cell and the next one.
    const editTable = ref(page, "edit-area").locator(".edit-slot").first().locator("table.nt").first();
    const nameCell = editTable.locator(":scope > tbody > tr:not(.hrow)").first().locator(":scope > td").first();
    await nameCell.scrollIntoViewIfNeeded();
    const box = need(await nameCell.boundingBox(), "the name cell's box");
    const tableWidth = need(await editTable.boundingBox(), "the table's box").width;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width - 1, y);
    await expect(nameCell).toHaveCSS("cursor", "col-resize");
    await page.mouse.down();
    await page.mouse.move(box.x + box.width + 29, y, { steps: 3 });
    await page.mouse.move(box.x + box.width + 59, y, { steps: 3 });
    await expect(page.locator(".col-drag-guide")).toBeVisible();
    await page.mouse.up();
    await expect(page.locator(".col-drag-guide")).toHaveCount(0);
    await expect(ref(page, "edit-dirty-state")).toHaveText("Unsaved changes");
    // On screen before saving, the name column is about 60 px wider.
    expect((need(await nameCell.boundingBox(), "the name cell's box").width) - box.width).toBeGreaterThan(50);

    await ref(page, "edit-save").click();
    await expect(ref(page, "save-success")).toBeVisible();
    const savedTable = attrsOf(tableWith(JSON.parse(need(changedFiles(fake).get(t.blockPath), `${t.blockPath} in the save`)))) as TableAttrs;
    const saved = savedTable.grid;
    expect(savedTable.ownWidths).toBe(true);
    // The border moved 60 px of the table's drawn width: the name column grew that much, the next shrank as much.
    const expected = need(moveColumnBorder(beforeTable, 0, (60 * sum) / tableWidth), "a border move");
    expect(saved).toHaveLength(before.length);
    expect(saved.reduce((a, b) => a + b, 0)).toBeCloseTo(sum, 0);
    saved.forEach((w, i) => expect(Math.abs(w - (expected[i] ?? 0))).toBeLessThan(1));

    // The page, now read, draws the saved widths.
    const shownTable = page.locator("main table.nt").filter({ has: page.locator(`[data-anchor="${t.id}"]`) }).first();
    const widths = await shownTable.locator(":scope > colgroup > col").evaluateAll((cols) => cols.map((c) => parseFloat((c as HTMLElement).style.width)));
    expect(widths).toHaveLength(saved.length);
    tableColumns(savedTable).forEach((pct, i) => expect(widths[i]).toBeCloseTo(pct, 1));
  });

  test("dragging the first column's border left narrows a name column drawn at the screen's minimum, and the save keeps her width and the page shows it", async ({ page, context, baseURL }) => {
    const t = needTopic();
    const { fake } = await world(context, baseURL, { seed: true });
    await openPage(page, t.hash);
    await signIn(page);
    await startEditing(page);
    const tableWith = (json: unknown): Rec => {
      const tablePath = need(findPath(json, (n) => n.type === "table" && findPath(n, (r) => r.type === "table_row" && attrsOf(r).id === t.id) !== null), "the topic's table");
      return nodeAt(json, tablePath);
    };
    const beforeTable = attrsOf(tableWith(JSON.parse(need(fake.readFile(t.blockPath), t.blockPath)))) as TableAttrs;
    const sum = beforeTable.grid.reduce((a, b) => a + b, 0);
    // Her Word width is narrower than the minimum, so the name column is drawn at it.
    expect(beforeTable.ownWidths).toBeUndefined();
    expect(tableColumns(beforeTable)[0]).toBe(MIN_FIRST_COLUMN_PCT);

    const editTable = ref(page, "edit-area").locator(".edit-slot").first().locator("table.nt").first();
    const nameCell = editTable.locator(":scope > tbody > tr:not(.hrow)").first().locator(":scope > td").first();
    await nameCell.scrollIntoViewIfNeeded();
    const box = need(await nameCell.boundingBox(), "the name cell's box");
    const tableWidth = need(await editTable.boundingBox(), "the table's box").width;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width - 1, y);
    await expect(nameCell).toHaveCSS("cursor", "col-resize");
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 21, y, { steps: 3 });
    await page.mouse.move(box.x + box.width - 41, y, { steps: 3 });
    await page.mouse.up();
    await expect(ref(page, "edit-dirty-state")).toHaveText("Unsaved changes");
    // On screen before saving, the name column is about 40 px narrower.
    expect(box.width - need(await nameCell.boundingBox(), "the name cell's box").width).toBeGreaterThan(30);

    await ref(page, "edit-save").click();
    await expect(ref(page, "save-success")).toBeVisible();
    const savedTable = attrsOf(tableWith(JSON.parse(need(changedFiles(fake).get(t.blockPath), `${t.blockPath} in the save`)))) as TableAttrs;
    expect(savedTable.ownWidths).toBe(true);
    const expected = need(moveColumnBorder(beforeTable, 0, (-40 * sum) / tableWidth), "a border move");
    expect(savedTable.grid).toHaveLength(beforeTable.grid.length);
    expect(savedTable.grid.reduce((a, b) => a + b, 0)).toBeCloseTo(sum, 0);
    savedTable.grid.forEach((w, i) => expect(Math.abs(w - (expected[i] ?? 0))).toBeLessThan(1));
    const firstPct = (100 * (savedTable.grid[0] ?? 0)) / sum;
    expect(firstPct).toBeLessThan(MIN_FIRST_COLUMN_PCT - 2);

    // The page, now read, draws her width: under the minimum, exactly as stored.
    const shownTable = page.locator("main table.nt").filter({ has: page.locator(`[data-anchor="${t.id}"]`) }).first();
    const widths = await shownTable.locator(":scope > colgroup > col").evaluateAll((cols) => cols.map((c) => parseFloat((c as HTMLElement).style.width)));
    expect(widths).toHaveLength(savedTable.grid.length);
    savedTable.grid.forEach((w, i) => expect(widths[i]).toBeCloseTo((100 * w) / sum, 1));
  });

  test("Cell margins Sides + and Top/bottom + pad every cell on screen while editing, and the save keeps them and the page shows them", async ({ page, context, baseURL }) => {
    const t = needTopic();
    const { fake } = await world(context, baseURL, { seed: true });
    await openPage(page, t.hash);
    // The topic row's second cell (the first is the topic's name), in a table as the page draws it.
    const topicCell = (table: Locator): Locator => table.locator(":scope > tbody > tr:not(.hrow)").first().locator(":scope > td").nth(1);
    const padding = (td: Locator): Promise<{ top: number; left: number }> =>
      td.evaluate((e) => ({ top: parseFloat(getComputedStyle(e).paddingTop), left: parseFloat(getComputedStyle(e).paddingLeft) }));
    const shownTable = page.locator("main table.nt").filter({ has: page.locator(`[data-anchor="${t.id}"]`) }).first();
    const readBefore = await padding(topicCell(shownTable));
    await signIn(page);
    await startEditing(page);
    const tableWith = (json: unknown): Rec => {
      const tablePath = need(findPath(json, (n) => n.type === "table" && findPath(n, (r) => r.type === "table_row" && attrsOf(r).id === t.id) !== null), "the topic's table");
      return nodeAt(json, tablePath);
    };
    type Margins = { top: number; right: number; bottom: number; left: number };
    const before = attrsOf(tableWith(JSON.parse(need(fake.readFile(t.blockPath), t.blockPath)))).cellMarginPt as Margins;

    const editTable = ref(page, "edit-area").locator(".edit-slot").first().locator("table.nt").first();
    const cell = topicCell(editTable);
    const nameCell = editTable.locator(":scope > tbody > tr:not(.hrow)").first().locator(":scope > td").first();
    const editBefore = await padding(cell);
    const nameBefore = await padding(nameCell);
    await cell.locator("p").first().click({ position: { x: 1, y: 2 } });
    await expect(ref(page, "tb-cell-sides-more")).toBeVisible();
    await clickN(ref(page, "tb-cell-sides-more"), 3);
    await clickN(ref(page, "tb-cell-tb-more"), 3);
    await expect(ref(page, "edit-dirty-state")).toHaveText("Unsaved changes");
    // On screen before saving: 3 pt more on each side of every cell of the table, not only the cursor's.
    const editAfter = await padding(cell);
    expect(editAfter.left - editBefore.left).toBeGreaterThan(2);
    expect(editAfter.top - editBefore.top).toBeGreaterThan(2);
    const nameAfter = await padding(nameCell);
    expect(nameAfter.left).toBeGreaterThan(nameBefore.left);
    expect(nameAfter.top).toBeGreaterThan(nameBefore.top);

    await ref(page, "edit-save").click();
    await expect(ref(page, "save-success")).toBeVisible();
    const saved = attrsOf(tableWith(JSON.parse(need(changedFiles(fake).get(t.blockPath), `${t.blockPath} in the save`)))).cellMarginPt as Margins;
    // Three clicks of one step each, kept to half points as the command keeps them.
    const plus3 = (v: number): number => [1, 2, 3].reduce((x) => roundHalf(x + CELL_MARGIN_STEP_PT), v);
    expect(saved).toEqual({ top: plus3(before.top), right: plus3(before.right), bottom: plus3(before.bottom), left: plus3(before.left) });
    // The page, now read, draws the wider margins too.
    const readAfter = await padding(topicCell(shownTable));
    expect(readAfter.left).toBeGreaterThan(readBefore.left);
    expect(readAfter.top).toBeGreaterThan(readBefore.top);
  });

  test("Delete row asks before each delete and is refused, with no dialog, on a one-row table", async ({ page, context, baseURL }) => {
    const t = needTopic();
    await world(context, baseURL, { seed: true });
    // The system page: a topic page shows only one table, which may hold a picture or a single row.
    await openPage(page, t.systemHash);
    await signIn(page);
    const area = await startEditing(page);
    const tables = area.locator("table.nt");
    // The smallest table with at least two rows and no pictures.
    const index = await tables.evaluateAll((els) => {
      let best = -1;
      let bestRows = Infinity;
      els.forEach((el, i) => {
        const rows = el.querySelectorAll(":scope > tbody > tr").length;
        if (rows >= 2 && rows < bestRows && el.querySelector("img") === null) {
          best = i;
          bestRows = rows;
        }
      });
      return best;
    });
    expect(index, "a picture-free table with two or more rows").toBeGreaterThanOrEqual(0);
    const table = tables.nth(index);
    const rows = table.locator(":scope > tbody > tr");
    const confirm = page.getByRole("dialog", { name: "Delete this table row?" });
    let count = await rows.count();
    while (count > 1) {
      await rows.first().locator("td").first().click();
      await ref(page, "tb-row-delete").click();
      await expect(confirm).toBeVisible();
      await ref(confirm, "confirm-ok").click();
      await expect(rows).toHaveCount(count - 1);
      count -= 1;
    }
    await rows.first().locator("td").first().click();
    await ref(page, "tb-row-delete").click();
    // A dialog would be modal and block this click; the row count proves Delete row did nothing.
    await ref(page, "tb-row-below").click();
    await expect(rows).toHaveCount(2);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("deleting a row that holds a picture names the pictures in the confirm, and Cancel keeps it", async ({ page, context, baseURL }) => {
    const pic = need(findPicture("cell"), "picture in a table cell on a system page");
    await world(context, baseURL, { seed: true });
    await openPage(page, pic.hash);
    await signIn(page);
    const area = await startEditing(page);
    const img = area.locator(`img[src$="${pic.asset}"]`);
    await expect(img).toHaveCount(1);
    const row = area.locator("table.nt > tbody > tr").filter({ has: page.locator(`img[src$="${pic.asset}"]`) }).last();
    const pictures = await row.locator("img").count();
    const tableRows = row.locator("xpath=..").locator(":scope > tr");
    const rowsBefore = await tableRows.count();
    await img.click();
    await ref(page, "tb-row-delete").click();
    const confirm = page.getByRole("dialog", { name: "Delete this table row?" });
    await expect(confirm).toContainText(`This row also holds ${pictures} picture(s), which will be deleted too.`);
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    await expect(tableRows).toHaveCount(rowsBefore);
    await expect(img).toHaveCount(1);
  });

  test("Delete picture asks first, and Backspace on a picture is refused", async ({ page, context, baseURL }) => {
    const pic = need(findPicture("page"), "picture outside tables on a system page");
    await world(context, baseURL, { seed: true });
    await openPage(page, pic.hash);
    await signIn(page);
    const area = await startEditing(page);
    const img = area.locator(`img[src$="${pic.asset}"]`);
    await expect(img).toHaveCount(1);

    await img.click();
    await page.keyboard.press("Backspace");
    await expect(toast(page)).toContainText('That would remove a picture. To remove a picture, click it and press "Delete picture".');
    await expect(img).toHaveCount(1);

    await img.click();
    await ref(page, "tb-pic-delete").click();
    const confirm = page.getByRole("dialog", { name: "Delete this picture?" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(img).toHaveCount(1);

    await img.click();
    await ref(page, "tb-pic-delete").click();
    await expect(confirm).toBeVisible();
    await ref(confirm, "confirm-ok").click();
    await expect(img).toHaveCount(0);
  });

  for (const where of ["page", "cell"] as const) {
    test(`picture size clamps to 24 pt and to the ${where === "cell" ? "cell" : "page"} width`, async ({ page, context, baseURL }) => {
      const pic = need(findPicture(where), `picture ${where === "cell" ? "in a table cell" : "outside tables"} on a system page`);
      const { fake } = await world(context, baseURL, { seed: true });
      await openPage(page, pic.hash);
      await signIn(page);
      const ratio = pic.heightPt / pic.widthPt;
      const savedPicture = (): Rec => {
        const text = need(changedFiles(fake).get(pic.blockPath), `${pic.blockPath} in the save`);
        const json: unknown = JSON.parse(text);
        return attrsOf(nodeAt(json, need(findPath(json, (n) => attrsOf(n).asset === pic.asset), "the picture in the saved block")));
      };

      let area = await startEditing(page);
      await area.locator(`img[src$="${pic.asset}"]`).click();
      await clickN(ref(page, "tb-pic-smaller"), 40);
      await ref(page, "edit-save").click();
      await expect(ref(page, "save-success")).toBeVisible();
      let attrs = savedPicture();
      expect(Number(attrs.widthPt)).toBeCloseTo(24, 1);
      expect(Number(attrs.heightPt) / Number(attrs.widthPt)).toBeCloseTo(ratio, 2);

      area = await startEditing(page);
      await area.locator(`img[src$="${pic.asset}"]`).click();
      await clickN(ref(page, "tb-pic-bigger"), 50);
      await ref(page, "edit-save").click();
      await expect(ref(page, "save-success")).toBeVisible();
      attrs = savedPicture();
      expect(Number(attrs.widthPt)).toBeCloseTo(pic.limit, 1);
      expect(Number(attrs.heightPt) / Number(attrs.widthPt)).toBeCloseTo(ratio, 2);
    });
  }
});

// ---- 5. conflict ----------------------------------------------------------------------------------------

/** Commits a change to the topic's block from "another device" at `date`; returns the appended text. */
function saveFromAnotherDevice(fake: FakeGithub, t: TopicTarget, date: string): string {
  const added = ` ${newMarker()}`;
  const json: unknown = JSON.parse(need(fake.readFile(t.blockPath), t.blockPath));
  const rowPath = need(findPath(json, (n) => n.type === "table_row" && attrsOf(n).id === t.id), "topic row");
  // The second cell, as typeMarker does: the first is the topic's name, and editing it renames the topic.
  const cellPath = [...rowPath, "content", 1];
  const text = nodeAt(json, [...cellPath, ...need(findPath(nodeAt(json, cellPath), (n) => n.type === "text"), "text in the topic row's second cell")]);
  text.text = `${String(text.text)}${added}`;
  fake.commitFiles(
    { [t.blockPath]: serializeFile(t.blockPath, json) },
    { message: commitMessage(`Edit: ${t.title}`, { kind: "edit", page: t.key, changed: [t.id], device: OTHER_DEVICE }), date },
  );
  return added.trim();
}

test.describe("pictures and highlight colors", () => {
  // A 1×1 PNG no guide holds.
  const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

  test("a picture added under Additional info, after the meds panel, shows at once and is saved with its bytes and the below block", async ({ page, context, baseURL }) => {
    const t = need(medsTopic, "topic with a meds panel whose first row is in a block file under content/");
    const { fake } = await world(context, baseURL, { seed: true });
    await openPage(page, t.hash);
    const card = page.locator(`section.tcard[data-topic="${t.id}"]`);
    // Nothing added yet: no heading for anyone.
    await expect(card.locator(".meds")).toHaveCount(1);
    await expect(card.getByRole("region", { name: "Additional info" })).toHaveCount(0);
    await signIn(page);
    const area = await startEditing(page);
    const below = area.getByRole("region", { name: "Additional info" });
    // While editing, the meds panel stays in view once, between her rows and the Additional info area.
    await expect(card.locator(".meds")).toHaveCount(1);
    const meds = area.locator(".meds");
    await expect(meds).toBeVisible();
    const order = await meds.evaluate((m) => {
      const after = (a: Node, b: Node): boolean => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      const rows = document.querySelector('[data-ref="edit-area"] .ProseMirror');
      const area = document.querySelector('[data-ref="edit-area"] .below-edit');
      return { rowsFirst: !!rows && after(rows, m), areaAfter: !!area && after(m, area) };
    });
    expect(order).toEqual({ rowsFirst: true, areaAfter: true });
    await below.locator(".ProseMirror p").first().click();
    const chooser = page.waitForEvent("filechooser");
    await ref(page, "tb-pic-add").click();
    await (await chooser).setFiles({ name: "ecg.png", mimeType: "image/png", buffer: PNG_BYTES });
    // ProseMirror adds its own `img.ProseMirror-separator` after an inline node ending a paragraph.
    const img = below.locator("img:not(.ProseMirror-separator)");
    await expect(img).toHaveCount(1);
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1);
    await expect(ref(page, "edit-dirty-state")).toHaveText("Unsaved changes");

    await ref(page, "edit-save").click();
    await expect(ref(page, "save-success")).toBeVisible();
    const name = `${createHash("sha256").update(PNG_BYTES).digest("hex").slice(0, 32)}.png`;
    expect(Buffer.from(need(fake.readBytes(`content/assets/${name}`), "the saved picture"))).toEqual(PNG_BYTES);
    const belowFiles = [...changedFiles(fake)].filter(([path]) => /\/below\/r_[0-9A-Z]{10}\.json$/.test(path));
    expect(belowFiles).toHaveLength(1);
    expect(belowFiles[0]?.[1]).toContain(name);
    // The saved picture shows on the page from this device before the site redeploys, under Additional
    // info after the meds panel.
    const info = card.getByRole("region", { name: "Additional info" });
    await expect(info.getByRole("heading", { name: "Additional info" })).toBeVisible();
    await expect(info.locator("img")).toHaveJSProperty("naturalWidth", 1);
    await expect(card.locator(".meds")).toHaveCount(1);
    expect(await card.locator(".meds").evaluate((m, el) => (m.compareDocumentPosition(el as Node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0, await info.elementHandle())).toBe(true);
  });

  for (const how of ["pasted", "dropped"] as const) {
    test(`a picture ${how} into Additional info is added as Add picture adds it and saved with its bytes`, async ({ page, context, baseURL }) => {
      const t = needTopic();
      const { fake } = await world(context, baseURL, { seed: true });
      await openPage(page, t.hash);
      await signIn(page);
      const area = await startEditing(page);
      const below = area.getByRole("region", { name: "Additional info" });
      const editor = below.locator(".ProseMirror");
      await editor.locator("p").first().click();
      // A copied picture arrives as a file on the clipboard (or the drag), with no text.
      await editor.evaluate((el, { b64, how }) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const data = new DataTransfer();
        data.items.add(new File([bytes], "image.png", { type: "image/png" }));
        if (how === "pasted") {
          el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
        } else {
          const box = (el.querySelector("p") ?? el).getBoundingClientRect();
          el.dispatchEvent(new DragEvent("drop", { dataTransfer: data, clientX: box.left + 2, clientY: box.top + box.height / 2, bubbles: true, cancelable: true }));
        }
      }, { b64: PNG_BYTES.toString("base64"), how });
      const img = below.locator("img:not(.ProseMirror-separator)");
      await expect(img).toHaveCount(1);
      await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1);

      await ref(page, "edit-save").click();
      await expect(ref(page, "save-success")).toBeVisible();
      const name = `${createHash("sha256").update(PNG_BYTES).digest("hex").slice(0, 32)}.png`;
      expect(Buffer.from(need(fake.readBytes(`content/assets/${name}`), "the saved picture"))).toEqual(PNG_BYTES);
      // One upload path: the bytes went up once, as a base64 blob through the Git Data API.
      expect(blobPosts(fake, PNG_BYTES.toString("base64").slice(0, 40))).toHaveLength(1);
      const belowFiles = [...changedFiles(fake)].filter(([path]) => /\/below\/r_[0-9A-Z]{10}\.json$/.test(path));
      expect(belowFiles).toHaveLength(1);
      expect(belowFiles[0]?.[1]).toContain(name);
      await expect(page.locator(`section.tcard[data-topic="${t.id}"]`).getByRole("region", { name: "Additional info" }).locator("img")).toHaveJSProperty("naturalWidth", 1);
    });
  }

  test("a highlight color from the picker is saved on the selected text", async ({ page, context, baseURL }) => {
    const t = needTopic();
    const { fake } = await world(context, baseURL, { seed: true });
    await openPage(page, t.hash);
    await signIn(page);
    await startEditing(page);
    const marker = newMarker();
    await typeMarker(page, marker);
    for (let i = 0; i < marker.length; i++) await page.keyboard.press("Shift+ArrowLeft");
    await ref(page, "tb-highlight").click();
    await expect(ref(page, "tb-highlight-colors").locator('[data-ref^="tb-hl-"]')).toHaveCount(15);
    await ref(page, "tb-hl-00FF00").click();
    await ref(page, "edit-save").click();
    await expect(ref(page, "save-success")).toBeVisible();

    const saved = savedParagraph(fake, marker);
    const run = firstText(nodeAt(saved.after, saved.path));
    expect(String(run.text).startsWith(marker)).toBe(true);
    expect(run.marks).toContainEqual({ type: "highlight", attrs: { hex: "00FF00" } });
  });
});

test("a conflict shows the other save's time, copies the rows tab-separated, and loads the newer version", async ({ page, context, baseURL }) => {
  const t = needTopic();
  const { fake } = await world(context, baseURL, { seed: true });
  await openPage(page, t.hash);
  await signIn(page);
  const area = await startEditing(page);
  const marker = newMarker();
  await typeMarker(page, marker);
  const theirs = saveFromAnotherDevice(fake, t, "2026-10-04T15:30:00Z");
  const at = await shownTime(page, "2026-10-04T15:30:00Z");

  await ref(page, "edit-save").click();
  const conflict = ref(page, "save-conflict");
  await expect(conflict).toContainText(`Not saved — this page was saved from another device at ${at} after you opened it.`);

  const row = area.locator("tr").filter({ hasText: marker }).last();
  const cells = await row.locator(":scope > td").count();
  await ref(page, "conflict-copy").click();
  await expect(toast(page)).toContainText("Your changes were copied.");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const line = need(copied.split(NL).find((l) => l.includes(marker)), "copied line with the marker");
  expect(line.split(TAB)).toHaveLength(cells);
  expect(cells).toBeGreaterThan(1);

  await ref(page, "conflict-load-newer").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(ref(page, "loaded").locator(".bt")).toHaveText(`Showing the newer version saved at ${at}. Your copied changes are on the clipboard.`);
  await expect(area).toContainText(theirs);
  await expect(area).not.toContainText(marker);
});

// ---- 6. banners -------------------------------------------------------------------------------------------

test.describe("save banners", () => {
  test("Saved after a save", async ({ page, context, baseURL }) => {
    const t = needTopic();
    await world(context, baseURL, { seed: true });
    await openPage(page, t.hash);
    await signIn(page);
    await startEditing(page);
    await typeMarker(page, newMarker());
    await ref(page, "edit-save").click();
    await expect(ref(page, "save-success")).toContainText("Saved. Everyone will see the change on the site within a few minutes. Search and the sidebar update too.");
  });

  test("the offline banner after the retries, and Try again saves", async ({ page, context, baseURL }) => {
    const t = needTopic();
    const { fake, seed } = await world(context, baseURL, { seed: true });
    await openPage(page, t.hash);
    await signIn(page);
    await startEditing(page);
    const marker = newMarker();
    await typeMarker(page, marker);
    let down = true;
    fake.fail((r) => down && r.method !== "OPTIONS" && r.url.startsWith("https://api.github.com/"), "network", 1000);
    await ref(page, "edit-save").click();
    const failed = ref(page, "save-failed");
    await expect(failed).toContainText("Couldn’t save — no internet connection.", { timeout: 30_000 });
    expect(fake.head()).toBe(seed);
    await expect(ref(page, "edit-area")).toContainText(marker);
    down = false;
    await ref(failed, "save-retry").click();
    await expect(ref(page, "save-success")).toBeVisible();
    expect([...changedFiles(fake).values()].some((text) => text.includes(marker))).toBe(true);
  });

  test("an expired sign-in asks to sign in again, then the save completes", async ({ page, context, baseURL }) => {
    const t = needTopic();
    const { fake, seed } = await world(context, baseURL, { seed: true });
    await openPage(page, t.hash);
    await signIn(page);
    await startEditing(page);
    const marker = newMarker();
    await typeMarker(page, marker);
    fake.validTokens.clear();
    fake.refreshTokens.clear();
    await ref(page, "edit-save").click();
    const again = page.getByRole("dialog", { name: "Sign in again to finish saving" });
    await expect(again).toBeVisible();
    const go = again.getByRole("button", { name: "Continue with GitHub" });
    await expect(go).toBeEnabled();
    const popup = page.waitForEvent("popup");
    await go.click();
    await popup;
    await expect(toast(page)).toContainText("Signed in again. Saving your changes…");
    await expect(ref(page, "save-success")).toBeVisible();
    expect(fake.head()).not.toBe(seed);
    expect([...changedFiles(fake).values()].some((text) => text.includes(marker))).toBe(true);
  });
});

// ---- 7. overlay -------------------------------------------------------------------------------------------

test("the overlay shows a save at once and drops it once build.json reports a commit containing it", async ({ page, context, baseURL }) => {
  const t = needTopic();
  const { fake, build, buildFetches } = await world(context, baseURL, { seed: true });
  await openPage(page, t.hash);
  await signIn(page);
  await startEditing(page);
  const marker = newMarker();
  await typeMarker(page, marker);
  await ref(page, "edit-save").click();
  await expect(ref(page, "save-success")).toBeVisible();
  const saved = fake.head();
  await expect(page.locator("main")).toContainText(marker);

  const compared = (): boolean => fake.requests.some((r) => r.url.includes(`/compare/${saved}...${build.commit}`));

  // The published build predates the save: the entry stays.
  await openPage(page, t.hash);
  await expect.poll(compared).toBe(true);
  await expect(page.locator("main")).toContainText(marker);

  // The published build contains the save: the entry goes and the page is the published data again.
  build.commit = saved;
  const fetched = buildFetches();
  await openPage(page, t.hash);
  await expect.poll(buildFetches).toBeGreaterThan(fetched);
  await expect.poll(compared).toBe(true);
  await expect(page.locator("main")).toContainText(t.title);
  await expect(page.locator("main")).not.toContainText(marker);
});

// ---- 8. Versions ----------------------------------------------------------------------------------------

test.describe("Versions", () => {
  const item = (page: Page, i: number): Locator => ref(page, `version-${i}`);

  test("a topic's versions: labels, badges, View and Restore", async ({ page, context, baseURL }) => {
    const t = needTopic();
    const { fake } = await world(context, baseURL, { seed: true });
    saveFromAnotherDevice(fake, t, "2026-10-02T00:00:00Z");
    await openPage(page, t.hash);
    await signIn(page);
    await startEditing(page);
    await typeMarker(page, newMarker());
    await ref(page, "edit-save").click();
    await expect(ref(page, "save-success")).toBeVisible();
    const mine = need(fake.commit(fake.head()), "her save").author.date;
    const original = await shownTime(page, IMPORT_DATE);
    const other = await shownTime(page, "2026-10-02T00:00:00Z");

    await ref(page, "edit-versions").click();
    await expect(page.locator("main h1").first()).toHaveText(`Versions of “${t.title}”`);
    const list = ref(page, "versions-list").locator(":scope > li");
    await expect(list).toHaveCount(3);
    await expect(item(page, 0).locator(".vt b")).toHaveText(await shownTime(page, mine));
    await expect(item(page, 0).locator(".vt small")).toHaveText("Your edit");
    await expect(item(page, 0).locator(".vbadge")).toHaveText(["Current"]);
    await expect(ref(item(page, 0), "version-restore-0")).toHaveCount(0);
    await expect(item(page, 1).locator(".vt b")).toHaveText(other);
    await expect(item(page, 1).locator(".vt small")).toHaveText("Saved from another device");
    await expect(item(page, 1).locator(".vbadge")).toHaveCount(0);
    await expect(item(page, 2).locator(".vt b")).toHaveText(original);
    await expect(item(page, 2).locator(".vt small")).toHaveText("Original — converted from your Word file");
    await expect(item(page, 2).locator(".vbadge")).toHaveText(["Original"]);

    await ref(page, "version-view-2").click();
    await expect(ref(page, "version-view-2")).toHaveText("Hide");
    await expect(ref(page, "version-preview")).toContainText(`Viewing the version from ${original}. This isn’t the current version.`);

    await ref(page, "version-restore-2").click();
    const confirm = page.getByRole("dialog", { name: "Restore this version?" });
    await expect(confirm).toBeVisible();
    await ref(confirm, "restore-confirm").click();
    await expect.poll(() => new URL(page.url()).hash).toBe(t.hash);
    await expect(ref(page, "restored")).toContainText(`Restored the version from ${original}. The version it replaced is kept in Versions.`);

    await ref(page, "edit-versions").click();
    await expect(list).toHaveCount(4);
    await expect(item(page, 0).locator(".vt small")).toHaveText(`Restored from ${original}`);
    await expect(item(page, 0).locator(".vbadge")).toHaveText(["Current"]);
    await expect(item(page, 1).locator(".vt small")).toHaveText("Your edit");
    await expect(item(page, 2).locator(".vt small")).toHaveText("Saved from another device");
    await expect(item(page, 3).locator(".vt small")).toHaveText("Original — converted from your Word file");
    await expect(item(page, 3).locator(".vbadge")).toHaveText(["Original"]);
  });

  test("a document's versions: Replaced with, Restored and the Original", async ({ page, context, baseURL }) => {
    const d = need(docs.find((x) => x.kind === "pdf" && existsSync(join(CONTENT, "files", x.id))), "PDF with its files under content/files");
    const { fake } = await world(context, baseURL, { seed: true });
    const extra = `content/files/${d.id}/New scan.pdf`;
    fake.commitFiles({ [extra]: "%PDF-1.4 new scan" }, {
      message: commitMessage(`Replace: ${d.name}`, { kind: "doc-replace", changed: [d.id], file: "New scan.pdf" }),
      date: "2026-10-02T00:00:00Z",
    });
    fake.commitFiles({ [extra]: null }, { message: commitMessage(`Restore: ${d.name}`, { kind: "doc-restore", changed: [d.id] }), date: "2026-10-03T00:00:00Z" });
    await openPage(page, "#/");
    await signIn(page);
    await openPage(page, versionsHash(buildPageKey("doc", d.id)));
    const list = ref(page, "versions-list").locator(":scope > li");
    await expect(list).toHaveCount(3);
    await expect(item(page, 0).locator(".vt b")).toHaveText(await shownTime(page, "2026-10-03T00:00:00Z"));
    await expect(item(page, 0).locator(".vt small")).toHaveText("Restored");
    await expect(item(page, 0).locator(".vbadge")).toHaveText(["Current"]);
    await expect(item(page, 1).locator(".vt small")).toHaveText("Replaced with “New scan.pdf”");
    await expect(item(page, 2).locator(".vt b")).toHaveText(await shownTime(page, IMPORT_DATE));
    await expect(item(page, 2).locator(".vt small")).toHaveText("Original — as first published");
    await expect(item(page, 2).locator(".vbadge")).toHaveText(["Original"]);
  });
});

// ---- 9. pharm section in edit mode ----------------------------------------------------------------------

test("a pharm section opens every card for editing, and Done returns the cards to how they were", async ({ page, context, baseURL }) => {
  const target = need(
    inGuides((g, n) => {
      for (const s of n.systems) {
        const sys = readData<SystemJson>(systemPath(g, s.id));
        const sec = sys.pharm?.sections.find((x) => x.cards.length >= 2);
        if (sec) return { g, sys, sec };
      }
      return undefined;
    }),
    "pharm section with two or more cards",
  );
  const { g, sys, sec } = target;
  const cardText = (blocks: string[]): string | null => {
    for (const b of blocks) {
      const doc = sys.notesBlocks[b]?.doc;
      const p = doc ? findPath(doc, (n) => n.type === "text" && String(n.text).trim().length >= 8) : null;
      if (doc && p) return String(nodeAt(doc, p).text).trim();
    }
    return null;
  };
  const texts = [
    ...sec.cards.map((k) => cardText(sys.cards[k]?.blocks ?? [])),
    ...[sec.overview, sec.lo].map((k) => (k === null ? null : cardText(sys.parts[k]?.blocks ?? []))),
  ].filter((x): x is string => x !== null);
  expect(texts.length).toBeGreaterThanOrEqual(2);

  await world(context, baseURL, { seed: true });
  await openPage(page, guideViewHash(g, { kind: "pharm", system: sys.id, section: sec.id, target: null }));
  await signIn(page);
  const card = (k: string): Locator => page.locator(`section.phc[data-anchor="${k}"]`);
  const [first, ...rest] = sec.cards;
  const opened = need(first, "card");
  await card(opened).locator(".phc-h button").click();
  await expect(card(opened)).toHaveClass(/(^| )open( |$)/);
  for (const k of rest) await expect(card(k)).not.toHaveClass(/(^| )open( |$)/);

  const area = await startEditing(page);
  for (const text of texts) {
    await expect(area.locator('.edit-slot [contenteditable="true"]').filter({ hasText: text }).first()).toBeVisible();
  }
  await ref(page, "edit-done").click();
  await expect(ref(page, "edit-area")).toHaveCount(0);
  await expect(card(opened)).toHaveClass(/(^| )open( |$)/);
  for (const k of rest) await expect(card(k)).not.toHaveClass(/(^| )open( |$)/);
});

test("an edit to a card's rows of her page table saves to her one stored table, and her page shows it", async ({ page, context, baseURL }) => {
  // A card part that cuts rows from a table stored on one of her Word pages.
  const target = need(
    inGuides((g, n) => {
      for (const s of n.systems) {
        const sys = readData<SystemJson>(systemPath(g, s.id));
        for (const sec of sys.pharm?.sections ?? []) {
          for (const k of sec.cards) {
            for (const part of sys.cards[k]?.parts ?? []) {
              const block = part.blocks[0];
              const row = part.rows?.[1];
              const host = block === undefined ? undefined : docs.find((d) => d.blocks?.some((b) => b.id === block));
              if (block !== undefined && row !== undefined && host) return { g, sys, sec, k, block, row, host };
            }
          }
        }
      }
      return undefined;
    }),
    "pharm card part cutting rows from a table on her Word page",
  );
  const { g, sys, sec, k, block, row, host } = target;
  // The paragraphs sitting directly in the cells of the part's own (non-heading) row.
  const table = need(sys.notesBlocks[block]?.doc, `notes block ${block}`);
  const rowPath = need(findPath(table, (n) => n.type === "table_row" && isRec(n.attrs) && n.attrs.id === row), `row ${row}`);
  const cells = nodeAt(table, rowPath).content;
  const rowTexts = (Array.isArray(cells) ? cells : [])
    .flatMap((cell: unknown) => (isRec(cell) && Array.isArray(cell.content) ? cell.content : []))
    .filter((n: unknown) => isRec(n) && n.type === "paragraph")
    .map((n: unknown) => textOf(n).trim())
    .filter((text) => text.length >= 8);

  const { fake, seed } = await world(context, baseURL, { seed: true });
  await openPage(page, guideViewHash(g, { kind: "pharm", system: sys.id, section: sec.id, target: null }));
  await signIn(page);
  const card = page.locator(`section.phc[data-anchor="${k}"]`);
  await card.locator(".phc-h button").click();
  for (const text of rowTexts) await expect(card).toContainText(text);

  // The edit area also holds her guide's own drug table, which can repeat a cell's text: edit a paragraph
  // of the row that appears in the edit area once (the saved file below proves which table it was).
  const area = await startEditing(page);
  const paragraph = (text: string): Locator => area.locator('.edit-slot [contenteditable="true"] p').filter({ hasText: text });
  let cellText: string | null = null;
  for (const text of rowTexts) {
    if ((await paragraph(text).count()) === 1) {
      cellText = text;
      break;
    }
  }
  if (cellText === null) throw new Error(`every paragraph of row ${row} also appears elsewhere in the edit area`);
  const marker = newMarker();
  await paragraph(cellText).click({ position: { x: 1, y: 2 } });
  await page.keyboard.press("Home");
  await page.keyboard.type(marker);
  await expect(ref(page, "edit-dirty-state")).toHaveText("Unsaved changes");
  await ref(page, "edit-save").click();
  await expect(ref(page, "save-success")).toBeVisible();

  expect(fake.head()).not.toBe(seed);
  const changed = changedFiles(fake);
  expect([...changed.keys()].filter((path) => path.endsWith(".json"))).toEqual([`content/docs/${host.id}/blocks/${block}.json`]);
  expect(changed.get(`content/docs/${host.id}/blocks/${block}.json`)).toContain(marker);
  await expect(ref(page, "edit-area")).toHaveCount(0);
  await expect(card).toContainText(`${marker}${cellText}`);

  await openPage(page, fileHash(host.id, null));
  await expect(page.locator("main")).toContainText(`${marker}${cellText}`);
});

// ---- 10–14. documents --------------------------------------------------------------------------------------

const place = (): OtherJson["sections"][number] => need(other.sections[0], "Other section");
const placeHash = (): string => otherHash(place().id);

async function openAdd(page: Page): Promise<Locator> {
  await ref(page, "add-doc").click();
  const dialog = page.getByRole("dialog", { name: `Add a document to ${place().title}` });
  await expect(dialog).toBeVisible();
  return dialog;
}

const smallPdf = (name: string): { name: string; mimeType: string; buffer: Buffer } => ({ name, mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.4 ${name}`) });

/** Nothing reached GitHub: no write and no dispatch. */
function nothingUploaded(fake: FakeGithub): void {
  expect(fake.writes()).toEqual([]);
  expect(fake.dispatches).toEqual([]);
}

/** Adds `file` named `name` to the Other section; resolves to the new document's id once the job is dispatched. */
async function addDocument(page: Page, fake: FakeGithub, file: string | { name: string; mimeType: string; buffer: Buffer }, name?: string): Promise<string> {
  const dialog = await openAdd(page);
  await ref(dialog, "add-doc-file").setInputFiles(file);
  if (name !== undefined) await ref(dialog, "add-doc-name").fill(name);
  const shown = await ref(dialog, "add-doc-name").inputValue();
  await ref(dialog, "add-doc-confirm").click();
  await expect(dialog).toBeHidden();
  await expect(toast(page)).toContainText(`Added “${shown}”. Everyone will see it within a few minutes, and search includes it.`);
  await expect(ref(page, "pending-docs").locator("li").last()).toContainText(shown);
  await expect.poll(() => fake.dispatches.length, { timeout: 120_000 }).toBe(1);
  const dispatch = need(fake.dispatches[0], "dispatch");
  expect(dispatch.workflow).toBe("process-inbox.yml");
  return String(dispatch.inputs.item);
}

test.describe("Add document checks leave nothing uploaded", () => {
  test("a .txt file is refused", async ({ page, context, baseURL }) => {
    const { fake } = await world(context, baseURL, { seed: true });
    await openPage(page, placeHash());
    await signIn(page);
    const dialog = await openAdd(page);
    await ref(dialog, "add-doc-file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("plain text") });
    await expect(ref(dialog, "add-doc-error")).toHaveText("That file type can’t be added. Use a Word file, a PDF, an image (PNG or JPG) or a PowerPoint.");
    await ref(dialog, "add-doc-confirm").click();
    await expect(ref(dialog, "add-doc-error")).toHaveText("Choose a file first.");
    nothingUploaded(fake);
  });

  test("a file over 100 MB is refused", async ({ page, context, baseURL }, testInfo) => {
    const { fake } = await world(context, baseURL, { seed: true });
    const path = testInfo.outputPath("Huge scan.pdf");
    const fd = openSync(path, "w");
    try {
      ftruncateSync(fd, 101 * MiB);
    } finally {
      closeSync(fd);
    }
    await openPage(page, placeHash());
    await signIn(page);
    const dialog = await openAdd(page);
    await ref(dialog, "add-doc-file").setInputFiles(path);
    await expect(ref(dialog, "add-doc-error")).toHaveText("This file is 101 MB. The site’s free hosting holds files up to 100 MB.");
    await ref(dialog, "add-doc-confirm").click();
    await expect(ref(dialog, "add-doc-error")).toHaveText("Choose a file first.");
    nothingUploaded(fake);
  });

  test("a file that would take the site past 1 GB is refused", async ({ page, context, baseURL }) => {
    const { fake } = await world(context, baseURL, { seed: true, siteBytes: 1_000_000_000 - 10 });
    await openPage(page, placeHash());
    await signIn(page);
    const dialog = await openAdd(page);
    await ref(dialog, "add-doc-file").setInputFiles(smallPdf("Lipids 2024.pdf"));
    await expect(ref(dialog, "add-doc-error")).toHaveCount(0);
    await ref(dialog, "add-doc-confirm").click();
    await expect(ref(dialog, "add-doc-error")).toHaveText("The site’s free hosting is full (1 GB). Remove a document to make room.");
    await expect(dialog).toBeVisible();
    nothingUploaded(fake);
  });
});

test("the name defaults to the file name without its extension, and a typed name is kept", async ({ page, context, baseURL }) => {
  await world(context, baseURL, { seed: true });
  await openPage(page, placeHash());
  await signIn(page);
  let dialog = await openAdd(page);
  await expect(ref(dialog, "add-doc-name")).toHaveValue("");
  await ref(dialog, "add-doc-file").setInputFiles(smallPdf("Lipids 2024.pdf"));
  await expect(ref(dialog, "add-doc-name")).toHaveValue("Lipids 2024");
  await ref(dialog, "add-doc-cancel").click();

  dialog = await openAdd(page);
  await ref(dialog, "add-doc-name").fill("My lipid notes");
  await ref(dialog, "add-doc-file").setInputFiles(smallPdf("Lipids 2024.pdf"));
  await expect(ref(dialog, "add-doc-name")).toHaveValue("My lipid notes");
});

test.describe("documents", () => {
  test("Add appends the document with its toast; Add asks for a file and a name first", async ({ page, context, baseURL }) => {
    const { fake } = await world(context, baseURL, { seed: true });
    await openPage(page, placeHash());
    await signIn(page);
    const dialog = await openAdd(page);
    await ref(dialog, "add-doc-confirm").click();
    await expect(ref(dialog, "add-doc-error")).toHaveText("Choose a file first.");
    await ref(dialog, "add-doc-file").setInputFiles(smallPdf("Lipids 2024.pdf"));
    await ref(dialog, "add-doc-name").fill("   ");
    await ref(dialog, "add-doc-confirm").click();
    await expect(ref(dialog, "add-doc-error")).toHaveText("Give the document a name.");
    nothingUploaded(fake);
    await ref(dialog, "add-doc-cancel").click();

    const id = await addDocument(page, fake, smallPdf("Lipids 2024.pdf"));
    const main = need(fake.commit(fake.head()), "doc-add commit");
    expect(main.message).toContain("Pa-Studying-Kind: doc-add");
    expect(JSON.parse(need(fake.readFile(`content/files/${id}/file.json`), "the added record"))).toMatchObject({ state: "processing", original: "Lipids 2024.pdf" });
  });

  const asIsDoc = (): DocRef => need(place().files.files.find((f) => f.kind === "pdf"), `PDF listed in Other › ${place().title}`);

  test("Rename checks the name, renames, and Undo renames back", async ({ page, context, baseURL }) => {
    const asIs = asIsDoc();
    const { fake, seed } = await world(context, baseURL, { seed: true });
    await openPage(page, fileHash(asIs.id, placeHash()));
    await signIn(page);
    await ref(page, "doc-rename").click();
    const dialog = page.getByRole("dialog", { name: "Rename document" });
    await ref(dialog, "doc-rename-name").fill("");
    await ref(dialog, "doc-rename-save").click();
    await expect(dialog.locator("p.fld-err")).toHaveText("Give the document a name.");
    expect(fake.head()).toBe(seed);
    await ref(dialog, "doc-rename-name").fill("Renamed scan");
    await ref(dialog, "doc-rename-save").click();
    await expect(toast(page)).toContainText("Renamed to “Renamed scan”.");
    await expect(page.locator("main h1").first()).toHaveText("Renamed scan");
    const renamed = fake.head();
    expect(need(fake.commit(renamed), "rename").message).toContain("Pa-Studying-Kind: doc-rename");
    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect.poll(() => fake.head()).not.toBe(renamed);
    await expect(page.locator("main h1").first()).toHaveText(asIs.name);
    expect(need(fake.commit(fake.head()), "undo").message).toContain("Pa-Studying-Kind: doc-rename");
  });

  test("Replace says the previous file is kept in Versions", async ({ page, context, baseURL }) => {
    const asIs = asIsDoc();
    await world(context, baseURL, { seed: true });
    await openPage(page, fileHash(asIs.id, placeHash()));
    await signIn(page);
    await ref(page, "doc-replace-file").setInputFiles(smallPdf("New scan.pdf"));
    await expect(toast(page)).toContainText(`Replaced “${asIs.name}” with New scan.pdf. The previous file is kept in Versions.`);
  });

  test("Remove returns to the page it was opened from, with an 8 second Undo that restores it", async ({ page, context, baseURL }) => {
    const asIs = asIsDoc();
    const { fake } = await world(context, baseURL, { seed: true });
    await openPage(page, placeHash());
    await signIn(page);
    const chip = page.locator(`main a[href^="#/file/${asIs.id}"]`).first();
    await chip.click();
    await expect(page.locator("main h1").first()).toHaveText(asIs.name);
    await ref(page, "doc-remove").click();
    const dialog = page.getByRole("dialog", { name: `Remove “${asIs.name}”?` });
    await ref(dialog, "doc-remove-confirm").click();
    await expect.poll(() => new URL(page.url()).hash).toBe(placeHash());
    await expect(toast(page)).toContainText(`Removed “${asIs.name}”.`);
    expect(need(fake.commit(fake.head()), "remove").message).toContain("Pa-Studying-Kind: doc-remove");
    await expect(page.locator(`main a[href^="#/file/${asIs.id}"]`)).toHaveCount(0);
    await expect(ref(page, "removed-docs-toggle")).toHaveText(`Show removed documents (${place().files.removed.length + 1})`);

    // The Undo stays for 8 seconds.
    await page.waitForTimeout(7_000);
    await expect(toast(page).getByRole("button", { name: "Undo" })).toBeVisible();
    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect(toast(page)).toContainText(`Restored “${asIs.name}”.`);
    expect(need(fake.commit(fake.head()), "restore").message).toContain("Pa-Studying-Kind: doc-restore");
    await expect(page.locator(`main a[href^="#/file/${asIs.id}"]`).first()).toBeVisible();
  });

  test("the Remove toast goes after 8 seconds", async ({ page, context, baseURL }) => {
    const asIs = asIsDoc();
    await world(context, baseURL, { seed: true });
    await openPage(page, fileHash(asIs.id, placeHash()));
    await signIn(page);
    await ref(page, "doc-remove").click();
    await ref(page.getByRole("dialog", { name: `Remove “${asIs.name}”?` }), "doc-remove-confirm").click();
    await expect(toast(page)).toContainText(`Removed “${asIs.name}”.`);
    await page.waitForTimeout(6_500);
    await expect(toast(page)).toContainText(`Removed “${asIs.name}”.`);
    await expect(toast(page)).toHaveCount(0, { timeout: 4_000 });
  });

  /** Every pharm page (system level) that lists `docId`. */
  function pharmPlaces(docId: string): { hash: string; removed: number }[] {
    const out: { hash: string; removed: number }[] = [];
    for (const { g, nav } of navs) {
      for (const s of nav.systems) {
        if (!s.pharm) continue;
        const files = readData<SystemJson>(systemPath(g, s.id)).pharm?.files;
        if (files?.files.some((f) => f.id === docId)) {
          out.push({ hash: guideViewHash(g, { kind: "pharm", system: s.id, section: null, target: null }), removed: files.removed.length });
        }
      }
    }
    return out;
  }

  test("a removed pharm document shows under Show removed documents at every pharm page that listed it, and Restore brings it back everywhere", async ({ page, context, baseURL }) => {
    const pharmDocs = [...new Set(docs.map((d) => d.id))].map((id) => ({ id, places: pharmPlaces(id) })).filter((x) => x.places.length >= 2);
    const target = need(pharmDocs.sort((a, b) => b.places.length - a.places.length)[0], "document listed on two or more pharm pages");
    const name = need(docs.find((d) => d.id === target.id), "document").name;
    const [home, ...others] = target.places;
    const first = need(home, "pharm place");
    await world(context, baseURL, { seed: true });
    await openPage(page, first.hash);
    await signIn(page);
    await page.locator(`main a[href^="#/file/${target.id}"]`).first().click();
    await ref(page, "doc-remove").click();
    await ref(page.getByRole("dialog", { name: `Remove “${name}”?` }), "doc-remove-confirm").click();
    await expect.poll(() => new URL(page.url()).hash).toBe(first.hash);
    await expect(toast(page)).toContainText(`Removed “${name}”.`);

    for (const p of [first, ...others]) {
      await openPage(page, p.hash);
      await expect(ref(page, "removed-docs-toggle")).toHaveText(`Show removed documents (${p.removed + 1})`);
      await expect(page.locator(`main a[href^="#/file/${target.id}"]`)).toHaveCount(0);
    }

    const last = need(others.at(-1), "second pharm place");
    await ref(page, "removed-docs-toggle").click();
    await ref(page, `restore-doc-${target.id}`).click();
    await expect(toast(page)).toContainText(`Restored “${name}”.`);
    for (const p of [last, first, ...others]) {
      await openPage(page, p.hash);
      await expect(page.locator(`main a[href^="#/file/${target.id}"]`).first()).toBeVisible();
      if (p.removed === 0) await expect(ref(page, "removed-docs")).toHaveCount(0);
      else await expect(ref(page, "removed-docs-toggle")).toHaveText(`Show removed documents (${p.removed})`);
    }
  });

  test("a removed PANCE sidebar document shows under Show removed documents in the PANCE sidebar, and Restore brings it back", async ({ page, context, baseURL }) => {
    const pance = need(navs.find((x) => x.g === PANCE), "PANCE guide").nav;
    const d = need(pance.sidebarEnd, "PANCE sidebar document");
    const home = guideViewHash(PANCE, { kind: "home" });
    const sidebar = page.locator("#site-sidebar");
    await world(context, baseURL, { seed: true });
    await openPage(page, fileHash(d.id, home));
    await signIn(page);
    await ref(page, "doc-remove").click();
    await ref(page.getByRole("dialog", { name: `Remove “${d.name}”?` }), "doc-remove-confirm").click();
    await expect.poll(() => new URL(page.url()).hash).toBe(home);

    await openPage(page, home);
    await expect(ref(sidebar, "removed-docs-toggle")).toHaveText(`Show removed documents (${pance.removed.length + 1})`);
    await expect(sidebar.locator(`a[href^="#/file/${d.id}"]`)).toHaveCount(0);
    await ref(sidebar, "removed-docs-toggle").click();
    await ref(sidebar, `restore-doc-${d.id}`).click();
    await expect(toast(page)).toContainText(`Restored “${d.name}”.`);
    await openPage(page, home);
    await expect(sidebar.locator(`a[href^="#/file/${d.id}"]`).first()).toBeVisible();
  });

  test("a removed general-topic document shows under Show removed documents on the general topic, and Restore brings it back", async ({ page, context, baseURL }) => {
    const target = need(
      inGuides((g, n) => {
        for (const t of n.general) {
          const f = readData<GeneralJson>(generalPath(g, t.key)).files;
          const d = f.files[0];
          if (d) return { hash: guideViewHash(g, { kind: "general", key: t.key }), d, removed: f.removed.length };
        }
        return undefined;
      }),
      "general topic that lists a document",
    );
    await world(context, baseURL, { seed: true });
    await openPage(page, fileHash(target.d.id, target.hash));
    await signIn(page);
    await ref(page, "doc-remove").click();
    await ref(page.getByRole("dialog", { name: `Remove “${target.d.name}”?` }), "doc-remove-confirm").click();
    await expect.poll(() => new URL(page.url()).hash).toBe(target.hash);
    await openPage(page, target.hash);
    await expect(ref(page, "removed-docs-toggle")).toHaveText(`Show removed documents (${target.removed + 1})`);
    await ref(page, "removed-docs-toggle").click();
    await ref(page, `restore-doc-${target.d.id}`).click();
    await expect(toast(page)).toContainText(`Restored “${target.d.name}”.`);
    await openPage(page, target.hash);
    await expect(page.locator(`main a[href^="#/file/${target.d.id}"]`).first()).toBeVisible();
  });
});

// ---- 13. upload ---------------------------------------------------------------------------------------------

/** A sparse file of `bytes` with a 48-byte tag at the start of each 16 MiB part. */
function partedFile(path: string, bytes: number, tags: string[]): { sha256: string; prefixes: string[] } {
  const fd = openSync(path, "w");
  const prefixes: string[] = [];
  try {
    ftruncateSync(fd, bytes);
    tags.forEach((tag, i) => {
      const mark = Buffer.from(tag.padEnd(48, "#").slice(0, 48), "latin1");
      writeSync(fd, mark, 0, 48, i * 16 * MiB);
      prefixes.push(mark.toString("base64"));
    });
  } finally {
    closeSync(fd);
  }
  return { sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), prefixes };
}

test.describe("upload", () => {
  test("a 40 MB file goes as three parts of 16 MB or less", async ({ page, context, baseURL }, testInfo) => {
    const { fake } = await world(context, baseURL, { seed: true });
    const path = testInfo.outputPath("Big scan.pdf");
    const file = partedFile(path, 40 * MiB, ["PART-ZERO", "PART-ONE", "PART-TWO"]);
    await openPage(page, placeHash());
    await signIn(page);
    const id = await addDocument(page, fake, path);
    const branch = `refs/heads/inbox/${id}`;
    expect(fake.hasRef(branch)).toBe(true);
    const parts = [0, 1, 2].map((i) => need(fake.readBytes(`${inboxItemDir(id)}/${partName(i)}`, branch), `part ${i}`));
    expect(parts.map((p) => p.byteLength)).toEqual([16 * MiB, 16 * MiB, 8 * MiB]);
    expect(fake.readBytes(`${inboxItemDir(id)}/${partName(3)}`, branch)).toBeUndefined();
    const joined = createHash("sha256");
    for (const p of parts) joined.update(p);
    expect(joined.digest("hex")).toBe(file.sha256);
    for (const prefix of file.prefixes) expect(blobPosts(fake, prefix)).toHaveLength(1);
  });

  test("a part that fails twice is sent again and the upload finishes", async ({ page, context, baseURL }, testInfo) => {
    const { fake } = await world(context, baseURL, { seed: true });
    const path = testInfo.outputPath("Retry scan.pdf");
    const file = partedFile(path, 20 * MiB, ["RETRY-ZERO", "RETRY-ONE"]);
    const second = need(file.prefixes[1], "part 1");
    fake.fail((r) => r.method === "POST" && r.url.endsWith("/git/blobs") && (r.body ?? "").includes(`"content":"${second}`), "network", 2);
    await openPage(page, placeHash());
    await signIn(page);
    const id = await addDocument(page, fake, path);
    expect(blobPosts(fake, second)).toHaveLength(1);
    expect(need(fake.readBytes(`${inboxItemDir(id)}/${partName(1)}`, `refs/heads/inbox/${id}`), "part 1").byteLength).toBe(4 * MiB);
    await expect(ref(page, "upload-failed")).toHaveCount(0);
  });

  test("a part that keeps failing shows the offline banner, and Try again resumes without re-sending finished parts", async ({ page, context, baseURL }, testInfo) => {
    test.setTimeout(300_000);
    const { fake } = await world(context, baseURL, { seed: true });
    const path = testInfo.outputPath("Offline scan.pdf");
    const file = partedFile(path, 20 * MiB, ["OFFLINE-ZERO", "OFFLINE-ONE"]);
    const firstPart = need(file.prefixes[0], "part 0");
    const secondPart = need(file.prefixes[1], "part 1");
    let down = true;
    fake.fail((r) => down && r.method === "POST" && r.url.endsWith("/git/blobs") && (r.body ?? "").includes(`"content":"${secondPart}`), "network", 1000);
    await openPage(page, placeHash());
    await signIn(page);
    const dialog = await openAdd(page);
    await ref(dialog, "add-doc-file").setInputFiles(path);
    await ref(dialog, "add-doc-confirm").click();
    await expect(dialog).toBeHidden();

    const failed = ref(page, "upload-failed");
    await expect(failed).toContainText("Couldn’t save — no internet connection.", { timeout: 120_000 });
    expect(fake.dispatches).toEqual([]);
    expect(blobPosts(fake, firstPart)).toHaveLength(1);
    expect(blobPosts(fake, secondPart)).toHaveLength(0);

    down = false;
    await ref(failed, "upload-retry").click();
    await expect.poll(() => fake.dispatches.length, { timeout: 120_000 }).toBe(1);
    expect(blobPosts(fake, firstPart)).toHaveLength(1);
    expect(blobPosts(fake, secondPart)).toHaveLength(1);
    await expect(failed).toHaveCount(0);
  });
});

// ---- 14. processing and failed documents -------------------------------------------------------------------

test.describe("processing and failed documents", () => {
  test("a processing document shows its name, Download original and the processing note, to her only", async ({ page, context, baseURL, browser }) => {
    const { fake } = await world(context, baseURL, { seed: true });
    await openPage(page, placeHash());
    await signIn(page);
    const bytes = Buffer.from("%PDF-1.4 lipids 2024 original");
    const id = await addDocument(page, fake, { name: "Lipids 2024.pdf", mimeType: "application/pdf", buffer: bytes });
    const hash = fileHash(id, placeHash());

    await openPage(page, hash);
    const pending = ref(page, "pending-doc");
    await expect(pending.locator("h1")).toHaveText("Lipids 2024");
    await expect(ref(pending, "doc-processing")).toHaveText("It will show here within a few minutes.");
    const download = page.waitForEvent("download");
    await ref(pending, "pending-download").click();
    const got = await download;
    expect(got.suggestedFilename()).toBe("Lipids 2024.pdf");
    expect(readFileSync(need(await got.path(), "downloaded file"))).toEqual(bytes);
    await expect(ref(pending, "pending-download")).toHaveText("Download original");

    const visitor = await browser.newContext({ baseURL });
    await missingDataIs404(visitor);
    try {
      const v = await visitor.newPage();
      await open(v, hash);
      await expect(v.locator("main h1").first()).toHaveText(NOT_ON_SITE);
      await openPage(v, placeHash());
      await expect(ref(v, "pending-docs")).toHaveCount(0);
    } finally {
      await visitor.close();
    }
  });

  test("a failed document shows the failure text with Download original, Rename and Remove, to her only", async ({ page, context, baseURL, browser }) => {
    const { fake } = await world(context, baseURL, { seed: true });
    await openPage(page, placeHash());
    await signIn(page);
    const id = await addDocument(page, fake, smallPdf("Lipids 2024.pdf"));
    const recordPath = `content/files/${id}/file.json`;
    const record: unknown = JSON.parse(need(fake.readFile(recordPath), "the added record"));
    if (!isRec(record)) throw new Error("the added record is not an object");
    fake.commitFiles({ [recordPath]: serializeFile(recordPath, { ...record, state: "failed" }) }, { message: commitMessage(`Inbox: ${id}`, { kind: "inbox" }) });
    const hash = fileHash(id, placeHash());

    await openPage(page, hash);
    const pending = ref(page, "pending-doc");
    await expect(pending.locator("h1")).toHaveText("Lipids 2024");
    await expect(ref(pending, "doc-failed")).toHaveText("This file couldn’t be shown on the site. You can download it, or remove it and try another copy.");
    await expect(ref(pending, "pending-download")).toHaveText("Download original");
    await expect(ref(page, "doc-rename")).toBeVisible();
    await expect(ref(page, "doc-remove")).toBeVisible();

    const visitor = await browser.newContext({ baseURL });
    await missingDataIs404(visitor);
    try {
      const v = await visitor.newPage();
      await open(v, hash);
      await expect(v.locator("main h1").first()).toHaveText(NOT_ON_SITE);
    } finally {
      await visitor.close();
    }
  });
});

