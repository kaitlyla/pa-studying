// Edit page keys: one builder and parser for every kind.
import { describe, expect, it } from "vitest";
import { buildPageKey, parsePageKey } from "./pageKey.ts";

describe("page keys", () => {
  it("builds each kind's key and parses it back into its fields", () => {
    const cases = [
      [buildPageKey("topic", "fm", "r_A"), { kind: "topic", guide: "fm", row: "r_A" }],
      [buildPageKey("section", "fm", "cardio", "cad"), { kind: "section", guide: "fm", system: "cardio", section: "cad" }],
      [buildPageKey("system", "fm", "cardio"), { kind: "system", guide: "fm", system: "cardio" }],
      [buildPageKey("listed", "fm", "b_A"), { kind: "listed", guide: "fm", block: "b_A" }],
      [buildPageKey("pharm", "fm", "cardio", "p1"), { kind: "pharm", guide: "fm", system: "cardio", section: "p1" }],
      [buildPageKey("general", "fm", "vaccines"), { kind: "general", guide: "fm", key: "vaccines" }],
      [buildPageKey("workup", "psy", "ams"), { kind: "workup", guide: "psy", item: "ams" }],
      [buildPageKey("ref", "labs", "cbc"), { kind: "ref", tab: "labs", sub: "cbc" }],
      [buildPageKey("other", "howto"), { kind: "other", section: "howto" }],
      [buildPageKey("slide", "fm", "s_A"), { kind: "slide", guide: "fm", slide: "s_A" }],
      [buildPageKey("doc", "d_A"), { kind: "doc", doc: "d_A" }],
    ] as const;
    for (const [key, parsed] of cases) expect(parsePageKey(key)).toEqual(parsed);
    expect(cases.map(([key]) => key)).toEqual([
      "topic:fm:r_A", "section:fm:cardio:cad", "system:fm:cardio", "listed:fm:b_A", "pharm:fm:cardio:p1",
      "general:fm:vaccines", "workup:psy:ams", "ref:labs:cbc", "other:howto", "slide:fm:s_A", "doc:d_A",
    ]);
  });

  it("refuses an unknown kind, a wrong number of fields, and an empty field", () => {
    for (const key of ["", "page:fm", "toString:x", "topic:fm", "topic:fm:r_A:extra", "doc:", "system::cardio"]) {
      expect(parsePageKey(key)).toBeNull();
    }
  });
});
