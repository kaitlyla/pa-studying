// Small structural checkers used by the content validators. Each throws a ContentError naming the
// file and the JSON path of the offending value.

export class ContentError extends Error {
  readonly file: string;
  constructor(file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = "ContentError";
    this.file = file;
  }
}

export type Checker = (value: unknown, at: string, ctx: Ctx) => void;

export interface Ctx {
  file: string;
}

export function bad(ctx: Ctx, at: string, what: string, value?: unknown): never {
  const shown = value === undefined ? "" : `, got ${JSON.stringify(value)?.slice(0, 120)}`;
  throw new ContentError(ctx.file, `${at || "(root)"}: expected ${what}${shown}`);
}

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const str: Checker = (v, at, ctx) => { if (typeof v !== "string") bad(ctx, at, "a string", v); };
export const nonEmpty: Checker = (v, at, ctx) => { if (typeof v !== "string" || v.trim() === "") bad(ctx, at, "a non-empty string", v); };
export const num: Checker = (v, at, ctx) => { if (typeof v !== "number" || !Number.isFinite(v)) bad(ctx, at, "a number", v); };
export const int: Checker = (v, at, ctx) => { if (!Number.isInteger(v) || (v as number) < 0) bad(ctx, at, "a non-negative integer", v); };
export const bool: Checker = (v, at, ctx) => { if (typeof v !== "boolean") bad(ctx, at, "a boolean", v); };
export const isNull: Checker = (v, at, ctx) => { if (v !== null) bad(ctx, at, "null", v); };
export const one = (v: unknown): Checker => (x, at, ctx) => { if (x !== v) bad(ctx, at, JSON.stringify(v), x); };
export const oneOf = (...allowed: readonly unknown[]): Checker => (v, at, ctx) => {
  if (!allowed.includes(v)) bad(ctx, at, `one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}`, v);
};
export const re = (pattern: RegExp, what: string): Checker => (v, at, ctx) => {
  if (typeof v !== "string" || !pattern.test(v)) bad(ctx, at, what, v);
};
export const nullable = (c: Checker): Checker => (v, at, ctx) => { if (v !== null) c(v, at, ctx); };
export const either = (what: string, ...cs: Checker[]): Checker => (v, at, ctx) => {
  for (const c of cs) {
    try { c(v, at, ctx); return; } catch { /* try the next alternative */ }
  }
  bad(ctx, at, what, v);
};
export const arr = (item: Checker): Checker => (v, at, ctx) => {
  if (!Array.isArray(v)) bad(ctx, at, "an array", v);
  v.forEach((x, i) => item(x, `${at}[${i}]`, ctx));
};
export const uniqueArr = (item: Checker): Checker => (v, at, ctx) => {
  arr(item)(v, at, ctx);
  const seen = new Set<unknown>();
  for (const x of v as unknown[]) {
    if (seen.has(x)) bad(ctx, at, "no duplicate entries", x);
    seen.add(x);
  }
};
export const record = (key: Checker, val: Checker): Checker => (v, at, ctx) => {
  if (!isObj(v)) bad(ctx, at, "an object", v);
  for (const [k, x] of Object.entries(v)) {
    key(k, `${at}{${k}}`, ctx);
    val(x, `${at}.${k}`, ctx);
  }
};

/** An object with exactly these required keys, plus the optional keys when present. */
export const obj = (required: Record<string, Checker>, optional: Record<string, Checker> = {}): Checker => (v, at, ctx) => {
  if (!isObj(v)) bad(ctx, at, "an object", v);
  for (const k of Object.keys(v)) {
    if (!Object.hasOwn(required, k) && !Object.hasOwn(optional, k)) bad(ctx, `${at}.${k}`, "no such key");
  }
  for (const [k, c] of Object.entries(required)) {
    if (!Object.hasOwn(v, k)) bad(ctx, `${at}.${k}`, "a value (key missing)");
    c(v[k], `${at}.${k}`, ctx);
  }
  for (const [k, c] of Object.entries(optional)) if (Object.hasOwn(v, k)) c(v[k], `${at}.${k}`, ctx);
};

type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];
type RequiredKeys<T> = Exclude<keyof T, OptionalKeys<T>>;

/**
 * `obj` keyed to a declared interface: the compiler requires a checker for exactly the interface's
 * required keys and for exactly its optional keys, so the validator and the type cannot drift.
 */
export function shapeOf<T>(
  required: { [K in RequiredKeys<T>]-?: Checker },
  optional: { [K in OptionalKeys<T>]-?: Checker },
): Checker {
  return obj(required as Record<string, Checker>, optional as Record<string, Checker>);
}

export const ISO_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const ISO_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const ISO_UTC_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,3})?Z$/;

/** A YYYY-MM-DD day that exists in the calendar: it formats back to itself (Date rolls 02-31 over to 03-03). */
function realDay(day: string): boolean {
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

export const isoDate: Checker = (v, at, ctx) => {
  if (typeof v !== "string" || !ISO_DATE_RE.test(v) || !realDay(v)) bad(ctx, at, "an ISO date (YYYY-MM-DD)", v);
};
export const isoUtc: Checker = (v, at, ctx) => {
  if (typeof v !== "string" || !ISO_UTC_RE.test(v) || !realDay(v.slice(0, 10))) bad(ctx, at, "an ISO-8601 UTC timestamp", v);
};
