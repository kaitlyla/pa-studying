// The PDF menu's download flow (70 §70.2): "Preparing…", then "Downloaded <file>" or the failure
// toast, with the menu usable again for a retry. downloadPdf (OB8) is replaced at the module boundary.
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { NavJson, SiteJson, SystemJson } from "../../lib/derive/published.ts";
import { hideToast, Toast } from "../shell/toast.tsx";
import { byText, click, flush, mount, publishedFixture, type Mounted } from "../testing.tsx";
import { PDF_FAILED, PdfMenu, type PageScope } from "./PdfMenu.tsx";

const pdf = vi.hoisted(() => ({
  downloadPdf: vi.fn<(scope: unknown, input: unknown) => Promise<string>>(),
}));

vi.mock("../pdf/download.ts", () => ({
  downloadPdf: pdf.downloadPdf,
  wholeGuideUrl: (repo: string, guide: string, source: string) => `https://github.com/${repo}/releases/download/${guide}/${encodeURIComponent(source)}.pdf`,
}));

let site: SiteJson;
let nav: NavJson;
let page: PageScope;
let ui: Mounted | null = null;
let errors: MockInstance<typeof console.error>;

beforeAll(async () => {
  const files = await publishedFixture();
  site = files.get("site.json") as SiteJson;
  nav = files.get("g/fm/nav.json") as NavJson;
  const system = files.get("g/fm/s/cardiovascular.json") as SystemJson;
  page = { label: "This system", name: "Cardiovascular", scope: { kind: "system" }, input: { nav, system } };
});

beforeEach(() => {
  pdf.downloadPdf.mockReset();
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  ui = mount(
    <>
      <PdfMenu site={site} guide="fm" nav={nav} page={page} />
      <Toast />
    </>,
  );
});

afterEach(() => {
  ui?.unmount();
  ui = null;
  hideToast();
  errors.mockRestore();
});

const toastText = (): string => ui?.container.querySelector(".toast span")?.textContent ?? "";
const menuButton = (): HTMLButtonElement | null => ui?.container.querySelector<HTMLButtonElement>("button[aria-haspopup='menu']") ?? null;

async function chooseScope(): Promise<void> {
  await click(menuButton());
  await click(byText(ui?.container ?? document, "[role='menuitem']", "This system"));
}

describe("PDF menu download", () => {
  it("lists the page scope and the whole-guide release link", async () => {
    await click(menuButton());
    const c = ui?.container ?? document.body;
    expect(menuButton()?.getAttribute("aria-expanded")).toBe("true");
    expect(byText(c, "[role='menuitem']", "This system")?.textContent).toBe("This systemCardiovascular");
    const whole = byText<HTMLAnchorElement>(c, "a[role='menuitem']", "Whole guide");
    expect(whole?.getAttribute("href")).toBe(`https://github.com/${site.repo}/releases/download/fm/${encodeURIComponent(nav.source)}.pdf`);
    expect(whole?.textContent).toContain("· every system, in guide order");
  });

  it("shows Preparing… while the PDF is built, then Downloaded <file>", async () => {
    let resolve: (name: string) => void = () => {};
    pdf.downloadPdf.mockImplementation(() => new Promise<string>((r) => (resolve = r)));
    await chooseScope();
    expect(pdf.downloadPdf).toHaveBeenCalledWith(page.scope, page.input);
    expect(toastText()).toBe("Preparing…");
    resolve("Family Medicine - Cardiovascular.pdf");
    await flush();
    expect(toastText()).toBe("Downloaded Family Medicine - Cardiovascular.pdf");
  });

  it("a rejected download clears Preparing… and shows the failure toast, and a retry succeeds", async () => {
    pdf.downloadPdf.mockRejectedValueOnce(new Error("fetch failed")).mockResolvedValueOnce("Family Medicine - Cardiovascular.pdf");
    await chooseScope();
    await flush();
    expect(toastText()).toBe(PDF_FAILED);
    expect(errors).toHaveBeenCalled();
    // The menu closed after the choice and opens again for the retry.
    expect(ui?.container.querySelector("[role='menu']")).toBeNull();
    await chooseScope();
    await flush();
    expect(pdf.downloadPdf).toHaveBeenCalledTimes(2);
    expect(toastText()).toBe("Downloaded Family Medicine - Cardiovascular.pdf");
  });

  it("the failure toast does not hang: it hides after its timeout", async () => {
    pdf.downloadPdf.mockRejectedValueOnce(new Error("offline"));
    await click(menuButton());
    // The harness's click/flush wait on real timers, so the scope is chosen inside act directly.
    vi.useFakeTimers();
    try {
      const item = byText(ui?.container ?? document, "[role='menuitem']", "This system");
      expect(item).not.toBeNull();
      await act(async () => {
        item?.click();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(toastText()).toBe(PDF_FAILED);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3799);
      });
      expect(toastText()).toBe(PDF_FAILED);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(ui?.container.querySelector(".toast")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Escape closes the menu and returns focus to the button", async () => {
    await click(menuButton());
    const item = ui?.container.querySelector<HTMLElement>("[role='menuitem']");
    expect(document.activeElement).toBe(item);
    item?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush(0);
    expect(ui?.container.querySelector("[role='menu']")).toBeNull();
    expect(document.activeElement).toBe(menuButton());
  });

  it("a click outside closes the menu", async () => {
    await click(menuButton());
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await flush(0);
    expect(ui?.container.querySelector("[role='menu']")).toBeNull();
  });
});
