// Test-only: the published data of tools/build/test-fixture.ts (built by the real lib/derive publish)
// served to the app through a fetch stub, and a harness that renders the app at a route and waits
// for its data. Not part of the site bundle (nothing outside *.test.tsx imports it).
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Content } from "../lib/derive/model.ts";
import { publish } from "../lib/derive/publish.ts";
import { loadContent } from "../tools/build/load.ts";
import { writeFixture } from "../tools/build/test-fixture.ts";
import { DATA_BASE, invalidateData } from "./data/load.ts";
import { App } from "./shell/App.tsx";
import { setOwner } from "./shell/owner.tsx";
import { navigate } from "./shell/route.ts";
import siteCss from "./styles.css?raw";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export { B, C, D, G, P, R, S, U } from "../tools/build/test-fixture.ts";

export interface PublishedFixture {
  /** Every file of the fixture's content tree by repository path (`content/...`), as written. */
  files: Record<string, Uint8Array>;
  /** The published data files by path under `data/`. */
  published: Map<string, unknown>;
}

async function walk(dir: string, out: string[]): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else out.push(p);
  }
}

/**
 * Writes tools/build/test-fixture.ts to a temporary tree, loads it, lets `mutate` change the loaded
 * content, and publishes it with the real lib/derive publish. `files` is the tree as written.
 */
export async function publishFixture(mutate?: (content: Content) => void): Promise<PublishedFixture> {
  const root = await mkdtemp(join(tmpdir(), "pa-app-"));
  try {
    await writeFixture(root);
    const paths: string[] = [];
    await walk(join(root, "content"), paths);
    const files: Record<string, Uint8Array> = {};
    for (const p of paths) files[relative(root, p).split(sep).join("/")] = new Uint8Array(await readFile(p));
    const content = await loadContent(root);
    mutate?.(content);
    return { files, published: publish(content).files };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The fixture's published files, keyed by path under `data/`. */
export async function publishedFixture(): Promise<Map<string, unknown>> {
  return (await publishFixture()).published;
}

export interface DataServer {
  /** Data paths requested (under `data/`), and full URLs of other requests, in order. */
  requests: string[];
  restore: () => void;
}

/**
 * Answers `fetch(DATA_BASE + path)` from `files` (404 when absent) and clears the data cache. Any other
 * URL goes to `other` when given (and is not recorded), else is recorded and answers 404.
 */
export function serveData(files: Map<string, unknown>, other?: typeof fetch): DataServer {
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (other && !url.startsWith(DATA_BASE)) return other(input, init);
    const path = url.startsWith(DATA_BASE) ? url.slice(DATA_BASE.length) : url;
    requests.push(path);
    const body = files.get(path);
    if (body === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  };
  invalidateData();
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
      invalidateData();
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Lets React and pending fetches run until `find` returns a value (fails after ~2 s). */
export async function until<T>(find: () => T | null | undefined | false, what: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = find();
    if (v) return v;
    await act(async () => {
      await sleep(10);
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Runs pending React work and fetches for a short while. */
export async function flush(ms = 20): Promise<void> {
  await act(async () => {
    await sleep(ms);
  });
}

export interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

/** Renders `node` into a fresh container in the document. */
export function mount(node: ReactNode): Mounted {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** Navigates to `hash` and renders the whole app there. */
export async function renderApp(hash: string): Promise<Mounted> {
  await navigate(hash);
  return mount(<App />);
}

/** Moves the mounted app to `hash`. */
export async function go(hash: string): Promise<void> {
  await act(async () => {
    await navigate(hash);
  });
}

/** Signs the owner in or out (the `data-owner` switch OB9's check drives). */
export function asOwner(owner: boolean): void {
  act(() => setOwner(owner ? { owner: true, login: "kaitlyla" } : { owner: false }));
}

let ownerCss: HTMLStyleElement | null = null;

/** Installs the site stylesheet's owner/visitor rules (app/styles.css) so visibility can be checked. */
export function installOwnerCss(): void {
  if (ownerCss) return;
  const rules = siteCss.split("\n").filter((l) => /\.(own|vis)-only\b/.test(l) && l.includes("{"));
  ownerCss = document.createElement("style");
  ownerCss.textContent = rules.join("\n");
  document.head.append(ownerCss);
}

/** True when `el` and all its ancestors are displayed under the installed CSS. */
export function shown(el: Element | null): boolean {
  for (let e = el; e; e = e.parentElement) {
    if (getComputedStyle(e).display === "none" || (e as HTMLElement).hidden) return false;
  }
  return el !== null;
}

/** The text a reader sees in `root`: hidden elements (by CSS or `hidden`) left out, whitespace collapsed. */
export function visibleText(root: Element): string {
  const parts: string[] = [];
  const walk = (n: Node): void => {
    if (n.nodeType === Node.TEXT_NODE) {
      parts.push(n.textContent ?? "");
      return;
    }
    if (n instanceof Element && (getComputedStyle(n).display === "none" || (n as HTMLElement).hidden)) return;
    n.childNodes.forEach(walk);
  };
  walk(root);
  return parts.join("").replace(/\s+/g, " ").trim();
}

/** Clicks an element inside `act`. */
export async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error("nothing to click");
  await act(async () => {
    (el as HTMLElement).click();
    await sleep(0);
  });
}

/**
 * The first element under `root` matching `selector` whose text contains `text`. Without a type
 * argument it is an HTMLElement; the first overload keeps that true when the call's result is passed
 * straight into another generic (where inference would otherwise widen it to Element).
 */
export function byText(root: ParentNode, selector: string, text: string | RegExp): HTMLElement | null;
export function byText<E extends Element>(root: ParentNode, selector: string, text: string | RegExp): E | null;
export function byText<E extends Element>(root: ParentNode, selector: string, text: string | RegExp): E | null {
  for (const el of root.querySelectorAll<E>(selector)) {
    const t = el.textContent ?? "";
    if (typeof text === "string" ? t.includes(text) : text.test(t)) return el;
  }
  return null;
}
