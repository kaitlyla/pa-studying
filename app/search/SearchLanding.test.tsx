import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { navigate } from "../shell/route.ts";
import { SearchClient, setSearchClient } from "./client.ts";
import { HitBlock, HitText, SearchHighlightProvider, SearchLanding } from "./SearchLanding.tsx";
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
    // The page's data arrives later: same tree, re-rendered with its content.
    const page = (ready: boolean): ReactNode => <Page>{ready ? <Content /> : <p>Loading…</p>}</Page>;
    await navigate("#/eor/fm/t/r_ie?q=endocard");
    act(() => root.render(page(false)));
    await act(async () => {
      await sleep(50);
    });
    expect(scrolled).toEqual([]);
    act(() => root.render(page(true)));
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

  function Pages(): ReactNode {
    return (
      <>
        {["p1", "p2", "p3"].map((p) => (
          <section key={p} data-anchor={p}>
            <HitText text={`Lithium page ${p}: lithium levels.`} />
          </section>
        ))}
      </>
    );
  }

  it("lands on the match inside the result's own anchor when several results share the route", async () => {
    await navigate("#/file/d_li?q=lithium&at=p2");
    act(() => root.render(<Page><Pages /></Page>));
    await until(() => scrolled.length > 0, "scroll");
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]?.closest("[data-anchor]")?.getAttribute("data-anchor")).toBe("p2");
    expect(scrolled[0]?.textContent).toBe("Lithium");
    // Every match on the page is still highlighted.
    expect(marks()).toHaveLength(6);
  });

  it("falls back to the page's first match when the anchor is not on the page", async () => {
    await navigate("#/file/d_li?q=lithium&at=p9");
    act(() => root.render(<Page><Pages /></Page>));
    await until(() => scrolled.length > 0, "scroll");
    expect(scrolled).toEqual([container.querySelector("mark.hit")]);
  });

  it("waits for the match inside the result's anchor rather than scrolling to an earlier match elsewhere", async () => {
    // p1 already shows a match; p2 (the result's own unit) gets its text later.
    const page = (ready: boolean): ReactNode => (
      <Page>
        <section data-anchor="p1">
          <HitText text="Lithium toxicity." />
        </section>
        <section data-anchor="p2">{ready ? <HitText text="Check lithium levels." /> : "Loading…"}</section>
      </Page>
    );
    await navigate("#/file/d_li?q=lithium&at=p2");
    act(() => root.render(page(false)));
    await until(() => marks().length > 0, "the earlier match");
    await act(async () => {
      await sleep(50);
    });
    expect(scrolled).toEqual([]);
    act(() => root.render(page(true)));
    await until(() => scrolled.length > 0, "scroll");
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]?.closest("[data-anchor]")?.getAttribute("data-anchor")).toBe("p2");
  });

  it("lands inside the anchor when its only match is split across formatted runs", async () => {
    await navigate("#/file/d_li?q=lithium&at=p2");
    act(() =>
      root.render(
        <Page>
          <p data-anchor="p1">
            <HitText text="Lithium toxicity." />
          </p>
          <p data-anchor="p2">
            <HitBlock text="Lithium levels.">
              <b>
                <HitText text="Lith" offset={0} />
              </b>
              <HitText text="ium levels." offset={4} />
            </HitBlock>
          </p>
        </Page>,
      ),
    );
    await until(() => scrolled.length > 0, "scroll");
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]?.closest("[data-anchor]")?.getAttribute("data-anchor")).toBe("p2");
    expect(scrolled[0]?.textContent).toBe("Lith");
  });

  it("Clear highlights also drops the anchor", async () => {
    await navigate("#/file/d_li?q=lithium&at=p2");
    act(() => root.render(<Page><Pages /></Page>));
    await until(() => marks().length > 0, "highlights");
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".hitbar button")?.click();
      await sleep(0);
    });
    expect(location.hash).toBe("#/file/d_li");
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

  /** A paragraph whose words her formatting splits into runs, rendered as the renderer does. */
  function SplitRuns({ runs, block }: { runs: string[]; block: boolean }): ReactNode {
    const starts = runs.map((_, i) => runs.slice(0, i).join("").length);
    const pieces = runs.map((r, i) => (
      <b key={i}>
        <HitText text={r} offset={starts[i]} />
      </b>
    ));
    return <p>{block ? <HitBlock text={runs.join("")}>{pieces}</HitBlock> : pieces}</p>;
  }

  it("highlights a mnemonic whose words are split across runs, matching the paragraph's joined text", async () => {
    const runs = ["M", "itral ", "S", "tenosis: opening snap."];
    await navigate("#/eor/fm/t/r_ie?q=mitral%20stenosis");
    act(() => root.render(<Page><SplitRuns runs={runs} block /></Page>));
    await until(() => marks().length > 0, "highlights");
    expect(marks()).toEqual(["M", "itral", "S", "tenosis"]);
    expect(container.querySelector("p")?.textContent).toBe(runs.join(""));
    expect(scrolled[0]?.textContent).toBe("M");
    // Matched run by run (no block), the split words are not found.
    act(() => root.render(<Page><SplitRuns runs={runs} block={false} /></Page>));
    await act(async () => {
      await sleep(20);
    });
    expect(marks()).toEqual([]);
  });

  it("highlights a vocabulary meaning split across runs for its abbreviation's query", async () => {
    await navigate("#/eor/fm/t/r_ie?q=MI");
    act(() => root.render(<Page><SplitRuns runs={["Acute ", "myocardial", " ", "infarction", " today."]} block /></Page>));
    await until(() => marks().length > 0, "highlights");
    expect(marks()).toEqual(["myocardial", " ", "infarction"]);
  });

  it("renders HitText as plain text outside a provider", () => {
    act(() => root.render(<p><HitText text="plain endocarditis" /></p>));
    expect(container.innerHTML).toBe("<p>plain endocarditis</p>");
  });
});
