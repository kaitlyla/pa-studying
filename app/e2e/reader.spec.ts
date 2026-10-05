// The reading site (99 reader.spec.ts list) against the built site and the content the import and
// curation produced. Every expectation is derived from the published data, so the spec follows the content.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type {
  DocJson,
  GeneralJson,
  HomeJson,
  NavEntry,
  NavJson,
  OtherJson,
  RefTabJson,
  SiteJson,
  SlidesJson,
  SystemJson,
  WorkupJson,
} from "../../lib/derive/published.ts";
import { fileHash, guideBase, guideViewHash, isRefTab, otherHash, parseHash, pharmLoc, refHash, TAB_LABELS } from "../../lib/derive/routes.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DATA = join(ROOT, "dist", "data");

function read<T>(rel: string): T {
  return JSON.parse(readFileSync(join(DATA, rel), "utf8")) as T;
}

const site = read<SiteJson>("site.json");
const eors = site.eors.map((e) => e.id);
const navs = new Map<string, NavJson>(eors.map((g) => [g, read<NavJson>(`g/${g}/nav.json`)]));

function navOf(g: string): NavJson {
  const n = navs.get(g);
  if (!n) throw new Error(`no nav for ${g}`);
  return n;
}

const systemOf = (g: string, s: string): SystemJson => read<SystemJson>(`g/${g}/s/${s}.json`);
const guideName = (g: string): string => site.guideNames[g] ?? g;
/** The guide file's name without its extension, as the guide home and the PDF menu show it. */
const guideFile = (nav: NavJson): string => nav.source.replace(/\.[A-Za-z0-9]+$/, "");
/** The picker's word for a guide's top-level groups (Psychiatry and OB call them sections). */
const systemsWord = (g: string, n: number): string => (g === "psy" || g === "ob" ? (n === 1 ? "section" : "sections") : n === 1 ? "system" : "systems");
const topicHash = (g: string, ids: string[]): string => guideViewHash(g, { kind: "topics", ids });
const pharmHash = (g: string, system: string, section: string | null = null, target: string | null = null): string =>
  guideViewHash(g, { kind: "pharm", system, section, target });

/** Every EOR system, with its guide. */
const allSystems = eors.flatMap((g) => navOf(g).systems.map((s) => ({ g, s })));

/** Every visible document's published record. */
const docs: DocJson[] = existsSync(join(DATA, "docs"))
  ? readdirSync(join(DATA, "docs"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => read<DocJson>(join("docs", f)))
  : [];

const hashOf = (page: Page): string => new URL(page.url()).hash;
const side = (page: Page): Locator => page.locator("#site-sidebar");
const main = (page: Page): Locator => page.locator("main");
const h1 = (page: Page): Locator => main(page).locator(".ph h1");
const sysRow = (scope: Locator, page: Page, title: string): Locator =>
  scope.locator(".sys > .sys-row").filter({ has: page.getByTitle(title, { exact: true }) });
const entLink = (scope: Locator, page: Page, title: string): Locator => scope.locator("a.ent").and(page.getByTitle(title, { exact: true }));
const setOwner = (page: Page): Promise<void> => page.evaluate(() => document.documentElement.setAttribute("data-owner", ""));
const setVisitor = (page: Page): Promise<void> => page.evaluate(() => document.documentElement.removeAttribute("data-owner"));

async function open(page: Page, hash: string): Promise<void> {
  await page.goto(`./${hash}`);
}

/** A list of sidebar topic entries (a system's flat list or one section's) with at least `n` topics. */
function topicList(n: number): { g: string; list: NavEntry[] } {
  for (const { g, s } of allSystems) {
    for (const list of [s.entries, ...s.sections.map((x) => x.entries)]) {
      const topics = list.filter((e) => e.kind === "topic");
      if (topics.length >= n) return { g, list: topics };
    }
  }
  throw new Error(`no sidebar list has ${n} topics`);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
});

test.describe("picker", () => {
  test("shows 7 EORs with system and general-topic counts, one column at 390 px", async ({ page }) => {
    expect(site.eors).toHaveLength(7);
    await open(page, "#/eor");
    const cards = main(page).locator(".pick .card");
    await expect(cards).toHaveCount(7);
    for (const [i, e] of site.eors.entries()) {
      await expect(cards.nth(i).locator(".cn")).toHaveText(e.name);
      await expect(cards.nth(i).locator(".cm")).toHaveText(
        `${e.systems.length} ${systemsWord(e.id, e.systems.length)} · ${e.general} general ${e.general === 1 ? "topic" : "topics"}`,
      );
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".site")).toHaveClass(/\bis-phone\b/);
    const boxes = await cards.evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, w: r.width })));
    const [first, ...rest] = boxes;
    if (!first) throw new Error("no cards");
    for (const b of rest) {
      expect(b.x).toBe(first.x);
      expect(b.w).toBe(first.w);
    }
    expect(boxes.map((b) => b.y)).toEqual([...boxes.map((b) => b.y)].sort((a, b) => a - b));
  });

  test("the picker's guide, a system's pharm row and a general topic each open", async ({ page }) => {
    const pick = allSystems.find(({ g, s }) => s.pharm !== null && navOf(g).general.some((x) => x.key !== "workup"));
    if (!pick) throw new Error("no EOR has both a pharm system and a general topic");
    const { g, s } = pick;
    const nav = navOf(g);
    await open(page, "#/eor");
    await main(page).locator(".pick .card").nth(eors.indexOf(g)).click();
    await expect.poll(() => hashOf(page)).toBe(guideBase(g));
    await expect(h1(page)).toHaveText(guideFile(nav));

    await sysRow(side(page), page, `${s.title} pharm`).locator("a.sys-name").click();
    await expect.poll(() => hashOf(page)).toBe(pharmHash(g, s.id));
    await expect(h1(page)).toHaveText(`${s.title} pharm`);

    const gen = nav.general.find((x) => x.key !== "workup");
    if (!gen) throw new Error("no general topic");
    await side(page).locator(".gen a.ent", { hasText: gen.label }).first().click();
    await expect.poll(() => hashOf(page)).toBe(guideViewHash(g, { kind: "general", key: gen.key }));
    await expect(h1(page)).toHaveText(`${gen.label} for ${guideName(g)}`);
  });
});

test.describe("sidebar", () => {
  test("« Hide leaves the 40 px rail and » restores it, focus follows, aria-expanded is set, the choice persists, no rail at 390 px", async ({ page }) => {
    const g = eors[0];
    if (!g) throw new Error("no EOR");
    const s = read<HomeJson>(`g/${g}/home.json`).systems[0];
    if (!s) throw new Error(`${g} has no systems`);
    await open(page, guideBase(g));
    const hide = page.locator(".side-collapse");
    const show = page.getByRole("button", { name: "Show sidebar" });
    await expect(hide).toHaveAttribute("aria-expanded", "true");
    await hide.click();
    await expect(side(page)).toHaveCount(0);
    await expect(page.locator(".side-rail")).toBeVisible();
    expect((await page.locator(".side-rail").boundingBox())?.width).toBe(40);
    await expect(show).toHaveAttribute("aria-expanded", "false");
    await expect(show).toBeFocused();

    // Across an in-app route change and a reload.
    await main(page).locator(".lnk a").first().click();
    await expect.poll(() => hashOf(page)).toBe(guideViewHash(g, { kind: "system", system: s.id }));
    await expect(page.locator(".side-rail")).toBeVisible();
    await page.reload();
    await expect(page.locator(".side-rail")).toBeVisible();
    await expect(side(page)).toHaveCount(0);

    await show.click();
    await expect(side(page)).toBeVisible();
    await expect(page.locator(".side-rail")).toHaveCount(0);
    await expect(hide).toBeFocused();

    await hide.click();
    await expect(page.locator(".side-rail")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".site")).toHaveClass(/\bis-phone\b/);
    await expect(page.locator(".side-rail")).toHaveCount(0);
    await expect(side(page)).toHaveCount(0);
  });

  test("inside an EOR there is no EOR switcher; the EOR breadcrumb returns to the picker", async ({ page }) => {
    const g = eors[0];
    if (!g) throw new Error("no EOR");
    await open(page, guideBase(g));
    const top = side(page).locator(".side-top");
    await expect(top.locator(".gname")).toHaveText(guideName(g));
    await expect(side(page).locator("select")).toHaveCount(0);
    await expect(side(page).getByRole("combobox")).toHaveCount(0);
    await expect(side(page).getByRole("listbox")).toHaveCount(0);
    await main(page).getByRole("navigation", { name: "Location" }).getByRole("link", { name: "EOR", exact: true }).click();
    await expect.poll(() => hashOf(page)).toBe("#/eor");
    await expect(main(page).locator(".pick h1")).toHaveText("EOR study guides");
  });

  test("a system name opens the system page and expands it; its arrow only expands or collapses", async ({ page }) => {
    const pick = allSystems.find(({ s }) => s.entries.length + s.sections.length > 0);
    if (!pick) throw new Error("no system with entries");
    const { g, s } = pick;
    await open(page, guideBase(g));
    const row = sysRow(side(page), page, s.title);
    const tog = row.locator(".sys-tog");
    await expect(tog).toHaveAttribute("aria-expanded", "false");
    await row.locator("a.sys-name").click();
    const sysHash = guideViewHash(g, { kind: "system", system: s.id });
    await expect.poll(() => hashOf(page)).toBe(sysHash);
    await expect(h1(page)).toContainText(s.title);
    await expect(tog).toHaveAttribute("aria-expanded", "true");
    const list = row.locator("xpath=following-sibling::ul[contains(concat(' ', @class, ' '), ' ents ')]");
    await expect(list).toBeVisible();

    await tog.click();
    await expect(tog).toHaveAttribute("aria-expanded", "false");
    await expect(list).toHaveCount(0);
    expect(hashOf(page)).toBe(sysHash);
    await tog.click();
    await expect(tog).toHaveAttribute("aria-expanded", "true");
    await expect(list).toBeVisible();
    expect(hashOf(page)).toBe(sysHash);
  });

  test("a section row's arrow expands it to show its entries and collapses it again, with aria-expanded following and the route unchanged", async ({ page }) => {
    const pick = allSystems.find(({ s }) => s.sections.some((x) => x.entries.length > 0));
    test.skip(!pick, "no system in the published content has sections");
    if (!pick) return;
    const { g, s } = pick;
    const sec = s.sections.find((x) => x.entries.length > 0);
    if (!sec) return;
    const sysHash = guideViewHash(g, { kind: "system", system: s.id });
    await open(page, sysHash);
    await expect(h1(page)).toContainText(s.title);
    const grp = side(page).locator("li.grp").filter({ has: page.locator(".grp-row").getByTitle(sec.title, { exact: true }) });
    const tog = grp.locator(".grp-row .sys-tog");
    await expect(tog).toHaveAttribute("aria-expanded", "false");
    await expect(grp.locator(".grp-ents")).toHaveCount(0);
    await tog.click();
    await expect(tog).toHaveAttribute("aria-expanded", "true");
    await expect(grp.locator(".grp-ents > li")).toHaveCount(sec.entries.length);
    for (const e of sec.entries) await expect(entLink(grp, page, e.title)).toBeVisible();
    expect(hashOf(page)).toBe(sysHash);
    await tog.click();
    await expect(tog).toHaveAttribute("aria-expanded", "false");
    await expect(grp.locator(".grp-ents")).toHaveCount(0);
    expect(hashOf(page)).toBe(sysHash);
  });

  test("clicking a topic replaces the page; + adds one below; two open each have ✕, read 'Comparing 2 topics', and Close others leaves one", async ({ page }) => {
    const { g, list } = topicList(3);
    const [a, b, c] = list;
    if (!a || !b || !c) throw new Error("need three topics");
    await open(page, topicHash(g, [a.id]));
    await expect(h1(page)).toHaveText(a.title);
    await entLink(side(page), page, b.title).click();
    await expect.poll(() => hashOf(page)).toBe(topicHash(g, [b.id]));
    await expect(h1(page)).toHaveText(b.title);
    await expect(main(page).locator(".tcard")).toHaveCount(1);

    await side(page).getByRole("link", { name: `Open ${c.title} alongside`, exact: true }).click();
    await expect.poll(() => hashOf(page)).toBe(topicHash(g, [b.id, c.id]));
    await expect(h1(page)).toHaveText("Comparing 2 topics");
    await expect(main(page).locator(".tcard")).toHaveCount(2);
    await expect(main(page).locator('.tcard .tcard-h button[aria-label^="Close "]')).toHaveCount(2);
    for (const card of await main(page).locator(".tcard").all()) await expect(card.locator('.tcard-h button[aria-label^="Close "]')).toBeVisible();

    await main(page).getByRole("button", { name: "Close others", exact: true }).click();
    await expect.poll(() => hashOf(page)).toBe(topicHash(g, [c.id]));
    await expect(main(page).locator(".tcard")).toHaveCount(1);
    await expect(h1(page)).toHaveText(c.title);
  });

  test("long topic names are cut to two lines with the full name in title; the page header shows the full name", async ({ page }) => {
    let pick: { g: string; e: NavEntry } | null = null;
    for (const { g, s } of allSystems) {
      for (const e of [...s.entries, ...s.sections.flatMap((x) => x.entries)]) {
        if (e.kind === "topic" && (!pick || e.title.length > pick.e.title.length)) pick = { g, e };
      }
    }
    if (!pick) throw new Error("no topics");
    const { g, e } = pick;
    await open(page, topicHash(g, [e.id]));
    await expect(h1(page)).toHaveText(e.title);
    const link = entLink(side(page), page, e.title);
    await expect(link).toHaveAttribute("title", e.title);
    const fit = await link.locator(".ent-t").evaluate((el) => {
      const cs = getComputedStyle(el);
      const lh = parseFloat(cs.lineHeight);
      return { clamp: cs.getPropertyValue("-webkit-line-clamp"), height: el.clientHeight, lh };
    });
    expect(fit.clamp).toBe("2");
    expect(fit.height).toBeLessThanOrEqual(Math.ceil(2 * fit.lh) + 1);
  });
});

test.describe("phone and laptop layouts", () => {
  test("at 390×844: tab row scrolls with a fade, magnifier opens full-screen search, Contents opens the drawer, Stacked/Table persists", async ({ page }) => {
    const { g, list } = topicList(2);
    const [a, b] = list;
    if (!a || !b) throw new Error("need two topics");
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, topicHash(g, [a.id]));
    await expect(h1(page)).toHaveText(a.title);

    const tabs = page.locator("header .tabs");
    const row = await tabs.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { overflowX: cs.overflowX, mask: cs.getPropertyValue("mask-image") || cs.getPropertyValue("-webkit-mask-image"), scrolls: el.scrollWidth > el.clientWidth };
    });
    expect(row.overflowX).toBe("auto");
    expect(row.mask).toContain("linear-gradient");
    expect(row.scrolls).toBe(true);

    await page.getByRole("button", { name: "Search", exact: true }).click();
    const full = page.locator(".srch-panel.full");
    await expect(full).toBeVisible();
    await expect(full.getByRole("textbox", { name: "Search all notes" })).toBeFocused();
    await full.getByRole("button", { name: "Close search" }).click();
    await expect(full).toBeHidden();

    await main(page).getByRole("button", { name: "Contents", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Contents" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Close contents" })).toBeFocused();
    await drawer.getByRole("button", { name: "Close contents" }).click();
    await expect(drawer).toHaveCount(0);

    const layout = main(page).getByRole("group", { name: "Table layout" });
    await expect(layout.getByRole("button", { name: "Stacked", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(main(page).locator(".tcard .stacked").first()).toBeVisible();
    await layout.getByRole("button", { name: "Table", exact: true }).click();
    await expect(layout.getByRole("button", { name: "Table", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(main(page).locator(".tcard .stacked")).toHaveCount(0);
    await expect(main(page).locator(".tcard table.nt").first()).toBeVisible();

    await open(page, topicHash(g, [b.id]));
    await expect(h1(page)).toHaveText(b.title);
    await expect(layout.getByRole("button", { name: "Table", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(main(page).locator(".tcard .stacked")).toHaveCount(0);
    await layout.getByRole("button", { name: "Stacked", exact: true }).click();
    await expect(main(page).locator(".tcard .stacked").first()).toBeVisible();
  });

  test("at 901 px the laptop layout", async ({ page }) => {
    const { g, list } = topicList(1);
    const [a] = list;
    if (!a) throw new Error("no topic");
    await page.setViewportSize({ width: 901, height: 900 });
    await open(page, topicHash(g, [a.id]));
    await expect(h1(page)).toHaveText(a.title);
    await expect(page.locator(".site")).not.toHaveClass(/\bis-phone\b/);
    await expect(side(page)).toBeVisible();
    await expect(main(page).locator(".contents-btn")).toHaveCount(0);
    await expect(main(page).locator(".layout-tog")).toHaveCount(0);
    await expect(page.getByRole("search").getByRole("textbox", { name: "Search all notes" })).toBeVisible();
  });

  test("at laptop width no table on FM Cardiovascular starts left of its scroll box (her tables reach into Word's page margin)", async ({ page }) => {
    const s = navOf("fm").systems.find((x) => x.id === "cardiovascular");
    if (!s) throw new Error("FM has no cardiovascular system");
    await open(page, guideViewHash("fm", { kind: "system", system: s.id }));
    await expect(h1(page)).toContainText(s.title);
    const tables = main(page).locator(".ntw > table.nt");
    await expect(tables.first()).toBeVisible();
    const offsets = await tables.evaluateAll((ts) => ts.map((t) => t.getBoundingClientRect().left - (t.parentElement as HTMLElement).getBoundingClientRect().left));
    expect(offsets.length).toBeGreaterThan(0);
    expect(offsets.filter((d) => d < 0)).toEqual([]);
  });
});

test.describe("keyboard and screen reader", () => {
  test("sidebar items are buttons with aria-expanded and links with aria-current", async ({ page }) => {
    const [first, second] = allSystems.filter(({ g }) => g === eors[0]);
    if (!first || !second) throw new Error("need two systems in the first EOR");
    const { g, s } = first;
    await open(page, guideViewHash(g, { kind: "system", system: s.id }));
    const row = sysRow(side(page), page, s.title);
    await expect(row.getByRole("button", { name: `Collapse ${s.title}`, exact: true })).toHaveAttribute("aria-expanded", "true");
    await expect(row.locator("a.sys-name")).toHaveAttribute("aria-current", "page");
    const other = sysRow(side(page), page, second.s.title);
    await expect(other.getByRole("button", { name: `Expand ${second.s.title}`, exact: true })).toHaveAttribute("aria-expanded", "false");
    await expect(other.locator("a.sys-name")).not.toHaveAttribute("aria-current", /./);

    const { g: tg, list } = topicList(1);
    const [t] = list;
    if (!t) throw new Error("no topic");
    await open(page, topicHash(tg, [t.id]));
    await expect(entLink(side(page), page, t.title)).toHaveAttribute("aria-current", "page");
  });

  test("the Contents dialog focuses its first button and traps Tab", async ({ page }) => {
    const g = eors[0];
    if (!g) throw new Error("no EOR");
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, guideBase(g));
    await main(page).getByRole("button", { name: "Contents", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Contents" });
    const close = drawer.getByRole("button", { name: "Close contents" });
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    const inside = (): Promise<boolean> => drawer.evaluate((d) => d.contains(document.activeElement) && document.activeElement !== d.querySelector("button"));
    await expect.poll(inside).toBe(true);
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
  });

  test("search results and slide numbers are announced in live regions", async ({ page }) => {
    const s = allSystems[0];
    if (!s) throw new Error("no system");
    const q = s.s.title.split(/\s+/).find((w) => /^\p{L}{3,}$/u.test(w)) ?? s.s.title.slice(0, 4);
    await open(page, "#/eor");
    const box = page.getByRole("search").getByRole("textbox", { name: "Search all notes" });
    await box.click();
    await box.fill(q);
    await expect(page.getByRole("region", { name: "Search results" }).locator('[aria-live="polite"]')).toContainText(/\d+ results?/);
    await box.press("Escape");

    const g = eors.find((x) => navOf(x).slides !== null);
    test.skip(!g, "no EOR has review slides");
    if (!g) return;
    await open(page, guideViewHash(g, { kind: "slides", n: 1 }));
    await expect(main(page).locator('.fv-bar [aria-live="polite"]')).toHaveText(/^Slide 1 of \d+$/);
  });

  test("touch targets are at least 40 px at 390 px", async ({ page }) => {
    // Two topics in one list, so the open topic's sibling shows its "+" target.
    const { g, list } = topicList(2);
    const [t] = list;
    if (!t) throw new Error("no topic");
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, topicHash(g, [t.id]));
    await expect(h1(page)).toHaveText(t.title);
    const check = async (what: string, loc: Locator): Promise<void> => {
      const all = await loc.filter({ visible: true }).all();
      expect(all.length, what).toBeGreaterThan(0);
      for (const [i, el] of all.entries()) {
        const b = await el.boundingBox();
        expect.soft(b?.height ?? 0, `${what} #${i} height`).toBeGreaterThanOrEqual(40);
        expect.soft(b?.width ?? 0, `${what} #${i} width`).toBeGreaterThanOrEqual(40);
      }
    };
    await check("header tab", page.locator("header .tabs .tab"));
    await check("Contents button", main(page).locator(".contents-btn"));
    await check("Stacked/Table button", main(page).locator(".layout-tog button"));
    await main(page).getByRole("button", { name: "Contents", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Contents" });
    await expect(drawer).toBeVisible();
    await check("sidebar arrow", drawer.locator(".sys-tog"));
    await check("sidebar system", drawer.locator("a.sys-name"));
    await check("sidebar entry", drawer.locator("a.ent"));
    await check("open alongside", drawer.locator("a.alongside"));
  });
});

test.describe("image viewer", () => {
  test("clicking an image opens it; −, Fit and + change the scale; the dialog traps Tab; Close and Esc close it", async ({ page }) => {
    const pick = allSystems.find(({ g, s }) => {
      const sys = systemOf(g, s.id);
      return sys.blocks.some((b) => sys.stubs[b.id] === undefined && JSON.stringify(b.doc).includes('"asset"'));
    });
    if (!pick) throw new Error("no system page shows an image");
    await open(page, guideViewHash(pick.g, { kind: "system", system: pick.s.id }));
    const img = main(page).locator("img.pic").filter({ visible: true }).first();
    await img.scrollIntoViewIfNeeded();
    await img.click();
    const dlg = page.getByRole("dialog", { name: "Image, full size" });
    await expect(dlg).toBeVisible();
    const out = dlg.getByRole("button", { name: "Zoom out" });
    const zin = dlg.getByRole("button", { name: "Zoom in" });
    const fit = dlg.getByRole("button", { name: "Fit", exact: true });
    const close = dlg.getByRole("button", { name: /^Close/ });
    const big = dlg.locator(".lb-in img");
    await expect(out).toBeFocused();
    await expect(big).toHaveAttribute("data-zoom", "1");
    await zin.click();
    await expect(big).toHaveAttribute("data-zoom", "1.5");
    await out.click();
    await out.click();
    await expect(big).toHaveAttribute("data-zoom", "0.5");
    await fit.click();
    await expect(big).toHaveAttribute("data-zoom", "1");

    await out.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(out).toBeFocused();

    await close.click();
    await expect(dlg).toHaveCount(0);
    await img.click();
    await expect(dlg).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dlg).toHaveCount(0);
  });
});

test.describe("review slides", () => {
  const generated = eors
    .filter((g) => navOf(g).slides !== null && existsSync(join(DATA, "g", g, "slides.json")))
    .map((g) => ({ g, deck: read<SlidesJson>(`g/${g}/slides.json`) }))
    .find((x) => x.deck.kind === "generated" && x.deck.slides.length >= 3);

  test("Previous/Next, ←/→ and Jump to slide move between slides and update n / N; slide 1 lists every slide", async ({ page }) => {
    if (!generated) throw new Error("no generated deck with 3 slides");
    const { g, deck } = generated;
    const total = deck.slides.length;
    const num = main(page).locator(".sd-num");
    const live = main(page).locator('.fv-bar [aria-live="polite"]');
    await open(page, guideViewHash(g, { kind: "slides", n: 1 }));
    await expect(num).toHaveText(`1 / ${total}`);
    await expect(live).toHaveText(`Slide 1 of ${total}`);
    await expect(main(page).locator(".sd-cover .sd-toc > li")).toHaveCount(total - 1);

    await main(page).getByRole("button", { name: "Next", exact: true }).click();
    await expect.poll(() => hashOf(page)).toBe(guideViewHash(g, { kind: "slides", n: 2 }));
    await expect(num).toHaveText(`2 / ${total}`);
    await expect(live).toHaveText(`Slide 2 of ${total}`);
    await main(page).getByRole("button", { name: "Previous", exact: true }).click();
    await expect(num).toHaveText(`1 / ${total}`);

    await main(page).locator(".slide").focus();
    await page.keyboard.press("ArrowRight");
    await expect(num).toHaveText(`2 / ${total}`);
    await main(page).locator(".slide").focus();
    await page.keyboard.press("ArrowLeft");
    await expect(num).toHaveText(`1 / ${total}`);

    await main(page).getByLabel("Jump to slide").selectOption(String(total));
    await expect.poll(() => hashOf(page)).toBe(guideViewHash(g, { kind: "slides", n: total }));
    await expect(num).toHaveText(`${total} / ${total}`);
    await expect(live).toHaveText(`Slide ${total} of ${total}`);
  });

  test("a generated slide's Summarizes chip opens its topic", async ({ page }) => {
    if (!generated) throw new Error("no generated deck");
    const { g, deck } = generated;
    const k = deck.slides.findIndex((s) => s.summarizes.length > 0);
    const slide = deck.slides[k];
    if (!slide) throw new Error("no generated slide summarizes a topic");
    const t = slide.summarizes[0];
    if (!t) throw new Error("empty summarizes");
    await open(page, guideViewHash(g, { kind: "slides", n: k + 1 }));
    await expect(main(page).locator(".hy-links .ph-k")).toHaveText("Summarizes");
    await main(page).locator(".hy-links a.ph-tchip").first().click();
    await expect.poll(() => hashOf(page)).toBe(t.route);
    await expect(h1(page)).toHaveText(t.title);
  });

  test("the psych deck shows Download original and no 'made from your notes'", async ({ page }) => {
    test.skip(!eors.includes("psy") || !existsSync(join(DATA, "g", "psy", "slides.json")), "the published content has no Psychiatry deck");
    const deck = read<SlidesJson>("g/psy/slides.json");
    expect(deck.kind).toBe("own");
    await open(page, guideViewHash("psy", { kind: "slides", n: 1 }));
    await expect(h1(page)).toHaveText("Psych review slides");
    await expect(main(page).getByRole("link", { name: "Download original", exact: true })).toBeVisible();
    await expect(main(page).locator(".sd-cover .sd-toc > li")).toHaveCount(deck.slides.length - 1);
    // Per-slide Edit/Versions render only for a signed-in owner, so their absence on this deck is
    // proved with a real owner in app/reader/reader.test.tsx (and signed in through the fake in edit.spec).
    await setOwner(page);
    await expect(main(page).locator(".rs-label")).toBeVisible();
    await expect(main(page).locator(".rs-label")).not.toContainText("made from your notes");
    await expect(main(page).getByText("made from your notes")).toHaveCount(0);
  });

  test("Antibiotic Flower Charts opens in the same viewer, one PDF page per slide", async ({ page }) => {
    const doc = docs.find((d) => /antibiotic\s+flow(er)?\s*charts?/i.test(d.name));
    if (!doc) throw new Error("the published content has no Antibiotic Flower Charts document");
    expect(doc.kind).toBe("slides");
    await open(page, fileHash(doc.id, null));
    await expect(h1(page)).toHaveText(doc.name);
    const viewer = main(page).locator(".slides-file");
    const live = viewer.locator('.fv-bar [aria-live="polite"]');
    await expect(live).toHaveText(/^1 \/ \d+$/);
    const total = Number((await live.textContent())?.split("/")[1]?.trim());
    if (typeof doc.pages === "number") expect(total).toBe(doc.pages);
    await expect(viewer.locator(".pdfpage")).toHaveCount(1);
    await expect(viewer.locator(".pdfpage")).toHaveAttribute("aria-label", "Page 1");
    test.skip(total < 2, "the document has one page");
    await viewer.getByRole("button", { name: "Next", exact: true }).click();
    await expect(live).toHaveText(`2 / ${total}`);
    await expect(viewer.locator(".pdfpage")).toHaveCount(1);
    await expect(viewer.locator(".pdfpage")).toHaveAttribute("aria-label", "Page 2");
  });
});

test.describe("general topics, workup and Other", () => {
  const generals = eors.flatMap((g) =>
    navOf(g)
      .general.filter((x) => x.key !== "workup")
      .map((x) => ({ g, data: read<GeneralJson>(`g/${g}/general/${x.key}.json`) })),
  );

  test("workup: the list is alphabetical with 'Can point to:'; an item opens only its gap block, with ‹ All presentations", async ({ page }) => {
    const g = eors.find((x) => navOf(x).general.some((k) => k.key === "workup"));
    if (!g) throw new Error("no EOR has Initial workup");
    const data = read<WorkupJson>(`g/${g}/workup.json`);
    const sorted = [...data.items].sort((a, b) => a.title.localeCompare(b.title));
    const listHash = guideViewHash(g, { kind: "workup", item: null });
    await open(page, listHash);
    const rows = main(page).locator(".workup-page .lnk > li");
    await expect(rows.locator(".lt")).toHaveText(sorted.map((x) => x.title));
    for (const [i, x] of sorted.entries()) {
      if (x.conds) await expect(rows.nth(i).locator(".ll")).toHaveText(`Can point to: ${x.conds}`);
    }
    const first = sorted[0];
    if (!first) throw new Error("empty workup");
    await rows.first().locator("a").click();
    await expect.poll(() => hashOf(page)).toBe(guideViewHash(g, { kind: "workup", item: first.id }));
    await expect(main(page).locator(".gap")).toHaveCount(1);
    await expect(main(page).locator(".gap")).toHaveAttribute("aria-label", first.gap.title);
    await expect(main(page).locator(".wk-h")).toHaveText(first.title);
    await main(page).getByRole("link", { name: "‹ All presentations" }).click();
    await expect.poll(() => hashOf(page)).toBe(listHash);
  });

  test("Other: 9 sections with file counts or 'Sourced reference', 2 across at 390 px; gap blocks only in Legal and Screenings, plus the Vaccines lead", async ({ page }) => {
    const other = read<OtherJson>("other.json");
    expect(other.sections).toHaveLength(9);
    expect(other.sections.filter((s) => s.gaps !== undefined).map((s) => s.title).sort()).toEqual(["Legal", "Screenings"]);
    const leads = other.sections.filter((s) => s.lead !== null);
    expect(leads.map((s) => s.title)).toHaveLength(1);
    expect(leads[0]?.title).toMatch(/vaccine/i);

    await open(page, otherHash());
    const cards = main(page).locator(".ogrid .ocard");
    await expect(cards).toHaveCount(9);
    for (const [i, s] of other.sections.entries()) {
      const n = s.files.files.length;
      const tail = s.id === "guidelines" ? " · updated guidelines" : "";
      await expect(cards.nth(i).locator("b")).toHaveText(s.title);
      // innerText: the owner wording beside the visitor wording is display:none.
      await expect(cards.nth(i).locator("small")).toHaveText(n > 0 ? `${n} ${n === 1 ? "file" : "files"}${tail}` : `Sourced reference${tail}`, { useInnerText: true });
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".site")).toHaveClass(/\bis-phone\b/);
    const boxes = await cards.evaluateAll((els) => els.slice(0, 3).map((el) => el.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y })));
    const [c0, c1, c2] = boxes;
    if (!c0 || !c1 || !c2) throw new Error("fewer than three cards");
    expect(c1.y).toBe(c0.y);
    expect(c1.x).toBeGreaterThan(c0.x);
    expect(c2.y).toBeGreaterThan(c0.y);
    expect(c2.x).toBe(c0.x);
    await page.setViewportSize({ width: 1280, height: 900 });

    for (const s of other.sections) {
      await open(page, otherHash(s.id));
      await expect(h1(page)).toHaveText(s.title);
      await expect(main(page).locator(".gap")).toHaveCount((s.gaps?.length ?? 0) + (s.lead ? 1 : 0));
      if (s.lead) {
        const lead = main(page).locator(".gap").first();
        await expect(lead).toHaveAttribute("aria-label", s.lead.title);
        const leadY = (await lead.boundingBox())?.y ?? Infinity;
        const partY = (await main(page).locator(".gsec").first().boundingBox())?.y ?? -Infinity;
        expect(leadY).toBeLessThan(partY);
      }
    }
  });

  test("a visitor sees no 'Not from your notes' text anywhere on a general-topic page", async ({ page }) => {
    const pick = generals.find((x) => x.data.gaps.length > 0);
    if (!pick) throw new Error("no general topic has gap blocks");
    await open(page, guideViewHash(pick.g, { kind: "general", key: pick.data.key }));
    await expect(main(page).locator(".gap").first()).toBeVisible();
    await expect(page.getByText(/not from your notes/i).filter({ visible: true })).toHaveCount(0);
  });

  test("general topic: howto set shows the gray line whose link opens the tab's how-to; howto null shows none; a drug-row link opens its pharm section at that row", async ({ page }) => {
    const withHowto = generals.find((x) => x.data.howto !== null && isRefTab(x.data.howto));
    if (!withHowto) throw new Error("no general topic has a how-to pointer");
    const tab = withHowto.data.howto;
    if (tab === null || !isRefTab(tab)) return;
    const ref = read<RefTabJson>(`ref/${tab}.json`);
    const sub = ref.subs.find((s) => /how to/i.test(s.title));
    const name = guideName(withHowto.g);
    await open(page, guideViewHash(withHowto.g, { kind: "general", key: withHowto.data.key }));
    const line = main(page).locator(".howto");
    await expect(line).toHaveText(`Only what ${name} needs is shown here. Full how-to: ${TAB_LABELS[tab]} tab › how to interpret`);
    await line.getByRole("link").click();
    await expect.poll(() => hashOf(page)).toBe(refHash(tab, sub ? sub.id : null));

    const without = generals.find((x) => x.data.howto === null);
    if (!without) throw new Error("no general topic without a how-to pointer");
    await open(page, guideViewHash(without.g, { kind: "general", key: without.data.key }));
    await expect(h1(page)).toContainText(without.data.label);
    await expect(main(page).locator(".howto")).toHaveCount(0);

    let drug: { g: string; key: GeneralJson["key"]; route: string; target: string } | null = null;
    for (const { g, data } of generals) {
      for (const l of data.links) {
        const r = parseHash(l.route);
        if (r.kind === "guide" && r.view.kind === "pharm" && r.view.section !== null && r.view.target !== null) {
          drug = { g, key: data.key, route: l.route, target: r.view.target };
          break;
        }
      }
      if (drug) break;
    }
    if (!drug) throw new Error("no general topic links to a drug row");
    await open(page, guideViewHash(drug.g, { kind: "general", key: drug.key }));
    await main(page).locator(`.lnk a[href="${drug.route}"]`).first().click();
    await expect.poll(() => hashOf(page)).toBe(drug.route);
    const at = main(page).locator(`[data-anchor="${drug.target}"]`).first();
    await expect(at).toBeVisible();
    await expect(at).toBeInViewport();
  });
});

test.describe("pharm", () => {
  test("pharm section page: cards start closed; Expand all opens every card and becomes Collapse all; one header toggles one card; Treats chips open topics", async ({ page }) => {
    let pick: { g: string; sys: SystemJson; sec: NonNullable<SystemJson["pharm"]>["sections"][number] } | null = null;
    for (const { g, s } of allSystems) {
      if (!s.pharm) continue;
      const sys = systemOf(g, s.id);
      const sec = sys.pharm?.sections.find((x) => x.cards.length >= 2 && x.treats.length > 0);
      if (sec) {
        pick = { g, sys, sec };
        break;
      }
    }
    if (!pick) throw new Error("no pharm section with two cards and a Treats chip");
    const { g, sys, sec } = pick;
    const keys = [...(sec.overview ? [sec.overview] : []), ...sec.cards, ...(sec.lo ? [sec.lo] : [])];
    await open(page, pharmHash(g, sys.id, sec.id));
    await expect(h1(page)).toHaveText(sec.title);
    const cards = main(page).locator("section.phc");
    const heads = cards.locator(".phc-h button");
    await expect(cards).toHaveCount(keys.length);
    for (const h of await heads.all()) await expect(h).toHaveAttribute("aria-expanded", "false");
    await expect(main(page).locator(".phc-b")).toHaveCount(0);

    const all = main(page).locator(".ph-h2row .linkbtn");
    await expect(all).toHaveText("Expand all");
    await all.click();
    for (const h of await heads.all()) await expect(h).toHaveAttribute("aria-expanded", "true");
    await expect(main(page).locator(".phc-b")).toHaveCount(keys.length);
    if (sec.overview) await expect(cards.first().locator(".phc-t")).toHaveText("Overview");
    if (sec.alsoFrom < sec.cards.length) await expect(main(page).locator(".phc-group", { hasText: "Also in the pharm notes" })).toBeVisible();
    if (sec.lo) await expect(cards.last().locator(".phc-t")).toHaveText(`Learning objectives — ${sec.title}`);
    await expect(all).toHaveText("Collapse all");
    await all.click();
    for (const h of await heads.all()) await expect(h).toHaveAttribute("aria-expanded", "false");
    await expect(main(page).locator(".phc-b")).toHaveCount(0);
    await expect(all).toHaveText("Expand all");

    const one = main(page).locator(`[id="card-${sec.cards[0] ?? ""}"]`);
    await one.locator(".phc-h button").click();
    await expect(one.locator(".phc-h button")).toHaveAttribute("aria-expanded", "true");
    await expect(main(page).locator(".phc-b")).toHaveCount(1);
    await expect(one.locator(".phc-b")).toBeVisible();
    await one.locator(".phc-h button").click();
    await expect(main(page).locator(".phc-b")).toHaveCount(0);

    const chips = main(page).locator(".ph-treats a.ph-tchip");
    await expect(chips).toHaveCount(sec.treats.length);
    const t = sec.treats[0];
    if (!t) throw new Error("no Treats topic");
    await chips.first().click();
    await expect.poll(() => hashOf(page)).toBe(topicHash(g, [t]));
    await expect(main(page).locator(`.tcard[data-topic="${t}"]`)).toBeVisible();
  });

  test("meds panel: 'Open in <System> pharm ›' opens the pharm section with that card open and scrolled into view", async ({ page }) => {
    let pick: { g: string; sys: SystemJson; topic: string; title: string; card: string; section: string } | null = null;
    for (const { g, s } of allSystems) {
      const listed = new Set([...s.entries, ...s.sections.flatMap((x) => x.entries)].map((e) => e.id));
      const sys = systemOf(g, s.id);
      for (const t of sys.topics) {
        const m = t.meds.find((x) => x.card !== null && x.target === x.card);
        if (m && m.card && listed.has(t.id)) {
          pick = { g, sys, topic: t.id, title: m.title, card: m.card, section: m.section };
          break;
        }
      }
      if (pick) break;
    }
    if (!pick) throw new Error("no condition topic with a meds card");
    const { g, sys, topic, title, card, section } = pick;
    await open(page, topicHash(g, [topic]));
    const meds = main(page).locator(".meds");
    await expect(meds.locator(".meds-hd")).toContainText("Medications for this condition");
    const mc = meds.locator("section.phc").filter({ has: page.locator(".phc-t", { hasText: title }) }).first();
    await mc.locator(".phc-h button").click();
    await mc.getByRole("link", { name: `Open in ${sys.title} pharm ›` }).click();
    await expect.poll(() => hashOf(page)).toBe(pharmHash(g, sys.id, section, card));
    const target = main(page).locator(`[id="card-${card}"]`);
    await expect(target.locator(".phc-h button")).toHaveAttribute("aria-expanded", "true");
    await expect(target.locator(".phc-b")).toBeVisible();
    await expect(target).toBeInViewport();
  });

  test("a file opened from a pharm page shows '<EOR> › <System> pharm' and Back returns there", async ({ page }) => {
    let pick: { g: string; sys: SystemJson } | null = null;
    for (const { g, s } of allSystems) {
      if (!s.pharm) continue;
      const sys = systemOf(g, s.id);
      if ((sys.pharm?.files.files.length ?? 0) > 0) {
        pick = { g, sys };
        break;
      }
    }
    if (!pick) throw new Error("no EOR pharm page lists a file");
    const { g, sys } = pick;
    const file = sys.pharm?.files.files[0];
    if (!file) return;
    const from = pharmHash(g, sys.id);
    await open(page, from);
    await main(page).locator(".fchip").first().click();
    await expect.poll(() => hashOf(page)).toBe(fileHash(file.id, from));
    await expect(h1(page)).toHaveText(file.name);
    const labels = [...pharmLoc(site.index, g, sys.id).split(" › "), file.name];
    await expect(main(page).getByRole("navigation", { name: "Location" }).locator(".crumb")).toHaveText(labels.map((l, i) => (i === 0 ? l : `›${l}`)));
    await main(page).getByRole("button", { name: "Back", exact: true }).click();
    await expect.poll(() => hashOf(page)).toBe(from);
  });
});

test.describe("PDF", () => {
  test("Download PDF opens a menu with the explanation line, the page scope and Whole guide; a browser scope shows Preparing… then Downloaded <file>", async ({ page }) => {
    test.setTimeout(180_000);
    // The smallest system keeps the browser build short.
    const sized = allSystems.map(({ g, s }) => ({ g, s, bytes: statSync(join(DATA, "g", g, "s", `${s.id}.json`)).size })).sort((a, b) => a.bytes - b.bytes);
    const pick = sized[0];
    if (!pick) throw new Error("no system");
    const { g, s } = pick;
    await open(page, guideViewHash(g, { kind: "system", system: s.id }));
    await main(page).getByRole("button", { name: "Download PDF" }).click();
    const menu = page.getByRole("menu", { name: "Download PDF" });
    await expect(menu).toBeVisible();
    const owner = "Your notes only, in your table layout. Content not from your notes and guideline notes are left out.";
    const visitor = "The guide’s notes, in its table layout.";
    await expect(menu.getByText(visitor, { exact: true })).toBeVisible();
    await expect(menu.getByText(owner, { exact: true })).toBeHidden();
    await setOwner(page);
    await expect(menu.getByText(owner, { exact: true })).toBeVisible();
    await expect(menu.getByText(visitor, { exact: true })).toBeHidden();
    await setVisitor(page);
    const scope = menu.getByRole("menuitem", { name: /^This system/ });
    await expect(scope.locator("small")).toHaveText(s.title);
    await expect(menu.getByRole("menuitem", { name: /^Whole guide/ }).locator("small")).toHaveText(`${guideFile(navOf(g))} · every system, in guide order`);

    const toast = page.locator(".toast-region");
    const downloading = page.waitForEvent("download", { timeout: 150_000 });
    await scope.click();
    await expect(toast).toContainText("Preparing…");
    const download = await downloading;
    await expect(toast).toContainText(`Downloaded ${download.suggestedFilename()}`);
  });

  test("the 'This system' PDF of the largest system downloads and has at least one page", async ({ page }, testInfo) => {
    test.setTimeout(300_000);
    const sized = allSystems.map(({ g, s }) => ({ g, s, bytes: statSync(join(DATA, "g", g, "s", `${s.id}.json`)).size })).sort((a, b) => b.bytes - a.bytes);
    const pick = sized[0];
    if (!pick) throw new Error("no system");
    const { g, s } = pick;
    await open(page, guideViewHash(g, { kind: "system", system: s.id }));
    await main(page).getByRole("button", { name: "Download PDF" }).click();
    const downloading = page.waitForEvent("download", { timeout: 270_000 });
    await page.getByRole("menu", { name: "Download PDF" }).getByRole("menuitem", { name: /^This system/ }).click();
    const download = await downloading;
    const out = testInfo.outputPath("largest-system.pdf");
    await download.saveAs(out);
    const bytes = readFileSync(out);
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(bytes.toString("latin1")).toMatch(/\/Type\s*\/Page[^s]/);
    await expect(page.locator(".toast-region")).toContainText(`Downloaded ${download.suggestedFilename()}`);
  });

  test("file viewer: every page of a PDF renders inline top to bottom, and Download original PDF downloads the stored file unchanged", async ({ page }, testInfo) => {
    const pdfs = docs.filter((d) => d.kind === "pdf" && typeof d.original === "string");
    // The shortest multi-page document keeps the render short.
    const doc = [...pdfs].sort((a, b) => (a.pages ?? 1) - (b.pages ?? 1)).find((d) => (d.pages ?? 1) >= 2) ?? pdfs[0];
    if (!doc || !doc.original) throw new Error("the published content has no PDF document");
    await open(page, fileHash(doc.id, null));
    await expect(h1(page)).toHaveText(doc.name);
    const pages = main(page).locator(".pdfv .pdfpage");
    if (typeof doc.pages === "number") await expect(pages).toHaveCount(doc.pages);
    else await expect(pages.first()).toBeVisible();
    const n = await pages.count();
    await expect
      .poll(() => pages.locator("canvas").evaluateAll((cs) => cs.filter((c) => c instanceof HTMLCanvasElement && c.style.aspectRatio !== "").length))
      .toBe(n);
    const labels = await pages.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
    expect(labels).toEqual(Array.from({ length: n }, (_, i) => `Page ${i + 1}`));
    const tops = await pages.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
    for (let i = 1; i < tops.length; i++) expect(tops[i] ?? 0).toBeGreaterThan(tops[i - 1] ?? 0);

    const downloading = page.waitForEvent("download");
    await main(page).getByRole("link", { name: "Download original PDF" }).click();
    const download = await downloading;
    const out = testInfo.outputPath("original.pdf");
    await download.saveAs(out);
    expect(readFileSync(out).equals(readFileSync(join(DATA, doc.original)))).toBe(true);
  });
});
