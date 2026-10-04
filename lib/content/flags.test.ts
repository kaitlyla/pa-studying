import { afterEach, describe, expect, it, vi } from "vitest";
import { addFlag } from "./flags.ts";
import type { NewFlag } from "./flags.ts";
import type { Flag } from "./types.ts";

const draft = (key: string, over: Partial<NewFlag> = {}): NewFlag => ({
  kind: "rec", source: "uspstf", by: "check", key, subject: "Breast Cancer: Screening: women aged 40 to 74 years",
  guideline: "Breast Cancer: Screening: women aged 40 to 74 years", org: "USPSTF", published: "2024-04",
  quote: "Biennial mammography", grade: "B", url: "https://www.uspreventiveservicestaskforce.org/", flagged: "2026-10-01", ...over,
});
const stored = (id: string, key: string, over: Partial<Flag> = {}): Flag => ({ ...draft(key), id, supersededBy: null, ...over });

/** Make crypto.getRandomValues fill each call's bytes with the next value (then 9 forever). */
function randomFills(...fills: number[]): void {
  vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(a: T): T => {
    (a as unknown as Uint8Array).fill(fills.shift() ?? 9);
    return a;
  });
}

afterEach(() => { vi.restoreAllMocks(); });

describe("addFlag", () => {
  const KEY = "/uspstf/recommendation/breast-cancer-screening#1";

  it("supersedes the current flag with the same key, retired or not, and leaves other keys and superseded flags alone", () => {
    const flags: Flag[] = [
      stored("u_0000000001", KEY, { supersededBy: "u_0000000002" }),
      stored("u_0000000002", KEY, { retired: "2026-09-01" }),
      stored("u_0000000003", "/uspstf/recommendation/breast-cancer-screening#2"),
      stored("u_0000000004", "gold", { kind: "edition", source: "gold", subject: null, quote: null, grade: null }),
    ];
    const { id, superseded } = addFlag(flags, draft(KEY, { published: "2026-05" }), new Set());
    expect(superseded).toEqual(["u_0000000002"]);
    expect(flags.map((f) => [f.id, f.supersededBy])).toEqual([
      ["u_0000000001", "u_0000000002"], ["u_0000000002", id], ["u_0000000003", null], ["u_0000000004", null], [id, null],
    ]);
    expect(flags.at(-1)).toEqual({ ...draft(KEY, { published: "2026-05" }), id, supersededBy: null });
    expect(flags.filter((f) => f.key === KEY && f.supersededBy === null)).toHaveLength(1);
  });

  it("supersedes nothing for a new key", () => {
    const flags = [stored("u_0000000001", "gold")];
    expect(addFlag(flags, draft(KEY), new Set()).superseded).toEqual([]);
    expect(flags[0]!.supersededBy).toBeNull();
  });

  it("never mints an id held by a flag or by `taken`, and adds the minted id to `taken`", () => {
    // Draws: u_0000000000 (a flag's id), u_1111111111 (in taken), then u_2222222222.
    randomFills(0, 1, 2);
    const flags = [stored("u_0000000000", "gold")];
    const taken = new Set(["u_1111111111", "b_2222222222"]);
    const { id } = addFlag(flags, draft(KEY), taken);
    expect(id).toBe("u_2222222222");
    expect(taken.has("u_2222222222")).toBe(true);
  });

  it("gives successive flags of one run distinct ids through the shared `taken`", () => {
    // Every draw is u_3333333333 until the fourth: the second add must skip it.
    randomFills(3, 3, 4);
    const flags: Flag[] = [];
    const taken = new Set<string>();
    expect(addFlag(flags, draft(KEY), taken).id).toBe("u_3333333333");
    expect(addFlag(flags, draft(KEY, { published: "2026-05" }), taken).id).toBe("u_4444444444");
    expect(flags.map((f) => [f.id, f.supersededBy])).toEqual([["u_3333333333", "u_4444444444"], ["u_4444444444", null]]);
  });
});
