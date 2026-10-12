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

/** A small reading page: at 1520 CSS px its drawn height can sit at the boundary. */
const HASH = "#/eor/fm/t/r_0SYPVD03FF";
/** Viewport heights whose scroll area height is within one scale-step (~7 px) of the drawn height. */
const HEIGHTS = [691, 694, 696];

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

test("the page scale settles at the overflow boundary instead of flipping every frame", async ({ page }) => {
  await page.setViewportSize({ width: 1520, height: 500 });
  await openPage(page);
  // Space-taking scrollbars are in effect, or this check cannot see the bug it exists for.
  expect((await mainBox(page)).sbw).toBeGreaterThan(0);

  let atBoundary = 0;
  for (const height of HEIGHTS) {
    await page.setViewportSize({ width: 1520, height });
    await openPage(page);
    const box = await mainBox(page);
    // These heights are the boundary band for this page; if its drawn height drifts away from them the
    // state count below would pass vacuously, so the last check fails instead.
    if (Math.abs(box.drawnH - box.clientH) <= 8) atBoundary += 1;

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
    expect(states).toHaveLength(1);
  }
  expect(atBoundary).toBeGreaterThan(0);
});
