import { describe, expect, it } from "vitest";
import type { DocRef, PubGap, PubLink, PubOtherNote } from "../../lib/derive/published.ts";
import { entryHash, sidebarEntries, splitOutline } from "./outline.ts";

const h = (heading: string, id: string, sub = false): PubOtherNote => ({ heading, id, sub });
const doc = (id: string, name: string): PubOtherNote => ({ doc: { id, name } as DocRef });
const gap = (id: string, title: string): PubOtherNote => ({ gap: { id, title } as PubGap });
const link = (target: string): PubOtherNote => ({ link: { target } as PubLink });

describe("splitOutline", () => {
  it("puts items before the first heading in the intro and each later item in the part of the heading above it", () => {
    const o = splitOutline([doc("d_1", "Intro doc"), h("Cardiac", "cardiac"), doc("d_2", "Theory"), h("Exam", "cardiac-exam", true), gap("g_1", "Skin")]);
    expect(o.intro).toEqual([doc("d_1", "Intro doc")]);
    expect(o.parts.map((p) => [p.id, p.title, p.sub, p.items])).toEqual([
      ["cardiac", "Cardiac", false, [doc("d_2", "Theory")]],
      ["cardiac-exam", "Exam", true, [gap("g_1", "Skin")]],
    ]);
  });
});

describe("sidebarEntries", () => {
  it("lists a top heading's sub headings as its sub-entries, as parts of their own", () => {
    const e = sidebarEntries(splitOutline([h("Cardiac", "cardiac"), doc("d_1", "A"), doc("d_2", "B"), h("Exam", "cardiac-exam", true), h("Theory", "cardiac-theory", true)]));
    expect(e).toEqual([{ id: "cardiac", title: "Cardiac", children: [{ id: "cardiac-exam", title: "Exam", part: true }, { id: "cardiac-theory", title: "Theory", part: true }] }]);
  });

  it("without sub headings, lists the part's named items when there are two or more, anchored in the part", () => {
    const e = sidebarEntries(splitOutline([h("Pulmonary", "pulmonary"), doc("d_1", "Pulm exam"), link("r_1"), gap("g_1", "Skin exam"), h("GI", "gi"), doc("d_2", "GI skills"), link("r_2")]));
    expect(e).toEqual([
      { id: "pulmonary", title: "Pulmonary", children: [{ id: "d_1", title: "Pulm exam", part: false }, { id: "g_1", title: "Skin exam", part: false }] },
      { id: "gi", title: "GI", children: [] },
    ]);
  });

  it("has no entries without headings", () => {
    expect(sidebarEntries(splitOutline([doc("d_1", "A"), doc("d_2", "B")]))).toEqual([]);
  });
});

describe("entryHash", () => {
  it("opens the part's page, landing on an item's anchor when given", () => {
    expect(entryHash("pe", "pulmonary")).toBe("#/other/pe/pulmonary");
    expect(entryHash("pe", "pulmonary", "g_1")).toBe("#/other/pe/pulmonary?at=g_1");
  });
});
