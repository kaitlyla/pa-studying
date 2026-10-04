import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PubPharmSection, SystemJson } from "../../lib/derive/published.ts";
import { fileHash, guideViewHash } from "../shell/route.ts";
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
const originalScroll = Element.prototype.scrollIntoView;

beforeAll(async () => {
  files = await publishedFixture();
  installOwnerCss();
});

beforeEach(() => {
  server = serveData(files);
  asOwner(false);
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
});

afterEach(() => {
  app?.unmount();
  app = null;
  server.restore();
  asOwner(false);
  Element.prototype.scrollIntoView = originalScroll;
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
    expect(scrolled).toEqual([]);
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
    await until(() => scrolled.length > 0, "scroll to the card");
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
    await until(() => scrolled.length > 0, "scroll to the row");
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
    await until(() => scrolled.length > 0, "scroll to the part");
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

  it("a section with learning objectives and a card without notes renders both", async () => {
    const cv = systemJson(CV);
    const mod = structuredClone(cv);
    const sec = antianginals(mod);
    const overview = need(mod.parts[need(sec.overview, "overview")], "overview part");
    const LO = "p_lo_fixture";
    sec.lo = LO;
    mod.parts[LO] = { title: "Learning objectives", role: "lo", file: overview.file, basePt: overview.basePt, blocks: overview.blocks };
    const bare = need(sec.cards[sec.cards.length - 1], "last card");
    need(mod.cards[bare], "bare card").blocks = [];
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
});
