// Identifiers (plan 20 §20.1).
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assetName, CROCKFORD, crockford, ID_RE, isId, newDeviceId, newId, slug } from "./ids.ts";

afterEach(() => { vi.restoreAllMocks(); });

describe("ids", () => {
  it("uses the Crockford base32 alphabet, without I, L, O and U", () => {
    expect(CROCKFORD).toHaveLength(32);
    expect(CROCKFORD).not.toMatch(/[ILOU]/);
    expect(crockford(200)).toMatch(/^[0-9A-HJKMNP-TV-Z]{200}$/);
  });

  it("makes prefixed 10-character ids for every kind", () => {
    for (const p of ["b", "r", "d", "g", "p", "c", "s", "u"] as const) {
      const id = newId(p);
      expect(id).toMatch(new RegExp(`^${p}_[0-9A-HJKMNP-TV-Z]{10}$`));
      expect(isId(p, id)).toBe(true);
      expect(ID_RE[p === "b" ? "r" : "b"].test(id)).toBe(false);
    }
    expect(newDeviceId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(isId("b", 7)).toBe(false);
  });

  it("draws from crypto.getRandomValues and never returns a taken id", () => {
    const fills = [0, 1];
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(a: T): T => {
      (a as unknown as Uint8Array).fill(fills.shift() ?? 2);
      return a;
    });
    expect(newId("b", new Set(["b_0000000000"]))).toBe("b_1111111111");
  });

  it("names an asset by the first 16 bytes of its SHA-256 plus its extension", async () => {
    const bytes = new TextEncoder().encode("a picture");
    const hex = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
    expect(await assetName(bytes, ".png")).toBe(`${hex}.png`);
    expect(await assetName(bytes, ".JPG")).toBe(`${hex}.jpg`);
    await expect(assetName(bytes, ".bmp")).rejects.toThrow(/Unsupported asset extension/);
  });

  it("slugs titles and file names", () => {
    expect(slug("Cardiovascular")).toBe("cardiovascular");
    expect(slug("cardio med list 1 (1)")).toBe("cardio-med-list-1-1");
    expect(slug("--Anesthetics and Procedural Sedation Med List and LOs (2)")).toBe("anesthetics-and-procedural-sedation-med-list-and-los-2");
    expect(slug("Ears, Nose & Throat")).toBe("ears-nose-throat");
  });
});
