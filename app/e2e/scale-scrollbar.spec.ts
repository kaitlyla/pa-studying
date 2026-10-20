// A reading page beside the open sidebar is drawn smaller with a transform; the scale comes from the
// scroll area's width, and the page's drawn height decides whether that area shows a scrollbar. With
// scrollbars that take space the two feed each other — the bar appears, the width drops, the scale
// shrinks, the drawn page fits again, the bar goes, the width grows — and they flip every frame whenever
// the drawn height sits within one scale-step of the scroll area's height, which is what "moving very
// fast and i cant read it" was. Headless Chromium hides scrollbars, so this file asks for the
// space-taking ones explicitly; without them it could not see the bug at all.
import { expect, test, type Page } from "@playwright/test";

test.use({
  launchOptions: {
    ignoreDefaultArgs: ["--hide-scrollbars"],
    args: ["--disable-features=OverlayScrollbar,FluentOverlayScrollbar,OverlayScrollbars,FluentScrollbars"],
  },
});

/** A small reading page, drawn beside the open sidebar at 1520 CSS px wide. */
const HASH = "#/eor/fm/t/r_0SYPVD03FF";
const WIDTH = 1520;

async function openPage(page: Page): Promise<void> {
  await page.goto("about:blank");
  await page.goto(`./${HASH}`);
  await expect(page.locator("main h1").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

async function mainBox(page: Page): Promise<{ sbw: number; clientH: number; drawnH: number }> {
  return page.evaluate(() => {
    const m = document.querySelector<HTMLElement>("main.main") ?? document.querySelector<HTMLElement>("main");
    if (!m) throw new Error("no main");
    return { sbw: m.offsetWidth - m.clientWidth, clientH: m.clientHeight, drawnH: m.scrollHeight };
  });
}

/**
 * The tallest viewport height at which the page overflows its scroll area: one CSS px taller and it fits.
 * Found from the page as it is drawn now, so her edits to the page's text move the band with it.
 */
async function overflowEdge(page: Page): Promise<number> {
  const overflows = async (height: number): Promise<boolean> => {
    await page.setViewportSize({ width: WIDTH, height });
    return page.evaluate(async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const m = document.querySelector<HTMLElement>("main.main") ?? document.querySelector<HTMLElement>("main");
      if (!m) throw new Error("no main");
      return m.scrollHeight > m.clientHeight;
    });
  };
  let lo = 300;
  let hi = 6000;
  if (!(await overflows(lo)) || (await overflows(hi))) throw new Error(`the page does not cross the overflow edge between ${lo} and ${hi} px`);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await overflows(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

test("the page scale settles at the overflow boundary instead of flipping every frame", async ({ page }) => {
  await page.setViewportSize({ width: WIDTH, height: 500 });
  await openPage(page);
  // Space-taking scrollbars are in effect, or this check cannot see the bug it exists for.
  expect((await mainBox(page)).sbw).toBeGreaterThan(0);

  // Viewport heights whose scroll area is within one scale-step (~7 px) of the drawn height: just short of
  // it (the bar shows) and just past it (the page fits).
  const edge = await overflowEdge(page);
  const heights = [edge - 5, edge - 2, edge, edge + 1, edge + 3];
  let overflowing = 0;
  for (const height of heights) {
    await page.setViewportSize({ width: WIDTH, height });
    await openPage(page);
    const box = await mainBox(page);
    // The band must hold heights where the page overflows by under one scale-step, or the state count
    // below would pass vacuously, so the last check fails instead.
    if (box.drawnH > box.clientH && box.drawnH - box.clientH <= 8) overflowing += 1;

    const states = await page.evaluate(async () => {
      const m = document.querySelector<HTMLElement>("main.main") ?? document.querySelector<HTMLElement>("main");
      const el = document.querySelector<HTMLElement>(".page-scale");
      const seen = new Set<string>();
      const t0 = performance.now();
      await new Promise<void>((resolve) => {
        const step = (): void => {
          seen.add(`${el?.style.transform ?? ""}|${m?.clientWidth ?? -1}|${Math.round(m?.scrollTop ?? -1)}`);
          if (performance.now() - t0 > 1000) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      return [...seen];
    });
    expect(states, `viewport height ${height}`).toHaveLength(1);
  }
  expect(overflowing).toBeGreaterThan(0);
});
