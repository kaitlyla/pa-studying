// The live location (10 §10.4) and the unsaved-changes guard (50 §50.3) through jsdom's real
// history: in-app navigation, and back/forward under the guard, checked by the order of entries.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentHash, navigate, setNavigationGuard, syncFromLocation, useRoute } from "./route.ts";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let unguard: (() => void) | null = null;

function guard(fn: (to: string) => boolean | Promise<boolean>): void {
  unguard?.();
  unguard = setNavigationGuard(fn);
}

/** Waits for jsdom's queued history traversal and the router's reaction to it. */
async function settle(check: () => boolean, what: string): Promise<void> {
  await vi.waitFor(
    () => {
      if (!check()) throw new Error(`waiting for ${what}`);
    },
    { timeout: 2000, interval: 5 },
  );
}

/** Builds history [..., #/x, #/a, #/b] with #/b current, no guard. */
async function threeEntries(): Promise<void> {
  await navigate("#/x");
  await navigate("#/a");
  await navigate("#/b");
  expect(location.hash).toBe("#/b");
  expect(currentHash()).toBe("#/b");
}

beforeEach(() => {
  unguard?.();
  unguard = null;
});

afterEach(() => {
  unguard?.();
  unguard = null;
});

describe("navigate", () => {
  it("moves the location and the current route, and accepts a hash without '#'", async () => {
    expect(await navigate("/eor/fm")).toBe(true);
    expect(location.hash).toBe("#/eor/fm");
    expect(currentHash()).toBe("#/eor/fm");
  });

  it("asks the guard with the target and stays put when it refuses", async () => {
    await navigate("#/start");
    const asked: string[] = [];
    guard((to) => {
      asked.push(to);
      return false;
    });
    expect(await navigate("#/eor/fm/s/cardiovascular")).toBe(false);
    expect(asked).toEqual(["#/eor/fm/s/cardiovascular"]);
    expect(location.hash).toBe("#/start");
    expect(currentHash()).toBe("#/start");
  });

  it("waits for an asynchronous guard before moving", async () => {
    await navigate("#/start");
    let allow: (ok: boolean) => void = () => {};
    guard(() => new Promise<boolean>((r) => (allow = r)));
    const moving = navigate("#/eor");
    await Promise.resolve();
    expect(location.hash).toBe("#/start");
    allow(true);
    expect(await moving).toBe(true);
    expect(location.hash).toBe("#/eor");
  });

  it("an unregistered guard no longer applies, and a stale unregister leaves the newer guard", async () => {
    const first = setNavigationGuard(() => false);
    const second = setNavigationGuard(() => false);
    first();
    expect(await navigate("#/blocked")).toBe(false);
    second();
    expect(await navigate("#/free")).toBe(true);
    expect(location.hash).toBe("#/free");
  });
});

describe("back/forward under the guard", () => {
  it("without a guard, Back simply follows the address", async () => {
    await threeEntries();
    history.back();
    await settle(() => currentHash() === "#/a", "current #/a");
    expect(location.hash).toBe("#/a");
  });

  it("allowed: the page moves to the entry Back landed on, and the history order is unchanged", async () => {
    await threeEntries();
    const asked: string[] = [];
    guard((to) => {
      asked.push(to);
      return true;
    });
    history.back();
    await settle(() => currentHash() === "#/a", "current #/a");
    expect(asked).toEqual(["#/a"]);
    expect(location.hash).toBe("#/a");
    // Order is still [#/x, #/a, #/b]: Forward reaches #/b, then Back twice reaches #/x.
    history.forward();
    await settle(() => currentHash() === "#/b", "current #/b");
    history.back();
    await settle(() => currentHash() === "#/a", "back to #/a");
    history.back();
    await settle(() => currentHash() === "#/x", "back to #/x");
  });

  it("refused: the page stays, a new entry restores the address, and the entry Back landed on is untouched", async () => {
    await threeEntries();
    const before = history.length;
    guard(() => false);
    history.back();
    // The router pushes #/b back onto the address once the guard refuses.
    await settle(() => location.hash === "#/b", "address restored to #/b");
    expect(currentHash()).toBe("#/b");
    // [#/x, #/a, #/b(new)]: the old #/b forward entry was replaced by the new one.
    expect(history.length).toBe(before);
    unguard?.();
    unguard = null;
    // The entry below is still #/a (not rewritten to #/b), and below it #/x.
    history.back();
    await settle(() => currentHash() === "#/a", "back to #/a");
    history.back();
    await settle(() => currentHash() === "#/x", "back to #/x");
  });

  it("a guard that refuses then allows a later Back still lands on #/a", async () => {
    await threeEntries();
    let ok = false;
    guard(() => ok);
    history.back();
    await settle(() => location.hash === "#/b", "refused");
    ok = true;
    history.back();
    await settle(() => currentHash() === "#/a", "allowed");
  });
});

describe("useRoute and syncFromLocation", () => {
  it("re-renders with the parsed route on every change, including the query", async () => {
    await navigate("#/eor/fm");
    const seen: string[] = [];
    function Probe(): ReactNode {
      const r = useRoute();
      seen.push(`${r.kind}:${r.path}:${r.query.q ?? ""}:${r.query.at ?? ""}`);
      return null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(createElement(Probe)));
    expect(seen.at(-1)).toBe("guide:#/eor/fm::");
    await act(async () => {
      await navigate("#/eor/fm/t/r_1?q=lithium&at=p2");
    });
    expect(seen.at(-1)).toBe("guide:#/eor/fm/t/r_1:lithium:p2");
    history.replaceState(null, "", "#/labs");
    act(() => syncFromLocation());
    expect(seen.at(-1)).toBe("ref:#/labs::");
    act(() => root.unmount());
  });
});
