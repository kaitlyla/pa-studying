import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, until, type Mounted } from "../testing.tsx";
import { PdfPages } from "./pdf.tsx";

// pdf.js itself cannot run here (no worker, no canvas), so it is faked at its getDocument boundary.
interface FakeTask {
  promise: Promise<FakeDoc>;
  destroy: ReturnType<typeof vi.fn<() => Promise<void>>>;
  resolve: (doc: FakeDoc) => void;
  reject: (e: unknown) => void;
}

interface FakePage {
  getViewport: (o: { scale: number }) => { width: number; height: number };
  render: ReturnType<typeof vi.fn<(o: { canvas: HTMLCanvasElement }) => { promise: Promise<void>; cancel: () => void }>>;
}

interface FakeDoc {
  numPages: number;
  getPage: ReturnType<typeof vi.fn<(n: number) => Promise<FakePage>>>;
  pages: FakePage[];
}

const pdfjs = vi.hoisted(() => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: vi.fn<(src: { url: string }) => FakeTask>(),
}));

vi.mock("pdfjs-dist", () => pdfjs);

const PDF_URL = "/data/files/d_0000000001/ACLS algorithms.pdf";
const ALERT = "This file couldn't be shown. Use Download to open it.";

function task(): FakeTask {
  let resolve: (doc: FakeDoc) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise<FakeDoc>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, destroy: vi.fn(() => Promise.resolve()), resolve, reject };
}

function doc(numPages: number): FakeDoc {
  const pages = Array.from({ length: numPages }, (): FakePage => ({
    getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: () => {} })),
  }));
  return { numPages, pages, getPage: vi.fn((n: number) => Promise.resolve(pages[n - 1] as FakePage)) };
}

let t: FakeTask;
let m: Mounted | null = null;

beforeEach(() => {
  t = task();
  pdfjs.getDocument.mockReset().mockImplementation(() => t);
});

afterEach(() => {
  m?.unmount();
  m = null;
  vi.restoreAllMocks();
});

async function open(): Promise<Mounted> {
  m = await mount(<PdfPages url={PDF_URL} />);
  await until(() => pdfjs.getDocument.mock.calls.length > 0, "the getDocument call");
  return m;
}

describe("PdfPages", () => {
  it("shows Loading… while the PDF opens, asking pdf.js for that URL with the bundled worker", async () => {
    const { container } = await open();
    expect(pdfjs.getDocument.mock.calls).toEqual([[{ url: PDF_URL }]]);
    expect(pdfjs.GlobalWorkerOptions.workerSrc).toMatch(/pdf\.worker\.min\.mjs$/);
    expect(container.querySelector(".loading")?.textContent).toBe("Loading…");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector(".pdfpage")).toBeNull();
  });

  it("shows the alert and logs the error when the PDF cannot be opened", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = await open();
    const failure = new Error("Invalid PDF structure");
    await act(async () => t.reject(failure));
    const alert = await until(() => container.querySelector('[role="alert"]'), "the alert");
    expect(alert.textContent).toBe(ALERT);
    expect(container.querySelector(".loading")).toBeNull();
    expect(logged).toHaveBeenCalledWith(failure);
  });

  it("draws every page, top to bottom, each on its own canvas", async () => {
    const { container } = await open();
    const d = doc(3);
    await act(async () => t.resolve(d));
    await until(() => d.pages.every((p) => p.render.mock.calls.length === 1), "every page drawn");
    const boxes = [...container.querySelectorAll(".pdfv .pdfpage")];
    expect(boxes.map((b) => [b.getAttribute("aria-label"), b.getAttribute("data-anchor")])).toEqual([
      ["Page 1", "p1"],
      ["Page 2", "p2"],
      ["Page 3", "p3"],
    ]);
    expect(d.getPage.mock.calls).toEqual([[1], [2], [3]]);
    d.pages.forEach((p, i) => expect(p.render.mock.calls[0]?.[0].canvas).toBe(boxes[i]?.querySelector("canvas")));
    expect(container.querySelector(".loading")).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("destroys the loading task when it unmounts after the PDF opened", async () => {
    const { container } = await open();
    await act(async () => t.resolve(doc(1)));
    await until(() => container.querySelector(".pdfpage"), "the page");
    expect(t.destroy).not.toHaveBeenCalled();
    m?.unmount();
    m = null;
    expect(t.destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys the loading task when it unmounts while still loading, and ignores a later failure", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await open();
    m?.unmount();
    m = null;
    expect(t.destroy).toHaveBeenCalledTimes(1);
    await act(async () => t.reject(new Error("Worker was destroyed")));
    expect(logged).not.toHaveBeenCalled();
  });
});
