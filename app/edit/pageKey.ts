// Edit page keys (50 §50.1): `<kind>:<field>:…`, naming the unit an Edit button opens. One table of
// fields per kind builds and parses them.

const FIELDS = {
  topic: ["guide", "row"],
  section: ["guide", "system", "section"],
  system: ["guide", "system"],
  listed: ["guide", "block"],
  pharm: ["guide", "system", "section"],
  general: ["guide", "key"],
  workup: ["guide", "item"],
  ref: ["tab", "sub"],
  other: ["section"],
  slide: ["guide", "slide"],
  doc: ["doc"],
} as const;

type Fields = typeof FIELDS;
export type PageKind = keyof Fields;

/** A parsed page key: its kind and one string per field of that kind. */
export type PageKey = { [K in PageKind]: { kind: K } & Record<Fields[K][number], string> }[PageKind];

/** One string per field name. */
type Values<T extends readonly string[]> = { readonly [I in keyof T]: string };

/** The page key of a `kind` page, its fields in table order. */
export function buildPageKey<K extends PageKind>(kind: K, ...fields: Values<Fields[K]>): string {
  return [kind, ...fields].join(":");
}

const isKind = (s: string): s is PageKind => Object.hasOwn(FIELDS, s);

/** The parts of `key`, or null when it is not a well-formed page key. */
export function parsePageKey(key: string): PageKey | null {
  const [kind = "", ...values] = key.split(":");
  if (!isKind(kind)) return null;
  const names: readonly string[] = FIELDS[kind];
  if (values.length !== names.length || values.some((v) => v === "")) return null;
  return Object.fromEntries([["kind", kind], ...names.map((n, i) => [n, values[i]])]) as PageKey;
}
