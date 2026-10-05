import { act, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocJson, DocList, GeneralJson, HostsJson, OtherJson, SystemJson } from "../../lib/derive/published.ts";
import {
  asOwner,
  byText,
  click,
  D,
  flush,
  go,
  installOwnerCss,
  mount,
  publishedFixture,
  R,
  renderApp,
  serveData,
  until,
  type DataServer,
  type Mounted,
} from "../testing.tsx";
import { FileChip, FileChips } from "./FileChip.tsx";
import { closeImageViewer, ImageViewer, openImageViewer } from "./imageViewer.tsx";
import { PdfStatus } from "./pdf.tsx";
import { SlideNav, slideKeys } from "./SlideNav.tsx";

const pdf = vi.hoisted(() => ({
  downloadPdf: vi.fn<(scope: unknown, input: unknown) => Promise<string>>(),
}));

vi.mock("../pdf/download.ts", async (actual) => ({
  ...(await actual<typeof import("../pdf/download.ts")>()),
  downloadPdf: pdf.downloadPdf,
}));

let files: Map<string, unknown>;
let server: DataServer;
let app: Mounted | null = null;

beforeAll(async () => {
  files = await publishedFixture();
  installOwnerCss();
});

beforeEach(() => {
  server = serveData(files);
  asOwner(false);
});

afterEach(() => {
  act(() => closeImageViewer());
  app?.unmount();
  app = null;
  server.restore();
  asOwner(false);
});

// ---- helpers ----------------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isDocList(v: unknown): v is DocList {
  return isRecord(v) && Array.isArray(v.files) && Array.isArray(v.removed) && Array.isArray(v.pending);
}

function isDocJson(v: unknown): v is DocJson {
  return isRecord(v) && typeof v.id === "string" && typeof v.name === "string" && typeof v.kind === "string";
}

function isHosts(v: unknown): v is HostsJson {
  return isRecord(v) && Object.values(v).every((p) => isRecord(p) && typeof p.route === "string" && typeof p.loc === "string");
}

function isGeneral(v: unknown): v is GeneralJson {
  return isRecord(v) && isDocList(v.files);
}

function isOther(v: unknown): v is OtherJson {
  return isRecord(v) && Array.isArray(v.sections);
}

function isSystem(v: unknown): v is SystemJson {
  if (!isRecord(v)) return false;
  const pharm = v.pharm;
  return pharm === null || (isRecord(pharm) && isDocList(pharm.files));
}

function published<T>(path: string, guard: (v: unknown) => v is T): T {
  const v = files.get(path);
  if (!guard(v)) throw new Error(`published ${path} is missing or not the expected shape`);
  return v;
}

function need<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`missing: ${what}`);
  return v;
}

/** The File page's location line plus title, one label per crumb. */
function crumbLabels(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll(".file-page .crumbs .crumb"), (c) => c.lastElementChild?.textContent ?? "");
}

async function openFile(hash: string): Promise<{ a: Mounted; page: HTMLElement }> {
  const a = await renderApp(hash);
  app = a;
  const page = await until(() => a.container.querySelector<HTMLElement>(".file-page"), "the file page");
  return { a, page };
}

function key(target: Element, k: string, init: KeyboardEventInit = {}): boolean {
  let notCancelled = true;
  act(() => {
    notCancelled = target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  return notCancelled;
}

const RENAL_PHARM = "#/eor/fm/pharm/renal";
const fromQuery = (route: string): string => `?from=${encodeURIComponent(route)}`;

// ---- File page --------------------------------------------------------------------------------------

describe("File page", () => {
  it("shows an image opened from a pharm page with its location, image, Download and Back", async () => {
    const doc = published(`docs/${D(2)}.json`, isDocJson);
    const original = need(doc.original, "image original path");
    const view = need(doc.view, "image view path");
    const { page } = await openFile(`#/file/${D(2)}${fromQuery(RENAL_PHARM)}`);

    expect(need(page.querySelector("h1"), "title").textContent).toBe("Renal chart");
    expect(crumbLabels(page)).toEqual(["EOR", "Family Medicine", "Urology/Renal pharm", "Renal chart"]);
    const locLink = need(byText<HTMLAnchorElement>(page, ".crumbs a", "Urology/Renal pharm"), "location crumb link");
    expect(locLink.getAttribute("href")).toBe(RENAL_PHARM);

    const img = need(page.querySelector<HTMLImageElement>(".imgv img"), "image");
    expect(img.getAttribute("src")?.endsWith(view)).toBe(true);
    expect(img.getAttribute("alt")).toBe("Renal chart");

    const dl = need(page.querySelector<HTMLAnchorElement>("a[download]"), "download link");
    expect(dl.textContent).toBe("Download");
    expect(dl.getAttribute("href")?.endsWith(original)).toBe(true);

    await click(byText(page, "button", "Back"));
    expect(location.hash).toBe(RENAL_PHARM);
  });

  it("without from, labels the location with the document's first placement and offers no Back", async () => {
    const hosts = published("hosts.json", isHosts);
    const place = need(hosts[D(3)], "hosts entry for the receptor chart");
    expect(place.loc).toBe("PANCE");
    const { page } = await openFile(`#/file/${D(3)}`);

    expect(crumbLabels(page)).toEqual([...place.loc.split(" › "), "Receptor chart"]);
    expect(byText(page, "button", "Back")).toBeNull();
    // The document's hosts route is this page itself, so the location crumb is not a link.
    expect(place.route).toBe(`#/file/${D(3)}`);
    expect(page.querySelector(".crumbs a")).toBeNull();
  });

  it("with a from that names no list, keeps Back on from and takes the location line from the first placement", async () => {
    const from = "#/eor/fm/s/renal";
    const { page } = await openFile(`#/file/${D(2)}${fromQuery(from)}`);

    expect(crumbLabels(page)).toEqual(["EOR", "Family Medicine", "Urology/Renal pharm", "Renal chart"]);
    expect(need(byText<HTMLAnchorElement>(page, ".crumbs a", "Urology/Renal pharm"), "location crumb link").getAttribute("href")).toBe(from);
    await click(byText(page, "button", "Back"));
    expect(location.hash).toBe(from);
  });

  it("labels a document opened from a reference tab with that tab", async () => {
    const { page } = await openFile(`#/file/${D(5)}${fromQuery("#/labs")}`);
    expect(crumbLabels(page)).toEqual(["Labs", "Thyroid notes"]);
    expect(need(byText<HTMLAnchorElement>(page, ".crumbs a", "Labs"), "Labs crumb").getAttribute("href")).toBe("#/labs");
  });

  it("renders a Word document's blocks through the notes renderer, with no Download", async () => {
    const { page } = await openFile(`#/file/${D(5)}`);
    expect(need(page.querySelector("h1"), "title").textContent).toBe("Thyroid notes");
    expect(crumbLabels(page)).toEqual(["EOR", "Family Medicine", "Labs", "Thyroid notes"]);

    const body = need(page.querySelector(".wordpage"), "word body");
    expect(body.textContent).toContain("TSH first");
    const row = need(body.querySelector(`[data-anchor="${R(600)}"]`), "Free T4 row");
    expect(row.textContent).toContain("Free T4");
    expect(row.textContent).toContain("high");
    expect(need(body.querySelector(`[data-anchor="${R(601)}"]`), "T3 row").textContent).toContain("T3");
    expect(page.querySelector("a[download]")).toBeNull();
    expect(page.querySelector(".imgv")).toBeNull();
  });

  it("downloads a Word document as a PDF of the page, with the Preparing… and Downloaded toasts", async () => {
    let resolve: (name: string) => void = () => {};
    pdf.downloadPdf.mockReset().mockImplementation(() => new Promise<string>((r) => (resolve = r)));
    const { a, page } = await openFile(`#/file/${D(5)}`);
    await click(byText(page, "button", "Download PDF"));
    const doc = files.get(`docs/${D(5)}.json`);
    expect(pdf.downloadPdf).toHaveBeenCalledWith({ kind: "doc" }, { doc });
    const toast = (): string => a.container.querySelector(".toast span")?.textContent ?? "";
    expect(toast()).toBe("Preparing…");
    resolve("Thyroid notes.pdf");
    await flush();
    expect(toast()).toBe("Downloaded Thyroid notes.pdf");
  });

  it("offers Download PDF only on Word documents", async () => {
    expect(published(`docs/${D(2)}.json`, isDocJson).kind).toBe("image");
    const { page } = await openFile(`#/file/${D(2)}`);
    expect(need(page.querySelector("h1"), "title").textContent).toBe("Renal chart");
    expect(byText(page, "button", "Download PDF")).toBeNull();
  });

  it("shows a removed document as not on the site to a visitor", async () => {
    const a = await renderApp(`#/file/${D(6)}`);
    app = a;
    const h = await until(() => byText(a.container, ".notfound h1", "isn't on the site"), "not-on-site page");
    expect(h.textContent).toBe("This page isn't on the site");
    expect(need(byText<HTMLAnchorElement>(a.container, ".notfound a", "Go to the EOR guides"), "EOR link").getAttribute("href")).toBe("#/eor");
    expect(a.container.querySelector(".file-page")).toBeNull();
    expect(server.requests).toContain(`docs/${D(6)}.json`);
  });

  it("shows a missing id as not on the site", async () => {
    const a = await renderApp("#/file/d_9999999999");
    app = a;
    const h = await until(() => byText(a.container, ".notfound h1", "isn't on the site"), "not-on-site page");
    expect(h.textContent).toBe("This page isn't on the site");
    expect(server.requests).toContain("docs/d_9999999999.json");
  });

  it("gives the owner her pending-document view instead of not-on-site for an unpublished document", async () => {
    asOwner(true);
    const a = await renderApp(`#/file/${D(7)}`);
    app = a;
    await until(() => server.requests.includes(`docs/${D(7)}.json`) && !a.container.querySelector(".main .loading"), "the document request to settle");
    await flush(50);
    expect(a.container.querySelector(".notfound")).toBeNull();
    expect(a.container.querySelector(".file-page")).toBeNull();
  });

  it("passes a failure other than a missing document to the page boundary", async () => {
    const served = globalThis.fetch;
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith(`docs/${D(2)}.json`)) return Promise.resolve(new Response("boom", { status: 500 }));
      return served(input, init);
    };
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const a = await renderApp(`#/file/${D(2)}`);
      app = a;
      const h = await until(() => byText(a.container, ".notfound h1", "couldn't load"), "the page boundary's message");
      expect(h.textContent).toBe("This page couldn't load");
      expect(byText(a.container, "h1", "isn't on the site")).toBeNull();
      expect(a.container.querySelector(".file-page")).toBeNull();
    } finally {
      quiet.mockRestore();
    }
  });
});

// ---- image viewer -----------------------------------------------------------------------------------

describe("image viewer", () => {
  it("opens from the file's image, zooms with − Fit +, traps Tab, and closes with Close and Escape", async () => {
    const doc = published(`docs/${D(2)}.json`, isDocJson);
    const original = need(doc.original, "image original path");
    const { a, page } = await openFile(`#/file/${D(2)}${fromQuery(RENAL_PHARM)}`);
    const opener = need(page.querySelector<HTMLButtonElement>("button.imgbtn"), "image button");
    expect(opener.getAttribute("aria-label")).toBe("Open Renal chart full size");

    const dialog = (): HTMLElement | null => a.container.querySelector<HTMLElement>('[role="dialog"][aria-label="Image, full size"]');
    const big = (): HTMLImageElement => need(dialog()?.querySelector<HTMLImageElement>(".lb-in img"), "viewer image");
    const btn = (label: string): HTMLButtonElement => {
      const d = need(dialog(), "viewer dialog");
      return need(d.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? byText<HTMLButtonElement>(d, "button", label), label);
    };

    expect(dialog()).toBeNull();
    act(() => opener.focus());
    await click(opener);
    expect(dialog()).not.toBeNull();
    expect(big().getAttribute("src")?.endsWith(original)).toBe(true);
    expect(document.activeElement).toBe(btn("Zoom out"));
    expect(big().dataset.zoom).toBe("1");
    expect(big().style.maxWidth).toBe("100%");
    expect(big().style.width).toBe("auto");

    await click(btn("Zoom in"));
    expect(big().dataset.zoom).toBe("1.5");
    expect(big().style.width).toBe("150%");
    expect(big().style.maxWidth).toBe("none");
    await click(btn("Zoom in"));
    expect(big().dataset.zoom).toBe("2");
    expect(big().style.width).toBe("200%");
    await click(btn("Zoom out"));
    expect(big().dataset.zoom).toBe("1.5");

    await click(btn("Fit"));
    expect(big().dataset.zoom).toBe("1");
    expect(big().style.width).toBe("auto");

    await click(btn("Zoom out"));
    expect(big().dataset.zoom).toBe("0.5");
    expect(big().style.width).toBe("50%");
    await click(btn("Zoom out"));
    expect(big().dataset.zoom).toBe("0.5");

    // Tab from the last button wraps to the first; Shift+Tab from the first wraps to the last.
    const close = btn("Close");
    act(() => close.focus());
    expect(key(close, "Tab")).toBe(false);
    expect(document.activeElement).toBe(btn("Zoom out"));
    expect(key(btn("Zoom out"), "Tab", { shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(close);
    const fit = btn("Fit");
    act(() => fit.focus());
    expect(key(fit, "Tab")).toBe(true);
    expect(document.activeElement).toBe(fit);

    await click(btn("Close"));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);

    act(() => opener.focus());
    await click(opener);
    expect(dialog()).not.toBeNull();
    expect(big().dataset.zoom).toBe("1");
    expect(key(btn("Zoom out"), "Escape")).toBe(false);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("opens from openImageViewer and starts each new image at Fit", async () => {
    const m = await mount(<ImageViewer />);
    try {
      expect(m.container.querySelector('[role="dialog"]')).toBeNull();
      act(() => openImageViewer("/data/files/a.png"));
      const img = (): HTMLImageElement => need(m.container.querySelector<HTMLImageElement>(".lb-in img"), "viewer image");
      expect(img().getAttribute("src")).toBe("/data/files/a.png");
      act(() => need(m.container.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]'), "Zoom in").click());
      expect(img().dataset.zoom).toBe("1.5");

      act(() => openImageViewer("/data/files/b.png"));
      expect(img().getAttribute("src")).toBe("/data/files/b.png");
      expect(img().dataset.zoom).toBe("1");

      act(() => closeImageViewer());
      expect(m.container.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      m.unmount();
    }
  });
});

// ---- slide navigation -------------------------------------------------------------------------------

describe("SlideNav", () => {
  const labels = ["Intro", "Middle", "End"];

  it("moves with Previous and Next, disables them at the ends, and jumps with the select", async () => {
    const go = vi.fn<(n: number) => void>();
    const m = await mount(<SlideNav n={2} total={3} go={go} labels={labels} />);
    try {
      const prev = (): HTMLButtonElement => need(byText<HTMLButtonElement>(m.container, "button", "Previous"), "Previous");
      const next = (): HTMLButtonElement => need(byText<HTMLButtonElement>(m.container, "button", "Next"), "Next");
      const jump = (): HTMLSelectElement => need(m.container.querySelector<HTMLSelectElement>('select[aria-label="Jump to slide"]'), "Jump to slide");

      expect(need(m.container.querySelector('[aria-live="polite"]'), "position").textContent).toBe("Slide 2 of 3");
      expect(prev().disabled).toBe(false);
      expect(next().disabled).toBe(false);
      expect(Array.from(jump().options, (o) => [o.value, o.textContent])).toEqual([
        ["1", "Intro"],
        ["2", "Middle"],
        ["3", "End"],
      ]);
      expect(jump().value).toBe("2");

      act(() => prev().click());
      expect(go).toHaveBeenLastCalledWith(1);
      act(() => next().click());
      expect(go).toHaveBeenLastCalledWith(3);

      act(() => {
        const s = jump();
        s.value = "3";
        s.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(go).toHaveBeenLastCalledWith(3);
      act(() => {
        const s = jump();
        s.value = "1";
        s.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(go).toHaveBeenLastCalledWith(1);
      expect(go).toHaveBeenCalledTimes(4);

      act(() => m.root.render(<SlideNav n={1} total={3} go={go} labels={labels} />));
      expect(prev().disabled).toBe(true);
      expect(next().disabled).toBe(false);
      act(() => prev().click());
      expect(go).toHaveBeenCalledTimes(4);

      act(() => m.root.render(<SlideNav n={3} total={3} go={go} labels={labels} />));
      expect(prev().disabled).toBe(false);
      expect(next().disabled).toBe(true);
      act(() => next().click());
      expect(go).toHaveBeenCalledTimes(4);
    } finally {
      m.unmount();
    }
  });

  it("reads as a fraction when asked", async () => {
    const m = await mount(<SlideNav n={2} total={5} go={() => {}} labels={labels} format="fraction" />);
    try {
      expect(need(m.container.querySelector('[aria-live="polite"]'), "position").textContent).toBe("2 / 5");
    } finally {
      m.unmount();
    }
  });

  it("slideKeys moves with the arrow keys, but not past the ends, from a field, or once handled", async () => {
    const go = vi.fn<(n: number) => void>();
    const Keys = ({ n, total }: { n: number; total: number }): ReactNode => (
      <div className="viewer" tabIndex={0} onKeyDown={slideKeys(n, total, go)}>
        <input aria-label="field" />
        <select aria-label="choice">
          <option>a</option>
        </select>
        <span className="handled">x</span>
      </div>
    );
    const m = await mount(<Keys n={2} total={3} />);
    try {
      const viewer = need(m.container.querySelector(".viewer"), "viewer");
      expect(key(viewer, "ArrowRight")).toBe(false);
      expect(go).toHaveBeenLastCalledWith(3);
      expect(key(viewer, "ArrowLeft")).toBe(false);
      expect(go).toHaveBeenLastCalledWith(1);
      expect(key(viewer, "Enter")).toBe(true);
      expect(go).toHaveBeenCalledTimes(2);

      expect(key(need(m.container.querySelector("input"), "input"), "ArrowRight")).toBe(true);
      expect(key(need(m.container.querySelector("select"), "select"), "ArrowLeft")).toBe(true);
      expect(go).toHaveBeenCalledTimes(2);

      const handled = need(m.container.querySelector(".handled"), "handled span");
      handled.addEventListener("keydown", (e) => e.preventDefault());
      expect(key(handled, "ArrowRight")).toBe(false);
      expect(go).toHaveBeenCalledTimes(2);

      act(() => m.root.render(<Keys n={3} total={3} />));
      expect(key(viewer, "ArrowRight")).toBe(true);
      act(() => m.root.render(<Keys n={1} total={3} />));
      expect(key(viewer, "ArrowLeft")).toBe(true);
      expect(go).toHaveBeenCalledTimes(2);
    } finally {
      m.unmount();
    }
  });
});

// ---- file chips -------------------------------------------------------------------------------------

describe("FileChip and FileChips", () => {
  it("lists a place's visible documents as chips that open the File page with from", async () => {
    const route = "#/eor/fm/general/labs";
    const labs = published("g/fm/general/labs.json", isGeneral).files;
    expect(labs.files.map((f) => f.id)).toEqual([D(5)]);
    expect(labs.removed.map((f) => f.id)).toEqual([D(6)]);
    expect(labs.pending.map((f) => f.id)).toEqual([D(7)]);

    await go(`${route}?q=tsh`);
    const m = await mount(<FileChips list={labs} />);
    try {
      const chips = Array.from(m.container.querySelectorAll<HTMLAnchorElement>(".fchips a.fchip"));
      expect(chips.map((c) => [need(c.querySelector(".ftype"), "kind").textContent, need(c.querySelector("b"), "name").textContent, c.getAttribute("href")])).toEqual([
        ["DOC", "Thyroid notes", `#/file/${D(5)}?from=${encodeURIComponent(route)}`],
      ]);
      expect(need(chips[0], "chip").querySelector(".ftype")?.classList.contains("word")).toBe(true);
      expect(m.container.textContent).not.toContain("Old handout");
      expect(m.container.textContent).not.toContain("New upload");

      await click(chips[0]);
      expect(location.hash).toBe(`#/file/${D(5)}?from=${encodeURIComponent(route)}`);
    } finally {
      m.unmount();
    }
  });

  it("labels PDF and image chips and points them back at the page they are on", async () => {
    const guidelines = need(published("other.json", isOther).sections.find((s) => s.id === "guidelines"), "Guidelines section").files;
    const renal = need(published("g/fm/s/renal.json", isSystem).pharm, "renal pharm").files;
    const pdf = need(guidelines.files[0], "guidelines file");
    const image = need(renal.files[0], "renal pharm file");

    await go("#/other/guidelines");
    const m = await mount(<FileChip file={pdf} />);
    try {
      const chip = need(m.container.querySelector<HTMLAnchorElement>("a.fchip"), "pdf chip");
      expect(need(chip.querySelector(".ftype.pdf"), "pdf kind").textContent).toBe("PDF");
      expect(chip.querySelector("b")?.textContent).toBe("ACLS algorithms");
      expect(chip.getAttribute("href")).toBe(`#/file/${D(1)}?from=${encodeURIComponent("#/other/guidelines")}`);

      await go(RENAL_PHARM);
      act(() => m.root.render(<FileChip file={image} />));
      const img = need(m.container.querySelector<HTMLAnchorElement>("a.fchip"), "image chip");
      expect(need(img.querySelector(".ftype.image"), "image kind").textContent).toBe("IMG");
      expect(img.querySelector("b")?.textContent).toBe("Renal chart");
      expect(img.getAttribute("href")).toBe(`#/file/${D(2)}?from=${encodeURIComponent(RENAL_PHARM)}`);
    } finally {
      m.unmount();
    }
  });

  it("renders no chip row when a place has no visible documents", async () => {
    const labs = published("g/fm/general/labs.json", isGeneral).files;
    const m = await mount(<FileChips list={{ files: [], removed: labs.removed, pending: labs.pending }} />);
    try {
      expect(m.container.querySelector(".fchips")).toBeNull();
      expect(m.container.textContent).toBe("");
    } finally {
      m.unmount();
    }
  });
});

// ---- PDF status ---------------------------------------------------------------------------------------

describe("PdfStatus", () => {
  it("shows Loading while a PDF opens and an alert when it cannot be shown", async () => {
    const m = await mount(<PdfStatus error={false} />);
    try {
      expect(need(m.container.querySelector(".loading"), "loading").textContent).toBe("Loading…");
      expect(m.container.querySelector('[role="alert"]')).toBeNull();
      act(() => m.root.render(<PdfStatus error={true} />));
      expect(need(m.container.querySelector('[role="alert"]'), "alert").textContent).toBe("This file couldn't be shown. Use Download to open it.");
      expect(m.container.querySelector(".loading")).toBeNull();
    } finally {
      m.unmount();
    }
  });
});
