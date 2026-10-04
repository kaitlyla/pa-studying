// Document placements (30 §30.2) and the pre-curation curation files (30 §30.14).
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GUIDE_IDS, validateFile } from "../../lib/content/index.ts";
import { REF_TABS } from "../../lib/derive/routes.ts";
import { buildOther, buildRefTabs, initialStructure, pharmFilesFor, sidebarEndOf } from "./placement.ts";
import type { PlacedDoc } from "./placement.ts";
import { loadGuides, loadSources } from "./sources.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const d = (n: number): string => `d_${String(n).padStart(10, "0")}`;

describe("guides.json categories", () => {
  // 30 §30.2's system → category map, keyed by the signed titles; every other system has none.
  const PLAN: Record<string, string> = {
    "Cardiovascular": "CV", "Pulmonary": "PULM", "Pulmonology": "PULM", "EENT": "EENT", "ENT/Ophthalmology": "EENT",
    "Gastrointestinal/Nutritional": "GI", "GI/Nutritional": "GI", "Gastrointestinal/Nutritional System": "GI",
    "Gastrointestinal System/Nutrition": "GI", "Infectious Disease": "ID", "Infectious Diseases": "ID",
    "Psychiatry/Behavioral Medicine": "PSY", "Endocrinology": "ENDO", "Endocrine System": "ENDO",
  };
  const PSY_GROUPS = ["Depressive Disorders; Bipolar & Related Disorders", "Anxiety Disorders; Trauma & Stress-Related Disorders", "Schizophrenia Spectrum & Other Psychotic Disorders"];

  it("give every system the category 30 §30.2 assigns it", async () => {
    const guides = await loadGuides(REPO);
    for (const g of GUIDE_IDS) {
      for (const sys of guides[g].systems) {
        const want = g === "psy" && PSY_GROUPS.includes(sys.title) ? "PSY" : PLAN[sys.title] ?? null;
        expect({ g, title: sys.title, category: sys.category }).toEqual({ g, title: sys.title, category: want });
      }
    }
  });
});

describe("pharmFilesFor", () => {
  const docs: PlacedDoc[] = [
    { id: d(1), placement: { pharm: ["CV", "PULM", "ID"] } },
    { id: d(2), placement: { other: "pe" } },
    { id: d(3), placement: { pharm: ["PULM"] } },
    { id: d(4), placement: null },
  ];
  it("lists the documents covering the system's category, in inventory order", () => {
    expect(pharmFilesFor("PULM", docs)).toEqual([d(1), d(3)]);
    expect(pharmFilesFor("ID", docs)).toEqual([d(1)]);
    expect(pharmFilesFor("ENDO", docs)).toEqual([]);
    expect(pharmFilesFor(null, docs)).toEqual([]);
  });

  it("with the committed inventory, places the antibiotic charts in the ID system of fm, im, peds and pance only (ruling D2)", async () => {
    const sources = await loadSources(REPO);
    const guides = await loadGuides(REPO);
    const placed = sources.map((s, i) => ({ id: d(i), placement: s.placement, name: s.name }));
    const abx = placed.filter((p) => p.name === "Abx flow charts" || p.name === "Antibiotic Flower Charts").map((p) => p.id);
    expect(abx).toHaveLength(2);
    const holders: string[] = [];
    for (const g of GUIDE_IDS) {
      for (const sys of guides[g].systems) {
        const files = pharmFilesFor(sys.category, placed);
        if (abx.every((id) => files.includes(id))) holders.push(`${g}:${sys.title}`);
        else expect(files.filter((id) => abx.includes(id))).toEqual([]);
      }
    }
    expect(holders).toEqual(["fm:Infectious Diseases", "im:Infectious Disease", "peds:Infectious Disease", "pance:Infectious Disease"]);
  });

  it("with the committed inventory, lists each category's files in the signed mockup's order", async () => {
    const sources = await loadSources(REPO);
    const placed = sources.map((s, i) => ({ id: d(i), placement: s.placement }));
    const name = (id: string): string => sources[Number(id.slice(2))]?.name ?? "";
    expect(pharmFilesFor("PSY", placed).map(name)).toEqual(["pharm review", "psych drug groupings", "Choosing and Switching Antidepressants 2024"]);
    expect(pharmFilesFor("PULM", placed).map(name)).toEqual(["pharm review", "inhaler combos"]);
    expect(pharmFilesFor("ENDO", placed).map(name)).toEqual(["insulin dosing"]);
    expect(pharmFilesFor("ID", placed).map(name)).toEqual(["pharm review", "Abx flow charts", "Antibiotic Flower Charts"]);
  });
});

describe("pre-curation files", () => {
  const docs: PlacedDoc[] = [
    { id: d(1), placement: { reftabs: "labs" } },
    { id: d(2), placement: { other: "screenings" } },
    { id: d(3), placement: { reftabs: "labs" } },
    { id: d(4), placement: { reftabs: "anatomy" } },
    { id: d(5), placement: { other: "notes" } },
    { id: d(6), placement: { sidebarEnd: "pance" } },
  ];

  it("structure.json has only the pharm files and validates", () => {
    const s = initialStructure([d(1)]);
    expect(s).toEqual({ v: 1, sections: [], members: {}, listed: {}, drugTables: [], pharmSections: [], pharmFiles: [d(1)] });
    expect(() => validateFile("content/guides/fm/pulmonary/structure.json", s)).not.toThrow();
  });

  it("reftabs.json lists each tab's files in order with no sub-topics", () => {
    const r = buildRefTabs(docs);
    expect(r.labs).toEqual({ subs: [], files: [d(1), d(3)] });
    expect(r.anatomy.files).toEqual([d(4)]);
    expect(r.imaging.files).toEqual([]);
    expect(r.ekg.files).toEqual([]);
    expect(() => validateFile("content/places/reftabs.json", r)).not.toThrow();
  });

  it("reftabs.json files each document under the tab its placement names, for every route tab", () => {
    const perTab = REF_TABS.map((tab, i) => ({ id: d(10 + i), placement: { reftabs: tab } }));
    const r = buildRefTabs([...perTab].reverse());
    expect(Object.keys(r).sort()).toEqual(["v", ...REF_TABS].sort());
    for (const { id, placement } of perTab) expect(r[placement.reftabs].files, placement.reftabs).toEqual([id]);
  });

  it("other.json has the 9 sections in order, gaps only on legal and screenings, no lead", () => {
    const o = buildOther(docs);
    expect(o.sections.map((s) => s.id)).toEqual(["emergency", "vaccines", "guidelines", "screenings", "legal", "pa", "vitamins", "pe", "notes"]);
    expect(o.sections.find((s) => s.id === "screenings")).toEqual({ id: "screenings", title: "Screenings", lead: null, files: [d(2)], links: [], gaps: [] });
    expect(o.sections.find((s) => s.id === "notes")).toEqual({ id: "notes", title: "Note templates & documentation", lead: null, files: [d(5)], links: [] });
    expect(o.sections.filter((s) => "gaps" in s).map((s) => s.id)).toEqual(["screenings", "legal"]);
    expect(() => validateFile("content/places/other.json", o)).not.toThrow();
  });

  it("sidebarEnd is the document placed there, or none", () => {
    expect(sidebarEndOf(docs)).toBe(d(6));
    expect(sidebarEndOf(docs.slice(0, 5))).toBeUndefined();
  });
});
