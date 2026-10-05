// Versions of a page (plan 50 §50.6): its file set's commit history read from GitHub, the versions and
// Original among them, a version's page read at its commit (View), and Restore, a new commit through the
// §50.4 protocol. The Versions page (VersionsPage.tsx) drives these.
import { commitMessage, isContentJSON, parseTrailers, type CommitKind, type Trailers } from "../../lib/content/index.ts";
import { fileHash, guideViewHash, isGeneralKey, isRefTab, otherHash, refHash } from "../../lib/derive/routes.ts";
import { commitChanges, type CommitOutcome } from "./commit.ts";
import { deviceId, versionTime } from "./format.ts";
import { pool, type CommitInfo, type Git, type Identity, type TreeChange } from "./github.ts";
import { parsePageKey } from "./pageKey.ts";
import { Snapshot, type BlobTexts } from "./snapshot.ts";
import { UnitError, buildRestore, loadUnit, type EditUnit } from "./units.ts";

/** Commits that are versions of a page when their Changed list names one of its ids. */
const VERSION_KINDS: ReadonlySet<CommitKind> = new Set(["edit", "restore", "doc-replace", "doc-restore"]);
/** Kinds that can be the Original: content as it first came onto the site. */
const ORIGIN_KINDS: ReadonlySet<CommitKind> = new Set(["import", "curation", "authoring", "inbox"]);
/** `per_page` of each commits request; a full page means there may be more. */
export const PER_PAGE = 100;

export const ORIGINAL_FROM_WORD = "Original — converted from your Word file";
export const ORIGINAL_PUBLISHED = "Original — as first published";

export interface Version {
  sha: string;
  /** The commit's author date (ISO). */
  date: string;
  /** `date` as shown: "Oct 4, 2026, 4:37 AM". */
  time: string;
  label: string;
  current: boolean;
  original: boolean;
}

/** The label of a version commit (UI versions). */
function versionLabel(t: Trailers, device: string): string {
  switch (t.kind) {
    case "edit":
      return t.device === device ? "Your edit" : "Saved from another device";
    case "restore":
      return `Restored from ${versionTime(t.restoredFrom ?? "")}`;
    case "doc-replace":
      return `Replaced with “${t.file ?? ""}”`;
    default:
      return "Restored";
  }
}

const isVersionKind = (t: Trailers | null): t is Trailers => t !== null && VERSION_KINDS.has(t.kind);
const namesAny = (t: Trailers, ids: ReadonlySet<string>): boolean => (t.changed ?? []).some((id) => ids.has(id));

/**
 * The versions of a page among the commits of its file set (any order, each once), newest first.
 * A version is an edit, restore, doc-replace or doc-restore commit whose Changed list names one of
 * the page's `ids` at main's head, or one of its ids at that commit's parent (`idsBefore`, by commit
 * sha), so a save that only deleted rows of the page is one of its versions (Orchestrator ruling
 * 2026-10-04 20:57Z, amending 50 §50.6). The Original is the newest import, curation, authoring or
 * inbox commit older than every version, else the oldest version; it is only settled once the history
 * is `complete` (every commit of the file set read), since an older page of commits could hold an
 * older version.
 */
export function pageVersions(
  commits: Iterable<CommitInfo>, ids: readonly string[],
  opts: { fromWord: boolean; device: string; complete: boolean; idsBefore: ReadonlyMap<string, readonly string[]> },
): Version[] {
  const want = new Set(ids);
  // Stable: commits with the same time keep the order GitHub listed them in (newest first).
  const all = [...commits]
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .map((c) => ({ c, t: parseTrailers(c.message) }));
  const isVersion = (c: CommitInfo, t: Trailers | null): t is Trailers =>
    isVersionKind(t) && (namesAny(t, want) || namesAny(t, new Set(opts.idsBefore.get(c.sha) ?? [])));
  const versions = all.filter((x) => isVersion(x.c, x.t));
  const oldest = versions.at(-1);
  const original = opts.complete
    ? (all.slice(oldest ? all.indexOf(oldest) + 1 : 0).find((x) => x.t !== null && ORIGIN_KINDS.has(x.t.kind)) ?? oldest)
    : undefined;
  const rows = original && !versions.includes(original) ? [...versions, original] : versions;
  return rows.map(({ c, t }, i): Version => {
    const isOriginal = original !== undefined && c.sha === original.c.sha;
    const label = isOriginal ? (opts.fromWord ? ORIGINAL_FROM_WORD : ORIGINAL_PUBLISHED) : versionLabel(t as Trailers, opts.device);
    return { sha: c.sha, date: c.date, time: versionTime(c.date), label, current: i === 0, original: isOriginal };
  });
}

/** The paths whose commits make up a page's history: each file of its set, and each directory of a `doc:` key. */
export const historyPaths = (unit: EditUnit): string[] => [...unit.scope.files, ...unit.scope.dirs.map((d) => d.replace(/\/$/, ""))];

/** A page's commit history, read a page of commits per path at a time (at most 6 requests at once). */
export class VersionHistory {
  readonly git: Git;
  /** The page at main's head: its file set and ids. */
  readonly unit: EditUnit;
  private readonly device: string;
  /** Blob reads shared by the page's snapshots at head and at earlier commits. */
  private readonly texts: BlobTexts;
  private readonly commits = new Map<string, CommitInfo>();
  /** Commit sha → the page's ids at its parent, for version-kind commits naming none of its ids at head. */
  private readonly idsBefore = new Map<string, readonly string[]>();
  /** Commit sha → the page's ids at that commit. */
  private readonly idsAtCommit = new Map<string, Promise<readonly string[]>>();
  private readonly pages = new Map<string, number>();
  /** Paths whose last page was full, so a later page may hold more. */
  private readonly unread = new Set<string>();

  constructor(git: Git, unit: EditUnit, device: string, texts: BlobTexts = new Map()) {
    this.git = git;
    this.unit = unit;
    this.device = device;
    this.texts = texts;
  }

  /** The page's history at main's head, first page of each path read. */
  static async open(git: Git, key: string): Promise<VersionHistory> {
    const texts: BlobTexts = new Map();
    const history = new VersionHistory(git, await loadUnit(key, await Snapshot.at(git, undefined, texts)), deviceId(), texts);
    await history.read(historyPaths(history.unit));
    return history;
  }

  get complete(): boolean {
    return this.unread.size === 0;
  }

  /** The next page of every path that may have more (she scrolled to the end of the list). */
  async more(): Promise<void> {
    await this.read([...this.unread]);
  }

  private async read(paths: readonly string[]): Promise<void> {
    await pool(paths, 6, async (path) => {
      const page = (this.pages.get(path) ?? 0) + 1;
      const list = await this.git.commits(path, { perPage: PER_PAGE, page });
      this.pages.set(path, page);
      if (list.length === PER_PAGE) this.unread.add(path);
      else this.unread.delete(path);
      for (const c of list) if (!this.commits.has(c.sha)) this.commits.set(c.sha, c);
    });
    await this.readIdsBefore();
  }

  /**
   * The page's ids at the parent of each version-kind commit read so far whose Changed list names none
   * of its ids at head: only such a commit can be a version through ids it has since lost.
   */
  private async readIdsBefore(): Promise<void> {
    const head = new Set(this.unit.ids);
    const pending = [...this.commits.values()].filter((c) => {
      if (this.idsBefore.has(c.sha)) return false;
      const t = parseTrailers(c.message);
      return isVersionKind(t) && !namesAny(t, head);
    });
    await pool(pending, 6, async (c) => {
      const parent = c.parents[0];
      this.idsBefore.set(c.sha, parent === undefined ? [] : await this.idsAt(parent));
    });
  }

  private idsAt(commit: string): Promise<readonly string[]> {
    let ids = this.idsAtCommit.get(commit);
    if (!ids) {
      ids = this.loadIds(commit);
      this.idsAtCommit.set(commit, ids);
      ids.catch(() => this.idsAtCommit.delete(commit));
    }
    return ids;
  }

  /** The page's ids at `commit`; none when the page was not there then. */
  private async loadIds(commit: string): Promise<readonly string[]> {
    try {
      return (await loadUnit(this.unit.key, await Snapshot.at(this.git, commit, this.texts))).ids;
    } catch (e) {
      if (e instanceof UnitError) return [];
      throw e;
    }
  }

  versions(): Version[] {
    return pageVersions(this.commits.values(), this.unit.ids, {
      fromWord: this.unit.fromWord, device: this.device, complete: this.complete, idsBefore: this.idsBefore,
    });
  }
}

/** The page as it was at a version (View): its files read from that commit's tree. */
export async function viewVersion(git: Git, key: string, sha: string): Promise<EditUnit> {
  return loadUnit(key, await Snapshot.at(git, sha));
}

/**
 * A `doc:` restore (tree re-point): every current entry under the key's directories is replaced by the
 * entries they had at the version, by blob sha (nothing is uploaded), and entries absent then are
 * deleted. The directories are the key's file set at either commit, so a restore across a change of
 * kind moves the document back, and the psych deck's slides go back with its document.
 */
async function repoint(unit: EditUnit, version: EditUnit): Promise<{ changes: TreeChange[]; files: Map<string, unknown> }> {
  const dirs = [...new Set([...unit.scope.dirs, ...version.scope.dirs])];
  const changes: TreeChange[] = [];
  const files = new Map<string, unknown>();
  for (const dir of dirs) {
    const then = version.snapshot.under(dir);
    for (const path of then) {
      const sha = version.snapshot.files.get(path) as string;
      if (unit.snapshot.files.get(path) === sha) continue;
      changes.push({ path, sha });
      if (isContentJSON(path)) files.set(path, await version.snapshot.json(path));
    }
    for (const path of unit.snapshot.under(dir)) if (!then.includes(path)) changes.push({ path, sha: null });
  }
  return { changes, files };
}

export interface RestoreRequest {
  git: Git;
  author: Identity;
  key: string;
  /** The page title, for the commit subject. */
  title: string;
  version: Version;
}

export type RestoreResult = CommitOutcome & {
  /** Parsed contents of the files a landed restore wrote (the local overlay, 50 §50.5). */
  files: Map<string, unknown>;
};

/**
 * Restore (50 §50.6): a commit of Kind `restore` with `Restored-From` = the version's time, through the
 * §50.4 commit protocol against main's head. A version whose content is already current writes nothing.
 */
export async function restoreVersion(req: RestoreRequest): Promise<RestoreResult> {
  const head = await Snapshot.at(req.git);
  const unit = await loadUnit(req.key, head);
  const version = await viewVersion(req.git, req.key, req.version.sha);
  const built = unit.docId !== null
    ? { ...(await repoint(unit, version)), changed: [unit.docId] }
    : await buildRestore(unit, version);
  if (built.changes.length === 0) return { kind: "saved", commit: head.commit, files: new Map() };
  const message = commitMessage(`Restore: ${req.title}`, {
    kind: "restore",
    page: req.key,
    changed: built.changed.length > 0 ? built.changed : unit.ids.slice(0, 1),
    device: deviceId(),
    restoredFrom: new Date(req.version.date).toISOString(),
  });
  const outcome = await commitChanges({
    git: req.git, base: head.commit, baseFiles: head.files, scope: unit.scope, changes: built.changes, message, author: req.author,
  });
  return { ...outcome, files: built.files };
}

/** The route of the page a key edits, for "Back to the page" when Versions was opened without one. */
export function pageHash(key: string): string | null {
  const k = parsePageKey(key);
  switch (k?.kind) {
    case "topic":
      return guideViewHash(k.guide, { kind: "topics", ids: [k.row] });
    case "section":
      return guideViewHash(k.guide, { kind: "section", system: k.system, section: k.section });
    case "system":
      return guideViewHash(k.guide, { kind: "system", system: k.system });
    case "listed":
      return guideViewHash(k.guide, { kind: "block", id: k.block });
    case "pharm":
      return guideViewHash(k.guide, { kind: "pharm", system: k.system, section: k.section, target: null });
    case "general":
      return isGeneralKey(k.key) ? guideViewHash(k.guide, { kind: "general", key: k.key }) : null;
    case "workup":
      return guideViewHash(k.guide, { kind: "workup", item: k.item });
    case "slide":
      return guideViewHash(k.guide, { kind: "slides", n: 1 });
    case "ref":
      return isRefTab(k.tab) ? refHash(k.tab, k.sub) : null;
    case "other":
      return otherHash(k.section);
    case "doc":
      return fileHash(k.doc, null);
    default:
      return null;
  }
}

// ---- where Versions was opened from ----------------------------------------------------------------

const ORIGIN_KEY = "pa.versions";

export interface VersionsOrigin {
  title: string;
  /** The route Versions was opened from. */
  back: string;
}

function origins(): Record<string, VersionsOrigin> {
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(ORIGIN_KEY) ?? "{}");
    return typeof v === "object" && v !== null ? (v as Record<string, VersionsOrigin>) : {};
  } catch {
    return {};
  }
}

/** Versions is being opened for `key` from the page titled `title` at route `back` (kept for this tab). */
export function rememberVersionsOrigin(key: string, origin: VersionsOrigin): void {
  sessionStorage.setItem(ORIGIN_KEY, JSON.stringify({ ...origins(), [key]: origin }));
}

export function versionsOrigin(key: string): VersionsOrigin | null {
  return origins()[key] ?? null;
}
