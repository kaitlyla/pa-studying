import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { navigate } from "../shell/route.ts";
import { SearchClient, setSearchClient } from "./client.ts";
import { HitText, SearchHighlightProvider, SearchLanding } from "./SearchLanding.tsx";
import { getSearchState, resetSearchState } from "./store.ts";
import { BASE, fakeSite, inProcessWorker, type FakeSite } from "./testing.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let site: FakeSite;
let container: HTMLDivElement;
let root: Root;
const scrolled: Element[] = [];
const original = Element.prototype.scrollIntoView;

beforeAll(() => {
  site = fakeSite();
});

beforeEach(async () => {
  site.requests.length = 0;
  setSearchClient(new SearchClient(() => inProcessWorker(site.fetch), BASE, site.fetch));
  resetSearchState();
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  await navigate("#/eor");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Element.prototype.scrollIntoView = original;
  setSearchClient(null);
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until<T>(find: () => T | null | undefined | false, what: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = find();
    if (v) return v;
    await act(async () => {
      await sleep(10);
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A page shaped like the shell's: the landing bar on top of <main>, text runs through <HitText>. */
function Page({ children }: { children: ReactNode }): ReactNode {
  return (
    <SearchHighlightProvider>
      <main id="page">
        <SearchLanding />
        {children}
      </main>
    </SearchHighlightProvider>
  );
}

const TEXT = ["Infective Endocarditis: fever and murmur.", "Rule out MI; endocardial involvement."];

function Content(): ReactNode {
  return (
    <div className="notes">
      {TEXT.map((t) => (
        <p key={t}>
          <HitText text={t} />
        </p>
      ))}
    </div>
  );
}

const marks = (): string[] => [...container.querySelectorAll("mark.hit")].map((m) => m.textContent ?? "");
const bar = (): HTMLElement | null => container.querySelector(".hitbar");

describe("search landing", () => {
  it("renders plain text and no bar without ?q=", async () => {
    act(() => root.render(<Page><Content /></Page>));
    await act(async () => {
      await sleep(20);
    });
    expect(bar()).toBeNull();
    expect(marks()).toEqual([]);
    expect(container.querySelector("p")?.textContent).toBe(TEXT[0]);
    expect(site.requests).toEqual([]);
  });

  it("highlights every match with the same rules, shows the bar, scrolls to the first match and keeps the query", async () => {
    await navigate("#/eor/fm/t/r_ie?q=endocard");
    act(() => root.render(<Page><Content /></Page>));
    expect(bar()?.textContent).toBe("Showing matches for “endocard”·Clear highlights");
    await until(() => marks().length > 0, "highlights");
    expect(marks()).toEqual(["Endocard", "endocard"]);
    // Text around the marks is unchanged.
    expect([...container.querySelectorAll("p")].map((p) => p.textContent)).toEqual(TEXT);
    expect(scrolled).toEqual([container.querySelector("mark.hit")]);
    expect(getSearchState().query).toBe("endocard");
  });

  it("highlights a vocabulary abbreviation for its meaning's query", async () => {
    await navigate("#/eor/fm/t/r_ie?q=myocardial%20infarction");
    act(() => root.render(<Page><Content /></Page>));
    await until(() => marks().length > 0, "highlights");
    expect(marks()).toEqual(["MI"]);
  });

  it("scrolls to the first match once the page's content renders after loading", async () => {
    const ctl: { show?: () => void } = {};
    function Late(): ReactNode {
      const [ready, setReady] = useState(false);
      ctl.show = () => setReady(true);
      return ready ? <Content /> : <p>Loading…</p>;
    }
    await navigate("#/eor/fm/t/r_ie?q=endocard");
    act(() => root.render(<Page><Late /></Page>));
    await act(async () => {
      await sleep(50);
    });
    expect(scrolled).toEqual([]);
    act(() => ctl.show?.());
    await until(() => scrolled.length > 0, "scroll");
    expect(scrolled[0]?.textContent).toBe("Endocard");
  });

  it("Clear highlights removes ?q= from the route, keeping ?from=, and the marks go away", async () => {
    await navigate("#/file/d_1?q=endocard&from=%23%2Fother%2Fs1");
    act(() => root.render(<Page><Content /></Page>));
    await until(() => marks().length > 0, "highlights");
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".hitbar button")?.click();
      await sleep(0);
    });
    expect(location.hash).toBe("#/file/d_1?from=%23%2Fother%2Fs1");
    expect(bar()).toBeNull();
    expect(marks()).toEqual([]);
    expect(getSearchState().query).toBe("endocard");
  });

  it("shows no bar for a one-character ?q=", async () => {
    await navigate("#/eor/fm/t/r_ie?q=e");
    act(() => root.render(<Page><Content /></Page>));
    await act(async () => {
      await sleep(20);
    });
    expect(bar()).toBeNull();
    expect(marks()).toEqual([]);
  });

  it("renders HitText as plain text outside a provider", () => {
    act(() => root.render(<p><HitText text="plain endocarditis" /></p>));
    expect(container.innerHTML).toBe("<p>plain endocarditis</p>");
  });
});
