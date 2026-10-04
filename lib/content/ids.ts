// Identifiers (plan 20 §20.1).

/** Crockford base32 alphabet (no I, L, O, U). */
export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const ID_PREFIXES = ["b", "r", "d", "g", "p", "c", "s", "u"] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

/** Regular-expression source for 10 Crockford characters: the body of every id. */
export const ID_BODY = "[0-9A-HJKMNP-TV-Z]{10}";

/** Unanchored regular-expression source for an id with any of the given prefixes. */
export function idSource(...prefixes: readonly IdPrefix[]): string {
  return `[${prefixes.join("")}]_${ID_BODY}`;
}

/** Anchored regular expression matching a whole id with any of the given prefixes. */
export function idRegExp(...prefixes: readonly IdPrefix[]): RegExp {
  return new RegExp(`^${idSource(...prefixes)}$`);
}

export const ID_RE = Object.fromEntries(ID_PREFIXES.map((p) => [p, idRegExp(p)])) as Record<IdPrefix, RegExp>;

export const ANY_ID_RE = idRegExp(...ID_PREFIXES);

export function isId(prefix: IdPrefix, value: unknown): value is string {
  return typeof value === "string" && ID_RE[prefix].test(value);
}

/** `n` Crockford characters from crypto.getRandomValues (32 divides 256, so `byte & 31` is uniform). */
export function crockford(n: number): string {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += CROCKFORD[b & 31];
  return out;
}

/** A fresh id such as `b_7K3M0Q9XZA`. Ids are never reused; `taken` lets a writer rule out collisions with existing ids. */
export function newId(prefix: IdPrefix, taken?: { has(id: string): boolean }): string {
  for (;;) {
    const id = `${prefix}_${crockford(10)}`;
    if (!taken || !taken.has(id)) return id;
  }
}

/** The 10-character device id stored in localStorage `pa.device` (50 §50.4). */
export function newDeviceId(): string {
  return crockford(10);
}

export const ASSET_EXTS = [".png", ".jpeg", ".jpg", ".gif"] as const;
export type AssetExt = (typeof ASSET_EXTS)[number];

/** Content-addressed asset name: hex of the first 16 bytes of SHA-256 of the bytes, plus the original extension. */
export async function assetName(bytes: Uint8Array, ext: string): Promise<string> {
  const e = ext.toLowerCase();
  if (!(ASSET_EXTS as readonly string[]).includes(e)) throw new Error(`Unsupported asset extension: ${ext}`);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource));
  let hex = "";
  for (const b of digest.subarray(0, 16)) hex += b.toString(16).padStart(2, "0");
  return hex + e;
}

/** Regular-expression source for a slug as `slug()` produces it (unanchored). */
export const SLUG_SOURCE = "[a-z0-9]+(?:-[a-z0-9]+)*";

/** Anchored regular expression matching a whole slug. */
export const SLUG_RE = new RegExp(`^${SLUG_SOURCE}$`);

const CITE_RE = new RegExp(`^cite:(${SLUG_SOURCE})$`);

/** The flag source / `checks.json` key of a cited series (20 §20.12): `cite:<series>`. */
export function citeKey(series: string): string {
  return `cite:${series}`;
}

/** The series of a `cite:<series>` key, or null when the key is not one. */
export function seriesOfCiteKey(key: string): string | null {
  return CITE_RE.exec(key)?.[1] ?? null;
}

/** Slug used for system, section and pharm-file ids: lowercase ASCII, non-alphanumerics → `-`, collapsed. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
