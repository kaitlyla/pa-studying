// A topic's rows grouped by the table block holding each one (40 §40.2): the diagnosis page, a
// table's PDF and the editor's rows editors each show one table per group.
import { describe, expect, it } from "vitest";
import { rowsByBlock } from "./topics.ts";

describe("rowsByBlock", () => {
  const blocks: Record<string, string> = { a1: "A", a2: "A", b1: "B", c1: "C" };
  const blockOf = (row: string): string | undefined => blocks[row];

  it("groups rows by their block, blocks in the order their rows first appear", () => {
    expect(rowsByBlock(["a1", "a2", "b1", "c1", "a1"], blockOf)).toEqual([
      { block: "A", rows: ["a1", "a2", "a1"] },
      { block: "B", rows: ["b1"] },
      { block: "C", rows: ["c1"] },
    ]);
  });

  it("leaves out a row the caller's page does not hold, and returns nothing for no rows", () => {
    expect(rowsByBlock(["a1", "missing", "b1"], blockOf)).toEqual([
      { block: "A", rows: ["a1"] },
      { block: "B", rows: ["b1"] },
    ]);
    expect(rowsByBlock([], blockOf)).toEqual([]);
  });
});
