// The Updated guidelines list and source status (80 §80.4–80.5), the Other › Guidelines entry line,
// and update notes placed beside their targets, rendered from the fixture's real published data.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import type { UpdatesJson } from "../../lib/derive/published.ts";
import {
  asOwner,
  byText,
  click,
  installOwnerCss,
  publishedFixture,
  publishFixture,
  R,
  renderApp,
  serveData,
  U,
  until,
  visibleText,
  type DataServer,
  type Mounted,
} from "../testing.tsx";
import { FIXED_SOURCES } from "./UpdatesPage.tsx";

const UPDATES = "#/other/guidelines/updates";
const TOPIC_101 = `#/eor/fm/t/${R(101)}`;

function isUpdates(v: unknown): v is UpdatesJson {
  return typeof v === "object" && v !== null && "flags" in v && Array.isArray(v.flags) && "sources" in v && Array.isArray(v.sources) && "series" in v;
}

function updatesOf(files: Map<string, unknown>): UpdatesJson {
  const u = files.get("updates.json");
  if (!isUpdates(u)) throw new Error("fixture has no updates.json");
  return u;
}

/** `files` with updates.json replaced by `change` applied to a copy of it. */
function withUpdates(files: Map<string, unknown>, change: (u: UpdatesJson) => void): Map<string, unknown> {
  const u = structuredClone(updatesOf(files));
  change(u);
  const out = new Map(files);
  out.set("updates.json", u);
  return out;
}

/** The fixture published with one more check-made `rec` flag whose subject no concept lists. */
async function fixtureWithUnmatchedFlag(): Promise<Map<string, unknown>> {
  const fx = await publishFixture((content) => {
    const base = content.flags.flags.find((f) => f.id === U(1));
    if (!base) throw new Error("fixture has no U(1)");
    content.flags.flags.push({ ...base, id: U(6), key: "k9", subject: "k9", guideline: "Guideline 6", quote: "Quote 6", published: "2024-02" });
  });
  return fx.published;
}

const entries = (root: Element): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(".updates-page .upd-entry")];
const entryFor = (root: Element, guideline: string): HTMLElement => {
  const e = entries(root).find((x) => byText(x, ".ut", guideline) !== null);
  if (!e) throw new Error(`no entry for ${guideline}`);
  return e;
};
const statusRows = (root: Element): HTMLTableRowElement[] => [...root.querySelectorAll<HTMLTableRowElement>("table.ustat tr")];
const rowNamed = (root: Element, name: string): HTMLTableRowElement => {
  const r = statusRows(root).find((x) => x.cells[0]?.textContent === name);
  if (!r) throw new Error(`no source row ${name}`);
  return r;
};

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

function serve(f: Map<string, unknown>): void {
  server.restore();
  server = serveData(f);
}

async function openUpdates(): Promise<Mounted> {
  app = await renderApp(UPDATES);
  const mounted = app;
  await until(() => mounted.container.querySelector(".updates-page table.ustat"), "the updates page");
  return mounted;
}

async function openTopic101(): Promise<Mounted> {
  app = await renderApp(TOPIC_101);
  const mounted = app;
  await until(() => mounted.container.querySelector(`section.tcard table`), "the R(101) topic table");
  return mounted;
}

describe("Updated guidelines page", () => {
  it("shows the last and next check dates in long form", async () => {
    const { container } = await openUpdates();
    const lead = container.querySelector(".updates-page p.lead");
    expect(lead).not.toBeNull();
    if (!lead) return;
    expect(visibleText(lead)).toBe("Checked once a month against the tracked sources. Last check: October 1, 2026 · next: November 1, 2026. Newest first.");
    expect(lead.querySelector("b")?.textContent).toBe("October 1, 2026");
    expect(container.querySelector(".updates-page h1")?.textContent).toContain("Updated guidelines");
  });

  it("says 'not yet' and omits the next date when no check has run", async () => {
    serve(withUpdates(files, (u) => {
      u.lastRun = null;
      u.nextRun = null;
    }));
    const { container } = await openUpdates();
    const lead = container.querySelector(".updates-page p.lead");
    if (!lead) throw new Error("no lead");
    expect(visibleText(lead)).toBe("Checked once a month against the tracked sources. Last check: not yet. Newest first.");
    expect(visibleText(lead)).not.toContain("next:");
  });

  it("lists flags newest first as full notes whose Added to links go to their targets", async () => {
    const { container } = await openUpdates();
    const order = entries(container).map((e) => e.querySelector(".ut")?.textContent ?? "");
    // published desc: U2 2025-01; U3 and U1 tie at 2024-04 (U3 flagged later); U5 2023-05; U4 2019-01.
    expect(order.map((t) => t.replace(/^New edition published$/, ""))).toEqual(["Guideline 2", "", "Guideline 1", "Guideline 5", "Guideline 4"]);
    expect(entries(container).map((e) => e.querySelector("aside")?.getAttribute("data-anchor"))).toEqual([U(2), U(3), U(1), U(5), U(4)]);
    expect(updatesOf(files).flags.map((f) => f.id)).toEqual([U(2), U(3), U(1), U(5), U(4)]);

    const one = entryFor(container, "Guideline 1");
    const note = one.querySelector('aside[aria-label="Updated guideline"]');
    if (!note) throw new Error("U(1) is not a full note");
    expect(note.querySelector(".lab-chip.updc")?.textContent).toBe("Updated guideline");
    expect(visibleText(note)).toContain("GOLD · Published Apr 2024 · Flagged Oct 1, 2026");
    expect(note.querySelector("blockquote")?.textContent).toBe("“Quote 1”");
    const read = byText<HTMLAnchorElement>(note, "a", "Read the guideline");
    expect(read?.getAttribute("href")).toBe("https://goldcopd.org/x");

    const added = one.querySelector(".added");
    if (!added) throw new Error("U(1) has no Added to list");
    expect(added.textContent).toMatch(/^Added to:/);
    const expected = updatesOf(files).flags.find((f) => f.id === U(1))?.addedTo ?? [];
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.map((p) => p.route)).toContain(TOPIC_101);
    const links = [...added.querySelectorAll<HTMLAnchorElement>("li a")];
    expect(links.map((a) => [a.getAttribute("href"), a.textContent])).toEqual(expected.map((p) => [p.route, p.loc]));

    const toTopic = links.find((a) => a.getAttribute("href") === TOPIC_101);
    await click(toTopic);
    expect(location.hash).toBe(TOPIC_101);
    await until(() => container.querySelector(`section.tcard`), "the topic page after clicking Added to");
  });

  it("keeps superseded and failed-verification flags in the list but never places them", async () => {
    const { container } = await openUpdates();
    const superseded = entryFor(container, "Guideline 4");
    expect(superseded.querySelector("blockquote")?.textContent).toBe("“Quote 4”");
    expect(superseded.querySelector(".added")).toBeNull();
    expect(visibleText(superseded)).not.toContain("Added to:");
    const failed = entryFor(container, "Guideline 2");
    expect(failed.querySelector(".added")).toBeNull();
    expect(visibleText(failed)).not.toContain("Added to:");
    app?.unmount();
    app = null;

    const topic = await openTopic101();
    const notes = [...topic.container.querySelectorAll('section.tcard aside[aria-label="Updated guideline"]')];
    expect(notes.map((n) => n.getAttribute("data-anchor"))).toEqual([U(1)]);
    expect(visibleText(topic.container)).not.toContain("Guideline 4");
    expect(visibleText(topic.container)).not.toContain("Guideline 2");
  });

  it("shows an edition flag as New edition published with its date and link, no quote and no Added to", async () => {
    const { container } = await openUpdates();
    const edition = entries(container).find((e) => e.querySelector(`aside[data-anchor="${U(3)}"]`));
    if (!edition) throw new Error("no edition entry");
    const aside = edition.querySelector('aside[aria-label="New edition published"]');
    if (!aside) throw new Error("edition entry is not an edition note");
    expect(aside.querySelector(".lab-chip.updc")?.textContent).toBe("Updated guideline");
    expect(visibleText(aside)).toBe("Updated guideline New edition published Guideline 3 GOLD · Detected Oct 2, 2026 Open the guideline");
    const link = byText<HTMLAnchorElement>(aside, "a", "Open the guideline");
    expect(link?.getAttribute("href")).toBe("https://goldcopd.org/x");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(edition.querySelector("blockquote")).toBeNull();
    expect(visibleText(edition)).not.toContain("Quote 3");
    expect(edition.querySelector(".added")).toBeNull();
    expect(visibleText(edition)).not.toContain("Added to:");
    expect(edition.querySelector('aside[aria-label="Updated guideline"]')).toBeNull();
  });

  it("shows no link for an edition flag without a web URL", async () => {
    serve(withUpdates(files, (u) => {
      const e = u.flags.find((f) => f.id === U(3));
      if (e) e.url = "goldcopd.org/x";
    }));
    const { container } = await openUpdates();
    const aside = container.querySelector(`aside[aria-label="New edition published"][data-anchor="${U(3)}"]`);
    if (!aside) throw new Error("no edition note");
    expect(visibleText(aside)).toContain("Detected Oct 2, 2026");
    expect(aside.querySelector("a")).toBeNull();
  });

  it("lists sources checked in the fixed order, then cited series, with each status", async () => {
    serve(withUpdates(files, (u) => {
      u.sources = [
        { id: "gold", status: "ok", lastSuccess: "2026-10-01", lastAttempt: "2026-10-01" },
        { id: "ada", status: "fail", lastSuccess: "2026-09-01", lastAttempt: "2026-10-01" },
        { id: "cpr", status: "fail", lastSuccess: null, lastAttempt: "2026-10-01" },
        ...u.series.map((s) => ({ id: s.id, status: "ok" as const, lastSuccess: "2026-09-15", lastAttempt: "2026-10-01" })),
      ];
    }));
    const { container } = await openUpdates();
    const series = updatesOf(files).series;
    expect(series.map((s) => s.label)).toEqual(["ACC/AHA atrial fibrillation guideline"]);
    expect(statusRows(container).map((r) => r.cells[0]?.textContent)).toEqual([
      "USPSTF recommendations",
      "AHA CPR & ECC (ACLS) guidelines",
      "ACC/AHA/HFSA heart failure guideline",
      "ADA Standards of Care in Diabetes",
      "GOLD report (COPD)",
      "GINA report (asthma)",
      "ACC/AHA atrial fibrillation guideline",
    ]);
    expect(FIXED_SOURCES.map((s) => s.id)).toEqual(["uspstf", "cpr", "hf", "ada", "gold", "gina"]);

    const status = (name: string): HTMLTableCellElement | undefined => rowNamed(container, name).cells[1];
    expect(status("GOLD report (COPD)")?.textContent).toBe("Checked Oct 1, 2026");
    expect(status("GOLD report (COPD)")?.className).toBe("st-ok");
    expect(status("ACC/AHA atrial fibrillation guideline")?.textContent).toBe("Checked Sep 15, 2026");
    expect(status("ADA Standards of Care in Diabetes")?.textContent).toBe("Couldn't be checked on Oct 1, 2026. Last successful check Sep 1, 2026. Will retry next month.");
    expect(status("ADA Standards of Care in Diabetes")?.className).toBe("st-fail");
    expect(status("AHA CPR & ECC (ACLS) guidelines")?.textContent).toBe("Couldn't be checked on Oct 1, 2026. Will retry next month.");
    expect(status("AHA CPR & ECC (ACLS) guidelines")?.className).toBe("st-fail");
    expect(status("USPSTF recommendations")?.textContent).toBe("Not checked yet");
    expect(status("USPSTF recommendations")?.className).toBe("st-ok");
    expect(status("GINA report (asthma)")?.textContent).toBe("Not checked yet");
  });

  it("dates a failed source by its last attempt when no run is recorded", async () => {
    serve(withUpdates(files, (u) => {
      u.lastRun = null;
      u.sources = [{ id: "gina", status: "fail", lastSuccess: "2026-08-01", lastAttempt: "2026-09-03" }];
    }));
    const { container } = await openUpdates();
    expect(rowNamed(container, "GINA report (asthma)").cells[1]?.textContent).toBe(
      "Couldn't be checked on Sep 3, 2026. Last successful check Aug 1, 2026. Will retry next month.",
    );
  });
});

describe("Update notes placed on pages", () => {
  it("shows a placed flag above its topic's table, with the chip and an external link", async () => {
    const { container } = await openTopic101();
    const card = container.querySelector("section.tcard");
    if (!card) throw new Error("no topic card");
    const note = card.querySelector('aside[aria-label="Updated guideline"]');
    if (!note) throw new Error("no update note on the R(101) topic");
    expect(note.getAttribute("data-anchor")).toBe(U(1));
    expect(note.querySelector(".ut")?.textContent).toBe("Guideline 1");
    expect(note.querySelector(".lab-chip.updc")?.textContent).toBe("Updated guideline");
    const table = card.querySelector("table");
    if (!table) throw new Error("no topic table");
    expect(note.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const link = byText<HTMLAnchorElement>(note, "a", "Read the guideline");
    expect(link?.getAttribute("href")).toBe("https://goldcopd.org/x");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("lists a flag whose subject has no concept only on the updates page", async () => {
    const f = await fixtureWithUnmatchedFlag();
    const flag = updatesOf(f).flags.find((x) => x.id === U(6));
    expect(flag?.addedTo).toEqual([]);
    serve(f);

    const list = await openUpdates();
    const entry = entryFor(list.container, "Guideline 6");
    expect(entry.querySelector("blockquote")?.textContent).toBe("“Quote 6”");
    expect(entry.querySelector(".added")).toBeNull();
    app?.unmount();
    app = null;

    const topic = await openTopic101();
    const anchors = [...topic.container.querySelectorAll('aside[aria-label="Updated guideline"]')].map((n) => n.getAttribute("data-anchor"));
    expect(anchors).toEqual([U(1)]);
    expect(visibleText(topic.container)).not.toContain("Guideline 6");
  });
});

describe("Other › Guidelines entry line", () => {
  it("shows the flag count and last check date, linking to the updates page", async () => {
    app = await renderApp("#/other/guidelines");
    const mounted = app;
    const entry = await until(() => mounted.container.querySelector<HTMLElement>('[data-ref="updates-entry"]'), "the updates entry line");
    const n = updatesOf(files).flags.length;
    expect(n).toBe(5);
    expect(visibleText(entry)).toContain("Updated guidelines — 5 flags · last checked October 1, 2026");
    expect(entry.querySelector(".lab-chip.updc")?.textContent).toBe("Updated guideline");
    const link = byText<HTMLAnchorElement>(entry, "a", "Updated guidelines");
    expect(link?.getAttribute("href")).toBe(UPDATES);
    await click(link);
    expect(location.hash).toBe(UPDATES);
    await until(() => mounted.container.querySelector(".updates-page"), "the updates page after clicking the entry");
  });
});
