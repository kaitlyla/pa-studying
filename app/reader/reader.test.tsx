// The guide reader and the EOR picker, rendered through the whole app over the published fixture
// (tools/build/test-fixture.ts): picker, guide home, sidebar, system / section / topic / block pages,
// review slides and the PDF menu.
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from "vitest";
import type { ComparisonsJson, DocJson, FlagNote, NavJson, SiteJson, SlidesJson, SystemJson } from "../../lib/derive/published.ts";
import { BELOW_HEADING } from "../../lib/derive/topics.ts";
import { DATA_BASE } from "../data/load.ts";
import { wholeGuideUrl } from "../pdf/download.ts";
import { parseHash, versionsHash } from "../shell/route.ts";
import {
  asOwner,
  B,
  byText,
  click,
  D,
  go,
  installOwnerCss,
  publishedFixture,
  R,
  renderApp,
  serveData,
  until,
  visibleText,
  type DataServer,
  type Mounted,
} from "../testing.tsx";
import { conditionRows, notesAt, rowsByBlock } from "./blocks.tsx";
import { sidebarFrom, slidesLabel } from "./Sidebar.tsx";
import { slideTitle } from "./ReviewSlidesPage.tsx";

let files: Map<string, unknown>;
let server: DataServer;
let app: Mounted | null = null;
let site: SiteJson;
let fmNav: NavJson;
let cv: SystemJson;
let deck: SlidesJson;
let scrolls: Mock<(arg?: boolean | ScrollIntoViewOptions) => void>;
let errors: MockInstance<typeof console.error> | null = null;
const originalScroll = Element.prototype.scrollIntoView;

function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`missing ${what}`);
  return v;
}

beforeAll(async () => {
  files = await publishedFixture();
  installOwnerCss();
  site = files.get("site.json") as SiteJson;
  fmNav = files.get("g/fm/nav.json") as NavJson;
  cv = files.get("g/fm/s/cardiovascular.json") as SystemJson;
  deck = files.get("g/fm/slides.json") as SlidesJson;
});

beforeEach(() => {
  server = serveData(files);
  asOwner(false);
  scrolls = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>();
  Element.prototype.scrollIntoView = scrolls;
});

afterEach(() => {
  app?.unmount();
  app = null;
  server.restore();
  asOwner(false);
  Element.prototype.scrollIntoView = originalScroll;
  errors?.mockRestore();
  errors = null;
});

/** Not-found pages are reported through console.error by React and the page boundary. */
function quietErrors(): void {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
}

const topicOf = (row: string): SystemJson["topics"][number] => must(cv.topics.find((t) => t.rows.includes(row)), `topic of ${row}`);
const af = (): SystemJson["topics"][number] => topicOf(R(101));
const stable = (): SystemJson["topics"][number] => topicOf(R(104));
const prinz = (): SystemJson["topics"][number] => topicOf(R(123));
/** A topic of another system (the fixture's fm guide has three). */
const topicIn = (system: string, row: string): SystemJson["topics"][number] => {
  const s = must(files.get(`g/fm/s/${system}.json`) as SystemJson | undefined, `the ${system} system`);
  return must(s.topics.find((t) => t.rows.includes(row)), `topic of ${row}`);
};

const h1 = (c: Element): string => c.querySelector(".main h1")?.textContent ?? "";
const crumbs = (c: Element): string[] => [...c.querySelectorAll(".main nav.crumbs .crumb")].map((e) => (e.textContent ?? "").replace("›", ""));
const row = (root: ParentNode, id: string): HTMLTableRowElement | null => root.querySelector<HTMLTableRowElement>(`tr[data-anchor="${id}"]`);
const side = (c: Element): HTMLElement => must(c.querySelector<HTMLElement>("aside.side"), "sidebar");
const groupLink = (c: Element, title: string): HTMLAnchorElement | null => side(c).querySelector<HTMLAnchorElement>(`a.sys-name[title="${title}"]`);
const groupToggle = (c: Element, title: string): HTMLButtonElement =>
  must(groupLink(c, title)?.parentElement?.querySelector<HTMLButtonElement>("button.sys-tog"), `${title} arrow`);
const entry = (c: Element, title: string): HTMLAnchorElement | null => side(c).querySelector<HTMLAnchorElement>(`a.ent[title="${title}"]`);
const notFound = (c: Element): boolean => c.querySelector(".notfound h1")?.textContent === "This page isn't on the site";
/** The sidebar's saved comparisons, when the section is up. */
const comparisonsList = (c: Element): HTMLUListElement | null => {
  const head = [...side(c).querySelectorAll(".side-sec")].find((e) => e.textContent === "Comparisons");
  return head?.nextElementSibling instanceof HTMLUListElement ? head.nextElementSibling : null;
};

async function press(el: Element, key: string): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

async function openPdfMenu(c: Element): Promise<HTMLElement> {
  await click(c.querySelector(".main .pdfm button[aria-haspopup='menu']"));
  return must(c.querySelector<HTMLElement>(".main [role='menu']"), "PDF menu");
}

describe("EOR picker", () => {
  it("lists the EORs with their system and general-topic counts and opens one", async () => {
    const a = await renderApp("#/eor");
    app = a;
    const c = a.container;
    await until(() => c.querySelector(".pick .card"), "picker cards");
    expect(h1(c)).toBe("EOR study guides");
    const cards = [...c.querySelectorAll(".pick a.card")];
    expect(cards.map((e) => e.querySelector(".cn")?.textContent)).toEqual(["Family Medicine", "Psychiatry"]);
    expect(cards.map((e) => e.querySelector(".cm")?.textContent)).toEqual(["3 systems · 4 general topics", "0 sections · 0 general topics"]);
    expect(cards.map((e) => e.getAttribute("href"))).toEqual(["#/eor/fm", "#/eor/psy"]);
    expect(c.querySelector("aside.side")).toBeNull();

    await click(cards[0]);
    await until(() => c.querySelector(".guide-home"), "Family Medicine home");
    expect(location.hash).toBe("#/eor/fm");
    expect(h1(c)).toBe("Family Medicine EOR");
  });
});

describe("guide home", () => {
  it("shows the preamble and the system list; the EOR crumb returns to the picker", async () => {
    const a = await renderApp("#/eor/fm");
    app = a;
    const c = a.container;
    await until(() => c.querySelector(".guide-home ul.lnk a"), "system list");
    expect(h1(c)).toBe("Family Medicine EOR");
    expect(crumbs(c)).toEqual(["EOR", "Family Medicine"]);
    expect(c.querySelector(`.guide-home [data-anchor="${B(1)}"]`)?.textContent).toBe("Family Medicine EOR");
    const links = [...c.querySelectorAll<HTMLAnchorElement>(".guide-home ul.lnk a")];
    expect(links.map((l) => l.querySelector(".lt")?.textContent)).toEqual(["Cardiovascular", "Pulmonary", "Urology/Renal"]);
    expect(links.map((l) => l.querySelector(".ll")?.textContent)).toEqual(["15%", "12%", "5%"]);
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["#/eor/fm/s/cardiovascular", "#/eor/fm/s/pulmonary", "#/eor/fm/s/renal"]);

    await click(byText(c, ".main nav.crumbs a", "EOR"));
    await until(() => c.querySelector(".pick"), "picker");
    expect(location.hash).toBe("#/eor");
    expect(c.querySelector(".guide-home")).toBeNull();
  });

  it("a system in the list opens its system page", async () => {
    const a = await renderApp("#/eor/fm");
    app = a;
    const c = a.container;
    await click(await until(() => byText(c, ".guide-home ul.lnk a", "Pulmonary"), "Pulmonary link"));
    await until(() => c.querySelector(".system-page"), "system page");
    expect(location.hash).toBe("#/eor/fm/s/pulmonary");
    expect(h1(c)).toBe("Pulmonary 12%");
  });

  it("PANCE home has the PANCE crumb and title; a guide without systems shows an empty list", async () => {
    const a = await renderApp("#/pance");
    app = a;
    const c = a.container;
    await until(() => c.querySelector(".guide-home ul.lnk a"), "PANCE system list");
    expect(h1(c)).toBe("PANCE / EOC Study Guide");
    expect(crumbs(c)).toEqual(["PANCE"]);
    expect(c.querySelector(".main nav.crumbs a")).toBeNull();

    await go("#/eor/psy");
    await until(() => h1(c) === "Psych EOR", "Psychiatry home");
    expect(c.querySelectorAll(".guide-home ul.lnk li")).toHaveLength(0);
    expect(crumbs(c)).toEqual(["EOR", "Psychiatry"]);
  });
});

describe("guide sidebar", () => {
  it("a system name opens and expands it; its arrow only toggles; a section arrow shows its entries; the current topic is marked", async () => {
    const a = await renderApp("#/eor/fm");
    app = a;
    const c = a.container;
    await until(() => groupLink(c, "Cardiovascular"), "Cardiovascular row");
    expect(side(c).querySelector(".gname")?.textContent).toBe("Family Medicine");
    expect(side(c).querySelector(".side-sec")?.textContent).toBe("Systems");
    expect(groupToggle(c, "Cardiovascular").getAttribute("aria-expanded")).toBe("false");
    expect(groupLink(c, "Coronary artery disease")).toBeNull();

    await click(groupLink(c, "Cardiovascular"));
    await until(() => c.querySelector(".system-page"), "system page");
    expect(location.hash).toBe("#/eor/fm/s/cardiovascular");
    const sysLink = must(groupLink(c, "Cardiovascular"), "Cardiovascular link");
    expect(sysLink.getAttribute("aria-current")).toBe("page");
    expect(groupToggle(c, "Cardiovascular").getAttribute("aria-expanded")).toBe("true");
    expect(groupLink(c, "Coronary artery disease")).not.toBeNull();
    expect(scrolls).toHaveBeenLastCalledWith({ block: "nearest" });
    expect(scrolls.mock.contexts.at(-1)).toBe(sysLink);

    // The arrow toggles without moving.
    await click(groupToggle(c, "Cardiovascular"));
    expect(groupToggle(c, "Cardiovascular").getAttribute("aria-expanded")).toBe("false");
    expect(groupToggle(c, "Cardiovascular").getAttribute("aria-label")).toBe("Expand Cardiovascular");
    expect(groupLink(c, "Coronary artery disease")).toBeNull();
    expect(location.hash).toBe("#/eor/fm/s/cardiovascular");
    await click(groupToggle(c, "Cardiovascular"));
    expect(groupToggle(c, "Cardiovascular").getAttribute("aria-expanded")).toBe("true");
    expect(location.hash).toBe("#/eor/fm/s/cardiovascular");

    // A section row's arrow expands and collapses its entries.
    const cad = "Coronary artery disease";
    expect(groupLink(c, cad)?.querySelector(".grp-n")?.textContent).toBe("2");
    expect(groupToggle(c, cad).getAttribute("aria-expanded")).toBe("false");
    expect(entry(c, stable().title)).toBeNull();
    await click(groupToggle(c, cad));
    expect(groupToggle(c, cad).getAttribute("aria-expanded")).toBe("true");
    expect(groupToggle(c, cad).getAttribute("aria-label")).toBe(`Collapse ${cad}`);
    expect(entry(c, stable().title)).not.toBeNull();
    expect(entry(c, prinz().title)).not.toBeNull();
    expect(location.hash).toBe("#/eor/fm/s/cardiovascular");
    await click(groupToggle(c, cad));
    expect(groupToggle(c, cad).getAttribute("aria-expanded")).toBe("false");
    expect(entry(c, stable().title)).toBeNull();
    await click(groupToggle(c, cad));

    // The current topic.
    await click(entry(c, stable().title));
    await until(() => c.querySelector(".topics-page"), "topic page");
    expect(location.hash).toBe(`#/eor/fm/t/${stable().id}`);
    const cur = must(entry(c, stable().title), "Stable angina entry");
    expect(cur.getAttribute("aria-current")).toBe("page");
    expect(cur.classList.contains("open")).toBe(true);
    expect(cur.parentElement?.querySelector("a.alongside")).toBeNull();
    const other = must(entry(c, prinz().title), "Prinzmetal entry");
    expect(other.getAttribute("aria-current")).toBeNull();
    const plus = must(other.parentElement?.querySelector("a.alongside"), "the + beside Prinzmetal");
    expect(plus.getAttribute("aria-label")).toBe(`Add ${prinz().title} to the comparison`);
    expect(plus.getAttribute("href")).toBe(`#/eor/fm/compare/${stable().id},${prinz().id}`);
    expect(groupToggle(c, cad).getAttribute("aria-expanded")).toBe("true");
    expect(groupLink(c, "Cardiovascular")?.getAttribute("aria-current")).toBeNull();
  });

  it("lists general topics, the review slides and each system's pharm row, marking the open one", async () => {
    const a = await renderApp("#/eor/fm");
    app = a;
    const c = a.container;
    await until(() => groupLink(c, "Cardiovascular pharm"), "pharm row");
    const secs = [...side(c).querySelectorAll(".side-sec")].map((e) => e.textContent);
    expect(secs).toEqual(["Systems", "General topics"]);
    const labs = must(byText<HTMLAnchorElement>(side(c), "ul.gen a.ent", "Labs"), "Labs link");
    expect(labs.getAttribute("href")).toBe("#/eor/fm/general/labs");
    const slides = must(byText<HTMLAnchorElement>(side(c), "ul.gen a.ent", "High-yield review slides"), "slides link");
    expect(slides.getAttribute("href")).toBe("#/eor/fm/slides/1");
    expect(slides.getAttribute("aria-current")).toBeNull();

    // The pharm row's arrow lists its sections.
    expect(byText(side(c), "a.ent", "Antianginals")).toBeNull();
    await click(groupToggle(c, "Cardiovascular pharm"));
    expect(groupToggle(c, "Cardiovascular pharm").getAttribute("aria-expanded")).toBe("true");
    expect(byText(side(c), "a.ent", "Antianginals")?.getAttribute("href")).toBe("#/eor/fm/pharm/cardiovascular/antianginals");
    expect(location.hash).toBe("#/eor/fm");

    await go("#/eor/fm/pharm/cardiovascular");
    await until(() => groupLink(c, "Cardiovascular pharm")?.getAttribute("aria-current") === "page", "pharm row current");
    await go("#/eor/fm/pharm/cardiovascular/antianginals");
    await until(() => byText(side(c), "a.ent", "Antianginals")?.getAttribute("aria-current") === "page", "pharm section current");
    expect(groupLink(c, "Cardiovascular pharm")?.getAttribute("aria-current")).toBeNull();

    await go("#/eor/fm/general/labs");
    await until(() => byText(side(c), "ul.gen a.ent", "Labs")?.getAttribute("aria-current") === "page", "Labs current");
    await go("#/eor/fm/slides/2");
    await until(() => byText(side(c), "ul.gen a.ent", "High-yield review slides")?.getAttribute("aria-current") === "page", "slides current");

    // The guide name goes home.
    await click(side(c).querySelector("a.gname"));
    await until(() => c.querySelector(".guide-home"), "guide home");
    expect(location.hash).toBe("#/eor/fm");
  });

  it("a listed block is a ¶ entry, current on its page", async () => {
    const a = await renderApp(`#/eor/fm/b/${B(11)}`);
    app = a;
    const c = a.container;
    const murmurs = await until(() => entry(c, "Murmurs"), "Murmurs entry");
    expect(murmurs.classList.contains("blk")).toBe(true);
    expect(murmurs.querySelector(".blk-mark")?.textContent).toBe("¶");
    expect(murmurs.getAttribute("aria-current")).toBe("page");
    expect(murmurs.parentElement?.querySelector("a.alongside")).toBeNull();
    expect(groupToggle(c, "Cardiovascular — other").getAttribute("aria-expanded")).toBe("true");
  });

  it("a guide with no general topics or deck shows only its sections heading", async () => {
    const a = await renderApp("#/eor/psy");
    app = a;
    const c = a.container;
    await until(() => c.querySelector("aside.side .side-sec"), "sidebar");
    expect([...side(c).querySelectorAll(".side-sec")].map((e) => e.textContent)).toEqual(["Sections"]);
    expect(side(c).querySelector("ul.gen")).toBeNull();
  });

  it("slidesLabel names her own Psychiatry deck, the generated deck by title, and nothing without a deck", () => {
    expect(slidesLabel("fm", fmNav)).toBe("High-yield review slides");
    expect(slidesLabel("psy", { ...fmNav, slides: { title: "Anything" } })).toBe("Psych review slides");
    expect(slidesLabel("fm", { ...fmNav, slides: null })).toBeNull();
  });
});

describe("system page", () => {
  it("shows every block, a drug table as its condition rows then its stub, and no drug rows", async () => {
    const a = await renderApp("#/eor/fm/s/cardiovascular");
    app = a;
    const c = a.container;
    const page = await until(() => c.querySelector<HTMLElement>(".system-page"), "system page");
    expect(h1(c)).toBe("Cardiovascular 15%");
    expect(crumbs(c)).toEqual(["EOR", "Family Medicine", "Cardiovascular"]);
    for (const r of [R(100), R(101), R(102), R(103), R(104)]) expect(row(page, r), r).not.toBeNull();
    expect(row(page, R(101))?.textContent).toContain("irregularly irregular");
    expect(page.querySelector(`[data-anchor="${B(11)}"]`)?.textContent).toContain("Murmurs");

    const drug = must(page.querySelector(`div.notes[data-anchor="${B(12)}"]`), "drug table");
    expect(row(drug, R(123))?.textContent).toContain("Prinzmetal angina");
    expect(row(drug, R(120))).not.toBeNull();
    for (const r of [R(121), R(122), R(124)]) expect(row(page, r), r).toBeNull();
    expect(page.textContent).not.toContain("Nitroglycerin");
    expect(page.textContent).not.toContain("Ranolazine");
    const stub = must(drug.nextElementSibling, "stub after the drug table");
    expect(stub.matches("a.stub")).toBe(true);
    expect(stub.textContent).toBe("ANTIANGINALS drug table — in Cardiovascular pharm ›");
    expect(stub.getAttribute("href")).toBe("#/eor/fm/pharm/cardiovascular/antianginals");

    expect(row(page, R(130))).not.toBeNull();
    expect(row(page, R(131))?.textContent).toContain("Heart failure");
    expect(page.querySelector(`[data-anchor="${B(14)}"]`)?.textContent).toContain("Mnemonic");

    const menu = await openPdfMenu(c);
    expect(byText(menu, "[role='menuitem']", "This system")?.textContent).toBe("This systemCardiovascular");

    await click(stub);
    await until(() => location.hash === "#/eor/fm/pharm/cardiovascular/antianginals", "pharm route");
  });

  it("an unknown system isn't on the site", async () => {
    quietErrors();
    const a = await renderApp("#/eor/fm/s/nope");
    app = a;
    await until(() => notFound(a.container), "not on site");
  });
});

describe("section page", () => {
  it("shows only member topics' rows, including a condition row inside a drug table followed by its stub", async () => {
    const a = await renderApp("#/eor/fm/sec/cardiovascular/cad");
    app = a;
    const c = a.container;
    const page = await until(() => c.querySelector<HTMLElement>(".section-page"), "section page");
    expect(h1(c)).toBe("Coronary artery disease 2 topics");
    expect(crumbs(c)).toEqual(["EOR", "Family Medicine", "Cardiovascular", "Coronary artery disease"]);
    expect(byText(c, ".main nav.crumbs a", "Cardiovascular")?.getAttribute("href")).toBe("#/eor/fm/s/cardiovascular");

    expect(row(page, R(103))).not.toBeNull();
    expect(row(page, R(104))?.textContent).toContain("chest pain on exertion");
    expect(row(page, R(101))).toBeNull();
    expect(row(page, R(102))).toBeNull();
    expect(page.textContent).not.toContain("irregularly irregular");

    const drug = must(page.querySelector(`div.notes[data-anchor="${B(12)}"]`), "drug table");
    expect(row(drug, R(120))).not.toBeNull();
    expect(row(drug, R(123))?.textContent).toContain("Prinzmetal angina");
    for (const r of [R(121), R(122), R(124)]) expect(row(page, r), r).toBeNull();
    const stub = must(drug.nextElementSibling, "stub after the drug table");
    expect(stub.matches("a.stub")).toBe(true);
    expect(stub.getAttribute("href")).toBe("#/eor/fm/pharm/cardiovascular/antianginals");

    expect(row(page, R(130))).not.toBeNull();
    expect(row(page, R(131))).toBeNull();
    expect(page.querySelector(`[data-anchor="${B(11)}"]`)).toBeNull();
    expect(page.querySelector(`[data-anchor="${B(14)}"]`)).toBeNull();

    const menu = await openPdfMenu(c);
    expect(byText(menu, "[role='menuitem']", "This section")?.textContent).toBe("This sectionCoronary artery disease");
  });

  it("the other section shows its prose blocks whole and no stub for a drug table with none of its rows", async () => {
    const a = await renderApp("#/eor/fm/sec/cardiovascular/other");
    app = a;
    const c = a.container;
    const page = await until(() => c.querySelector<HTMLElement>(".section-page"), "section page");
    expect(h1(c)).toBe("Cardiovascular — other 3 topics");
    expect(row(page, R(101))).not.toBeNull();
    expect(row(page, R(131))).not.toBeNull();
    expect(row(page, R(104))).toBeNull();
    expect(page.querySelector(`[data-anchor="${B(11)}"]`)?.textContent).toContain("Systolic");
    expect(page.querySelector(`[data-anchor="${B(14)}"]`)?.textContent).toContain("Mnemonic");
    expect(page.querySelector(`[data-anchor="${B(12)}"]`)).toBeNull();
    expect(page.querySelector("a.stub")).toBeNull();
  });

  it("an unknown section isn't on the site", async () => {
    quietErrors();
    const a = await renderApp("#/eor/fm/sec/cardiovascular/nope");
    app = a;
    await until(() => notFound(a.container), "not on site");
  });
});

describe("blocks helpers", () => {
  it("conditionRows returns the condition topic's rows with its heading row once", () => {
    const p = prinz();
    expect(p.condition).toBe(true);
    expect(p.id).toBe(R(123));
    expect(p.rows).toEqual([R(120), R(123)]);
    expect(conditionRows(cv, B(12))).toEqual(p.rows);
    expect(conditionRows(cv, B(10))).toEqual([]);
  });

  it("rowsByBlock groups every row id by its table block", () => {
    const by = rowsByBlock(cv);
    expect([...(by.get(B(12)) ?? [])].sort()).toEqual([R(120), R(121), R(122), R(123), R(124)]);
    expect([...(by.get(B(10)) ?? [])].sort()).toEqual([R(100), R(101), R(102), R(103), R(104)]);
    expect(by.has(B(11))).toBe(false);
  });

  it("notesAt collects the notes at the given ids in order, each flag once", () => {
    const note = (id: string): FlagNote => ({ id, guideline: `G ${id}`, org: "Org", published: "2024-01", quote: null, grade: null, url: "https://example.org", flagged: "2026-10-01" });
    const [n1, n2, n3] = [note("u1"), note("u2"), note("u3")];
    expect(notesAt({ a: [n1, n2], b: [n2, n3] }, ["b", "missing", "a"])).toEqual([n2, n3, n1]);
    expect(notesAt({}, ["a"])).toEqual([]);
  });
});

describe("topics page", () => {
  it("a sidebar topic replaces the page; the + opens the comparison and ✕ narrows it", async () => {
    const a = await renderApp(`#/eor/fm/t/${stable().id}`);
    app = a;
    const c = a.container;
    await until(() => c.querySelector(`.topics-page section.tcard[data-topic="${stable().id}"]`), "Stable angina card");
    expect(h1(c)).toBe("Stable angina");
    expect(crumbs(c)).toEqual(["EOR", "Family Medicine", "Cardiovascular", "Coronary artery disease", "Stable angina"]);
    expect(c.querySelector(".tcard button[aria-label^='Close ']")).toBeNull();
    expect(row(must(c.querySelector(".tcard"), "card"), R(104))).not.toBeNull();
    const pageMenu = await openPdfMenu(c);
    expect(byText(pageMenu, "[role='menuitem']", "This topic")?.textContent).toBe(`This topic${stable().title}`);
    await press(must(pageMenu.querySelector("[role='menuitem']"), "menu item"), "Escape");

    // Clicking a topic replaces the page.
    await click(groupToggle(c, "Cardiovascular — other"));
    await click(entry(c, af().title));
    await until(() => c.querySelector(`section.tcard[data-topic="${R(101)}"]`), "AF card");
    expect(location.hash).toBe(`#/eor/fm/t/${R(101)}`);
    expect(c.querySelectorAll("section.tcard")).toHaveLength(1);
    expect(h1(c)).toBe(af().title);

    // The sidebar's + opens the comparison with the diagnosis on screen in the first quadrant.
    await click(groupToggle(c, "Coronary artery disease"));
    await click(side(c).querySelector(`a.alongside[aria-label="Add ${stable().title} to the comparison"]`));
    await until(() => c.querySelectorAll(".cmp-q").length === 2, "two quadrants");
    expect(location.hash).toBe(`#/eor/fm/compare/${R(101)},${stable().id}`);
    expect(h1(c)).toBe("Compare");
    expect(crumbs(c)).toEqual(["EOR", "Family Medicine", "Compare"]);
    expect([...c.querySelectorAll(".cmp-q .tcard")].map((e) => e.getAttribute("data-topic"))).toEqual([R(101), stable().id]);

    // On the comparison, the + fills the next quadrant, and ✕ takes one off while the rest stay.
    await click(side(c).querySelector(`a.alongside[aria-label="Add ${prinz().title} to the comparison"]`));
    await until(() => c.querySelectorAll(".cmp-q").length === 3, "three quadrants");
    expect(location.hash).toBe(`#/eor/fm/compare/${R(101)},${stable().id},${prinz().id}`);
    await click(must(c.querySelector("button[aria-label='Remove quadrant 2']"), "remove the second quadrant"));
    await until(() => c.querySelectorAll(".cmp-q").length === 2, "two quadrants after ✕");
    expect(location.hash).toBe(`#/eor/fm/compare/${R(101)},${prinz().id}`);
    expect([...c.querySelectorAll(".cmp-q .tcard")].map((e) => e.getAttribute("data-topic"))).toEqual([R(101), prinz().id]);
  });

  it("shows a topic's rows that continue into a later table, in her order", async () => {
    const a = await renderApp(`#/eor/fm/t/${stable().id}`);
    app = a;
    const c = a.container;
    const card = await until(() => c.querySelector<HTMLElement>(`section.tcard[data-topic="${stable().id}"]`), "Stable angina card");
    // Her rows continue into B(13): both tables show, the continuing one after the first.
    expect(stable().rows.at(-1)).toBe(R(130));
    const first = must(card.querySelector(`div.notes[data-anchor="${B(10)}"]`), "the topic's first table");
    const second = must(card.querySelector(`div.notes[data-anchor="${B(13)}"]`), "the table its rows continue into");
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row(card, R(104))?.textContent).toContain("chest pain on exertion");
    expect(row(card, R(130))?.textContent).toContain("angina continues here");
  });

  it("a topic's below block shows after its meds panel under Additional info, and on its section page under the table holding its last row with no heading", async () => {
    const BELOW = B(900);
    const withBelow = structuredClone(cv);
    const murmurs = must(cv.blocks.find((b) => b.id === B(11)), "B11 prose");
    const st = must(withBelow.topics.find((t) => t.id === stable().id), "Stable angina");
    st.below = { id: BELOW, kind: "prose", doc: murmurs.doc };
    server.restore();
    server = serveData(new Map([...files, ["g/fm/s/cardiovascular.json", withBelow]]));
    expect(st.rows.at(-1)).toBe(R(130));

    const a = await renderApp(`#/eor/fm/t/${stable().id}`);
    app = a;
    const c = a.container;
    const card = await until(() => c.querySelector<HTMLElement>(`section.tcard[data-topic="${stable().id}"]`), "Stable angina card");
    const below = must(card.querySelector(`[data-anchor="${BELOW}"]`), "below block");
    expect(below.textContent).toContain("Systolic");
    const meds = must(card.querySelector(".meds"), "meds panel");
    expect(card.querySelectorAll(".meds")).toHaveLength(1);
    expect(meds.compareDocumentPosition(below) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Her heading sits over the block, after the meds panel.
    const info = must(card.querySelector<HTMLElement>(`section[aria-label="${BELOW_HEADING}"]`), "Additional info section");
    expect(info.querySelector("h3")?.textContent).toBe("Additional info");
    expect(info.contains(below)).toBe(true);
    expect(meds.compareDocumentPosition(info) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await go("#/eor/fm/sec/cardiovascular/cad");
    const page = await until(() => c.querySelector<HTMLElement>(".section-page"), "section page");
    const shown = must(page.querySelector(`[data-anchor="${BELOW}"]`), "below block on the section page");
    const tableOfLastRow = must(page.querySelector(`div.notes[data-anchor="${B(13)}"]`), "B13 table");
    expect(tableOfLastRow.nextElementSibling).toBe(shown);
    expect(page.querySelectorAll(`[data-anchor="${BELOW}"]`)).toHaveLength(1);
    // Her answer: the heading is on the condition's page only.
    expect(page.textContent).not.toContain(BELOW_HEADING);
  });

  it("a topic with nothing added below shows no Additional info heading", async () => {
    const a = await renderApp(`#/eor/fm/t/${stable().id}`);
    app = a;
    const c = a.container;
    const card = await until(() => c.querySelector<HTMLElement>(`section.tcard[data-topic="${stable().id}"]`), "Stable angina card");
    expect(card.querySelectorAll(".meds")).toHaveLength(1);
    expect(card.querySelector(`section[aria-label="${BELOW_HEADING}"]`)).toBeNull();
    expect(card.textContent).not.toContain(BELOW_HEADING);
  });

  it("an old two-topic link is the comparison, with no page PDF; a flat system's topic has no section crumb", async () => {
    const a = await renderApp(`#/eor/fm/t/${R(101)},${R(201)}`);
    app = a;
    const c = a.container;
    await until(() => c.querySelectorAll(".cmp-q").length === 2, "two quadrants");
    // The stacked page is gone: the link lands on the comparison and the address becomes its canonical route.
    expect(location.hash).toBe(`#/eor/fm/compare/${R(101)},${R(201)}`);
    expect([...c.querySelectorAll(".cmp-q .tcard")].map((e) => e.getAttribute("data-topic"))).toEqual([R(101), R(201)]);
    expect(h1(c)).toBe("Compare");
    expect(c.querySelector(".main .pdfm")).toBeNull();

    await go(`#/eor/fm/t/${R(201)}`);
    await until(() => c.querySelectorAll("section.tcard").length === 1, "one card");
    expect(crumbs(c)).toEqual(["EOR", "Family Medicine", "Pulmonary", "Asthma"]);
    expect(h1(c)).toBe("Asthma");
    const menu2 = await openPdfMenu(c);
    expect(byText(menu2, "[role='menuitem']", "This topic")?.textContent).toBe("This topicAsthma");
  });

  it("an unknown topic, or a listed block opened as a topic, isn't on the site", async () => {
    quietErrors();
    const a = await renderApp("#/eor/fm/t/r_0000009999");
    app = a;
    await until(() => notFound(a.container), "unknown topic not on site");
    await go(`#/eor/fm/t/${B(11)}`);
    await until(() => notFound(a.container) && location.hash === `#/eor/fm/t/${B(11)}`, "block as topic not on site");
    expect(a.container.querySelector("section.tcard")).toBeNull();
  });
});

describe("compare page", () => {
  it("the dx page's Compare button opens the view; the + adds, the picker swaps, ✕ removes", async () => {
    const a = await renderApp(`#/eor/fm/t/${stable().id}`);
    app = a;
    const c = a.container;
    await until(() => c.querySelector(`section.tcard[data-topic="${stable().id}"]`), "Stable angina card");

    await click(byText(c, ".main .acts button", "Compare"));
    await until(() => c.querySelectorAll(".cmp-q").length === 1, "one quadrant");
    expect(location.hash).toBe(`#/eor/fm/compare/${stable().id}`);
    const first = must(c.querySelector(".cmp-q"), "first quadrant");
    expect(must(first.querySelector("select"), "first picker").value).toBe(stable().id);
    // The quadrant draws her card stacked, so its rows are the stacked blocks, not table rows.
    expect(must(first.querySelector(".tcard"), "card").querySelector(`[data-anchor="${R(104)}"]`)).not.toBeNull();
    expect(first.querySelector("button[aria-label^='Remove quadrant']")).toBeNull();
    expect(c.querySelector(".favm")).toBeNull();
    // The diagnosis on screen is the whole comparison, so no row offers its own +.
    expect(side(c).querySelector(`a.alongside[aria-label="Add ${stable().title} to the comparison"]`)).toBeNull();

    // The sidebar's + adds the next diagnosis beside it: the quadrant's section is open with it.
    await click(side(c).querySelector(`a.alongside[aria-label="Add ${prinz().title} to the comparison"]`));
    await until(() => c.querySelectorAll(".cmp-q").length === 2, "two quadrants");
    expect(location.hash).toBe(`#/eor/fm/compare/${stable().id},${prinz().id}`);
    expect([...c.querySelectorAll(".cmp-q select")].map((e) => (e as HTMLSelectElement).value)).toEqual([stable().id, prinz().id]);

    // A quadrant's picker swaps that quadrant alone.
    const second = must([...c.querySelectorAll(".cmp-q")][1], "second quadrant");
    const pick = must(second.querySelector("select"), "second picker");
    await act(async () => {
      pick.value = af().id;
      pick.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await until(() => c.querySelectorAll(".cmp-q .tcard").length === 2, "two cards");
    expect(location.hash).toBe(`#/eor/fm/compare/${stable().id},${af().id}`);
    expect(must(c.querySelector(".cmp-q"), "the first quadrant").querySelector(".tcard")?.getAttribute("data-topic")).toBe(stable().id);

    // ✕ takes the last one off; with one quadrant left there is no ✕.
    await click(must(c.querySelector("button[aria-label='Remove quadrant 2']"), "remove the second quadrant"));
    await until(() => c.querySelectorAll(".cmp-q").length === 1, "one quadrant again");
    expect(location.hash).toBe(`#/eor/fm/compare/${stable().id}`);
    expect(c.querySelector("button[aria-label^='Remove quadrant']")).toBeNull();
  });

  it("groups the picker by system; an empty slot drops off, an unknown topic isn't on the site, and five quadrants stay", async () => {
    quietErrors();
    const a = await renderApp(`#/eor/fm/compare/${stable().id}`);
    app = a;
    const c = a.container;
    await until(() => c.querySelector(".cmp-q .tcard"), "card");
    expect([...c.querySelectorAll(".cmp-q select optgroup")].map((g) => g.getAttribute("label"))).toContain("Cardiovascular");
    expect([...c.querySelectorAll(".cmp-q select option")].map((o) => (o as HTMLOptionElement).value)).toContain(af().id);

    // An old address with an empty slot keeps its quadrants and drops the slot from the address.
    await go(`#/eor/fm/compare/${stable().id},,`);
    await until(() => location.hash === `#/eor/fm/compare/${stable().id}`, "the empty slot drops off");
    expect(c.querySelectorAll(".cmp-q")).toHaveLength(1);

    await go(`#/eor/fm/compare/r_0000009999`);
    await until(() => notFound(c), "unknown topic not on site");
    await go(`#/eor/fm/compare/${stable().id}`);
    await until(() => c.querySelector(".cmp-q .tcard"), "a real compare page again");
    // No limit: a comparison of every diagnosis the fixture's guide has opens like any other.
    const five = [af(), stable(), prinz(), topicOf(R(131)), topicIn("pulmonary", R(201))];
    const hash = `#/eor/fm/compare/${five.map((t) => t.id).join(",")}`;
    await go(hash);
    await until(() => c.querySelectorAll(".cmp-q .tcard").length === 5, "five quadrants");
    expect(location.hash).toBe(hash);
  });

  it("shows her card stacked in the quadrant while the diagnosis page keeps the table layout", async () => {
    const a = await renderApp(`#/eor/fm/t/${af().id}`);
    app = a;
    const c = a.container;
    const card = await until(() => c.querySelector(`section.tcard[data-topic="${af().id}"]`), "the diagnosis card");
    // Her own page draws the table as a grid on a laptop: no stacked blocks anywhere in it.
    expect(card.querySelector(".notes table.nt")).not.toBeNull();
    expect(card.querySelector(".stacked")).toBeNull();

    await click(byText(c, ".main .acts button", "Compare"));
    const quadrant = await until(() => c.querySelector(".cmp-q .tcard"), "the quadrant's card");
    // The quadrant draws the same card the phone's Stacked layout draws — each column heading above its
    // text (the AF row's "Presentation" above "irregularly irregular") — and no grid table.
    const stack = must(quadrant.querySelector(".notes .stacked"), "the stacked card");
    expect(quadrant.querySelector(".notes table.nt")).toBeNull();
    expect(must(stack.querySelector(".stk-ch"), "a column heading").textContent).toContain("Presentation");
    const head = must(stack.querySelector(".stk-ch"), "the heading");
    const body = must(stack.querySelector(".stk-cb"), "its text");
    expect(head.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(body.textContent).toContain("irregularly irregular");
  });

  it("with four quadrants up, the sidebar's + still offers the next diagnosis and the fifth goes on", async () => {
    const four = [af(), stable(), prinz(), topicOf(R(131))];
    const a = await renderApp(`#/eor/fm/compare/${four.map((t) => t.id).join(",")}`);
    app = a;
    const c = a.container;
    await until(() => c.querySelectorAll(".cmp-q").length === 4, "four quadrants");
    // The fifth lives in another system: its row (and +) shows once that group is open.
    await click(groupToggle(c, "Pulmonary"));
    const asthma = topicIn("pulmonary", R(201));
    const plus = must(side(c).querySelector(`a.alongside[aria-label="Add ${asthma.title} to the comparison"]`), "the fifth's +");
    await click(plus);
    await until(() => c.querySelectorAll(".cmp-q").length === 5, "five quadrants");
    expect(location.hash).toBe(`#/eor/fm/compare/${[...four.map((t) => t.id), asthma.id].join(",")}`);
    expect(must([...c.querySelectorAll(".cmp-q")][4], "the fifth quadrant").querySelector(".tcard")?.getAttribute("data-topic")).toBe(asthma.id);
  });

  it("a saved comparison whose diagnosis is gone opens on the rest, and is listed without it", async () => {
    const saved: ComparisonsJson = {
      guide: "fm",
      comparisons: [
        { name: "Adrenal", ids: [stable().id, "r_0000009999"] },
        { name: "Gone", ids: ["r_0000008888"] },
      ],
    };
    server.restore();
    server = serveData(new Map([...files, ["g/fm/comparisons.json", saved]]));
    const a = await renderApp(`#/eor/fm/compare/${stable().id},r_0000009999`);
    app = a;
    const c = a.container;
    // The quadrant the guide still has, and an address without the diagnosis it no longer has.
    await until(() => c.querySelector(".cmp-q .tcard"), "the quadrant that is left");
    expect(c.querySelectorAll(".cmp-q")).toHaveLength(1);
    expect(location.hash).toBe(`#/eor/fm/compare/${stable().id}`);
    // The sidebar lists the comparison without that diagnosis, and not one whose diagnoses are all gone.
    await until(() => comparisonsList(c), "the Comparisons list");
    const rows = [...must(comparisonsList(c), "the Comparisons list").querySelectorAll("a.ent")];
    expect(rows.map((e) => e.textContent)).toEqual(["Adrenal"]);
    expect(must(rows[0], "the row").getAttribute("href")).toBe(`#/eor/fm/compare/${stable().id}/Adrenal`);
  });

  it("the owner with none sees the Comparisons section and a line saying how to make one", async () => {
    const none: ComparisonsJson = { guide: "fm", comparisons: [] };
    server.restore();
    server = serveData(new Map([...files, ["g/fm/comparisons.json", none]]));
    asOwner(true);
    const a = await renderApp(`#/eor/fm/t/${stable().id}`);
    app = a;
    const c = a.container;
    await until(() => c.querySelector("aside.side .ent"), "the sidebar's entries");
    expect([...side(c).querySelectorAll(".side-sec")].map((e) => e.textContent)).toContain("Comparisons");
    expect(must(side(c).querySelector("p.side-note"), "the empty line").textContent).toBe("None saved yet. Open Compare and press Save comparison.");
    expect(comparisonsList(c)).toBeNull();
  });

  it("a visitor with none sees no Comparisons section", async () => {
    const none: ComparisonsJson = { guide: "fm", comparisons: [] };
    server.restore();
    server = serveData(new Map([...files, ["g/fm/comparisons.json", none]]));
    const a = await renderApp(`#/eor/fm/t/${stable().id}`);
    app = a;
    const c = a.container;
    await until(() => c.querySelector("aside.side .ent"), "the sidebar's entries");
    expect([...side(c).querySelectorAll(".side-sec")].map((e) => e.textContent)).not.toContain("Comparisons");
    expect(side(c).querySelector("p.side-note")).toBeNull();
  });
});

describe("block page", () => {
  it("renders a listed block whole under its section crumb", async () => {
    const a = await renderApp(`#/eor/fm/b/${B(11)}`);
    app = a;
    const c = a.container;
    const page = await until(() => c.querySelector<HTMLElement>(".block-page"), "block page");
    expect(h1(c)).toBe("Murmurs");
    expect(crumbs(c)).toEqual(["EOR", "Family Medicine", "Cardiovascular", "Cardiovascular — other", "Murmurs"]);
    expect(byText(c, ".main nav.crumbs a", "Cardiovascular — other")?.getAttribute("href")).toBe("#/eor/fm/sec/cardiovascular/other");
    const body = must(page.querySelector(`[data-anchor="${B(11)}"]`), "Murmurs block");
    expect(body.textContent).toContain("Murmurs");
    expect(body.textContent).toContain("Systolic");
  });

  it("renders every block of an entry listing a run, in order, under the listed title", async () => {
    const nav = structuredClone(fmNav);
    const other = must(nav.systems.find((s) => s.id === "cardiovascular")?.sections.find((s) => s.id === "other"), "Cardiovascular — other");
    const entry = must(other.entries.find((e) => e.id === B(11)), "Murmurs entry");
    entry.blocks = [B(11), B(14)];
    server.restore();
    server = serveData(new Map([...files, ["g/fm/nav.json", nav]]));
    const a = await renderApp(`#/eor/fm/b/${B(11)}`);
    app = a;
    const c = a.container;
    const page = await until(() => c.querySelector<HTMLElement>(".block-page"), "block page");
    expect(h1(c)).toBe("Murmurs");
    const anchors = [...page.querySelectorAll<HTMLElement>("[data-anchor]")].map((e) => e.dataset.anchor).filter((id) => id === B(11) || id === B(14));
    expect([...new Set(anchors)]).toEqual([B(11), B(14)]);
    expect(must(page.querySelector(`[data-anchor="${B(14)}"]`), "run's second block").textContent).toContain("Mnemonic");
  });

  it("an unknown block, or a topic opened as a block, isn't on the site", async () => {
    quietErrors();
    const a = await renderApp(`#/eor/fm/b/${B(99)}`);
    app = a;
    await until(() => notFound(a.container), "unknown block not on site");
    await go(`#/eor/fm/b/${R(101)}`);
    await until(() => notFound(a.container) && location.hash === `#/eor/fm/b/${R(101)}`, "topic as block not on site");
  });
});

describe("review slides", () => {
  it("the generated deck opens on its contents slide, steps through its slides, and stops at the end", async () => {
    expect(deck.slides).toHaveLength(2);
    const a = await renderApp("#/eor/fm/slides/1");
    app = a;
    const c = a.container;
    const slide = await until(() => c.querySelector<HTMLElement>(".slides-page .slide"), "slide");
    expect(h1(c)).toBe("High-yield review slides for Family Medicine");
    expect(crumbs(c)).toEqual(["EOR", "Family Medicine", "High-yield review slides"]);
    expect(slide.getAttribute("aria-label")).toBe("Slide 1: Contents");
    expect(slide.querySelector(".sd-body")?.textContent).toBe("High-yield review slides");
    expect(slide.querySelector(".sd-num")?.textContent).toBe("1 / 2");
    expect(slide.querySelector(".sd-cover p")?.textContent).toBe("High-yield review · 2 slides");
    const toc = [...slide.querySelectorAll("ol.sd-toc li")];
    expect(toc).toHaveLength(1);
    expect(toc[0]?.querySelector(".n")?.textContent).toBe("2");
    expect(toc[0]?.textContent).toBe("2Atrial fibrillation");
    expect(c.querySelector(".hy-links")).toBeNull();
    expect(byText<HTMLButtonElement>(c, ".fv-bar button", "Previous")?.disabled).toBe(true);
    expect([...c.querySelectorAll(".fv-bar select option")].map((o) => o.textContent)).toEqual(["Contents", "2. Atrial fibrillation"]);

    await click(byText(c, ".fv-bar button", "Next"));
    await until(() => c.querySelector(".slide")?.getAttribute("aria-label") === "Slide 2: Atrial fibrillation", "slide 2");
    expect(location.hash).toBe("#/eor/fm/slides/2");
    const two = must(c.querySelector(".slide"), "slide 2");
    expect(two.querySelector(".sd-body")?.textContent).toContain("Atrial fibrillation");
    expect(two.querySelector(".sd-body")?.textContent).toContain("Irregularly irregular");
    expect(two.querySelector(".sd-num")?.textContent).toBe("2 / 2");
    expect(two.querySelector(".sd-cover")).toBeNull();
    expect(byText<HTMLButtonElement>(c, ".fv-bar button", "Next")?.disabled).toBe(true);
    const chips = [...c.querySelectorAll<HTMLAnchorElement>(".hy-links a.ph-tchip")];
    expect(c.querySelector(".hy-links .ph-k")?.textContent).toBe("Summarizes");
    expect(chips.map((l) => l.getAttribute("href"))).toEqual([`#/eor/fm/t/${R(101)}`]);
    expect(chips[0]?.textContent).toBe(af().title);

    // The badge says "made from your notes" to the owner only.
    const badge = must(c.querySelector(".rs-label"), "badge");
    expect(visibleText(badge)).toBe("Review slides · Not included in PDF downloads");
    asOwner(true);
    expect(visibleText(badge)).toBe("Review slides — made from your notes · Not included in PDF downloads");
    // A generated slide is editable: the signed-in owner gets Edit and Versions on it.
    expect(c.querySelectorAll('.slides-page [data-ref="edit-page"]').length).toBeGreaterThan(0);
    expect(c.querySelectorAll('.slides-page [data-ref="edit-versions"]').length).toBeGreaterThan(0);
    asOwner(false);

    // Keys, the jump list and the contents list move between slides.
    await press(two, "ArrowLeft");
    await until(() => location.hash === "#/eor/fm/slides/1", "ArrowLeft");
    await press(must(c.querySelector(".slide"), "slide"), "ArrowRight");
    await until(() => location.hash === "#/eor/fm/slides/2", "ArrowRight");
    const jump = must(c.querySelector<HTMLSelectElement>(".fv-bar select"), "jump");
    await act(async () => {
      jump.value = "1";
      jump.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await until(() => location.hash === "#/eor/fm/slides/1", "jump");
    await click(await until(() => c.querySelector("ol.sd-toc button"), "contents item"));
    await until(() => location.hash === "#/eor/fm/slides/2", "contents item");

    await click(chips[0] ?? null);
    await until(() => c.querySelector(`section.tcard[data-topic="${R(101)}"]`), "summarized topic");
    expect(location.hash).toBe(`#/eor/fm/t/${R(101)}`);
  });

  it("a slide past the end isn't on the site", async () => {
    quietErrors();
    const a = await renderApp("#/eor/fm/slides/3");
    app = a;
    await until(() => notFound(a.container), "slide 3 not on site");
  });

  it("slideTitle reads a slide's heading line", () => {
    expect(deck.slides.map(slideTitle)).toEqual(["High-yield review slides", "Atrial fibrillation"]);
  });

  /** Serves psy's review slides as her own deck, stored as document D(4). */
  function serveOwnDeck(): void {
    const own: SlidesJson = { ...deck, guide: "psy", kind: "own", title: "Psych review slides", file: D(4) };
    const doc: DocJson = { id: D(4), name: "Psych review slides", kind: "slides", original: `files/${D(4)}/psych.pptx`, notes: {} };
    const psyNav = files.get("g/psy/nav.json") as NavJson;
    const data = new Map(files);
    data.set("g/psy/slides.json", own);
    data.set(`docs/${D(4)}.json`, doc);
    data.set("g/psy/nav.json", { ...psyNav, slides: { title: "Psych review slides" } });
    server.restore();
    server = serveData(data);
  }

  it("her own deck opens on her first slide with the contents under it, Download original and Versions", async () => {
    serveOwnDeck();
    const a = await renderApp("#/eor/psy/slides/1");
    app = a;
    const c = a.container;
    const slide = await until(() => c.querySelector<HTMLElement>(".slides-page .slide"), "own slide");
    expect(h1(c)).toBe("Psych review slides");
    expect(crumbs(c)).toEqual(["EOR", "Psychiatry", "Psych review slides"]);
    expect(slide.getAttribute("aria-label")).toBe("Slide 1: High-yield review slides");
    expect(slide.querySelector(".sd-num")?.textContent).toBe("1 / 2");
    expect(slide.querySelector(".sd-cover p")?.textContent).toBe("Psych review slides · 2 slides");
    expect(slide.querySelector("ol.sd-toc li")?.textContent).toBe("2Atrial fibrillation");
    const original = must(byText<HTMLAnchorElement>(c, ".main a.btn", "Download original"), "Download original");
    expect(original.getAttribute("href")).toBe(`${DATA_BASE}files/${D(4)}/psych.pptx`);
    expect(original.hasAttribute("download")).toBe(true);
    expect(c.querySelector('.main button.own-only[data-ref="deck-versions"]')?.textContent).toBe("Versions");
    asOwner(true);
    expect(visibleText(must(c.querySelector(".rs-label"), "badge"))).toBe("Review slides · Not included in PDF downloads");
    // Her own deck is replaced, not text-edited: no per-slide Edit/Versions even for the signed-in owner.
    expect(c.querySelector('.slides-page [data-ref="edit-page"], .slides-page [data-ref="edit-versions"]')).toBeNull();
    asOwner(false);
    const sideLink = must(byText(side(c), "ul.gen a.ent", "Psych review slides"), "sidebar deck link");
    expect(sideLink.getAttribute("aria-current")).toBe("page");

    await click(byText(c, ".fv-bar button", "Next"));
    await until(() => c.querySelector(".slide")?.getAttribute("aria-label") === "Slide 2: Atrial fibrillation", "own slide 2");
    expect(c.querySelector(".slide .sd-cover")).toBeNull();
    expect(c.querySelector(".hy-links")).toBeNull();

    quietErrors();
    await go("#/eor/psy/slides/3");
    await until(() => notFound(c), "own slide 3 not on site");
  });

  it("her deck's Versions opens the deck document's history, and Back to the page returns to the slide she was on", async () => {
    serveOwnDeck();
    asOwner(true);
    // No GitHub is served here, so the history itself fails to load (and logs); only the page frame matters.
    quietErrors();
    const a = await renderApp("#/eor/psy/slides/2");
    app = a;
    const c = a.container;
    await click(await until(() => c.querySelector('.main [data-ref="deck-versions"]'), "the deck's Versions"));

    const versions = await until(() => c.querySelector('[data-surface="versions"]'), "the Versions page");
    expect(parseHash(location.hash)).toEqual(parseHash(versionsHash(`doc:${D(4)}`)));
    expect(versions.querySelector("h1")?.textContent).toBe("Versions of “Psych review slides”");

    await click(versions.querySelector('[data-ref="versions-back"]'));
    await until(() => c.querySelector(".slide")?.getAttribute("aria-label") === "Slide 2: Atrial fibrillation", "back on own slide 2");
    expect(location.hash).toBe("#/eor/psy/slides/2");
  });
});

describe("PANCE sidebar end entry", () => {
  it("links its document with the current route as from, and keeps it on the file page", async () => {
    const a = await renderApp("#/pance");
    app = a;
    const c = a.container;
    const link = await until(() => byText<HTMLAnchorElement>(c, "aside.side ul.gen a.ent", "Receptor chart"), "Receptor chart link");
    expect(side(c).querySelector(".gname")?.textContent).toBe("PANCE / EOC study guide");
    expect([...side(c).querySelectorAll(".side-sec")].map((e) => e.textContent)).toEqual(["Systems", "All systems"]);
    expect(link.getAttribute("href")).toBe(`#/file/${D(3)}?from=%23%2Fpance`);
    expect(parseHash(link.getAttribute("href") ?? "").query.from).toBe("#/pance");
    expect(link.getAttribute("aria-current")).toBeNull();

    await go("#/pance/s/cardiovascular");
    await until(() => byText(c, "aside.side ul.gen a.ent", "Receptor chart")?.getAttribute("href") === `#/file/${D(3)}?from=%23%2Fpance%2Fs%2Fcardiovascular`, "from the system page");

    await go(`#/file/${D(3)}?from=%23%2Fpance`);
    await until(() => byText(c, "aside.side ul.gen a.ent", "Receptor chart")?.getAttribute("aria-current") === "page", "current on its file page");
    expect(byText(c, "aside.side ul.gen a.ent", "Receptor chart")?.getAttribute("href")).toBe(`#/file/${D(3)}?from=%23%2Fpance`);
  });

  it("sidebarFrom keeps a file page's from, falls back to the guide, and is the route elsewhere", () => {
    expect(sidebarFrom(parseHash(`#/file/${D(3)}?from=%23%2Fpance`), "pance")).toBe("#/pance");
    expect(sidebarFrom(parseHash(`#/file/${D(3)}`), "pance")).toBe("#/pance");
    expect(sidebarFrom(parseHash(`#/file/${D(3)}`), "fm")).toBe("#/eor/fm");
    const r = parseHash("#/eor/fm/s/cardiovascular?q=af");
    expect(sidebarFrom(r, "fm")).toBe(r.path);
    expect(r.path).toBe("#/eor/fm/s/cardiovascular");
  });
});

describe("PDF menu", () => {
  it("explains the download to visitors and the owner, offers the page scope and the whole guide, and Escape closes it", async () => {
    const a = await renderApp("#/eor/fm/s/cardiovascular");
    app = a;
    const c = a.container;
    await until(() => c.querySelector(".system-page .pdfm button"), "PDF button");
    const button = must(c.querySelector<HTMLButtonElement>(".main .pdfm button[aria-haspopup='menu']"), "PDF button");
    expect(button.textContent).toBe("Download PDF");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(c.querySelector(".main [role='menu']")).toBeNull();

    const menu = await openPdfMenu(c);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const head = must(menu.querySelector(".mh"), "menu explanation");
    expect(visibleText(head)).toBe("The guide’s notes, in its table layout.");
    asOwner(true);
    expect(visibleText(head)).toBe("Your notes only, in your table layout. Content not from your notes and guideline notes are left out.");
    asOwner(false);
    const items = [...menu.querySelectorAll("[role='menuitem']")];
    expect(items.map((e) => e.textContent)).toEqual(["This systemCardiovascular", "Whole guideFamily Medicine EOR · every system, in guide order"]);
    expect(document.activeElement).toBe(items[0]);
    const whole = must(byText<HTMLAnchorElement>(menu, "a[role='menuitem']", "Whole guide"), "Whole guide");
    expect(whole.getAttribute("href")).toBe(wholeGuideUrl(site.repo, "fm", fmNav.source));
    expect(whole.querySelector("small")?.textContent).toBe("Family Medicine EOR · every system, in guide order");

    await press(must(items[0], "first item"), "Escape");
    expect(c.querySelector(".main [role='menu']")).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);

    // A click outside closes it too; following the whole-guide link closes it.
    await openPdfMenu(c);
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(c.querySelector(".main [role='menu']")).toBeNull();
    const again = await openPdfMenu(c);
    const link = must(again.querySelector<HTMLAnchorElement>("a[role='menuitem']"), "Whole guide");
    link.addEventListener("click", (e) => e.preventDefault());
    await click(link);
    expect(c.querySelector(".main [role='menu']")).toBeNull();
  });

  it("the guide home offers only the whole guide", async () => {
    const a = await renderApp("#/eor/fm");
    app = a;
    const c = a.container;
    await until(() => c.querySelector(".guide-home .pdfm button"), "PDF button");
    const menu = await openPdfMenu(c);
    expect([...menu.querySelectorAll("[role='menuitem']")].map((e) => e.textContent)).toEqual(["Whole guideFamily Medicine EOR · every system, in guide order"]);
  });
});
