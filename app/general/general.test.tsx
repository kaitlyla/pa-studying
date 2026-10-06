import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  asOwner,
  B,
  byText,
  click,
  D,
  G,
  go,
  installOwnerCss,
  publishedFixture,
  publishFixture,
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

/** Block `i` of the published Thyroid notes Word page. */
function thyroidBlock(i: number): { id: string } {
  const doc = record(files.get(`docs/${D(5)}.json`), "thyroid doc");
  if (!("blocks" in doc) || !Array.isArray(doc.blocks)) throw new Error("thyroid doc has no blocks");
  const b = record(doc.blocks[i], `thyroid block ${i}`);
  if (!("id" in b) || typeof b.id !== "string") throw new Error("block without id");
  return { ...b, id: b.id };
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
          id: "cbc", title: "CBC", group: null, intro: null, notes: [], gaps: [g1, g2, g3],
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

  it("shows her own notes above the sections: headings, whole blocks, and a table's column under its header", async () => {
    const sub = record(cbcSub(), "cbc");
    serveWith({
      [REF]: {
        ...record(files.get(REF), REF),
        subs: [{ ...sub, notes: [{ heading: "Thyroid labs" }, { block: thyroidBlock(0), basePt: 11, column: null, rows: null }, { block: thyroidBlock(1), basePt: 11, column: 1, rows: null }] }],
      },
    });
    const a = await renderApp("#/labs/cbc");
    app = a;
    const notes = await until(() => a.container.querySelector(".ref-page .place-notes"), "CBC notes");
    expect(notes.querySelector("h2.pn-h")?.textContent).toBe("Thyroid labs");
    const blocks = [...notes.querySelectorAll(".notes")];
    expect(blocks.map((b) => b.getAttribute("data-anchor"))).toEqual([thyroidBlock(0).id, thyroidBlock(1).id]);
    expect(at(blocks, 0).textContent).toContain("TSH first");
    // Column 1 of the table: its first-row text heads it; the rows after the first show their first cell and that column.
    expect(notes.querySelector("h3.pn-col")?.textContent).toBe("high");
    const column = at(blocks, 1);
    expect([...column.querySelectorAll("tr")].map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent))).toEqual([["T3", "low"]]);
    const section = a.container.querySelector(".ref-page .ref-sec");
    if (!section) throw new Error("no section");
    expect(before(notes, section)).toBe(true);
  });

  it("tells the owner a topic with no gaps is covered, without naming a guide", async () => {
    serveWith({ [REF]: { ...record(files.get(REF), REF), subs: [{ id: "cbc", title: "CBC", group: null, intro: null, notes: [], links: [], gaps: [] }] } });
    const a = await renderApp("#/labs/cbc");
    app = a;
    const covered = await until(() => a.container.querySelector(".ref-page .covered"), "covered note");
    expect(covered.textContent).toBe("Your notes and files cover this. Nothing was added.");
    expect(shown(covered)).toBe(false);
    asOwner(true);
    expect(shown(covered)).toBe(true);
  });

  it("lists grouped topics under their group's heading on the landing page and in the sidebar, and names the group in the crumbs", async () => {
    const cbc = record(cbcSub(), "cbc");
    serveWith({
      [REF]: {
        ...record(files.get(REF), REF),
        subs: [
          { ...cbc, group: "Blood" },
          { ...cbc, id: "bmp", title: "BMP", group: "Blood" },
          { ...cbc, id: "urine", title: "Urinalysis", group: null },
        ],
      },
    });
    const a = await renderApp("#/labs");
    app = a;
    const grp = await until(() => a.container.querySelector(".ref-page .ref-grp"), "grouped landing");
    expect(grp.querySelector("h2")?.textContent).toBe("Blood");
    expect([...grp.querySelectorAll(".lnk li a")].map((x) => x.textContent)).toEqual(["CBC", "BMP"]);
    expect([...a.container.querySelectorAll(".ref-page .lnk li a")].map((x) => x.textContent)).toEqual(["CBC", "BMP", "Urinalysis"]);
    const side = await until(() => a.container.querySelector(".side-in"), "ref sidebar");
    const heading = side.querySelector(".side-grp");
    expect(heading?.textContent).toBe("Blood");
    const bmp = byText(side, "a", "BMP");
    if (!heading || !bmp) throw new Error("no group heading or BMP entry");
    expect(before(heading, bmp)).toBe(true);
    expect(side.querySelectorAll(".side-grp")).toHaveLength(1);

    await click(bmp);
    await until(() => byText(a.container, ".ref-page h1", "BMP"), "BMP page");
    expect([...a.container.querySelectorAll(".ref-page .crumbs .crumb")].map((c) => c.lastElementChild?.textContent)).toEqual(["Labs", "Blood", "BMP"]);
  });

  describe("a topic with intro sections", () => {
    /** CBC with three sections; the first is its intro, the other two are findings (the third has a link). */
    function serveFindings(): void {
      const sub = record(cbcSub(), "cbc");
      if (!("gaps" in sub) || !Array.isArray(sub.gaps) || !("links" in sub) || !Array.isArray(sub.links)) throw new Error("cbc has no gaps or links");
      const g1 = record(sub.gaps[0], "gap");
      const first = { ...record(sub.links[0], "cbc link"), flagged: false };
      serveWith({
        [REF]: {
          ...record(files.get(REF), REF),
          subs: [{
            id: "cbc", title: "CBC", group: "Blood", intro: [G(1)], notes: [],
            gaps: [{ ...g1, id: G(902), title: "Second section" }, g1, { ...g1, id: G(903), title: "Third section" }],
            links: [{ ...first, covers: "Atrial flutter", gap: G(903) }],
          }],
        },
      });
    }

    it("shows the intro open first, then each other section closed under its title, with its links inside", async () => {
      serveFindings();
      const a = await renderApp("#/labs/cbc");
      app = a;
      const page = await until(() => a.container.querySelector(".ref-page .sec-index") && a.container.querySelector(".ref-page"), "CBC page");
      const secs = [...page.querySelectorAll(".ref-sec")];
      expect(secs.map((s) => s.querySelector("section.gap")?.getAttribute("data-anchor"))).toEqual([G(1), G(902), G(903)]);
      expect(at(secs, 0).tagName).toBe("DIV");
      expect(at(secs, 0).querySelector("h3")?.textContent).toBe("TSH in AF");
      const finds = [...page.querySelectorAll<HTMLDetailsElement>("details.ref-find")];
      expect(finds.map((d) => [d.querySelector("summary")?.textContent, d.open])).toEqual([["Second section", false], ["Third section", false]]);
      expect(finds.map((d) => d.querySelector("section.gap h3"))).toEqual([null, null]);
      expect(at(finds, 1).querySelector(".sec-links .lg-c")?.textContent).toBe("Atrial flutter");
      expect([...page.querySelectorAll(".sec-index button")].map((b) => b.textContent)).toEqual(["TSH in AF", "Second section", "Third section"]);
    });

    it("opens a closed section when the section index jumps to it, and scrolls to it", async () => {
      serveFindings();
      const scrolled: Element[] = [];
      const saved = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
      try {
        const a = await renderApp("#/labs/cbc");
        app = a;
        const page = await until(() => a.container.querySelector(".ref-page .sec-index") && a.container.querySelector(".ref-page"), "CBC page");
        await click(byText(page, ".sec-index button", "Third section"));
        const third = page.querySelector<HTMLDetailsElement>(`details.ref-find:has(section[data-anchor="${G(903)}"])`);
        expect(third?.open).toBe(true);
        expect(page.querySelector<HTMLDetailsElement>(`details.ref-find:has(section[data-anchor="${G(902)}"])`)?.open).toBe(false);
        expect(scrolled.some((e) => e.getAttribute("data-anchor") === G(903))).toBe(true);
      } finally {
        Element.prototype.scrollIntoView = saved;
      }
    });

    it("opens the section a link lands on", async () => {
      serveFindings();
      const a = await renderApp(`#/labs/cbc?at=${G(902)}`);
      app = a;
      const page = await until(() => a.container.querySelector(".ref-page .sec-index") && a.container.querySelector(".ref-page"), "CBC page");
      const finds = [...page.querySelectorAll<HTMLDetailsElement>("details.ref-find")];
      expect(finds.map((d) => d.open)).toEqual([true, false]);
      await go(`#/labs/cbc?at=${G(903)}`);
      await until(() => at(finds, 1).open, "third section opened");
      expect(at(finds, 0).open).toBe(true);
    });
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

  describe("a section with an outline", () => {
    // Physical exam's outline: a top heading with her Word doc whole and a sub heading holding one
    // table column, then a top heading with a PDF and a gap block (two named items: sub-entries).
    beforeEach(async () => {
      const fx = await publishFixture((content) => {
        const pe = content.other.sections.find((s) => s.id === "pe");
        if (!pe) throw new Error("no pe section");
        Object.assign(pe, {
          files: [D(5), D(1)],
          gaps: [G(1)],
          notes: [
            { heading: "Cardiac" },
            { doc: D(5) },
            { heading: "Murmurs", sub: true },
            { block: B(61), column: 1 },
            { heading: "Pulmonary" },
            { doc: D(1) },
            { gap: G(1) },
          ],
        });
      });
      server.restore();
      server = serveData(fx.published);
    });

    it("shows every part on the section page: her doc whole with an Open file link, headings, the PDF and the gap block", async () => {
      const a = await renderApp("#/other/pe");
      app = a;
      const page = await until(() => (a.container.querySelector(`.other-page .odoc[data-anchor="${D(5)}"] .notes`) ? a.container.querySelector(".other-page") : null), "pe outline");
      expect([...page.querySelectorAll(".opart-h")].map((h) => [h.tagName, h.textContent, h.getAttribute("data-anchor")])).toEqual([
        ["H2", "Cardiac", "cardiac"],
        ["H3", "Murmurs", "cardiac-murmurs"],
        ["H2", "Pulmonary", "pulmonary"],
      ]);
      const thyroid = page.querySelector(`.odoc[data-anchor="${D(5)}"]`);
      expect(thyroid?.querySelector("h3")?.textContent).toBe("Thyroid notes");
      expect(thyroid?.textContent).toContain("TSH first");
      expect(byText(thyroid ?? page, "a", "Open file")?.getAttribute("href")).toBe(`#/file/${D(5)}?from=${encodeURIComponent("#/other/pe")}`);
      expect(page.querySelector(`.odoc[data-anchor="${D(1)}"] h3`)?.textContent).toBe("ACLS algorithms");
      expect(page.querySelector(`section.gap[data-anchor="${G(1)}"]`)).not.toBeNull();
      // Every listed file and gap is in the outline: nothing is left over as chips.
      expect(page.querySelector(".fchip")).toBeNull();
      expect(page.querySelectorAll(".gsec")).toHaveLength(0);
    });

    it("lists the outline in the sidebar: sub headings and named items as sub-entries", async () => {
      const a = await renderApp("#/other/pe");
      app = a;
      const side = await until(() => a.container.querySelector<HTMLElement>(".side-in"), "other sidebar");
      // The current section is open to its top headings, each a group with its sub-entry count.
      const groups = [...side.querySelectorAll(".grp-row .sys-name")].map((l) => [l.querySelector(".ent-t")?.textContent, l.querySelector(".grp-n")?.textContent, l.getAttribute("href")]);
      expect(groups).toEqual([
        ["Cardiac", "1", "#/other/pe/cardiac"],
        ["Pulmonary", "2", "#/other/pe/pulmonary"],
      ]);
      expect(side.querySelector(".grp-ents")).toBeNull();
      for (const name of ["Cardiac", "Pulmonary"]) {
        const toggle = side.querySelector<HTMLElement>(`button[aria-label="Expand ${name}"]`);
        if (!toggle) throw new Error(`no ${name} toggle`);
        await click(toggle);
      }
      const gapTitle = side.querySelectorAll(".grp-ents a")[2]?.textContent ?? "";
      expect(gapTitle).not.toBe("");
      expect([...side.querySelectorAll(".grp-ents a")].map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
        ["Murmurs", "#/other/pe/cardiac-murmurs"],
        ["ACLS algorithms", `#/other/pe/pulmonary?at=${D(1)}`],
        [gapTitle, `#/other/pe/pulmonary?at=${G(1)}`],
      ]);
    });

    it("opens a top heading's part with its sub parts only, and a sub heading's part alone", async () => {
      const a = await renderApp("#/other/pe/cardiac");
      app = a;
      await until(() => a.container.querySelector(`.other-page .odoc[data-anchor="${D(5)}"] .notes`), "cardiac part");
      expect(a.container.querySelector(".other-page h1")?.textContent).toBe("Cardiac");
      expect([...a.container.querySelectorAll(".crumbs a")].map((c) => [c.textContent, c.getAttribute("href")])).toEqual([
        ["Other", "#/other"],
        ["Physical exam", "#/other/pe"],
      ]);
      expect([...a.container.querySelectorAll(".other-page .opart-h")].map((h) => h.textContent)).toEqual(["Murmurs"]);
      expect(a.container.querySelector(`.other-page .odoc[data-anchor="${D(1)}"]`)).toBeNull();

      await go("#/other/pe/cardiac-murmurs");
      await until(() => byText(a.container, ".other-page h1", "Murmurs"), "murmurs part");
      expect(a.container.querySelector(`.other-page .odoc[data-anchor="${D(5)}"]`)).toBeNull();
      const column = await until(() => a.container.querySelector(`.other-page [data-anchor="${B(61)}-c1"]`), "column item");
      // Column 1 alone: headed by its first-row text, then each later row's first cell and that column.
      expect(column.querySelector("h3.pn-col")?.textContent).toBe("high");
      expect(column.textContent).toContain("T3");
      expect(column.textContent).not.toContain("Free T4");
    });

    it("shows a block's listed rows under its first row, and none of the table's other rows", async () => {
      const fx = await publishFixture((content) => {
        const pe = content.other.sections.find((s) => s.id === "pe");
        if (!pe) throw new Error("no pe section");
        Object.assign(pe, { files: [D(5)], gaps: [], notes: [{ heading: "Cardiac" }, { block: B(61), rows: [R(600)] }, { heading: "Pulmonary" }, { block: B(61), rows: [R(601)] }] });
      });
      server.restore();
      server = serveData(fx.published);
      const a = await renderApp("#/other/pe/cardiac");
      app = a;
      const cardiac = await until(() => a.container.querySelector(`.other-page [data-anchor="${R(600)}"]`), "cardiac rows");
      expect(cardiac.textContent).toContain("Free T4");
      expect(a.container.querySelector(`.other-page [data-anchor="${R(601)}"]`)).toBeNull();
      expect(a.container.querySelector(".other-page")?.textContent).not.toContain("T3");

      await go("#/other/pe/pulmonary");
      await until(() => byText(a.container, ".other-page h1", "Pulmonary"), "pulmonary part");
      const rows = await until(() => (a.container.querySelector(`.other-page [data-anchor="${R(601)}"]`) ? a.container.querySelectorAll(".other-page tr") : null), "pulmonary rows");
      expect([...rows].map((r) => r.getAttribute("data-anchor"))).toEqual([R(600), R(601)]);
    });

    it("has no page for a part the outline does not have", async () => {
      const a = await renderApp("#/other/pe/nope");
      app = a;
      await until(() => byText(a.container, "h1", "This page isn't on the site"), "not-on-site page");
      expect(a.container.querySelector(".other-page")).toBeNull();
    });

    it("shows 'Coming soon.' for a sub heading with nothing under it, and not for a top heading whose items are in its sub parts", async () => {
      const fx = await publishFixture((content) => {
        const pe = content.other.sections.find((s) => s.id === "pe");
        if (!pe) throw new Error("no pe section");
        Object.assign(pe, { files: [D(5)], gaps: [], notes: [{ heading: "GI" }, { heading: "Exam", sub: true }, { doc: D(5) }, { heading: "Lab checklist", sub: true }] });
      });
      server.restore();
      server = serveData(fx.published);
      const a = await renderApp("#/other/pe/gi");
      app = a;
      await until(() => a.container.querySelector(`.other-page .odoc[data-anchor="${D(5)}"]`), "exam doc");
      expect(a.container.querySelector(".other-page h1")?.textContent).toBe("GI");
      const parts = [...a.container.querySelectorAll(".other-page .opart")];
      expect(parts.map((p) => [p.querySelector(".opart-h")?.textContent, p.querySelector(".osoon")?.textContent ?? null])).toEqual([
        ["Exam", null],
        ["Lab checklist", "Coming soon."],
      ]);
      expect(a.container.querySelectorAll(".other-page .osoon")).toHaveLength(1);

      await go("#/other/pe/gi-lab-checklist");
      await until(() => byText(a.container, ".other-page h1", "Lab checklist"), "lab checklist part");
      expect(a.container.querySelector(".other-page .osoon")?.textContent).toBe("Coming soon.");
    });
  });

  it("shows an original item as one small link to its File page, not the file itself and not as a leftover chip", async () => {
    const fx = await publishFixture((content) => {
      const pe = content.other.sections.find((s) => s.id === "pe");
      if (!pe) throw new Error("no pe section");
      Object.assign(pe, { files: [D(5), D(1)], gaps: [], notes: [{ heading: "Cardiac" }, { doc: D(5) }, { original: D(1) }] });
    });
    server.restore();
    server = serveData(fx.published);
    const a = await renderApp("#/other/pe/cardiac");
    app = a;
    const line = await until(() => a.container.querySelector<HTMLElement>(`.other-page .oorig[data-anchor="${D(1)}"]`), "original link");
    expect(visibleText(line)).toBe("Original PDF: ACLS algorithms");
    expect(line.querySelector("a")?.getAttribute("href")).toBe(`#/file/${D(1)}?from=${encodeURIComponent("#/other/pe/cardiac")}`);
    expect(a.container.querySelector(`.other-page .odoc[data-anchor="${D(1)}"]`)).toBeNull();
    expect(a.container.querySelector(".other-page .fchip")).toBeNull();
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
