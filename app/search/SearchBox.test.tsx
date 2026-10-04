import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { navigate } from "../shell/route.ts";
import { SearchClient, setSearchClient } from "./client.ts";
import { SearchBox } from "./SearchBox.tsx";
import { DEBOUNCE_MS } from "./SearchPanel.tsx";
import { resetSearchState } from "./store.ts";
import { BASE, fakeSite, inProcessWorker, U, type FakeSite } from "./testing.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** IntersectionObserver stand-in: rows become visible only when the test reveals them. */
class FakeIO {
  static all: FakeIO[] = [];
  els: Element[] = [];
  private readonly cb: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
    FakeIO.all.push(this);
  }
  observe(el: Element): void {
    this.els.push(el);
  }
  unobserve(): void {}
  disconnect(): void {
    this.els = [];
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  fire(): void {
    if (this.els.length === 0) return;
    this.cb(this.els.map((target) => ({ isIntersecting: true, target }) as unknown as IntersectionObserverEntry), this as unknown as IntersectionObserver);
  }
}

let site: FakeSite;
let client: SearchClient;
let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  site = fakeSite();
});

beforeEach(async () => {
  site.requests.length = 0;
  site.failing.clear();
  FakeIO.all = [];
  vi.stubGlobal("IntersectionObserver", FakeIO);
  client = new SearchClient(() => inProcessWorker(site.fetch), BASE, site.fetch);
  setSearchClient(client);
  resetSearchState();
  await navigate("#/eor");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  setSearchClient(null);
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await sleep(ms);
  });
}

/** Wait (bounded) until `find` returns something. */
async function until<T>(find: () => T | null | undefined | false, what: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = find();
    if (v) return v;
    await settle(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function render(phone = false): void {
  act(() => root.render(<SearchBox phone={phone} />));
}

const input = (): HTMLInputElement => {
  const el = container.querySelector<HTMLInputElement>('input[aria-label="Search all notes"]');
  if (!el) throw new Error("no search input");
  return el;
};

function typeInto(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const panel = (): HTMLElement | null => container.querySelector<HTMLElement>('[aria-label="Search results"]');
const status = (): string => container.querySelector(".srch-status")?.textContent ?? "";
const rows = (): HTMLButtonElement[] => [...container.querySelectorAll<HTMLButtonElement>(".srch-row")];
const row = (n: number): HTMLButtonElement | null => container.querySelector<HTMLButtonElement>(`.srch-row[data-unit="${n}"]`);
const chip = (label: string): HTMLButtonElement => {
  const b = [...container.querySelectorAll<HTMLButtonElement>(".srch-chips button")].find((x) => x.textContent?.startsWith(label));
  if (!b) throw new Error(`no chip ${label}`);
  return b;
};

/** Focus the box, type `q`, and wait for the results (or a final message) to show. */
async function search(q: string): Promise<void> {
  act(() => input().focus());
  typeInto(input(), q);
  await settle(DEBOUNCE_MS + 10);
  await until(() => rows().length > 0 || status().startsWith("No matches"), `results for ${q}`);
}

async function revealRows(): Promise<void> {
  await act(async () => {
    for (const io of [...FakeIO.all]) io.fire();
    await sleep(0);
  });
  await until(() => !container.querySelector(".srch-row.pending"), "rows to load");
}

describe("SearchBox states", () => {
  it("loads the index on first focus and says what search covers while the box is empty", async () => {
    render();
    expect(site.requests).toEqual([]);
    expect(panel()).toBeNull();
    act(() => input().focus());
    expect(status()).toContain("Search every tab:");
    await until(() => client.getStatus() === "ready", "index load");
    expect(site.requests).toEqual(expect.arrayContaining(["index.json", "vocab.json"]));
  });

  it("asks for more than one letter", async () => {
    render();
    act(() => input().focus());
    typeInto(input(), "e");
    expect(status()).toBe("Keep typing — searches start at 2 characters.");
  });

  it("treats a lone symbol as one character: it runs no search and asks to keep typing", async () => {
    const spy = vi.spyOn(client, "search");
    render();
    act(() => input().focus());
    await until(() => client.getStatus() === "ready", "index load");
    for (const symbol of ["⊕", "↓", " ↑ "]) {
      typeInto(input(), symbol);
      await settle(DEBOUNCE_MS + 10);
      expect(status()).toBe("Keep typing — searches start at 2 characters.");
    }
    expect(spy).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
  });

  it("says when nothing matches and keeps the text in the box", async () => {
    render();
    await search("zzqx");
    expect(status()).toContain("No matches for “zzqx”");
    expect(input().value).toBe("zzqx");
  });

  it("shows a load failure with Try again, which retries", async () => {
    site.failing.add("index.json");
    render();
    act(() => input().focus());
    typeInto(input(), "endocard");
    await until(() => status().startsWith("Search couldn't load."), "load failure");
    site.failing.clear();
    const retry = [...container.querySelectorAll("button")].find((b) => b.textContent === "Try again");
    act(() => retry?.click());
    await until(() => rows().length === 4, "results after retry");
  });
});

describe("SearchBox results", () => {
  it("lists topics named the query before mentions, each group in site order", async () => {
    render();
    await search("endocard");
    const groups = [...container.querySelectorAll(".srch-grp")].map((g) => g.textContent);
    expect(groups).toEqual(["Topics named “endocard”", "Mentions"]);
    expect(rows().map((r) => Number(r.dataset.unit))).toEqual([U.ie, U.gap, U.cushion, U.angina]);
    // The Mentions heading sits between the last title row and the first mention.
    const all = [...container.querySelectorAll(".srch-grp, .srch-row")].map((e) => e.textContent?.startsWith("Mentions") ? "M" : (e as HTMLElement).dataset.unit);
    expect(all).toEqual([undefined, String(U.ie), String(U.gap), String(U.cushion), "M", String(U.angina)]);
  });

  it("fetches a row's unit only when it scrolls into view, then shows title, location and highlighted excerpt", async () => {
    render();
    await search("endocard");
    expect(site.requests.some((r) => r.startsWith("units-"))).toBe(false);
    await revealRows();
    expect(site.requests.filter((r) => r.startsWith("units-")).sort()).toEqual(["units-0.json", "units-1.json"]);
    const ie = row(U.ie);
    expect(ie?.querySelector(".srch-title")?.textContent).toBe("Infective endocarditis");
    expect([...(ie?.querySelectorAll(".srch-title mark") ?? [])].map((m) => m.textContent)).toEqual(["endocard"]);
    expect(ie?.querySelector(".srch-loc")?.textContent).toBe("EOR › Family Medicine › Cardiovascular");
    const angina = row(U.angina);
    expect(angina?.querySelector(".srch-ex")?.textContent).toContain("Endocarditis is not a cause.");
    expect([...(angina?.querySelectorAll(".srch-ex mark") ?? [])].map((m) => m.textContent)).toEqual(["Endocard"]);
  });

  it("marks gap units for everyone and labels them 'Not from your notes' in owner-only wording", async () => {
    render();
    await search("endocard");
    await revealRows();
    const gap = row(U.gap);
    expect(gap?.classList.contains("gap")).toBe(true);
    const label = gap?.querySelector(".srch-chip.gap");
    expect(label?.textContent).toBe("Not from your notes");
    expect(label?.parentElement?.classList.contains("own-only")).toBe(true);
    expect(row(U.ie)?.classList.contains("gap")).toBe(false);
    expect(row(U.ie)?.querySelector(".srch-chip")).toBeNull();
  });

  it("labels update units 'Updated guideline'", async () => {
    render();
    await search("heart failure");
    await revealRows();
    expect(row(U.update)?.querySelector(".srch-chip.upd")?.textContent).toBe("Updated guideline");
  });

  it("shows the abbreviation line when a result matched through the vocabulary", async () => {
    render();
    await search("MI");
    await revealRows();
    expect(rows().map((r) => Number(r.dataset.unit))).toEqual([U.angina, U.acs]);
    expect(row(U.acs)?.querySelector(".srch-via")?.textContent).toContain("MI = myocardial infarction");
    expect([...(row(U.acs)?.querySelectorAll(".srch-ex mark") ?? [])].map((m) => m.textContent)).toEqual(["myocardial infarction"]);
  });

  it("lists every result, with no cap", async () => {
    render();
    await search("plain radiograph");
    expect(rows()).toHaveLength(2093);
    expect(chip("All").textContent).toBe("All 2093");
  });

  it("counts results per tab, filters to one tab, and disables tabs with no results", async () => {
    render();
    await search("endocard");
    expect(chip("All").textContent).toBe("All 4");
    expect(chip("EOR").textContent).toBe("EOR 3");
    expect(chip("Anatomy").textContent).toBe("Anatomy 1");
    for (const t of ["PANCE", "Labs", "Imaging", "EKG", "Other"]) expect(chip(t).disabled).toBe(true);
    act(() => chip("Anatomy").click());
    expect(chip("Anatomy").getAttribute("aria-pressed")).toBe("true");
    expect(rows().map((r) => Number(r.dataset.unit))).toEqual([U.cushion]);
    expect([...container.querySelectorAll(".srch-grp")].map((g) => g.textContent)).toEqual(["Topics named “endocard”"]);
    act(() => chip("All").click());
    expect(rows()).toHaveLength(4);
  });

  it("runs once per pause in typing", async () => {
    const spy = vi.spyOn(client, "search");
    render();
    act(() => input().focus());
    await until(() => client.getStatus() === "ready", "index load");
    typeInto(input(), "en");
    typeInto(input(), "end");
    typeInto(input(), "endo");
    expect(spy).not.toHaveBeenCalled();
    await settle(DEBOUNCE_MS + 30);
    expect(spy.mock.calls).toEqual([["endo"]]);
  });
});

describe("opening and closing", () => {
  it("opens a result at its route with ?q=, closes the panel and keeps the query in the box", async () => {
    render();
    await search("endocard");
    await revealRows();
    await act(async () => {
      row(U.ie)?.click();
      await sleep(0);
    });
    expect(location.hash).toBe("#/eor/fm/t/r_ie?q=endocard");
    expect(panel()).toBeNull();
    expect(input().value).toBe("endocard");
  });

  it("Esc clears and closes without changing the route", async () => {
    render();
    await search("endocard");
    act(() => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(panel()).toBeNull();
    expect(input().value).toBe("");
    expect(location.hash).toBe("#/eor");
  });

  it("✕ clears and closes without changing the route", async () => {
    render();
    await search("endocard");
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')?.click());
    expect(panel()).toBeNull();
    expect(input().value).toBe("");
    expect(location.hash).toBe("#/eor");
  });

  it("an outside click closes the panel, keeps the text and the route", async () => {
    render();
    await search("endocard");
    act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(panel()).toBeNull();
    expect(input().value).toBe("endocard");
    expect(location.hash).toBe("#/eor");
    // A click inside the panel does not close it. (The box kept focus, so re-focus it to reopen.)
    act(() => {
      input().blur();
      input().focus();
    });
    const reopened = panel();
    expect(reopened).not.toBeNull();
    act(() => reopened?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(panel()).not.toBeNull();
  });

  it("puts a landing query from the address into the empty box", async () => {
    await navigate("#/eor/fm/t/r_ie?q=MI");
    render();
    expect(input().value).toBe("MI");
  });
});

describe("phone", () => {
  it("opens a full-screen search from the magnifier and closes it with the back arrow", async () => {
    render(true);
    expect(container.querySelector('input[aria-label="Search all notes"]')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Search"]')?.click());
    expect(panel()?.classList.contains("full")).toBe(true);
    expect(document.activeElement).toBe(input());
    typeInto(input(), "troponin");
    await settle(DEBOUNCE_MS + 10);
    await until(() => rows().length > 0, "phone results");
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')?.click());
    expect(input().value).toBe("");
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Close search"]')?.click());
    expect(panel()).toBeNull();
  });
});
