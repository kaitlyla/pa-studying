import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PubPharmSection, SystemJson } from "../../lib/derive/published.ts";
import { readRows, type PMNode } from "../../lib/derive/text.ts";
import { trimRowText } from "../../lib/derive/trim.ts";
import { schema } from "../../lib/schema.ts";
import { tableDoc } from "../../tools/build/test-fixture.ts";
import { fileHash, guideViewHash } from "../shell/route.ts";
import { OWN_VERSION } from "./MedsPanel.tsx";
import {
  asOwner,
  C,
  click,
  D,
  go,
  installOwnerCss,
  P,
  publishedFixture,
  R,
  renderApp,
  serveData,
  until,
  visibleText,
  type DataServer,
  type Mounted,
} from "../testing.tsx";

let files: Map<string, unknown>;
let server: DataServer;
let app: Mounted | null = null;
const scrolled: Element[] = [];
/** Every scroll in call order: scrollIntoView's element, or the scroller a scrollTo moved. */
const scrollOrder: Element[] = [];
const originalScroll = Element.prototype.scrollIntoView;
const originalScrollTo = Element.prototype.scrollTo;

beforeAll(async () => {
  files = await publishedFixture();
  installOwnerCss();
});

beforeEach(() => {
  server = serveData(files);
  asOwner(false);
  scrolled.length = 0;
  scrollOrder.length = 0;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
    scrollOrder.push(this);
  };
  Element.prototype.scrollTo = function (this: Element) {
    scrollOrder.push(this);
  };
});

afterEach(() => {
  app?.unmount();
  app = null;
  server.restore();
  asOwner(false);
  Element.prototype.scrollIntoView = originalScroll;
  Element.prototype.scrollTo = originalScrollTo;
});

function isSystemJson(v: unknown): v is SystemJson {
  return typeof v === "object" && v !== null && "topics" in v && "cards" in v && "pharm" in v && "parts" in v;
}

function systemJson(path: string, from: Map<string, unknown> = files): SystemJson {
  const v = from.get(path);
  if (!isSystemJson(v)) throw new Error(`no system json at ${path}`);
  return v;
}

function need<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`missing ${what}`);
  return v;
}

const CV = "g/fm/s/cardiovascular.json";
const SEC_HASH = "#/eor/fm/pharm/cardiovascular/antianginals";

function antianginals(system: SystemJson): PubPharmSection {
  return need(system.pharm?.sections.find((s) => s.id === "antianginals"), "antianginals section");
}

/** Card keys in page order: Overview, class cards, Learning objectives. */
function keysOf(sec: PubPharmSection): string[] {
  return [...(sec.overview ? [sec.overview] : []), ...sec.cards, ...(sec.lo ? [sec.lo] : [])];
}

const pharmPage = (a: Mounted): HTMLElement => need(a.container.querySelector<HTMLElement>(".pharm-page"), "pharm page");
const cardEl = (root: ParentNode, anchor: string): HTMLElement => need(root.querySelector<HTMLElement>(`section.phc[data-anchor="${anchor}"]`), `card ${anchor}`);
const cardBtn = (root: ParentNode, anchor: string): HTMLButtonElement => need(cardEl(root, anchor).querySelector<HTMLButtonElement>(".phc-h button"), `card button ${anchor}`);
const anchors = (root: ParentNode): string[] => [...root.querySelectorAll<HTMLElement>("section.phc")].map((s) => s.dataset.anchor ?? "");
const expandedState = (root: ParentNode): Record<string, string | null> =>
  Object.fromEntries([...root.querySelectorAll<HTMLElement>("section.phc")].map((s) => [s.dataset.anchor ?? "", s.querySelector(".phc-h button")?.getAttribute("aria-expanded") ?? null]));
const allButtonText = (root: ParentNode): string => need(root.querySelector<HTMLButtonElement>(".ph-h2row button.linkbtn"), "expand-all button").textContent ?? "";

async function renderSection(hash: string): Promise<Mounted> {
  const a = await renderApp(hash);
  app = a;
  await until(() => a.container.querySelector(".pharm-page section.phc"), `pharm cards at ${hash}`);
  return a;
}

describe("pharm pages", () => {
  it("system pharm page lists its sections with what they treat, then its pharm files", async () => {
    const cv = systemJson(CV);
    const sections = need(cv.pharm, "cardiovascular pharm").sections;
    const a = await renderApp("#/eor/fm/pharm/cardiovascular");
    app = a;
    await until(() => a.container.querySelector(".pharm-page .fchip"), "pharm files");
    const pg = pharmPage(a);
    expect(visibleText(need(pg.querySelector("h1"), "title"))).toBe("Cardiovascular pharm");
    expect(visibleText(need(pg.querySelector(".ph-lead"), "lead"))).toBe(
      "The guide's drug tables for Cardiovascular, in guide order. Each one is followed by the pharm notes on the same drug classes.",
    );

    const items = [...pg.querySelectorAll<HTMLAnchorElement>("ul.lnk li a")];
    expect(items.map((x) => x.getAttribute("href"))).toEqual(
      sections.map((s) => guideViewHash("fm", { kind: "pharm", system: "cardiovascular", section: s.id, target: null })),
    );
    expect(items[0]?.getAttribute("href")).toBe(SEC_HASH);
    expect(items.map((x) => x.querySelector(".lt")?.textContent)).toEqual(sections.map((s) => s.title));
    const sec = antianginals(cv);
    expect(sec.treats.length).toBeGreaterThan(0);
    const titles = sec.treats.map((t) => need(cv.topics.find((x) => x.id === t), `topic ${t}`).title);
    expect(items[0]?.querySelector(".ll")?.textContent).toBe(`Treats: ${titles.join(", ")}`);
    expect(titles).toContain("Prinzmetal angina");

    const filesHead = need(pg.querySelector(".gsec h2"), "pharm files heading");
    expect(visibleText(filesHead)).toBe("Pharm files 1");
    const chips = [...pg.querySelectorAll<HTMLAnchorElement>("a.fchip")];
    expect(chips.map((c) => [c.querySelector(".ftype")?.textContent, c.querySelector("b")?.textContent])).toEqual([["PDF", "ACLS algorithms"]]);
    expect(chips[0]?.getAttribute("href")).toBe(fileHash(D(1), "#/eor/fm/pharm/cardiovascular"));
    expect(chips[0]?.getAttribute("href")).toMatch(new RegExp(`^#/file/${D(1)}\\?from=`));
    // Sections come before the files.
    const list = need(pg.querySelector("ul.lnk"), "section list");
    expect(list.compareDocumentPosition(need(chips[0], "chip")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // No section body on the system page.
    expect(pg.querySelector("section.phc")).toBeNull();
    expect(pg.querySelector(".ph-treats")).toBeNull();
  });

  it("owner sees 'Your' wording on the system pharm page", async () => {
    asOwner(true);
    const a = await renderApp("#/eor/fm/pharm/cardiovascular");
    app = a;
    await until(() => a.container.querySelector(".pharm-page .fchip"), "pharm files");
    const pg = pharmPage(a);
    expect(visibleText(need(pg.querySelector(".ph-lead"), "lead"))).toMatch(/^Your guide's drug tables for Cardiovascular.*followed by your pharm notes/);
    expect(visibleText(need(pg.querySelector(".gsec h2"), "pharm files heading"))).toBe("Your pharm files 1");
  });

  it("section page shows the drug table in full, then Overview and class cards in publish order, all closed", async () => {
    const cv = systemJson(CV);
    const sec = antianginals(cv);
    const a = await renderSection(SEC_HASH);
    const pg = pharmPage(a);
    expect(visibleText(need(pg.querySelector("h1"), "title"))).toBe("Antianginals");
    const crumbs = need(a.container.querySelector("nav.crumbs"), "crumbs");
    const pharmCrumb = need(crumbs.querySelector<HTMLAnchorElement>(`a[href="#/eor/fm/pharm/cardiovascular"]`), "Pharm crumb");
    expect(pharmCrumb.textContent).toBe("Pharm");
    expect(visibleText(crumbs)).toContain("Antianginals");

    const tableArea = need(pg.querySelector(".ph-src .ph-rowblk"), "table block");
    const tableText = tableArea.textContent ?? "";
    for (const drug of ["ANTIANGINALS", "Nitroglycerin", "Amlodipine", "Prinzmetal angina", "Ranolazine"]) expect(tableText).toContain(drug);
    expect(tableText.indexOf("Nitroglycerin")).toBeLessThan(tableText.indexOf("Amlodipine"));
    expect(tableText.indexOf("Amlodipine")).toBeLessThan(tableText.indexOf("Ranolazine"));
    expect(tableArea.querySelector(`[data-anchor="${R(121)}"]`)).not.toBeNull();
    const h2s = [...pg.querySelectorAll(".ph-h2")].map((h) => visibleText(h));
    expect(h2s).toEqual(["Family Medicine guide's table", "Pharm notes, by drug class"]);

    // Notes area follows the table.
    const firstCard = need(pg.querySelector("section.phc"), "first card");
    expect(tableArea.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const keys = keysOf(sec);
    expect(sec.cards).toContain(C(1));
    expect(sec.cards).toContain(C(2));
    expect(anchors(pg)).toEqual(keys);
    expect([...pg.querySelectorAll(".phc-t")].map((t) => t.textContent)).toEqual([
      ...(sec.overview ? ["Overview"] : []),
      ...sec.cards.map((c) => need(cv.cards[c], `card ${c}`).title),
    ]);
    expect([...pg.querySelectorAll(".phc-t")].map((t) => t.textContent)).toContain("Calcium Channel Blockers");

    // Groups: table-order cards, then "also" cards with their sub label.
    const groups = [...pg.querySelectorAll(".phc-group")].map((g) => visibleText(g));
    const tableCards = sec.cards.slice(0, sec.alsoFrom);
    const alsoCards = sec.cards.slice(sec.alsoFrom);
    expect(tableCards.length).toBeGreaterThan(0);
    expect(alsoCards.length).toBeGreaterThan(0);
    expect(groups).toEqual(["Same order as the table", "Also in the pharm notes"]);
    for (const c of tableCards) expect(cardEl(pg, c).querySelector(".phc-s")).toBeNull();
    for (const c of alsoCards) expect(visibleText(need(cardEl(pg, c).querySelector(".phc-s"), "also label"))).toBe("not in the guide's table");

    // Every card starts closed: no body in the DOM.
    for (const k of keys) {
      expect(cardBtn(pg, k).getAttribute("aria-expanded")).toBe("false");
      expect(cardEl(pg, k).querySelector(".phc-b")).toBeNull();
      expect(cardEl(pg, k).classList.contains("open")).toBe(false);
    }
    expect(pg.textContent).not.toContain("MOA: block L-type channels");
    expect(pg.textContent).not.toContain("Antianginal overview");
    expect(allButtonText(pg)).toBe("Expand all");
    // The sidebar scrolls its own current entry into view; the page itself must not scroll.
    expect(scrolled.filter((e) => pg.contains(e))).toEqual([]);
  });

  it("Expand all opens every card and becomes Collapse all, which closes them all", async () => {
    const cv = systemJson(CV);
    const sec = antianginals(cv);
    const keys = keysOf(sec);
    const a = await renderSection(SEC_HASH);
    const pg = pharmPage(a);
    await click(pg.querySelector(".ph-h2row button.linkbtn"));
    expect(allButtonText(pg)).toBe("Collapse all");
    for (const k of keys) {
      expect(cardBtn(pg, k).getAttribute("aria-expanded")).toBe("true");
      expect(cardEl(pg, k).classList.contains("open")).toBe(true);
      expect(cardEl(pg, k).querySelector(".phc-b")).not.toBeNull();
    }
    const text = visibleText(pg);
    for (const body of ["Antianginal overview", "MOA: block L-type channels", "MOA: venodilation", "MOA: beta-1 blockade"]) expect(text).toContain(body);
    // Visitors see the file label without the owner-only prefix.
    const fileLabel = need(cardEl(pg, C(1)).querySelector(".ph-file"), "file label");
    expect(visibleText(fileLabel)).toBe("cardio med list");
    // Each class card shows its parts, each tagged with its part id.
    const c1 = need(cv.cards[C(1)], "card C1");
    expect([...cardEl(pg, C(1)).querySelectorAll<HTMLElement>(".ph-part")].map((p) => p.dataset.anchor)).toEqual(c1.parts.map((p) => p.id));
    // The Overview part is shown without a part anchor of its own.
    expect(need(cardEl(pg, need(sec.overview, "overview")).querySelector<HTMLElement>(".ph-part"), "overview part").hasAttribute("data-anchor")).toBe(false);

    await click(pg.querySelector(".ph-h2row button.linkbtn"));
    expect(allButtonText(pg)).toBe("Expand all");
    for (const k of keys) {
      expect(cardBtn(pg, k).getAttribute("aria-expanded")).toBe("false");
      expect(cardEl(pg, k).querySelector(".phc-b")).toBeNull();
    }
    expect(pg.textContent).not.toContain("MOA: venodilation");
  });

  it("owner sees 'Your' wording and the owner file prefix in an open card", async () => {
    asOwner(true);
    const a = await renderSection(SEC_HASH);
    const pg = pharmPage(a);
    await click(cardBtn(pg, C(1)));
    expect(visibleText(need(cardEl(pg, C(1)).querySelector(".ph-file"), "file label"))).toBe("From your pharm notes · cardio med list");
    expect([...pg.querySelectorAll(".ph-h2")].map((h) => visibleText(h))).toEqual(["Your Family Medicine guide's table", "Your pharm notes, by drug class"]);
    expect([...pg.querySelectorAll(".phc-group")].map((g) => visibleText(g))).toContain("Also in your pharm notes");
  });

  it("a card header toggles only that card", async () => {
    const sec = antianginals(systemJson(CV));
    const keys = keysOf(sec);
    const a = await renderSection(SEC_HASH);
    const pg = pharmPage(a);
    const closed = Object.fromEntries(keys.map((k) => [k, "false"]));
    expect(expandedState(pg)).toEqual(closed);

    await click(cardBtn(pg, C(1)));
    expect(expandedState(pg)).toEqual({ ...closed, [C(1)]: "true" });
    expect(visibleText(cardEl(pg, C(1)))).toContain("MOA: block L-type channels");
    expect(cardEl(pg, C(2)).querySelector(".phc-b")).toBeNull();
    // Not every card is open, so the button still offers Expand all.
    expect(allButtonText(pg)).toBe("Expand all");

    await click(cardBtn(pg, C(1)));
    expect(expandedState(pg)).toEqual(closed);
    expect(pg.textContent).not.toContain("MOA: block L-type channels");

    // Opening every card one by one turns the button into Collapse all.
    for (const k of keys) await click(cardBtn(pg, k));
    expect(allButtonText(pg)).toBe("Collapse all");
  });

  it("a card-id route target opens that card and scrolls it into view", async () => {
    const sec = antianginals(systemJson(CV));
    const a = await renderSection(`${SEC_HASH}/${C(2)}`);
    const pg = pharmPage(a);
    await until(() => scrolled.some((e) => pg.contains(e)), "scroll to the card");
    const state = expandedState(pg);
    expect(state[C(2)]).toBe("true");
    for (const k of keysOf(sec).filter((k) => k !== C(2))) expect(state[k]).toBe("false");
    expect(visibleText(cardEl(pg, C(2)))).toContain("MOA: venodilation");
    expect(scrolled).toContain(cardEl(pg, C(2)));
    expect(cardEl(pg, C(2)).id).toBe(`card-${C(2)}`);
  });

  it("a row route target (no card) scrolls to the row and opens nothing", async () => {
    const sec = antianginals(systemJson(CV));
    const a = await renderSection(`${SEC_HASH}/${R(124)}`);
    const pg = pharmPage(a);
    await until(() => scrolled.some((e) => pg.contains(e)), "scroll to the row");
    const row = need(pg.querySelector(`[data-anchor="${R(124)}"]`), "Ranolazine row");
    expect(row.textContent).toContain("Ranolazine");
    expect(scrolled).toContain(row);
    expect(Object.values(expandedState(pg))).toEqual(keysOf(sec).map(() => "false"));
  });

  it("?at=<card part id> opens the card holding that part", async () => {
    const cv = systemJson(CV);
    const sec = antianginals(cv);
    const holder = need(
      keysOf(sec).find((k) => cv.cards[k]?.parts.some((p) => p.id === P(3))),
      "card holding P3",
    );
    expect(cv.cards[holder]?.title).toBe("Nitrates");
    const a = await renderSection(`${SEC_HASH}?at=${P(3)}`);
    const pg = pharmPage(a);
    await until(() => scrolled.some((e) => pg.contains(e)), "scroll to the part");
    const state = expandedState(pg);
    expect(state[holder]).toBe("true");
    for (const k of keysOf(sec).filter((k) => k !== holder)) expect(state[k]).toBe("false");
    const part = need(cardEl(pg, holder).querySelector<HTMLElement>(`.ph-part[data-anchor="${P(3)}"]`), "part container");
    expect(part.textContent).toContain("MOA: venodilation");
    expect(scrolled).toContain(part);
  });

  it("?at=<overview part id> opens the Overview card", async () => {
    const sec = antianginals(systemJson(CV));
    const overview = need(sec.overview, "overview");
    expect(overview).toBe(P(1));
    const a = await renderSection(`${SEC_HASH}?at=${overview}`);
    const pg = pharmPage(a);
    await until(() => scrolled.length > 0, "scroll to the overview");
    expect(cardBtn(pg, overview).getAttribute("aria-expanded")).toBe("true");
    expect(visibleText(cardEl(pg, overview))).toContain("Antianginal overview");
    expect(scrolled).toContain(cardEl(pg, overview));
    for (const c of sec.cards) expect(cardBtn(pg, c).getAttribute("aria-expanded")).toBe("false");
  });

  it("each Treats chip links to its topic route", async () => {
    const cv = systemJson(CV);
    const sec = antianginals(cv);
    const a = await renderSection(SEC_HASH);
    const pg = pharmPage(a);
    const treats = need(pg.querySelector(".ph-treats"), "treats");
    expect(need(treats.querySelector(".ph-k"), "treats label").textContent).toBe("Treats");
    const chips = [...treats.querySelectorAll<HTMLAnchorElement>("a.ph-tchip")];
    expect(chips.map((c) => c.getAttribute("href"))).toEqual(sec.treats.map((t) => guideViewHash("fm", { kind: "topics", ids: [t] })));
    expect(chips.map((c) => c.textContent)).toEqual(sec.treats.map((t) => need(cv.topics.find((x) => x.id === t), `topic ${t}`).title));
    expect(chips.map((c) => c.getAttribute("href"))).toContain(`#/eor/fm/t/${R(123)}`);

    const first = need(chips[0], "first chip");
    const href = need(first.getAttribute("href"), "chip href");
    await click(first);
    expect(location.hash).toBe(href);
    const topicId = need(sec.treats[0], "first treated topic");
    await until(() => a.container.querySelector(`section.tcard[data-topic="${topicId}"]`), "topic page");
    expect(a.container.querySelector(".pharm-page")).toBeNull();
  });

  it("meds panel on a condition topic shows the card's guide rows and notes, and links into the pharm section", async () => {
    const cv = systemJson(CV);
    const topic = need(
      cv.topics.find((t) => t.condition && t.meds.some((m) => m.card)),
      "condition topic with meds",
    );
    expect(topic.id).toBe(R(123));
    const med = need(topic.meds.find((m) => m.card), "med with a card");
    expect(med.card).toBe(C(1));
    expect(med.title).toBe("Calcium Channel Blockers");

    const a = await renderApp(`#/eor/fm/t/${topic.id}`);
    app = a;
    const panel = await until(() => a.container.querySelector<HTMLElement>(`section.tcard[data-topic="${topic.id}"] .meds`), "meds panel");
    expect(visibleText(need(panel.querySelector(".meds-hd"), "meds heading"))).toBe(`Medications for this condition ${topic.meds.length}`);
    expect(anchors(panel)).toEqual(topic.meds.map((m) => `meds-${m.target}`));
    expect([...panel.querySelectorAll(".phc-t")].map((t) => t.textContent)).toEqual(topic.meds.map((m) => m.title));
    // Closed until opened.
    const anchor = `meds-${med.target}`;
    expect(cardBtn(panel, anchor).getAttribute("aria-expanded")).toBe("false");
    expect(cardEl(panel, anchor).querySelector(".phc-b")).toBeNull();

    await click(cardBtn(panel, anchor));
    const card = cardEl(panel, anchor);
    expect(cardBtn(panel, anchor).getAttribute("aria-expanded")).toBe("true");
    const guideRows = need(card.querySelector(".ph-rowblk"), "guide rows");
    expect(visibleText(need(guideRows.querySelector(".phn-k"), "guide rows label"))).toBe("From the guide");
    for (const r of med.rows) expect(guideRows.querySelector(`[data-anchor="${r}"]`)).not.toBeNull();
    expect(guideRows.textContent).toContain("Amlodipine");
    expect(guideRows.textContent).not.toContain("Ranolazine");
    expect(visibleText(card)).toContain("MOA: block L-type channels");

    asOwner(true);
    expect(visibleText(need(guideRows.querySelector(".phn-k"), "guide rows label"))).toBe("From your guide");
    asOwner(false);

    const link = need(card.querySelector<HTMLAnchorElement>("a.phc-more"), "pharm link");
    expect(link.textContent).toBe("Open in Cardiovascular pharm ›");
    const href = guideViewHash("fm", { kind: "pharm", system: "cardiovascular", section: med.section, target: med.target });
    expect(href).toBe(`${SEC_HASH}/${C(1)}`);
    expect(link.getAttribute("href")).toBe(href);

    await click(link);
    expect(location.hash).toBe(href);
    const pg = await until(() => a.container.querySelector<HTMLElement>(".pharm-page"), "pharm section");
    await until(() => pg.querySelector(`section.phc[data-anchor="${C(1)}"] .phc-b`), "opened card");
    expect(cardBtn(pg, C(1)).getAttribute("aria-expanded")).toBe("true");
    for (const k of keysOf(antianginals(cv)).filter((k) => k !== C(1))) expect(cardBtn(pg, k).getAttribute("aria-expanded")).toBe("false");
    await until(() => scrolled.includes(cardEl(pg, C(1))), "scroll to the card");
    // The new route's reset of the page scroller must not land after the scroll to the card.
    expect(scrollOrder.at(-1)).toBe(cardEl(pg, C(1)));
  });

  it("meds panel card for a card-less drug row shows just the row and links to the row", async () => {
    const cv = systemJson(CV);
    const topic = need(
      cv.topics.find((t) => t.meds.some((m) => m.card === null)),
      "topic with a card-less med",
    );
    const med = need(topic.meds.find((m) => m.card === null), "card-less med");
    expect(med.title).toBe("Ranolazine");
    expect(med.target).toBe(R(124));
    // Stable angina's panel also lists the class cards for the drug rows it names.
    expect(topic.meds.length).toBeGreaterThan(1);

    const a = await renderApp(`#/eor/fm/t/${topic.id}`);
    app = a;
    const panel = await until(() => a.container.querySelector<HTMLElement>(`section.tcard[data-topic="${topic.id}"] .meds`), "meds panel");
    const anchor = `meds-${med.target}`;
    await click(cardBtn(panel, anchor));
    const card = cardEl(panel, anchor);
    expect(card.querySelector(`.ph-rowblk [data-anchor="${R(124)}"]`)).not.toBeNull();
    expect(card.querySelector(".phn")).toBeNull();
    // The other med cards stay closed.
    for (const m of topic.meds.filter((x) => x !== med)) expect(cardBtn(panel, `meds-${m.target}`).getAttribute("aria-expanded")).toBe("false");

    const link = need(card.querySelector<HTMLAnchorElement>("a.phc-more"), "pharm link");
    expect(link.getAttribute("href")).toBe(`${SEC_HASH}/${R(124)}`);
    await click(link);
    expect(location.hash).toBe(`${SEC_HASH}/${R(124)}`);
    await until(() => a.container.querySelector(".pharm-page section.phc"), "pharm section");
    const pg = pharmPage(a);
    const row = need(pg.querySelector(`[data-anchor="${R(124)}"]`), "Ranolazine row");
    expect(row.textContent).toContain("Ranolazine");
    await until(() => scrolled.includes(row), "scroll to the row");
    expect(Object.values(expandedState(pg)).every((v) => v === "false")).toBe(true);
  });

  it("meds panel card with no rows in the system shows its pharm-section notes; links only to a pharm system in this guide", async () => {
    // A card her text names whose drug rows sit in another system's (or another guide's) pharm.
    const cv = systemJson(CV);
    const nitrates = need(cv.cards[C(2)], "Nitrates card in the system's cards");
    expect(nitrates.title).toBe("Nitrates");
    const patched = structuredClone(cv);
    const topic = need(patched.topics.find((t) => t.id === R(131)), "Heart failure topic");
    expect(topic.meds).toEqual([]);
    topic.meds = [
      { card: C(2), title: "Nitrates", rows: [], section: "antianginals", system: "pulmonary", target: C(2) },
      { card: C(3), title: "Beta Blockers", rows: [], section: "beta-blockers", system: null, target: C(3) },
    ];
    expect(need(cv.cards[C(3)], "Beta Blockers card in the system's cards").title).toBe("Beta Blockers");
    server.restore();
    server = serveData(new Map([...files, [CV, patched]]));

    const a = await renderApp(`#/eor/fm/t/${topic.id}`);
    app = a;
    const panel = await until(() => a.container.querySelector<HTMLElement>(`section.tcard[data-topic="${topic.id}"] .meds`), "meds panel");
    expect([...panel.querySelectorAll(".phc-t")].map((t) => t.textContent)).toEqual(["Nitrates", "Beta Blockers"]);

    await click(cardBtn(panel, `meds-${C(2)}`));
    const sameGuide = cardEl(panel, `meds-${C(2)}`);
    expect(sameGuide.querySelector(".ph-rowblk")).toBeNull();
    expect(visibleText(sameGuide)).toContain("MOA: venodilation");
    const link = need(sameGuide.querySelector<HTMLAnchorElement>("a.phc-more"), "pharm link");
    expect(link.textContent).toBe("Open in Pulmonary pharm ›");
    expect(link.getAttribute("href")).toBe(guideViewHash("fm", { kind: "pharm", system: "pulmonary", section: "antianginals", target: C(2) }));

    await click(cardBtn(panel, `meds-${C(3)}`));
    const otherGuide = cardEl(panel, `meds-${C(3)}`);
    expect(otherGuide.querySelector(".ph-rowblk")).toBeNull();
    expect(visibleText(otherGuide)).toContain("MOA: beta-1 blockade");
    expect(otherGuide.querySelector("a.phc-more")).toBeNull();
  });

  it("meds panel shows a part of her pharm notes attached to the topic: its cut of her table, from its file, with no link", async () => {
    const mod = structuredClone(systemJson(CV));
    const TBL = "b_pagetable02";
    mod.notesBlocks[TBL] = {
      id: TBL, kind: "table",
      doc: schema.nodeFromJSON(tableDoc(3, [
        [R(920), "heading", "SPECIFIC DISEASE TX", "Hemophilia A", "Acute ITP"],
        [R(921), "content", "Tx", "Factor VIII", "IVIG, steroids"],
        [R(922), "heading", "", "Chronic ITP", "HIT"],
      ])).toJSON() as SystemJson["notesBlocks"][string]["doc"],
    };
    mod.parts.p_itp = { title: "Acute ITP", role: "topic", file: "pharm review", basePt: 11, blocks: [TBL], rows: [R(920), R(921)], column: 2 };
    const topic = need(mod.topics.find((t) => t.id === R(131)), "Heart failure topic");
    topic.meds = [{ card: null, part: "p_itp", title: "Acute ITP", rows: [], section: null, system: null, target: "p_itp" }];
    server.restore();
    server = serveData(new Map([...files, [CV, mod]]));

    const a = await renderApp(`#/eor/fm/t/${topic.id}`);
    app = a;
    const panel = await until(() => a.container.querySelector<HTMLElement>(`section.tcard[data-topic="${topic.id}"] .meds`), "meds panel");
    expect(visibleText(need(panel.querySelector(".meds-hd"), "meds heading"))).toBe("Medications for this condition 1");
    expect([...panel.querySelectorAll(".phc-t")].map((t) => t.textContent)).toEqual(["Acute ITP"]);
    expect(cardBtn(panel, "meds-p_itp").getAttribute("aria-expanded")).toBe("false");

    await click(cardBtn(panel, "meds-p_itp"));
    const card = cardEl(panel, "meds-p_itp");
    const part = need(card.querySelector<HTMLElement>('.ph-part[data-anchor="p_itp"]'), "her part");
    expect(visibleText(need(part.querySelector(".pn-col"), "column title"))).toBe("Acute ITP");
    expect(visibleText(part)).toContain("IVIG, steroids");
    for (const other of ["Factor VIII", "Hemophilia A", "Chronic ITP"]) expect(visibleText(part)).not.toContain(other);
    expect(visibleText(card)).toContain("pharm review");
    expect(card.querySelector(".ph-rowblk")).toBeNull();
    expect(card.querySelector("a.phc-more")).toBeNull();
  });

  it("meds panel shows her own panel for the condition: less what she took off, her version of a card, then a card she added", async () => {
    const mod = structuredClone(systemJson(CV));
    const topic = need(mod.topics.find((t) => t.id === R(104)), "Stable angina topic");
    expect(topic.meds.map((m) => m.target)).toEqual([C(2), R(124)]);
    const mine = "My own nitrates note for stable angina";
    topic.medsEdit = {
      remove: [R(124)],
      add: [{ card: C(3), title: "Beta Blockers", rows: [], section: "beta-blockers", system: null, target: C(3) }],
      own: { [C(2)]: [{ kind: "notes", basePt: 11, title: null, file: "angina", doc: schema.node("doc", null, [schema.node("paragraph", null, [schema.text(mine)])]).toJSON() as SystemJson["notesBlocks"][string]["doc"] }] },
      ownGaps: {},
      gaps: [],
      roles: {},
    };
    server.restore();
    server = serveData(new Map([...files, [CV, mod]]));

    const a = await renderApp(`#/eor/fm/t/${topic.id}`);
    app = a;
    const panel = await until(() => a.container.querySelector<HTMLElement>(`section.tcard[data-topic="${topic.id}"] .meds`), "meds panel");
    expect(visibleText(need(panel.querySelector(".meds-hd"), "meds heading"))).toBe("Medications for this condition 2");
    expect(anchors(panel)).toEqual([`meds-${C(2)}`, `meds-${C(3)}`]);

    await click(cardBtn(panel, `meds-${C(2)}`));
    const own = cardEl(panel, `meds-${C(2)}`);
    expect(visibleText(own)).toContain(mine);
    // Her version replaces the card's guide rows and notes here.
    expect(own.querySelector(".ph-rowblk")).toBeNull();
    expect(visibleText(own)).not.toContain("MOA: venodilation");
    // The label is hers alone; visitors see her version without it.
    expect(visibleText(own)).not.toContain(OWN_VERSION);
    asOwner(true);
    expect(visibleText(need(own.querySelector(".phn-k.own-only"), "own version label"))).toBe(OWN_VERSION);
    asOwner(false);
    expect(need(own.querySelector<HTMLAnchorElement>("a.phc-more"), "pharm link").textContent).toBe("Open in Cardiovascular pharm ›");

    await click(cardBtn(panel, `meds-${C(3)}`));
    const added = cardEl(panel, `meds-${C(3)}`);
    expect(visibleText(added)).toContain("MOA: beta-1 blockade");
    expect(added.textContent).not.toContain(OWN_VERSION);
  });

  it("meds panel shows the gap block her version holds under her version's notes, with its sources, and not as an entry", async () => {
    const mod = structuredClone(systemJson(CV));
    const topic = need(mod.topics.find((t) => t.id === R(104)), "Stable angina topic");
    const doc = (text: string): SystemJson["notesBlocks"][string]["doc"] => schema.node("doc", null, [schema.node("paragraph", null, [schema.text(text)])]).toJSON() as SystemJson["notesBlocks"][string]["doc"];
    const src = { name: "Nitroglycerin label", org: "DailyMed", year: "2026", url: "https://dailymed.nlm.nih.gov/x" };
    const held = {
      id: "g_HELD000000", title: "Nitrates: EOR additions", relevantTo: "Stable angina", written: "2026-10-09", doc: doc("Avoid with PDE-5 inhibitors."), differs: null,
      sources: [src], ownerEdits: [], figures: [], asNotes: false, notes: [],
    };
    topic.medsEdit = { remove: [], add: [], own: { [C(2)]: [{ kind: "notes", basePt: 11, title: null, file: "angina", doc: doc("My trimmed nitrates") }] }, ownGaps: { [C(2)]: held }, gaps: [], roles: {} };
    server.restore();
    server = serveData(new Map([...files, [CV, mod]]));

    const a = await renderApp(`#/eor/fm/t/${topic.id}`);
    app = a;
    const panel = await until(() => a.container.querySelector<HTMLElement>(`section.tcard[data-topic="${topic.id}"] .meds`), "meds panel");
    expect(anchors(panel)).toEqual([`meds-${C(2)}`, `meds-${R(124)}`]);
    await click(cardBtn(panel, `meds-${C(2)}`));
    const own = cardEl(panel, `meds-${C(2)}`);
    const text = visibleText(own);
    expect(text).toContain("Avoid with PDE-5 inhibitors.");
    expect(text.indexOf("My trimmed nitrates")).toBeLessThan(text.indexOf("Avoid with PDE-5 inhibitors."));
    expect(text).toContain("Nitroglycerin label");
  });

  it("meds panel orders entries by role label, shows each label's source, and shows her sourced cards less any she took off", async () => {
    const mod = structuredClone(systemJson(CV));
    const topic = need(mod.topics.find((t) => t.id === R(104)), "Stable angina topic");
    const doc = (text: string): SystemJson["notesBlocks"][string]["doc"] => schema.node("doc", null, [schema.node("paragraph", null, [schema.text(text)])]).toJSON() as SystemJson["notesBlocks"][string]["doc"];
    const src = { name: "Angina Pectoris", org: "MSD Manual Professional", year: "2026", url: "https://www.msdmanuals.com/professional/angina" };
    const gap = (id: string, title: string, text: string) => ({
      id, title, relevantTo: "Stable angina", written: "2026-10-08", doc: doc(text), differs: null, sources: [src], ownerEdits: [], figures: [], asNotes: false, notes: [],
    });
    topic.medsEdit = {
      remove: ["g_REMOVED000"],
      add: [{ card: C(3), title: "Beta Blockers", rows: [], section: "beta-blockers", system: null, target: C(3) }],
      own: {},
      ownGaps: {},
      gaps: [gap("g_SOURCED000", "Ranolazine (sourced)", "Ranolazine for refractory angina."), gap("g_REMOVED000", "Ivabradine (sourced)", "Ivabradine text she took off.")],
      roles: {
        [C(3)]: [{ role: "1st", drugs: "metoprolol", note: null, sources: [src] }],
        g_SOURCED000: [{ role: "adjunct", drugs: null, note: "refractory symptoms only", sources: [src] }],
      },
    };
    server.restore();
    server = serveData(new Map([...files, [CV, mod]]));

    const a = await renderApp(`#/eor/fm/t/${topic.id}`);
    app = a;
    const panel = await until(() => a.container.querySelector<HTMLElement>(`section.tcard[data-topic="${topic.id}"] .meds`), "meds panel");
    // 1st-line before adjunct; the unlabeled cards keep their order after them. The removed sourced card is gone.
    expect(anchors(panel)).toEqual([`meds-${C(3)}`, "g_SOURCED000", `meds-${C(2)}`, `meds-${R(124)}`]);
    expect(visibleText(need(panel.querySelector(".meds-hd"), "meds heading"))).toBe("Medications for this condition 4");
    expect(panel.textContent).not.toContain("Ivabradine");
    const chip = need(cardEl(panel, `meds-${C(3)}`).querySelector<HTMLElement>(".phc-h .rolec"), "role chip");
    expect(chip.textContent).toBe("1st-line: metoprolol");
    expect(chip.title).toBe("Source: Angina Pectoris, MSD Manual Professional (2026)");
    expect(cardEl(panel, `meds-${C(2)}`).querySelector(".rolec")).toBeNull();

    await click(cardBtn(panel, "g_SOURCED000"));
    const sourced = cardEl(panel, "g_SOURCED000");
    expect(visibleText(need(sourced.querySelector(".phc-h"), "header"))).toContain("Ranolazine (sourced)");
    const line = need(sourced.querySelector<HTMLElement>(".rolels li"), "role line");
    expect(visibleText(line)).toBe("Adjunct — refractory symptoms only · Source: Angina Pectoris, MSD Manual Professional (2026)");
    expect(need(line.querySelector<HTMLAnchorElement>("a"), "source link").href).toBe(src.url);
    expect(visibleText(sourced)).toContain("Ranolazine for refractory angina.");
  });

  it("a topic without meds shows no meds panel", async () => {
    const cv = systemJson(CV);
    const topic = need(cv.topics.find((t) => t.meds.length === 0 && t.id === R(131)), "Heart failure topic without meds");
    const a = await renderApp(`#/eor/fm/t/${topic.id}`);
    app = a;
    const card = await until(() => a.container.querySelector<HTMLElement>(`section.tcard[data-topic="${topic.id}"] .notes`), "topic notes");
    expect(card.textContent).toContain("Heart failure");
    expect(a.container.querySelector(".meds")).toBeNull();
  });

  it("renal pharm page shows only its file; PANCE beta-blockers section renders its table and card", async () => {
    const a = await renderApp("#/eor/fm/pharm/renal");
    app = a;
    await until(() => a.container.querySelector(".pharm-page .fchip"), "renal pharm file");
    const pg = pharmPage(a);
    expect(visibleText(need(pg.querySelector("h1"), "title"))).toBe("Urology/Renal pharm");
    expect(pg.querySelector("ul.lnk")).toBeNull();
    expect(pg.querySelector(".ph-lead")).toBeNull();
    expect(pg.querySelector("section.phc")).toBeNull();
    const chips = [...pg.querySelectorAll<HTMLAnchorElement>("a.fchip")];
    expect(chips.map((c) => [c.querySelector(".ftype")?.textContent, c.querySelector("b")?.textContent])).toEqual([["IMG", "Renal chart"]]);
    expect(chips[0]?.getAttribute("href")).toBe(fileHash(D(2), "#/eor/fm/pharm/renal"));
    a.unmount();
    app = null;

    const pance = systemJson("g/pance/s/cardiovascular.json");
    const sec = need(pance.pharm?.sections.find((s) => s.id === "beta-blockers"), "beta-blockers section");
    const b = await renderSection("#/pance/pharm/cardiovascular/beta-blockers");
    const ppg = pharmPage(b);
    expect(visibleText(need(ppg.querySelector("h1"), "title"))).toBe("Beta blockers");
    const table = need(ppg.querySelector(".ph-rowblk"), "PANCE table");
    expect(table.textContent).toContain("Metoprolol");
    expect(table.textContent).toContain("Propranolol (non-selective)");
    expect(visibleText(need(ppg.querySelector(".ph-h2"), "table heading"))).toBe("PANCE guide's table");
    // No condition topics draw on this table and the system has no pharm files.
    expect(ppg.querySelector(".ph-treats")).toBeNull();
    expect(ppg.querySelector(".fchip")).toBeNull();
    expect(ppg.querySelector(".gsec")).toBeNull();
    expect(anchors(ppg)).toEqual(keysOf(sec));
    expect(sec.cards).toContain(C(3));
  });

  it("an unknown pharm section and a system without pharm are not on the site", async () => {
    const a = await renderApp("#/eor/fm/pharm/cardiovascular/no-such-section");
    app = a;
    await until(() => a.container.querySelector(".notfound h1"), "not-found page");
    expect(a.container.querySelector(".notfound h1")?.textContent).toBe("This page isn't on the site");
    expect(a.container.querySelector(".pharm-page")).toBeNull();
    a.unmount();
    app = null;

    const b = await renderApp("#/eor/fm/pharm/pulmonary");
    app = b;
    await until(() => b.container.querySelector(".notfound h1"), "not-found page");
    expect(b.container.querySelector(".notfound h1")?.textContent).toBe("This page isn't on the site");
    expect(b.container.querySelector(".pharm-page")).toBeNull();
  });

  it("a card leaves out the notes lines its shown table rows already say, until either side is edited", async () => {
    const cv = systemJson(CV);
    const topic = need(cv.topics.find((t) => t.meds.some((m) => m.card === C(1) && m.rows.length > 0)), "topic with the CCB card's rows");
    const med = need(topic.meds.find((m) => m.card === C(1)), "CCB med");
    const rowId = need(med.rows[0], "CCB row");
    const block = need(cv.blocks.find((b) => b.id === cv.rows[rowId]?.block), "CCB row's table");
    const table = need((block.doc.content as PMNode[]).find((n) => n.type === "table"), "table node");
    const rowText = trimRowText(need(readRows(table.content ?? []).find((r) => r.id === rowId), "CCB row read"));
    const notes = need(cv.cards[C(1)], "CCB card").blocks;
    const serve = (rowTextJudged: string): void => {
      const mod = structuredClone(cv);
      mod.trims = Object.fromEntries(notes.map((b) => [b, [{ text: "MOA: block L-type channels", label: false, rows: [{ id: rowId, text: rowTextJudged }] }]]));
      const served = new Map(files);
      served.set(CV, mod);
      server.restore();
      server = serveData(served);
    };
    const openMed = async (): Promise<HTMLElement> => {
      const a = await renderApp(`#/eor/fm/t/${topic.id}`);
      app = a;
      const panel = await until(() => a.container.querySelector<HTMLElement>(`section.tcard[data-topic="${topic.id}"] .meds`), "meds panel");
      await click(cardBtn(panel, `meds-${med.target}`));
      return cardEl(panel, `meds-${med.target}`);
    };

    serve(rowText);
    let card = await openMed();
    expect(card.querySelector(`.ph-rowblk [data-anchor="${rowId}"]`)).not.toBeNull();
    expect(visibleText(card)).not.toContain("MOA: block L-type channels");
    expect(card.querySelector(".phn")).toBeNull();
    // The section page shows the same card with its table, so the line goes there too.
    app?.unmount();
    const pg = pharmPage(await renderSection(SEC_HASH));
    await click(cardBtn(pg, C(1)));
    expect(visibleText(need(cardEl(pg, C(1)).querySelector(".phn-none"), "no-notes line"))).toBe(
      "The pharm notes have nothing more on this one. The row in the table above is all of it.",
    );
    app?.unmount();

    // A row that no longer reads as judged no longer says the line.
    serve(`${rowText} edited`);
    card = await openMed();
    expect(visibleText(card)).toContain("MOA: block L-type channels");
  });

  it("a class card stacks her notes from each file under that file's name", async () => {
    const mod = structuredClone(systemJson(CV));
    const ccb = need(mod.cards[C(1)], "CCB card");
    const other = need(mod.cards[C(2)], "Nitrates card");
    const own = need(ccb.parts[0], "CCB part");
    const II = "Cardio II Med List";
    // Two parts from her other file follow the card's own: one label for the run of them.
    ccb.parts = [own, { id: "p_ii_one", blocks: other.blocks, file: II, basePt: 9 }, { id: "p_ii_two", blocks: [], file: II, basePt: 9 }];
    ccb.blocks = [...own.blocks, ...other.blocks];
    const served = new Map(files);
    served.set(CV, mod);
    server.restore();
    server = serveData(served);

    const pg = pharmPage(await renderSection(SEC_HASH));
    await click(cardBtn(pg, C(1)));
    const card = cardEl(pg, C(1));
    expect([...card.querySelectorAll(".ph-file")].map((f) => visibleText(f))).toEqual(["cardio med list", II]);
    expect([...card.querySelectorAll<HTMLElement>(".ph-part")].map((p) => p.dataset.anchor)).toEqual([own.id, "p_ii_one", "p_ii_two"]);
    const text = visibleText(card);
    expect(text.indexOf("MOA: block L-type channels")).toBeLessThan(text.indexOf(II));
    expect(text.indexOf(II)).toBeLessThan(text.indexOf("MOA: venodilation"));
  });

  it("a card part cutting her table shows its heading row and its own rows, or one column under its heading", async () => {
    const mod = structuredClone(systemJson(CV));
    const ccb = need(mod.cards[C(1)], "CCB card");
    const own = need(ccb.parts[0], "CCB part");
    const TBL = "b_pagetable01";
    mod.notesBlocks[TBL] = {
      id: TBL, kind: "table",
      // As published: through the schema, attribute defaults made explicit.
      doc: schema.nodeFromJSON(tableDoc(3, [
        [R(910), "heading", "ANTICOAGULANTS", "Warfarin", "Apixaban"],
        [R(911), "content", "MOA", "VKA", "Xa inhibitor"],
        [R(912), "content", "Monitor", "INR", "none needed"],
      ])).toJSON() as SystemJson["notesBlocks"][string]["doc"],
    };
    ccb.parts = [
      { ...own, id: "p_rows", blocks: [TBL], rows: [R(910), R(912)] },
      { ...own, id: "p_bare", blocks: [TBL], rows: [R(911)] },
      { ...own, id: "p_col", blocks: [TBL], column: 2 },
    ];
    ccb.blocks = [TBL];
    // Lines of her table named for another section: a table's lines are never hidden, so no part goes.
    mod.uses = { ...mod.uses, [TBL]: [{ text: "ANTICOAGULANTS", for: ["hf"] }, { text: "Monitor", for: ["hf"] }] };
    const served = new Map(files);
    served.set(CV, mod);
    server.restore();
    server = serveData(served);

    const pg = pharmPage(await renderSection(SEC_HASH));
    await click(cardBtn(pg, C(1)));
    const part = (anchor: string): HTMLElement => need(cardEl(pg, C(1)).querySelector<HTMLElement>(`.ph-part[data-anchor="${anchor}"]`), anchor);
    const rowTexts = (el: HTMLElement): string[] => [...el.querySelectorAll("tr")].map((tr) => visibleText(tr));
    expect(rowTexts(part("p_rows"))).toEqual([expect.stringContaining("ANTICOAGULANTS"), expect.stringContaining("none needed")]);
    expect(visibleText(part("p_rows"))).not.toContain("Xa inhibitor");
    // A part shows only the rows it lists: with no heading row listed, none shows.
    expect(rowTexts(part("p_bare"))).toEqual([expect.stringContaining("Xa inhibitor")]);
    expect(visibleText(part("p_bare"))).not.toContain("ANTICOAGULANTS");
    expect(part("p_rows").querySelector(".pn-col")).toBeNull();
    expect(visibleText(need(part("p_col").querySelector(".pn-col"), "column title"))).toBe("Apixaban");
    expect(visibleText(part("p_col"))).toContain("Xa inhibitor");
    expect(visibleText(part("p_col"))).not.toContain("VKA");
  });

  it("a card shows only the notes written for a use relevant where it shows, on the section page and the meds panel", async () => {
    const cv = systemJson(CV);
    // A card with guide rows on the panel shows the notes for the condition's uses (a rowless one, its home's).
    const topic = need(cv.topics.find((t) => t.meds.some((m) => m.card === C(1) && m.rows.length > 0)), "topic with the CCB card's rows");
    const med = need(topic.meds.find((m) => m.card === C(1)), "CCB med");
    const serve = (panelUses: string[]): void => {
      const mod = structuredClone(cv);
      const ccb = need(mod.cards[C(1)], "CCB card");
      const own = need(ccb.parts[0], "CCB part");
      const other = need(mod.cards[C(2)], "Nitrates card");
      // Her other file's notes on the class, written for Antiarrhythmics; one of the card's own lines too.
      ccb.parts = [own, { id: "p_rhythm", blocks: other.blocks, file: "Cardio II Med List", basePt: 9, for: ["antiarrhythmics"] }];
      ccb.blocks = [...own.blocks, ...other.blocks];
      mod.uses = { [need(own.blocks[0], "CCB block")]: [{ text: "MOA: block L-type channels", for: ["antiarrhythmics"] }] };
      mod.panelSections = { ...mod.panelSections, [need(topic.section, "topic section")]: panelUses };
      const served = new Map(files);
      served.set(CV, mod);
      server.restore();
      server = serveData(served);
    };
    const openMed = async (): Promise<string> => {
      const a = await renderApp(`#/eor/fm/t/${topic.id}`);
      app = a;
      const panel = await until(() => a.container.querySelector<HTMLElement>(`section.tcard[data-topic="${topic.id}"] .meds`), "meds panel");
      await click(cardBtn(panel, `meds-${med.target}`));
      const text = visibleText(cardEl(panel, `meds-${med.target}`));
      app.unmount();
      app = null;
      return text;
    };

    serve(["antianginals"]);
    const pg = pharmPage(await renderSection(SEC_HASH));
    await click(cardBtn(pg, C(1)));
    const page = visibleText(cardEl(pg, C(1)));
    expect(page).not.toContain("MOA: venodilation");
    expect(page).not.toContain("Cardio II Med List");
    expect(page).not.toContain("MOA: block L-type channels");
    app?.unmount();
    app = null;
    const panel = await openMed();
    expect(panel).not.toContain("MOA: venodilation");
    expect(panel).not.toContain("MOA: block L-type channels");

    // Where her condition's section is treated by Antiarrhythmics too, the panel shows them.
    serve(["antianginals", "antiarrhythmics"]);
    const both = await openMed();
    expect(both).toContain("MOA: venodilation");
    expect(both).toContain("MOA: block L-type channels");
  });

  it("a section with learning objectives and a card without notes renders both", async () => {
    const cv = systemJson(CV);
    const mod = structuredClone(cv);
    const sec = antianginals(mod);
    const overview = need(mod.parts[need(sec.overview, "overview")], "overview part");
    const LO = "p_lo_fixture";
    sec.lo = LO;
    mod.parts[LO] = { title: "Learning objectives", role: "lo", file: overview.file, basePt: overview.basePt, blocks: overview.blocks };
    const bare = need(sec.cards[sec.cards.length - 1], "last card");
    const bareCard = need(mod.cards[bare], "bare card");
    bareCard.blocks = [];
    bareCard.parts = bareCard.parts.map((p) => ({ ...p, blocks: [] }));
    const served = new Map(files);
    served.set(CV, mod);
    server.restore();
    server = serveData(served);

    const a = await renderSection(SEC_HASH);
    const pg = pharmPage(a);
    const order = anchors(pg);
    expect(order).toEqual(keysOf(sec));
    expect(order[order.length - 1]).toBe(LO);
    const groups = [...pg.querySelectorAll(".phc-group")].map((g) => visibleText(g));
    expect(groups[groups.length - 1]).toBe("Learning objectives & concepts");
    expect(visibleText(need(cardEl(pg, LO).querySelector(".phc-t"), "LO title"))).toBe("Learning objectives — Antianginals");

    await click(pg.querySelector(".ph-h2row button.linkbtn"));
    expect(allButtonText(pg)).toBe("Collapse all");
    expect(cardBtn(pg, LO).getAttribute("aria-expanded")).toBe("true");
    expect(visibleText(cardEl(pg, LO))).toContain("Antianginal overview");
    expect(visibleText(need(cardEl(pg, bare).querySelector(".phn-none"), "no-notes line"))).toBe(
      "The pharm notes have nothing more on this one. The row in the table above is all of it.",
    );
    expect(cardEl(pg, bare).querySelector(".phn")).toBeNull();

    // ?at= the LO part opens only the LO card.
    await go(`${SEC_HASH}?at=${LO}`);
    await until(() => scrolled.includes(cardEl(pg, LO)), "scroll to the LO card");
    expect(cardBtn(pg, LO).getAttribute("aria-expanded")).toBe("true");
    for (const k of keysOf(sec).filter((k) => k !== LO)) expect(cardBtn(pg, k).getAttribute("aria-expanded")).toBe("false");
  });

  it("a section's learning-objectives part cutting a range of her table's columns shows those columns alone", async () => {
    const mod = structuredClone(systemJson(CV));
    const sec = antianginals(mod);
    const overview = need(mod.parts[need(sec.overview, "overview")], "overview part");
    const TBL = "b_pagetable02";
    mod.notesBlocks[TBL] = {
      id: TBL, kind: "table",
      doc: schema.nodeFromJSON(tableDoc(4, [
        [R(920), "heading", "SSRIs", "", "SNRIs", ""],
        [R(921), "content", "Fluoxetine", "Sertraline", "Venlafaxine", "Duloxetine"],
      ])).toJSON() as SystemJson["notesBlocks"][string]["doc"],
    };
    const LO = "p_lo_range";
    sec.lo = LO;
    mod.parts[LO] = { title: "Learning objectives", role: "lo", file: overview.file, basePt: overview.basePt, blocks: [TBL], rows: [R(920), R(921)], column: 0, columns: 2 };
    const served = new Map(files);
    served.set(CV, mod);
    server.restore();
    server = serveData(served);

    const pg = pharmPage(await renderSection(SEC_HASH));
    await click(cardBtn(pg, LO));
    const card = cardEl(pg, LO);
    expect(visibleText(need(card.querySelector(".pn-col"), "range title"))).toBe("SSRIs");
    const text = visibleText(card);
    for (const kept of ["Fluoxetine", "Sertraline"]) expect(text).toContain(kept);
    for (const cut of ["SNRIs", "Venlafaxine", "Duloxetine"]) expect(text).not.toContain(cut);
  });
});
