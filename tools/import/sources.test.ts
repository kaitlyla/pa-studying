// The source inventory: the committed sources.json/guides.json and their validation.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GUIDE_IDS } from "../../lib/content/index.ts";
import {
  baseName, checkSourcesExist, loadGuides, loadSources, parseGuides, parseSources, stem,
} from "./sources.ts";
import type { Source } from "./sources.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

const guideRows = GUIDE_IDS.map((g) => ({ path: `G/${g}.docx`, kind: "guide", name: g, placement: { guide: g } }));
const inventory = (...rows: unknown[]) => ({ v: 1, sources: [...guideRows, ...rows] });

describe("the committed inventory (30 §30.2)", () => {
  it("parses, with one row per guide and the listed kinds", async () => {
    const sources = await loadSources(REPO);
    const count = (k: Source["kind"]) => sources.filter((s) => s.kind === k).length;
    expect(count("guide")).toBe(8);
    expect(count("word")).toBe(32);
    expect(count("pdf") + count("image") + count("slides")).toBe(18);
    expect(count("pharm")).toBe(10);
    expect(count("deck")).toBe(1);
    expect(count("vocab")).toBe(1);
    expect(count("duplicate")).toBe(2);
  });

  it("lists none of the files the design leaves out", async () => {
    const paths = (await loadSources(REPO)).filter((s) => s.kind !== "duplicate").map((s) => s.path);
    const excluded = /EOR\.pdf$|SG\.pdf$|USPSTF guidelines\.pdf|ABG .*\.pdf$|FIRST AID|PSA \(update\)|OSCE|Genetics|Myocarditis|Geriatrics|Untitled document|Oral presentation|\/Info\.docx|accommadations|Syllabus|\.bak$|Psych Behavioural Health table|Clin Med_Examples|Patho_Examples/;
    expect(paths.filter((p) => excluded.test(p))).toEqual([]);
    // Her physical-exam notes and exam theory are the course-note folders on the site (Other › Physical exam).
    expect(paths.filter((p) => p.startsWith("Physical Exam_Examples/")).sort()).toEqual([
      "Physical Exam_Examples/Cardiac -Theory.docx",
      "Physical Exam_Examples/GI_ Skills.docx",
      "Physical Exam_Examples/MSK_Physical_Exam_.docx",
      "Physical Exam_Examples/Neuro Lab Checklist Summer 2026 (1).docx",
      "Physical Exam_Examples/Pulm_ Physcial Exam .docx",
      "Physical Exam_Examples/Vitals- Physical & Cultural Competence.docx",
    ]);
    // Her Cardiac theory copy there is a proven duplicate of the Physical Exam_Examples one.
    expect(paths.filter((p) => p.startsWith("Theory_Examples/")).sort()).toEqual([
      "Theory_Examples/Abdominal Skills_ Theory .docx",
      "Theory_Examples/MSK Theory.docx",
      "Theory_Examples/Pt Theory_ DRE, GU, Sex.docx",
      "Theory_Examples/Pt Theory_ female, geriatric, foley (1).docx",
      "Theory_Examples/Pt_Assessment_Neuro_Theory_UPDATED_v4 (1).docx",
      "Theory_Examples/Pulmonary Theory.docx",
    ]);
    // Her Master ACLS guide: she pointed to it for Emergency care's ACLS algorithms (2026-10-05).
    expect(paths.filter((p) => p.startsWith("docx to fix/"))).toEqual([
      "docx to fix/--Master ACLS Study Guide 2025_corrected.docx",
      "docx to fix/--Anesthetics and Procedural Sedation Med List and LOs (2).docx",
    ]);
  });

  it("guides.json has every guide's systems, with the PANCE renal heading matched by its leading text", async () => {
    const guides = await loadGuides(REPO);
    expect(Object.keys(guides).sort()).toEqual([...GUIDE_IDS].sort());
    expect(guides.fm.systems.map((s) => s.title)).toContain("Infectious Diseases");
    expect(guides.pance.systems.find((s) => s.title === "Renal System & GU System")).toEqual({ title: "Renal System & GU System", pct: "5% / 5%", category: null, match: "Renal System (5%) & GU System" });
  });
});

describe("parseSources", () => {
  it("accepts every placement shape for its kind", () => {
    const rows = parseSources(inventory(
      { path: "a.docx", kind: "word", name: "A", placement: { other: "notes" } },
      { path: "b.pdf", kind: "pdf", name: "B", placement: { sidebarEnd: "pance" } },
      { path: "c.png", kind: "image", name: "C", placement: { reftabs: "labs" } },
      { path: "d.pptx", kind: "slides", name: "D", placement: { pharm: ["ID"] } },
      { path: "e.pptx", kind: "deck", name: "E", placement: { deck: "psy" } },
      { path: "f.docx", kind: "pharm", name: "F", placement: null },
      { path: "g.docx", kind: "vocab", name: "G", placement: null },
      { path: "h.docx", kind: "duplicate", name: "H", placement: { duplicateOf: "a.docx" } },
    ));
    expect(rows).toHaveLength(16);
    expect(rows[8]).toEqual({ path: "a.docx", kind: "word", name: "A", placement: { other: "notes" } });
  });

  it.each([
    ["a wrong top level", { v: 2, sources: [] }, /expected \{ v: 1/],
    ["a non-object row", inventory(5), /sources\[8\]: expected an object/],
    ["an extra key", inventory({ path: "a", kind: "pharm", name: "A", placement: null, x: 1 }), /exactly path, kind, name, placement/],
    ["a backslash path", inventory({ path: "a\\b.docx", kind: "pharm", name: "A", placement: null }), /relative path/],
    ["an unknown kind", inventory({ path: "a", kind: "zip", name: "A", placement: null }), /unknown kind "zip"/],
    ["a blank name", inventory({ path: "a", kind: "pharm", name: " ", placement: null }), /name: expected a non-empty string/],
    ["a placement on a pharm row", inventory({ path: "a", kind: "pharm", name: "A", placement: { other: "pe" } }), /expected null for kind pharm/],
    ["a missing placement", inventory({ path: "a", kind: "word", name: "A", placement: null }), /expected an object with one of/],
    ["a placement the kind does not take", inventory({ path: "a", kind: "word", name: "A", placement: { sidebarEnd: "pance" } }), /sidebarEnd is not a placement for kind word/],
    ["an unknown Other section", inventory({ path: "a", kind: "word", name: "A", placement: { other: "cases" } }), /placement.other: invalid value "cases"/],
    ["an unknown category", inventory({ path: "a", kind: "pdf", name: "A", placement: { pharm: ["CV", "XX"] } }), /placement.pharm: invalid/],
    ["a repeated category", inventory({ path: "a", kind: "pdf", name: "A", placement: { pharm: ["CV", "CV"] } }), /placement.pharm: invalid/],
    ["a repeated path", inventory({ path: "a", kind: "pharm", name: "A", placement: null }, { path: "a", kind: "pharm", name: "B", placement: null }), /duplicate path a/],
    ["a duplicate of a non-word row", inventory({ path: "a", kind: "pharm", name: "A", placement: null }, { path: "b", kind: "duplicate", name: "B", placement: { duplicateOf: "a" } }), /duplicateOf must name a word row/],
    ["two vocab rows", inventory({ path: "a", kind: "vocab", name: "A", placement: null }, { path: "b", kind: "vocab", name: "B", placement: null }), /at most one vocab row/],
    ["two sidebarEnd rows", inventory({ path: "a", kind: "pdf", name: "A", placement: { sidebarEnd: "pance" } }, { path: "b", kind: "pdf", name: "B", placement: { sidebarEnd: "pance" } }), /at most one sidebarEnd/],
  ])("rejects %s", (_, json, error) => {
    expect(() => parseSources(json, "s.json")).toThrow(error);
  });

  it("requires exactly one row per guide", () => {
    expect(() => parseSources({ v: 1, sources: guideRows.slice(1) })).toThrow(/one guide row for each of em/);
    expect(() => parseSources({ v: 1, sources: [...guideRows, { ...guideRows[0], path: "other.docx" }] })).toThrow(/one guide row/);
  });
});

describe("parseGuides", () => {
  const all = Object.fromEntries(GUIDE_IDS.map((g) => [g, { systems: [{ title: "Cardiovascular", pct: "10%", category: "CV" }] }]));
  it("accepts a match, an empty pct and a null category", () => {
    const json = { v: 1, guides: { ...all, ob: { systems: [{ title: "Gynecology", pct: "", category: null, match: "GYN" }] } } };
    expect(parseGuides(json).ob.systems).toEqual([{ title: "Gynecology", pct: "", category: null, match: "GYN" }]);
    expect(parseGuides(json).em.systems[0]?.category).toBe("CV");
  });
  it.each([
    ["a wrong top level", { v: 1 }, /expected \{ v: 1, guides/],
    ["an unknown guide", { v: 1, guides: { ...all, zz: { systems: [] } } }, /unknown guide zz/],
    ["a guide with no systems", { v: 1, guides: { ...all, em: { systems: [] } } }, /em: expected \{ systems/],
    ["a system with no title", { v: 1, guides: { ...all, em: { systems: [{ pct: "1%", category: null }] } } }, /em.systems\[0\]: expected/],
    ["a system with no category", { v: 1, guides: { ...all, em: { systems: [{ title: "A", pct: "" }] } } }, /em.systems\[0\]: expected \{ title, pct, category/],
    ["an unknown category", { v: 1, guides: { ...all, em: { systems: [{ title: "A", pct: "", category: "Cardio" }] } } }, /em.systems\[0\].category: expected one of CV/],
    ["an unknown key", { v: 1, guides: { ...all, em: { systems: [{ title: "A", pct: "", category: null, id: "a" }] } } }, /em.systems\[0\].id: no such key/],
    ["a blank match", { v: 1, guides: { ...all, em: { systems: [{ title: "A", pct: "", category: null, match: "" }] } } }, /match: expected a non-empty string/],
  ])("rejects %s", (_, json, error) => {
    expect(() => parseGuides(json)).toThrow(error);
  });
});

describe("checkSourcesExist", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "pa-src-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("names every missing source and passes when all exist", async () => {
    await mkdir(join(root, "a b"), { recursive: true });
    await writeFile(join(root, "a b", "x.docx"), "x");
    const row = (path: string): Source => ({ path, kind: "pharm", name: path, placement: null });
    await expect(checkSourcesExist(root, [row("a b/x.docx"), row("a b/y.docx"), row("z.pdf")])).rejects.toThrow("Source files missing:\n  a b/y.docx\n  z.pdf");
    await expect(checkSourcesExist(root, [row("a b/x.docx")])).resolves.toBeUndefined();
    expect(await readFile(join(root, "a b", "x.docx"), "utf8")).toBe("x");
  });
});

describe("file names", () => {
  it("takes the base name and drops only the last extension", () => {
    expect(baseName("a/b/EKG_Reading_Notes.md.pdf")).toBe("EKG_Reading_Notes.md.pdf");
    expect(baseName("root.docx")).toBe("root.docx");
    expect(stem("EKG_Reading_Notes.md.pdf")).toBe("EKG_Reading_Notes.md");
    expect(stem("--Anesthetics (2).docx")).toBe("--Anesthetics (2)");
    expect(stem(".hidden")).toBe(".hidden");
  });
});
