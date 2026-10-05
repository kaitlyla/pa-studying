import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  asOwner,
  byText,
  click,
  D,
  G,
  go,
  installOwnerCss,
  publishedFixture,
  R,
  renderApp,
  serveData,
  shown,
  until,
  visibleText,
  type DataServer,
  type Mounted,
} from "../testing.tsx";

const LABS = "g/fm/general/labs.json";
const REF = "ref/labs.json";
const NOT_FROM = "Not from your notes";
const NOTHING = "Nothing was added.";

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
  app?.unmount();
  app = null;
  server.restore();
  asOwner(false);
});

interface LinkData {
  target: string;
  route: string;
  title: string;
  loc: string;
}

/** `list[i]`, failing the test when it is missing. */
function at<T>(list: ArrayLike<T>, i: number): T {
  const v = list[i];
  if (v === undefined) throw new Error(`nothing at index ${i} (length ${list.length})`);
  return v;
}

function record(v: unknown, what: string): object {
  if (typeof v !== "object" || v === null) throw new Error(`${what} is not an object`);
  return v;
}

/** The published `links` of `holder` (a general topic or a reference sub). */
function linksOf(holder: unknown, what: string): LinkData[] {
  const h = record(holder, what);
  if (!("links" in h) || !Array.isArray(h.links)) throw new Error(`${what} has no links`);
  return h.links.map((l: unknown) => {
    if (
      typeof l === "object" && l !== null &&
      "target" in l && typeof l.target === "string" &&
      "route" in l && typeof l.route === "string" &&
      "title" in l && typeof l.title === "string" &&
      "loc" in l && typeof l.loc === "string"
    ) {
      return { target: l.target, route: l.route, title: l.title, loc: l.loc };
    }
    throw new Error(`${what} has a malformed link`);
  });
}

function firstRawLink(path: string): object {
  const v = record(files.get(path), path);
  if (!("links" in v) || !Array.isArray(v.links)) throw new Error(`${path} has no links`);
  return record(v.links[0], `${path} link`);
}

function cbcSub(): unknown {
  const ref = record(files.get(REF), REF);
  if (!("subs" in ref) || !Array.isArray(ref.subs)) throw new Error(`${REF} has no subs`);
  return ref.subs[0];
}

function flagCount(): number {
  const u = record(files.get("updates.json"), "updates.json");
  if (!("flags" in u) || !Array.isArray(u.flags)) throw new Error("updates.json has no flags");
  return u.flags.length;
}

/** Serves `files` with some paths replaced. */
function serveWith(changes: Record<string, unknown>): void {
  server.restore();
  const changed = new Map(files);
  for (const [k, v] of Object.entries(changes)) changed.set(k, v);
  server = serveData(changed);
}

function mainOf(m: Mounted): HTMLElement {
  const main = m.container.querySelector("main");
  if (!main) throw new Error("no <main>");
  return main;
}

function before(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

async function openGeneralLabs(): Promise<Mounted> {
  const a = await renderApp("#/eor/fm/general/labs");
  app = a;
  await until(() => byText(a.container, "h1", "Labs for Family Medicine") && a.container.querySelector(".general-page .gap"), "general labs page");
  return a;
}

describe("general topic page", () => {
  it("renders her links, then her files, then the gap part, and the link opens its published route", async () => {
    const a = await openGeneralLabs();
    const page = a.container.querySelector(".general-page");
    if (!page) throw new Error("no general page");
    const parts = page.querySelectorAll(".gsec");
    expect(parts).toHaveLength(3);
    const notes = at(parts, 0);
    const own = at(parts, 1);
    const gaps = at(parts, 2);

    expect(notes.querySelector("h2")?.textContent).toContain("In the notes");
    expect(own.querySelector("h2")?.textContent).toContain("Files");
    expect(own.querySelector(".fchip")?.textContent).toContain("Thyroid notes");
    expect(gaps.querySelector("h2.own-only")?.textContent).toBe("Not covered by your notes");
    expect(gaps.querySelector('section.gap[aria-label="TSH in AF"]')).not.toBeNull();
    expect(before(notes, own) && before(own, gaps)).toBe(true);

    const published = linksOf(files.get(LABS), LABS);
    expect(published.map((l) => l.target)).toEqual([R(101)]);
    const af = at(published, 0);
    const items = notes.querySelectorAll(".lnk li");
    expect(items).toHaveLength(1);
    expect(notes.querySelector("h2 .n")?.textContent).toBe("1");
    const link = at(items, 0).querySelector("a");
    if (!link) throw new Error("no link");
    expect(link.querySelector(".lt")?.textContent).toBe(af.title);
    expect(af.title).toContain("Atrial fibrillation");
    expect(link.querySelector(".ll")?.textContent).toBe(`${af.loc} — AF labs`);
    expect(link.getAttribute("href")).toBe(af.route);

    await click(link);
    expect(location.hash).toBe(af.route);
  });

  it("shows the gap block's title, relevance, sentences and numbered sources; its chip is owner-only", async () => {
    const a = await openGeneralLabs();
    const gap = a.container.querySelector<HTMLElement>(`.general-page section.gap[data-anchor="${G(1)}"]`);
    if (!gap) throw new Error("no gap block");
    expect(gap.querySelector("h3")?.textContent).toBe("TSH in AF");
    expect(gap.querySelector(".gap-meta")?.textContent).toContain("Relevant to: Atrial fibrillation");
    const body = gap.querySelector(".gap-body")?.textContent ?? "";
    expect(body).toContain("Check TSH.");
    expect(body).toContain("Repeat in 6 weeks.");
    const sources = gap.querySelectorAll(".gap-src ol > li");
    expect(sources).toHaveLength(1);
    const source = at(sources, 0);
    expect(source.textContent).toContain("AHA/ACC AF guideline. American Heart Association. 2023.");
    expect(source.querySelector("a")?.getAttribute("href")).toBe("https://www.ahajournals.org/x");

    const chip = gap.querySelector(".gap-h .gapc");
    expect(chip?.textContent).toContain(NOT_FROM);
    expect(shown(chip)).toBe(false);
    expect(visibleText(gap)).not.toContain(NOT_FROM);

    asOwner(true);
    expect(shown(chip)).toBe(true);
    expect(visibleText(gap)).toContain(NOT_FROM);
  });

  it("shows a visitor no 'Not from your notes' wording anywhere", async () => {
    const a = await openGeneralLabs();
    expect(a.container.textContent).toContain(NOT_FROM);
    expect(visibleText(a.container)).not.toContain(NOT_FROM);
    expect(visibleText(a.container)).not.toContain("Not covered by your notes");
  });

  it("speaks to the owner in the part headings", async () => {
    const a = await openGeneralLabs();
    const heads = [...a.container.querySelectorAll(".general-page .gsec h2")];
    expect(heads.map((h) => visibleText(h))).toEqual(["In the notes 1", "Files 1", ""]);
    asOwner(true);
    expect(heads.map((h) => visibleText(h))).toEqual(["In your notes 1", "Your files 1", "Not covered by your notes"]);
  });

  it("does not list a removed or still-processing file as a file chip", async () => {
    const a = await openGeneralLabs();
    const chips = [...a.container.querySelectorAll(".general-page .fchip")];
    expect(chips.map((c) => c.textContent)).toEqual(["DOCThyroid notes"]);
    expect(at(chips, 0).getAttribute("href")).toBe(`#/file/${D(5)}?from=${encodeURIComponent("#/eor/fm/general/labs")}`);
    expect(byText(a.container, ".fchip", "Old handout")).toBeNull();
    expect(visibleText(a.container)).not.toContain("Old handout");
    expect(visibleText(a.container)).not.toContain("New upload");
  });

  it("puts the how-to pointer above part 1 and marks flagged links", async () => {
    const first = firstRawLink(LABS);
    serveWith({
      [LABS]: {
        ...record(files.get(LABS), LABS),
        howto: "labs",
        links: [{ ...first, flagged: true }, { ...first, target: "r_0000009998", covers: "", flagged: false }],
      },
    });
    const a = await openGeneralLabs();
    const howto = await until(() => a.container.querySelector(".general-page .howto"), "how-to pointer");
    expect(howto.textContent).toBe("Only what Family Medicine needs is shown here. Full how-to: Labs tab › how to interpret");
    expect(howto.querySelector("a")?.getAttribute("href")).toBe("#/labs");
    const part1 = a.container.querySelector(".general-page .gsec");
    if (!part1) throw new Error("no part 1");
    expect(before(howto, part1)).toBe(true);

    const items = part1.querySelectorAll(".lnk li");
    expect(items).toHaveLength(2);
    expect(at(items, 0).querySelector(".updc")?.textContent).toContain("Updated guideline");
    expect(at(items, 1).querySelector(".updc")).toBeNull();
    const loc = at(linksOf(files.get(LABS), LABS), 0).loc;
    expect(at(items, 1).querySelector(".ll")?.textContent).toBe(loc);
  });

  it("points the how-to at the reference tab's how-to topic when it has one", async () => {
    serveWith({
      [LABS]: { ...record(files.get(LABS), LABS), howto: "labs" },
      [REF]: { ...record(files.get(REF), REF), subs: [{ id: "interp", title: "How to interpret labs", links: [], gaps: [] }] },
    });
    const a = await openGeneralLabs();
    const howto = await until(() => a.container.querySelector(".general-page .howto"), "how-to pointer");
    expect(howto.querySelector("a")?.getAttribute("href")).toBe("#/labs/interp");
  });
});

describe("initial workup", () => {
  it("lists presentations and opens one to show only its gap block", async () => {
    const a = await renderApp("#/eor/fm/workup");
    app = a;
    await until(() => byText(a.container, ".workup-page .lnk li", "Altered mental status"), "workup list");
    const main = mainOf(a);
    expect(byText(main, "h1", "Initial workup of common presentations")?.textContent).toBe("Initial workup of common presentations for Family Medicine");
    expect(main.querySelector(".wk-lead")?.textContent).toBe("What to order when a patient presents with…");
    const items = main.querySelectorAll(".workup-page .lnk li");
    expect(items).toHaveLength(1);
    const item = at(items, 0);
    expect(item.querySelector(".lt")?.textContent).toBe("Altered mental status");
    expect(item.querySelector(".ll")?.textContent).toBe("Can point to: Delirium");
    expect(shown(item.querySelector(".gapc"))).toBe(false);
    expect(main.querySelector(".workup-page .gap")).toBeNull();
    const open = item.querySelector("a");
    expect(open?.getAttribute("href")).toBe("#/eor/fm/workup/ams");

    await click(open);
    expect(location.hash).toBe("#/eor/fm/workup/ams");
    await until(() => main.querySelector(".workup-page .wk-h"), "workup item");
    expect(main.querySelector(".wk-h")?.textContent).toBe("Altered mental status");
    const gaps = main.querySelectorAll(".workup-page section.gap");
    expect(gaps).toHaveLength(1);
    expect(at(gaps, 0).getAttribute("aria-label")).toBe("AMS workup");
    expect(at(gaps, 0).getAttribute("data-anchor")).toBe(G(2));
    expect(main.querySelector(".workup-page .gsec")).toBeNull();
    expect(main.querySelector(".workup-page .lnk")).toBeNull();
    expect(main.textContent).not.toContain("TSH in AF");
    expect(byText(main, ".crumbs a", "Initial workup")?.getAttribute("href")).toBe("#/eor/fm/workup");

    const back = main.querySelector(".wk-back");
    expect(back?.textContent).toBe("‹ All presentations");
    expect(back?.getAttribute("href")).toBe("#/eor/fm/workup");
    await click(back);
    expect(location.hash).toBe("#/eor/fm/workup");
    await until(() => main.querySelector(".workup-page .lnk"), "workup list again");
  });

  it("renders the workup list for the general/workup key too", async () => {
    const a = await renderApp("#/eor/fm/general/workup");
    app = a;
    const li = await until(() => byText(a.container, ".workup-page .lnk li", "Altered mental status"), "workup list");
    expect(li.querySelector("a")?.getAttribute("href")).toBe("#/eor/fm/workup/ams");
  });
});

describe("reference tab", () => {
  it("lands on a list of the tab's topics and files, with the sidebar", async () => {
    const a = await renderApp("#/labs");
    app = a;
    await until(() => byText(a.container, ".ref-page .lnk li", "CBC"), "labs landing");
    const main = mainOf(a);
    expect(main.querySelector(".ref-page h1")?.textContent).toBe("Labs");
    expect(visibleText(main.querySelector(".ref-page .lead") ?? main)).toBe("Across every rotation and PANCE.");
    const subs = main.querySelectorAll(".ref-page .lnk li a");
    expect([...subs].map((s) => s.textContent)).toEqual(["CBC"]);
    expect(at(subs, 0).getAttribute("href")).toBe("#/labs/cbc");
    expect(visibleText(main.querySelector(".ref-page .gsec h2") ?? main)).toBe("Files");
    expect(byText(main, ".ref-page .fchip", "Thyroid notes")).not.toBeNull();

    const side = await until(() => a.container.querySelector(".side-in"), "ref sidebar");
    expect(side.querySelector(".gname")?.textContent).toBe("Labs");
    expect(byText(side, "a", "CBC")?.getAttribute("href")).toBe("#/labs/cbc");
    const fileRoute = `#/file/${D(5)}?from=${encodeURIComponent("#/labs")}`;
    const sideFile = byText(side, "a", "Thyroid notes");
    expect(sideFile?.getAttribute("href")).toBe(fileRoute);
    expect(side.querySelector("a.open")).toBeNull();

    await click(sideFile);
    expect(location.hash).toBe(fileRoute);
    const openFile = await until(() => a.container.querySelector(".side-in a.open"), "open sidebar file");
    expect(openFile.textContent).toBe("Thyroid notes");
    expect(openFile.getAttribute("aria-current")).toBe("page");
  });

  it("shows a topic's sections first, then the links that belong to no section", async () => {
    const a = await renderApp("#/labs/cbc");
    app = a;
    await until(() => byText(a.container, ".ref-page h1", "CBC") && a.container.querySelector(".ref-page .gap"), "CBC page");
    const page = a.container.querySelector(".ref-page");
    if (!page) throw new Error("no ref page");
    expect(page.querySelector(".crumbs a")?.getAttribute("href")).toBe("#/labs");
    const section = page.querySelector(`.ref-sec section.gap[data-anchor="${G(1)}"]`);
    expect(section?.querySelector("h3")?.textContent).toBe("TSH in AF");
    expect(page.querySelector(".ref-sec .sec-links")).toBeNull();
    const rest = page.querySelector(".sec-rest");
    if (!section || !rest) throw new Error("no section or no rest");
    expect(before(section, rest)).toBe(true);
    expect(visibleText(rest.querySelector("h2") ?? rest)).toBe("Also in the notes");
    const published = linksOf(cbcSub(), "cbc");
    expect(published.map((l) => l.target)).toEqual([R(201)]);
    const asthma = at(published, 0);
    expect(asthma.title).toContain("Asthma");
    const link = rest.querySelector(".lgroups li a");
    expect(link?.textContent).toBe(asthma.loc);
    expect(link?.getAttribute("title")).toBe(asthma.title);
    expect(link?.getAttribute("href")).toBe(asthma.route);
    expect(page.querySelector(".sec-index")).toBeNull();
    expect(page.querySelector(".fchip")).toBeNull();
    asOwner(true);
    expect(visibleText(rest.querySelector("h2") ?? rest)).toBe("Also in your notes");
    expect(a.container.textContent).not.toContain("Your notes and files cover this.");
    expect(visibleText(page)).not.toContain(NOTHING);

    const current = a.container.querySelector(".side-in a.open");
    expect(current?.textContent).toBe("CBC");
    expect(current?.getAttribute("aria-current")).toBe("page");
  });

  it("lists a section's own links under it, one line per covers text, and indexes the sections", async () => {
    const sub = record(cbcSub(), "cbc");
    if (!("gaps" in sub) || !Array.isArray(sub.gaps) || !("links" in sub) || !Array.isArray(sub.links)) throw new Error("cbc has no gaps or links");
    const g1 = record(sub.gaps[0], "gap");
    const raw = linksOf(cbcSub(), "cbc");
    const first = { ...record(sub.links[0], "cbc link"), flagged: false };
    const g2 = { ...g1, id: G(902), title: "Second section" };
    const g3 = { ...g1, id: G(903), title: "Third section" };
    const loc = at(raw, 0).loc;
    serveWith({
      [REF]: {
        ...record(files.get(REF), REF),
        subs: [{
          id: "cbc", title: "CBC", gaps: [g1, g2, g3],
          links: [
            { ...first, covers: "Atrial flutter", gap: G(902) },
            { ...first, target: R(902), title: "Flutter (IM)", covers: "Atrial flutter", gap: G(902), flagged: true },
            { ...first, target: R(903), covers: "Loose link" },
          ],
        }],
      },
    });
    const scrolled: Element[] = [];
    const saved = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    try {
      const a = await renderApp("#/labs/cbc");
      app = a;
      const page = await until(() => a.container.querySelector(".ref-page .sec-index") && a.container.querySelector(".ref-page"), "CBC sections");
      const secs = [...page.querySelectorAll(".ref-sec")];
      expect(secs.map((s) => s.querySelector("h3")?.textContent)).toEqual(["TSH in AF", "Second section", "Third section"]);
      expect(at(secs, 0).querySelector(".sec-links")).toBeNull();
      const own = at(secs, 1).querySelector(".sec-links");
      if (!own) throw new Error("no section links");
      expect(visibleText(own.querySelector(".sl-h") ?? own)).toBe("In the notes");
      const lines = own.querySelectorAll(".lgroups li");
      expect(lines).toHaveLength(1);
      const line = at(lines, 0);
      expect(line.querySelector(".lg-c")?.textContent).toBe("Atrial flutter");
      // Both links share one place, so each names its topic too.
      expect([...line.querySelectorAll("a")].map((x) => x.textContent)).toEqual([`${loc} › ${at(raw, 0).title}`, `${loc} › Flutter (IM)`]);
      expect(line.querySelectorAll(".updc")).toHaveLength(1);
      const rest = page.querySelector(".sec-rest");
      expect(rest?.querySelectorAll(".lgroups li")).toHaveLength(1);
      expect(rest?.querySelector(".lg-c")?.textContent).toBe("Loose link");

      const jump = byText(page, ".sec-index button", "Third section");
      await click(jump);
      expect(scrolled.some((e) => e.getAttribute("data-anchor") === G(903))).toBe(true);
      asOwner(true);
      expect(visibleText(own.querySelector(".sl-h") ?? own)).toBe("In your notes");
    } finally {
      Element.prototype.scrollIntoView = saved;
    }
  });

  it("tells the owner a topic with no gaps is covered, without naming a guide", async () => {
    serveWith({ [REF]: { ...record(files.get(REF), REF), subs: [{ id: "cbc", title: "CBC", links: [], gaps: [] }] } });
    const a = await renderApp("#/labs/cbc");
    app = a;
    const covered = await until(() => a.container.querySelector(".ref-page .covered"), "covered note");
    expect(covered.textContent).toBe("Your notes and files cover this. Nothing was added.");
    expect(shown(covered)).toBe(false);
    asOwner(true);
    expect(shown(covered)).toBe(true);
  });
});

describe("Other tab", () => {
  it("shows the nine section cards with file counts", async () => {
    const a = await renderApp("#/other");
    app = a;
    await until(() => a.container.querySelectorAll(".ogrid .ocard").length > 0, "other grid");
    const cards = [...a.container.querySelectorAll(".ogrid .ocard")];
    expect(cards.map((c) => c.querySelector("b")?.textContent)).toEqual([
      "Emergency", "Vaccines", "Guidelines", "Screenings", "Legal", "PA profession", "Vitamins", "Physical exam", "Notes",
    ]);
    expect(at(cards, 1).getAttribute("href")).toBe("#/other/vaccines");
    const guidelines = at(cards, 2).querySelector("small");
    if (!guidelines) throw new Error("no guidelines count");
    expect(visibleText(guidelines)).toBe("1 file · updated guidelines");
    expect(visibleText(at(cards, 0).querySelector("small") ?? at(cards, 0))).toBe("Sourced reference");
    expect(visibleText(at(cards, 8).querySelector("small") ?? at(cards, 8))).toBe("Sourced reference");
    asOwner(true);
    expect(visibleText(guidelines)).toBe("1 of your files · updated guidelines");
  });

  it("puts the Vaccines lead block above part 1", async () => {
    const a = await renderApp("#/other/vaccines");
    app = a;
    const lead = await until(() => a.container.querySelector(`.other-page section.gap[data-anchor="${G(3)}"]`), "vaccines lead");
    expect(lead.querySelector("h3")?.textContent).toBe("Vaccine schedule");
    const part1 = a.container.querySelector(".other-page .gsec");
    if (!part1) throw new Error("no part 1");
    expect(visibleText(part1.querySelector("h2") ?? part1)).toBe("In the notes 0");
    expect(before(lead, part1)).toBe(true);
    expect(a.container.querySelectorAll(".other-page .gsec")).toHaveLength(1);
    expect(byText(a.container, ".crumbs a", "Other")?.getAttribute("href")).toBe("#/other");
  });

  it("shows 'Nothing was added' only to the owner, only where nothing was added", async () => {
    let a = await renderApp("#/other/screenings");
    app = a;
    const screenings = await until(() => a.container.querySelector(".other-page .covered"), "screenings covered note");
    expect(screenings.textContent).toBe("Your notes and files cover this topic for Screenings. Nothing was added.");
    expect(visibleText(a.container)).not.toContain(NOTHING);
    asOwner(true);
    expect(visibleText(a.container)).toContain(`Your notes and files cover this topic for Screenings. ${NOTHING}`);

    await go("#/other/legal");
    const legal = await until(() => byText(a.container, ".other-page .covered", "Legal"), "legal covered note");
    expect(visibleText(legal)).toBe("Your notes and files cover this topic for Legal. Nothing was added.");

    await go("#/other/vaccines");
    await until(() => byText(a.container, ".other-page h1", "Vaccines") && a.container.querySelector(".other-page .gap"), "vaccines");
    expect(a.container.textContent).not.toContain(NOTHING);

    a.unmount();
    app = null;
    a = await openGeneralLabs();
    expect(a.container.textContent).not.toContain(NOTHING);
  });

  it("points Guidelines to Updated guidelines and lists its file", async () => {
    const a = await renderApp("#/other/guidelines");
    app = a;
    const entry = await until(() => a.container.querySelector('.other-page [data-ref="updates-entry"]'), "updates entry");
    const n = flagCount();
    expect(visibleText(entry)).toBe(`Updated guideline Updated guidelines — ${n} ${n === 1 ? "flag" : "flags"} · last checked October 1, 2026`);
    expect(byText(entry, "a", "Updated guidelines")?.getAttribute("href")).toBe("#/other/guidelines/updates");
    const chip = byText(a.container, ".other-page .fchip", "ACLS algorithms");
    expect(chip?.getAttribute("href")).toBe(`#/file/${D(1)}?from=${encodeURIComponent("#/other/guidelines")}`);
    expect(visibleText(at(a.container.querySelectorAll(".other-page .gsec h2"), 1))).toBe("Files 1");
  });

  it("lists no file chip for a section whose only file was removed", async () => {
    const a = await renderApp("#/other/notes");
    app = a;
    await until(() => byText(a.container, ".other-page h1", "Notes"), "notes section");
    expect(a.container.querySelector(".other-page .fchip")).toBeNull();
    expect(a.container.textContent).not.toContain("Old handout");
    const heads = [...a.container.querySelectorAll(".other-page .gsec h2")];
    expect(heads.map((h) => visibleText(h))).toEqual(["In the notes 0"]);
  });
});

describe("unknown pages", () => {
  it.each(["#/eor/fm/workup/nope", "#/labs/nope", "#/other/nope"])("%s is not on the site", async (hash) => {
    const a = await renderApp(hash);
    app = a;
    const h = await until(() => byText(a.container, "h1", "This page isn't on the site"), "not-on-site page");
    expect(h.textContent).toBe("This page isn't on the site");
    expect(a.container.querySelector(".workup-page, .ref-page, .other-page")).toBeNull();
  });
});
