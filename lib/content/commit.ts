// Commit messages and trailers for every commit that changes content/ (plan 50 §50.4).
import { ANY_ID_RE, ID_BODY, ID_RE } from "./ids.ts";
import { ISO_UTC_RE } from "./check.ts";

/**
 * `doc-marker` changes only a document's `replacing`/`replaceFailed` marker; it is neither a version
 * nor an Original (Orchestrator ruling 2026-10-05 00:55Z, amending 50 §50.4 and §50.6).
 */
export const COMMIT_KINDS = [
  "import", "curation", "authoring", "edit", "restore", "doc-add", "doc-rename", "doc-replace",
  "doc-remove", "doc-restore", "doc-marker", "inbox", "guidelines",
] as const;
export type CommitKind = (typeof COMMIT_KINDS)[number];

export interface Trailers {
  kind: CommitKind;
  /** Page key (50 §50.2); edits and restores. */
  page?: string;
  /** Ids of the rows and blocks whose content changed (every doc-* commit lists its d_id). */
  changed?: readonly string[];
  /** localStorage `pa.device`: 10 Crockford characters. */
  device?: string;
  /** ISO time of the restored version (restore). */
  restoredFrom?: string;
  /** The new file's name (doc-replace). */
  file?: string;
}

const NAMES = {
  kind: "Pa-Studying-Kind",
  page: "Pa-Studying-Page",
  changed: "Pa-Studying-Changed",
  device: "Pa-Studying-Device",
  restoredFrom: "Pa-Studying-Restored-From",
  file: "Pa-Studying-File",
} as const;

const DEVICE_RE = new RegExp(`^${ID_BODY}$`);

function singleLine(name: string, value: string): string {
  if (value.trim() === "" || /[\r\n]/.test(value)) throw new Error(`${name} must be a non-empty single line`);
  return value;
}

function checkTrailers(t: Trailers): void {
  if (!(COMMIT_KINDS as readonly string[]).includes(t.kind)) throw new Error(`Unknown commit kind: ${t.kind}`);
  const needsPage = t.kind === "edit" || t.kind === "restore";
  if (needsPage && t.page === undefined) throw new Error(`A ${t.kind} commit needs ${NAMES.page}`);
  if (t.kind === "edit" && t.device === undefined) throw new Error(`An edit commit needs ${NAMES.device}`);
  if (t.kind === "restore" && t.restoredFrom === undefined) throw new Error(`A restore commit needs ${NAMES.restoredFrom}`);
  if (t.kind === "doc-replace" && t.file === undefined) throw new Error(`A doc-replace commit needs ${NAMES.file}`);
  if ((t.kind === "edit" || t.kind === "restore" || t.kind.startsWith("doc-")) && !t.changed?.length) {
    throw new Error(`A ${t.kind} commit needs ${NAMES.changed}`);
  }
  for (const id of t.changed ?? []) if (!ANY_ID_RE.test(id)) throw new Error(`${NAMES.changed}: not an id: ${id}`);
  // Versions find a document's doc-* commits by its d_ id in Changed (50 §50.6).
  if (t.kind.startsWith("doc-") && !t.changed?.some((id) => ID_RE.d.test(id))) {
    throw new Error(`A ${t.kind} commit needs the document's d_ id in ${NAMES.changed}`);
  }
  if (t.device !== undefined && !DEVICE_RE.test(t.device)) throw new Error(`${NAMES.device}: not a 10-character Crockford id: ${t.device}`);
  if (t.restoredFrom !== undefined && !ISO_UTC_RE.test(t.restoredFrom)) throw new Error(`${NAMES.restoredFrom}: not an ISO-8601 UTC time: ${t.restoredFrom}`);
}

/**
 * The full commit message: `subject`, a blank line, then the trailers (e.g. subject
 * `Edit: <page title>` for an edit, `Import her source files` for the import).
 */
export function commitMessage(subject: string, trailers: Trailers): string {
  singleLine("The commit subject", subject);
  checkTrailers(trailers);
  const lines = [`${NAMES.kind}: ${trailers.kind}`];
  if (trailers.page !== undefined) lines.push(`${NAMES.page}: ${singleLine(NAMES.page, trailers.page)}`);
  if (trailers.changed?.length) lines.push(`${NAMES.changed}: ${[...new Set(trailers.changed)].join(",")}`);
  if (trailers.device !== undefined) lines.push(`${NAMES.device}: ${trailers.device}`);
  if (trailers.restoredFrom !== undefined) lines.push(`${NAMES.restoredFrom}: ${trailers.restoredFrom}`);
  if (trailers.file !== undefined) lines.push(`${NAMES.file}: ${singleLine(NAMES.file, trailers.file)}`);
  return `${subject}\n\n${lines.join("\n")}`;
}

/** Read the Pa-Studying trailers back from a commit message; null when it has no Kind trailer. */
export function parseTrailers(message: string): Trailers | null {
  const paragraphs = message.replace(/\r\n/g, "\n").trimEnd().split(/\n\s*\n/);
  const found = new Map<string, string>();
  for (const line of (paragraphs.at(-1) ?? "").split("\n")) {
    const m = /^(?<name>Pa-Studying-[A-Za-z-]+):\s?(?<value>.*)$/.exec(line);
    if (m?.groups) found.set(m.groups.name ?? "", (m.groups.value ?? "").trim());
  }
  const kind = found.get(NAMES.kind);
  if (!kind || !(COMMIT_KINDS as readonly string[]).includes(kind)) return null;
  const t: Trailers = { kind: kind as CommitKind };
  const page = found.get(NAMES.page);
  const changed = found.get(NAMES.changed);
  const device = found.get(NAMES.device);
  const restoredFrom = found.get(NAMES.restoredFrom);
  const file = found.get(NAMES.file);
  if (page !== undefined) t.page = page;
  if (changed !== undefined) t.changed = changed.split(",").map((s) => s.trim()).filter(Boolean);
  if (device !== undefined) t.device = device;
  if (restoredFrom !== undefined) t.restoredFrom = restoredFrom;
  if (file !== undefined) t.file = file;
  return t;
}
