import { act, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError } from "../data/load.ts";
import {
  asOwner,
  B,
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
  visibleText,
  type DataServer,
  type Mounted,
} from "../testing.tsx";
import { PageBoundary, SITE_NAME, tabOf } from "./App.tsx";
import { PageNotFound } from "./errors.ts";
import { trapTab } from "./focus.ts";
import { formatDate, latest } from "./format.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { Link } from "./Link.tsx";
import { getOwner, setOwner, useOwner, Voice } from "./owner.tsx";
import { Crumbs, DrawerContext, PageHead, TableModeSwitch, useStacked } from "./Page.tsx";
import { reloadPrefs, setSidebarHidden, setTableMode, useSidebarHidden, useTableMode } from "./prefs.ts";
import { PHONE_QUERY } from "./responsive.ts";
import { parseHash } from "./route.ts";
import { TABS } from "./tabs.ts";
import { hideToast, showToast, Toast } from "./toast.tsx";

let files: Map<string, unknown>;
let server: DataServer;
let app: Mounted | null = null;
const extra: Mounted[] = [];
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");

/** Mounts `node` and unmounts it after the test. */
async function track(node: ReactNode): Promise<Mounted> {
  const m = await mount(node);
  extra.push(m);
  return m;
}

function need<T>(x: T | null | undefined, what: string): T {
  if (x === null || x === undefined) throw new Error(`missing ${what}`);
  return x;
}

function setMatchMedia(value: unknown): void {
  Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value });
}

interface PhoneQuery {
  set: (matches: boolean) => void;
  listeners: Set<() => void>;
  queried: string[];
}

/** A `window.matchMedia` whose single query reports `matches` and whose change listeners the test fires. */
function stubPhone(matches: boolean): PhoneQuery {
  const listeners = new Set<() => void>();
  const queried: string[] = [];
  const mq = {
    media: PHONE_QUERY,
    matches,
    addEventListener: (type: string, cb: () => void): void => {
      if (type === "change") listeners.add(cb);
    },
    removeEventListener: (type: string, cb: () => void): void => {
      if (type === "change") listeners.delete(cb);
    },
  };
  setMatchMedia((media: string) => {
    queried.push(media);
    return mq;
  });
  return {
    listeners,
    queried,
    set: (m: boolean) => {
      mq.matches = m;
      act(() => {
        for (const l of [...listeners]) l();
      });
    },
  };
}

function key(el: Element, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    el.dispatchEvent(e);
  });
  return e;
}

const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function focusables(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => !(x instanceof HTMLButtonElement && x.disabled));
}

beforeAll(async () => {
  files = await publishedFixture();
  installOwnerCss();
});

beforeEach(() => {
  server = serveData(files);
  asOwner(false);
  localStorage.clear();
  reloadPrefs();
  // Laptop unless a test stubs a phone: no usable matchMedia.
  setMatchMedia(undefined);
});

afterEach(() => {
  app?.unmount();
  app = null;
  for (const m of extra.splice(0)) m.unmount();
  server.restore();
  asOwner(false);
  act(() => hideToast());
  localStorage.clear();
  reloadPrefs();
  if (originalMatchMedia) Object.defineProperty(window, "matchMedia", originalMatchMedia);
  else Reflect.deleteProperty(window, "matchMedia");
});

describe("tabs", () => {
  it("maps each route to its header tab, and marks the current tab", async () => {
    expect(tabOf(parseHash("#/eor"))).toBe("eor");
    expect(tabOf(parseHash("#/eor/fm"))).toBe("eor");
    expect(tabOf(parseHash("#/pance"))).toBe("pance");
    expect(tabOf(parseHash("#/labs"))).toBe("labs");
    expect(tabOf(parseHash("#/other"))).toBe("other");
    expect(tabOf(parseHash("#/other/guidelines/updates"))).toBe("other");
    expect(tabOf(parseHash(`#/file/${D(5)}?from=%23%2Flabs`))).toBe("labs");
    expect(tabOf(parseHash(`#/file/${D(5)}`))).toBeNull();
    expect(tabOf(parseHash("#/versions/x"))).toBeNull();
    expect(tabOf(parseHash("#/nope"))).toBeNull();

    const a = await renderApp(`#/file/${D(5)}?from=%23%2Flabs`);
    app = a;
    const current = (): string[] => [...a.container.querySelectorAll('nav.tabs a.tab[aria-current="page"]')].map((t) => t.textContent ?? "");
    expect([...a.container.querySelectorAll("nav.tabs a.tab")].map((t) => [t.textContent, t.getAttribute("href")])).toEqual(TABS.map((t) => [t.label, t.to]));
    expect(current()).toEqual(["Labs"]);
    await go("#/pance");
    expect(current()).toEqual(["PANCE"]);
    await go("#/other/guidelines/updates");
    expect(current()).toEqual(["Other"]);
    await go("#/nope");
    expect(current()).toEqual([]);
    await until(() => a.container.querySelector(".brand")?.textContent === "PA Studying", "the site name");
    expect(SITE_NAME).toBe("PA Studying");
  });
});

describe("pages", () => {
  const ROUTES = [
    "#/eor",
    "#/eor/fm",
    "#/eor/fm/s/cardiovascular",
    "#/eor/fm/sec/cardiovascular/cad",
    `#/eor/fm/t/${R(101)}`,
    `#/eor/fm/b/${B(11)}`,
    "#/eor/fm/pharm/cardiovascular/antianginals",
    "#/eor/fm/general/labs",
    "#/eor/fm/workup",
    "#/eor/fm/slides",
    "#/pance",
    "#/labs",
    "#/other",
    "#/other/guidelines/updates",
    `#/file/${D(5)}?from=%23%2Flabs`,
  ];

  it.each(ROUTES)("renders %s inside the frame", async (hash) => {
    const a = await renderApp(hash);
    app = a;
    const h1 = await until(() => a.container.querySelector("main h1"), `the page heading at ${hash}`);
    expect(h1.textContent).not.toBe("This page couldn't load");
    expect(h1.textContent).not.toBe("This page isn't on the site");
    expect(a.container.querySelector("main .notfound")).toBeNull();
  });

  it("a visitor on a versions page gets the not-on-site page (Versions is the owner's)", async () => {
    const a = await renderApp(`#/versions/topic:fm:${R(101)}`);
    app = a;
    await flush();
    expect(a.container.querySelector("main .notfound h1")?.textContent).toBe("This page isn't on the site");
    expect(a.container.querySelector('main [data-surface="versions"]')).toBeNull();
  });

  it("shows the not-on-site page for an unknown route, and its link goes to the EOR guides", async () => {
    const a = await renderApp("#/nope");
    app = a;
    expect(a.container.querySelector("main .notfound h1")?.textContent).toBe("This page isn't on the site");
    expect(a.container.querySelector("#site-sidebar")).toBeNull();
    expect(a.container.querySelector(".side-rail")).toBeNull();
    const link = need(byText<HTMLAnchorElement>(a.container, "main .notfound a", "Go to the EOR guides"), "EOR link");
    expect(link.getAttribute("href")).toBe("#/eor");
    await click(link);
    expect(location.hash).toBe("#/eor");
    const h1 = await until(() => a.container.querySelector("main h1"), "the picker");
    expect(h1.textContent).toBe("EOR study guides");
  });

  it("the skip link focuses the page without changing the address", async () => {
    const a = await renderApp("#/eor");
    app = a;
    const skip = need(byText(a.container, "a.skip", "Skip to the page"), "skip link");
    await click(skip);
    expect(document.activeElement).toBe(a.container.querySelector("main#page"));
    expect(location.hash).toBe("#/eor");
  });
});

describe("laptop sidebar", () => {
  it("Hide leaves the rail, focus follows the reappearing button, and the choice persists", async () => {
    const a = await renderApp("#/eor/fm");
    app = a;
    await until(() => a.container.querySelector("#site-sidebar .side-in"), "the sidebar contents");
    const hide = need(byText<HTMLButtonElement>(a.container, "button.side-collapse", "Hide"), "Hide");
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    expect(hide.getAttribute("aria-controls")).toBe("site-sidebar");
    // First load moves no focus.
    expect(document.activeElement).not.toBe(hide);
    expect(a.container.querySelector(".layout-tog")).toBeNull();
    expect(a.container.querySelector("button.contents-btn")).toBeNull();

    await click(hide);
    const rail = need(a.container.querySelector<HTMLButtonElement>('.side-rail button[aria-label="Show sidebar"]'), "rail");
    expect(a.container.querySelector("#site-sidebar")).toBeNull();
    expect(rail.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(rail);
    expect(localStorage.getItem("pa.sidebarHidden")).toBe("1");

    await go("#/eor/fm/s/pulmonary");
    await until(() => a.container.querySelector("main h1"), "the pulmonary page");
    expect(a.container.querySelector('.side-rail button[aria-label="Show sidebar"]')).not.toBeNull();
    expect(a.container.querySelector("#site-sidebar")).toBeNull();
    // Laptop tables are grids.
    expect(a.container.querySelector("main table.nt")).not.toBeNull();
    expect(a.container.querySelector("main .stacked")).toBeNull();

    await click(a.container.querySelector('.side-rail button[aria-label="Show sidebar"]'));
    expect(a.container.querySelector(".side-rail")).toBeNull();
    const hideAgain = need(byText<HTMLButtonElement>(a.container, "button.side-collapse", "Hide"), "Hide again");
    expect(document.activeElement).toBe(hideAgain);
    expect(localStorage.getItem("pa.sidebarHidden")).toBe("0");
  });

  it("starts hidden when storage says so, without moving focus", async () => {
    localStorage.setItem("pa.sidebarHidden", "1");
    act(() => reloadPrefs());
    const a = await renderApp("#/labs");
    app = a;
    const rail = need(a.container.querySelector('.side-rail button[aria-label="Show sidebar"]'), "rail");
    expect(document.activeElement).not.toBe(rail);
    await click(rail);
    await until(() => a.container.querySelector("#site-sidebar"), "the labs sidebar");
  });
});

describe("phone", () => {
  it("has no rail or sidebar; Contents opens a focus-trapped drawer that Escape, the scrim and navigation close", async () => {
    stubPhone(true);
    const a = await renderApp("#/eor/fm");
    app = a;
    expect(a.container.querySelector(".site")?.classList.contains("is-phone")).toBe(true);
    const contents = await until(() => byText(a.container, "button.contents-btn", "Contents"), "the Contents button");
    expect(a.container.querySelector(".side-rail")).toBeNull();
    expect(a.container.querySelector("#site-sidebar")).toBeNull();
    expect(a.container.querySelector('aside[role="dialog"]')).toBeNull();

    await click(contents);
    const drawer = need(a.container.querySelector('aside.drawer[role="dialog"]'), "drawer");
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    const close = need(drawer.querySelector<HTMLButtonElement>('button[aria-label="Close contents"]'), "close");
    expect(document.activeElement).toBe(close);

    const esc = key(close, { key: "Escape" });
    expect(esc.defaultPrevented).toBe(true);
    expect(a.container.querySelector('aside[role="dialog"]')).toBeNull();

    await click(byText(a.container, "button.contents-btn", "Contents"));
    const d2 = need(a.container.querySelector('aside.drawer[role="dialog"]'), "drawer again");
    await until(() => d2.querySelector(".side-in"), "the drawer's sidebar");
    const items = focusables(d2);
    expect(items.length).toBeGreaterThan(2);
    const first = need(items[0], "first focusable");
    const last = need(items[items.length - 1], "last focusable");
    expect(first).toBe(d2.querySelector('button[aria-label="Close contents"]'));

    last.focus();
    const wrap = key(last, { key: "Tab" });
    expect(wrap.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    const back = key(first, { key: "Tab", shiftKey: true });
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);

    const middle = need(items[1], "middle focusable");
    middle.focus();
    const through = key(middle, { key: "Tab" });
    expect(through.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(middle);

    const other = key(middle, { key: "a" });
    expect(other.defaultPrevented).toBe(false);
    expect(a.container.querySelector('aside[role="dialog"]')).not.toBeNull();

    await click(a.container.querySelector(".drawer-scrim"));
    expect(a.container.querySelector('aside[role="dialog"]')).toBeNull();

    await click(byText(a.container, "button.contents-btn", "Contents"));
    expect(a.container.querySelector('aside[role="dialog"]')).not.toBeNull();
    await go("#/eor/fm/s/pulmonary");
    expect(a.container.querySelector('aside[role="dialog"]')).toBeNull();

    const contents3 = await until(() => byText(a.container, "button.contents-btn", "Contents"), "Contents on pulmonary");
    await click(contents3);
    const d3 = need(a.container.querySelector('aside.drawer[role="dialog"]'), "drawer on pulmonary");
    const gname = await until(() => d3.querySelector<HTMLAnchorElement>("a.gname"), "the guide link in the drawer");
    await click(gname);
    expect(location.hash).toBe("#/eor/fm");
    expect(a.container.querySelector('aside[role="dialog"]')).toBeNull();
  });

  it("follows the 900px query as it changes, and stops listening on unmount", async () => {
    const mq = stubPhone(false);
    const a = await renderApp("#/eor/fm");
    app = a;
    await until(() => a.container.querySelector("#site-sidebar"), "the laptop sidebar");
    expect(mq.queried).toContain("(max-width: 899.98px)");
    expect(mq.listeners.size).toBeGreaterThan(0);

    mq.set(true);
    expect(a.container.querySelector(".site")?.classList.contains("is-phone")).toBe(true);
    expect(a.container.querySelector("#site-sidebar")).toBeNull();
    await until(() => byText(a.container, "button.contents-btn", "Contents"), "the Contents button");

    mq.set(false);
    expect(a.container.querySelector(".site")?.classList.contains("is-phone")).toBe(false);
    expect(a.container.querySelector("#site-sidebar")).not.toBeNull();
    expect(a.container.querySelector("button.contents-btn")).toBeNull();

    a.unmount();
    app = null;
    expect(mq.listeners.size).toBe(0);
  });

  it("Table replaces stacked tables with grids, is stored, and survives a reload of the preferences", async () => {
    stubPhone(true);
    const a = await renderApp("#/eor/fm/s/cardiovascular");
    app = a;
    await until(() => a.container.querySelector("main .stacked"), "stacked tables");
    expect(a.container.querySelector("main table.nt")).toBeNull();
    const group = need(a.container.querySelector('[role="group"][aria-label="Table layout"]'), "switch");
    const stackedBtn = need(byText<HTMLButtonElement>(group, "button", "Stacked"), "Stacked");
    const tableBtn = need(byText<HTMLButtonElement>(group, "button", "Table"), "Table");
    expect(stackedBtn.getAttribute("aria-pressed")).toBe("true");
    expect(tableBtn.getAttribute("aria-pressed")).toBe("false");

    await click(tableBtn);
    expect(localStorage.getItem("pa.tableMode")).toBe("table");
    expect(a.container.querySelector("main .stacked")).toBeNull();
    expect(a.container.querySelector("main table.nt")).not.toBeNull();
    expect(tableBtn.getAttribute("aria-pressed")).toBe("true");

    act(() => reloadPrefs());
    expect(a.container.querySelector("main .stacked")).toBeNull();
    expect(a.container.querySelector("main table.nt")).not.toBeNull();

    await click(stackedBtn);
    expect(localStorage.getItem("pa.tableMode")).toBe("stacked");
    expect(a.container.querySelector("main .stacked")).not.toBeNull();
  });
});

describe("page head", () => {
  function Stacked(): ReactNode {
    return <output>{String(useStacked())}</output>;
  }

  it("on phone offers the table switch and the Contents button only when a drawer is provided", async () => {
    stubPhone(true);
    const open = vi.fn();
    const withDrawer = await track(
      <DrawerContext.Provider value={open}>
        <PageHead crumbs={[{ label: "Here" }]} title="Title" tables actions={<button type="button">Act</button>} />
      </DrawerContext.Provider>,
    );
    expect(withDrawer.container.querySelector("h1")?.textContent).toBe("Title");
    expect(byText(withDrawer.container, ".acts button", "Act")).not.toBeNull();
    expect(withDrawer.container.querySelector(".acts .layout-tog")).not.toBeNull();
    await click(byText(withDrawer.container, "button.contents-btn", "Contents"));
    expect(open).toHaveBeenCalledTimes(1);

    const noDrawer = await track(<PageHead crumbs={[{ label: "Here" }]} title="Plain" />);
    expect(noDrawer.container.querySelector("button.contents-btn")).toBeNull();
    expect(noDrawer.container.querySelector(".layout-tog")).toBeNull();
  });

  it("on laptop shows neither the switch nor the Contents button", async () => {
    const open = vi.fn();
    const m = await track(
      <DrawerContext.Provider value={open}>
        <PageHead crumbs={[{ label: "Here" }]} title="Title" tables />
      </DrawerContext.Provider>,
    );
    expect(m.container.querySelector("button.contents-btn")).toBeNull();
    expect(m.container.querySelector(".layout-tog")).toBeNull();
  });

  it("useStacked is true only on phone with Stacked chosen", async () => {
    const laptop = await track(<Stacked />);
    expect(laptop.container.textContent).toBe("false");
    laptop.unmount();
    extra.splice(extra.indexOf(laptop), 1);

    stubPhone(true);
    const phone = await track(
      <>
        <Stacked />
        <TableModeSwitch />
      </>,
    );
    expect(phone.container.querySelector("output")?.textContent).toBe("true");
    act(() => setTableMode("table"));
    expect(phone.container.querySelector("output")?.textContent).toBe("false");
  });

  it("Crumbs link every crumb with a target and mark the last as the current page", async () => {
    const m = await track(<Crumbs items={[{ label: "EOR", to: "#/eor" }, { label: "Middle" }, { label: "Here" }]} />);
    const nav = need(m.container.querySelector('nav.crumbs[aria-label="Location"]'), "crumbs");
    const crumbs = [...nav.querySelectorAll(":scope > .crumb")];
    expect(crumbs.map((c) => c.textContent)).toEqual(["EOR", "›Middle", "›Here"]);
    expect(crumbs[0]?.querySelector("a")?.getAttribute("href")).toBe("#/eor");
    expect(crumbs[1]?.querySelector("span:not([aria-hidden])")?.hasAttribute("aria-current")).toBe(false);
    expect(crumbs[2]?.querySelector("span:not([aria-hidden])")?.getAttribute("aria-current")).toBe("page");
    expect(nav.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
  });
});

describe("preferences", () => {
  function Prefs(): ReactNode {
    return <output>{`${String(useSidebarHidden())} ${useTableMode()}`}</output>;
  }

  it("keep working in memory when storage is unavailable", async () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    try {
      act(() => reloadPrefs());
      const m = await track(<Prefs />);
      expect(m.container.textContent).toBe("false stacked");
      act(() => {
        setSidebarHidden(true);
        setTableMode("table");
      });
      expect(m.container.textContent).toBe("true table");
      expect(set).toHaveBeenCalledWith("pa.sidebarHidden", "1");
      expect(set).toHaveBeenCalledWith("pa.tableMode", "table");
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
    expect(localStorage.getItem("pa.sidebarHidden")).toBeNull();
    expect(localStorage.getItem("pa.tableMode")).toBeNull();
  });
});

describe("owner", () => {
  it("the footer legend is visible only to the owner", async () => {
    const a = await renderApp("#/eor");
    app = a;
    const foot = need(a.container.querySelector("footer.foot"), "footer");
    expect(visibleText(foot)).not.toContain("Anything not from your notes is marked");
    expect(visibleText(foot)).toContain("PA Studying");
    asOwner(true);
    expect(visibleText(foot)).toContain("Anything not from your notes is marked Not from your notes or Updated guideline");
    asOwner(false);
    expect(visibleText(foot)).not.toContain("Anything not from your notes is marked");
  });

  it("Voice renders both wordings and the stylesheet shows the one that applies; setOwner drives useOwner", async () => {
    function Who(): ReactNode {
      const o = useOwner();
      return <i>{o.owner ? `owner ${o.login ?? ""}` : "visitor"}</i>;
    }
    const m = await track(
      <div>
        <p id="both">
          <Voice owner="Your notes" visitor="Her notes" />
        </p>
        <p id="ownonly">
          <Voice owner="Only yours" />
        </p>
        <Who />
      </div>,
    );
    const both = need(m.container.querySelector("#both"), "both");
    const ownOnly = need(m.container.querySelector("#ownonly"), "own only");
    expect([...both.querySelectorAll("span")].map((s) => [s.className, s.textContent])).toEqual([
      ["own-only", "Your notes"],
      ["vis-only", "Her notes"],
    ]);
    expect(ownOnly.querySelectorAll("span")).toHaveLength(1);
    expect(document.documentElement.hasAttribute("data-owner")).toBe(false);
    expect(visibleText(both)).toBe("Her notes");
    expect(visibleText(ownOnly)).toBe("");
    expect(m.container.querySelector("i")?.textContent).toBe("visitor");

    const signedIn = { owner: true, login: "kaitlyla" };
    act(() => setOwner(signedIn));
    expect(document.documentElement.hasAttribute("data-owner")).toBe(true);
    expect(visibleText(both)).toBe("Your notes");
    expect(visibleText(ownOnly)).toBe("Only yours");
    expect(m.container.querySelector("i")?.textContent).toBe("owner kaitlyla");
    expect(getOwner()).toEqual(signedIn);
    expect(getOwner()).not.toBe(signedIn);

    act(() => setOwner({ owner: false, login: "someone" }));
    expect(document.documentElement.hasAttribute("data-owner")).toBe(false);
    expect(getOwner()).toEqual({ owner: false });
    expect(visibleText(both)).toBe("Her notes");
    expect(m.container.querySelector("i")?.textContent).toBe("visitor");
  });
});

describe("page boundary", () => {
  function Boom({ error }: { error: Error }): ReactNode {
    throw error;
  }

  it("shows the not-on-site page for a missing data file or id, without logging it", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const missing = new NotFoundError("guides/x.json");
      const m = await track(
        <PageBoundary resetKey="a">
          <Boom error={missing} />
        </PageBoundary>,
      );
      expect(m.container.querySelector(".notfound h1")?.textContent).toBe("This page isn't on the site");
      expect(m.container.querySelector('[role="alert"]')).toBeNull();
      expect(spy.mock.calls.some((c) => c[0] === missing)).toBe(false);

      const noId = new PageNotFound("topic r_1");
      const n = await track(
        <PageBoundary resetKey="a">
          <Boom error={noId} />
        </PageBoundary>,
      );
      expect(n.container.querySelector(".notfound h1")?.textContent).toBe("This page isn't on the site");
      expect(spy.mock.calls.some((c) => c[0] === noId)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("shows a plain message for any other failure, logs it, and clears it when the route changes", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const broken = new Error("boom");
      const m = await track(
        <PageBoundary resetKey="a">
          <Boom error={broken} />
        </PageBoundary>,
      );
      const alert = need(m.container.querySelector('.notfound[role="alert"]'), "alert");
      expect(alert.querySelector("h1")?.textContent).toBe("This page couldn't load");
      expect(alert.querySelector("p")?.textContent).toBe("Check the connection and reload the page.");
      expect(spy.mock.calls.some((c) => c[0] === broken)).toBe(true);

      // Same route: the error stays.
      act(() =>
        m.root.render(
          <PageBoundary resetKey="a">
            <p className="fine">fine</p>
          </PageBoundary>,
        ),
      );
      expect(m.container.querySelector(".fine")).toBeNull();
      expect(m.container.querySelector('[role="alert"]')).not.toBeNull();

      act(() =>
        m.root.render(
          <PageBoundary resetKey="b">
            <p className="fine">fine</p>
          </PageBoundary>,
        ),
      );
      expect(m.container.querySelector(".fine")?.textContent).toBe("fine");
      expect(m.container.querySelector('[role="alert"]')).toBeNull();

      // A route change with no error keeps the children.
      act(() =>
        m.root.render(
          <PageBoundary resetKey="c">
            <p className="fine">still fine</p>
          </PageBoundary>,
        ),
      );
      expect(m.container.querySelector(".fine")?.textContent).toBe("still fine");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("toast", () => {
  it("shows the message, Undo runs its callback, Dismiss hides it, and it hides itself after its time", async () => {
    const m = await track(<Toast />);
    const region = need(m.container.querySelector('.toast-region[role="status"]'), "region");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.querySelector(".toast")).toBeNull();
    vi.useFakeTimers();
    try {
      const undo = vi.fn();
      act(() => showToast("Saved", { undo }));
      expect(region.querySelector(".toast span")?.textContent).toBe("Saved");
      act(() => need(byText(region, "button", "Undo"), "Undo").click());
      expect(undo).toHaveBeenCalledTimes(1);
      expect(region.querySelector(".toast")).toBeNull();

      act(() => showToast("Copied"));
      expect(byText(region, "button", "Undo")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(3799);
      });
      expect(region.querySelector(".toast span")?.textContent).toBe("Copied");
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(region.querySelector(".toast")).toBeNull();

      // A newer toast replaces the old one and its timer.
      act(() => showToast("First", { ms: 1000 }));
      act(() => showToast("Second", { ms: 5000 }));
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(region.querySelector(".toast span")?.textContent).toBe("Second");

      // ms 0 stays until dismissed.
      act(() => showToast("Sticky", { ms: 0 }));
      act(() => {
        vi.advanceTimersByTime(60000);
      });
      expect(region.querySelector(".toast span")?.textContent).toBe("Sticky");
      act(() => need(region.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]'), "Dismiss").click());
      expect(region.querySelector(".toast")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("format", () => {
  it("formats days and months, short and long, and passes anything else through", () => {
    expect(formatDate("2026-10-01", "short")).toBe("Oct 1, 2026");
    expect(formatDate("2026-10-01", "long")).toBe("October 1, 2026");
    expect(formatDate("2026-10-01")).toBe("Oct 1, 2026");
    expect(formatDate("2024-04")).toBe("Apr 2024");
    expect(formatDate("2024-04", "long")).toBe("April 2024");
    expect(formatDate("2026-10-04T12:00:00Z")).toBe("Oct 4, 2026");
    expect(formatDate(null)).toBe("");
    expect(formatDate(undefined)).toBe("");
    expect(formatDate("")).toBe("");
    expect(formatDate("soon")).toBe("soon");
    expect(formatDate("2026-13-01")).toBe("2026-13-01");
  });

  it("latest picks the newest ISO date", () => {
    expect(latest(["2024-04", "2026-10-01", "2025-01-05"])).toBe("2026-10-01");
    expect(latest(["2026-10-01T09:00:00Z", "2026-10-01"])).toBe("2026-10-01T09:00:00Z");
    expect(latest([])).toBeNull();
  });
});

describe("Link", () => {
  it("a plain click navigates in-app; a modified or non-primary click is left to the browser", async () => {
    await go("#/labs");
    const seen: boolean[] = [];
    // Records whether the link already prevented the click, then stops the browser's own navigation.
    const record = (e: Event): void => {
      seen.push(e.defaultPrevented);
      e.preventDefault();
    };
    document.addEventListener("click", record);
    try {
      const m = await track(
        <Link to="/eor/fm" className="go" title="Family Medicine">
          Go
        </Link>,
      );
      const el = need(m.container.querySelector("a.go"), "link");
      expect(el.getAttribute("href")).toBe("#/eor/fm");
      expect(el.getAttribute("title")).toBe("Family Medicine");
      const mods: MouseEventInit[] = [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }];
      for (const mod of mods) {
        act(() => {
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...mod }));
        });
        expect(location.hash).toBe("#/labs");
      }
      expect(seen).toEqual([false, false, false, false, false]);

      act(() => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
      expect(seen.at(-1)).toBe(true);
      expect(location.hash).toBe("#/eor/fm");

      const own = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
      const n = await track(
        <Link to="#/pance" className="own" onClick={own}>
          PANCE
        </Link>,
      );
      act(() => {
        need(n.container.querySelector("a.own"), "own link").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      expect(own).toHaveBeenCalledTimes(1);
      expect(location.hash).toBe("#/eor/fm");
    } finally {
      document.removeEventListener("click", record);
    }
  });
});

describe("focus trap", () => {
  it("skips disabled controls and does nothing without focusable content", async () => {
    const m = await track(
      <div>
        <div className="withbtns" onKeyDown={trapTab}>
          <button type="button">One</button>
          <button type="button">Two</button>
          <button type="button" disabled>
            Off
          </button>
        </div>
        <div className="empty" tabIndex={-1} onKeyDown={trapTab}>
          text
        </div>
      </div>,
    );
    const two = need(byText<HTMLButtonElement>(m.container, ".withbtns button", "Two"), "Two");
    const one = need(byText<HTMLButtonElement>(m.container, ".withbtns button", "One"), "One");
    two.focus();
    const e = key(two, { key: "Tab" });
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(one);

    const empty = need(m.container.querySelector<HTMLElement>(".empty"), "empty");
    empty.focus();
    const f = key(empty, { key: "Tab" });
    expect(f.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(empty);
  });
});

describe("Icon", () => {
  const NAMES: IconName[] = ["search", "chev", "plus", "x", "dl", "menu", "hide", "show", "pill", "gap", "upd", "ext", "back"];

  it("draws every icon as a hidden 16px line drawing unless sized", async () => {
    const m = await track(
      <div>
        {NAMES.map((n) => (
          <span key={n} data-n={n}>
            <Icon n={n} />
          </span>
        ))}
        <span data-n="sized">
          <Icon n="x" size={14} />
        </span>
      </div>,
    );
    for (const n of NAMES) {
      const svg = need(m.container.querySelector(`[data-n="${n}"] svg.ic`), `icon ${n}`);
      expect(svg.getAttribute("width")).toBe("16");
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      expect(svg.getAttribute("focusable")).toBe("false");
      expect(svg.querySelectorAll("path, circle, rect").length).toBeGreaterThan(0);
    }
    const sized = need(m.container.querySelector('[data-n="sized"] svg'), "sized icon");
    expect(sized.getAttribute("width")).toBe("14");
    expect(sized.getAttribute("height")).toBe("14");
    const drawn = NAMES.map((n) => m.container.querySelector(`[data-n="${n}"] svg`)?.innerHTML);
    expect(new Set(drawn).size).toBe(NAMES.length);
  });
});
