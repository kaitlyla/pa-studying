// Adding and replacing documents in the browser (plan 50 §50.7 checks, §50.9 Browser upload): the
// checks before anything is uploaded, then the upload as resumable steps with the retry rule, its
// state for the owner's lists and pages, and "Download original" while it is processed.
import { useSyncExternalStore } from "react";
import {
  inboxItemDir, inboxUploadPath, newId, parseFile, partName, serializeFile, UPLOAD_EXTS, UPLOAD_KIND, UPLOAD_NAME, type UploadExt,
  type UploadFile,
} from "../../lib/content/index.ts";
import { BUILD_PATH, type BuildJson } from "../../lib/derive/published.ts";
import { waitForSignIn } from "../auth/auth.ts";
import { SignedOutError } from "../auth/session.ts";
import { DATA_BASE } from "../data/load.ts";
import { addDocRecord, addedFiles, markReplacing, processingRecord, storedBytes, type DocOutcome, type DocPlace } from "./docs.ts";
import { ApiError, NetworkError, retry, type Git, type Identity } from "./github.ts";
import { dropUnsaved, recordSaved, showUnsaved } from "./overlay.ts";
import { Snapshot } from "./snapshot.ts";

/** The file picker's accept list (UI other-tab/add-doc). */
export const DOC_ACCEPT = UPLOAD_EXTS.map((e) => `.${e}`).join(",");
/** The largest file she can add (50 §50.7 check 2). */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** The site's hosting limit (50 §50.7 check 3, operator ruling 2C). */
export const SITE_LIMIT_BYTES = 1_000_000_000;
/** Raw bytes per uploaded part (50 §50.9 step 3). */
export const PART_BYTES = 16 * 1024 * 1024;
/** Kept on the site twice: the original plus its converted view (50 §50.7 check 3). */
const STORED_TWICE: ReadonlySet<UploadExt> = new Set(["ppt", "pptx", "doc"]);
/** Waits before the retries of a failed step 3–7 (50 §50.9). */
export const STEP_RETRY_MS = [2000, 4000, 8000] as const;
/** Inbox branches older than this are left over from closed tabs (50 §50.9). */
const STALE_BRANCH_MS = 24 * 3600 * 1000;
export const PROCESS_WORKFLOW = "process-inbox.yml";

// ---- wording (signed mockup ui-edit.js / ui-app.js; plan 50 §50.7, §50.9 for the rest) -----------

export const TYPE_REFUSED = "That file type can’t be added. Use a Word file, a PDF, an image (PNG or JPG) or a PowerPoint.";
export const TOO_BIG = (bytes: number): string => `This file is ${(bytes / 1048576).toFixed(0)} MB. The site’s free hosting holds files up to 100 MB.`;
export const SITE_FULL = "The site’s free hosting is full (1 GB). Remove a document to make room.";
export const CHOOSE_FILE = "Choose a file first.";
export const NAME_BLANK = "Give the document a name.";

// ---- checks (pure) -------------------------------------------------------------------------------

/** The file name's last extension if it is one she can add, lower-cased; otherwise null. */
export function uploadExt(fileName: string): UploadExt | null {
  const m = /\.([^.]+)$/.exec(fileName);
  const ext = m?.[1]?.toLowerCase();
  return ext !== undefined && (UPLOAD_EXTS as readonly string[]).includes(ext) ? (ext as UploadExt) : null;
}

/** The name field's default: the file name without its last extension (`Lipids 2024.pdf` → `Lipids 2024`). */
export function defaultName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

/** Checks 1 and 2 of 50 §50.7: the first failure's message, or null. */
export function fileProblem(file: { name: string; size: number }): string | null {
  if (uploadExt(file.name) === null) return TYPE_REFUSED;
  if (file.size > MAX_FILE_BYTES) return TOO_BIG(file.size);
  return null;
}

/** Check 3 of 50 §50.7 for a file of `size` bytes: the message when the site would pass 1 GB, or null. */
export function spaceProblem(siteBytes: number, size: number, ext: UploadExt, replacedBytes = 0): string | null {
  const projected = siteBytes + size * (STORED_TWICE.has(ext) ? 2 : 1) - replacedBytes;
  return projected > SITE_LIMIT_BYTES ? SITE_FULL : null;
}

/** `build.json.siteBytes` as deployed now. A connection failure is a NetworkError. */
export async function readSiteBytes(): Promise<number> {
  let res: Response;
  try {
    res = await fetch(`${DATA_BASE}${BUILD_PATH}`, { cache: "no-store" });
  } catch (e) {
    if (e instanceof TypeError) throw new NetworkError();
    throw e;
  }
  if (!res.ok) throw new Error(`${BUILD_PATH}: HTTP ${res.status}`);
  return ((await res.json()) as BuildJson).siteBytes;
}

/** All three checks for adding (`replaceId` absent) or replacing a document with `file`. */
export async function checkUpload(git: Git, file: { name: string; size: number }, replaceId?: string): Promise<string | null> {
  const problem = fileProblem(file);
  if (problem !== null) return problem;
  const ext = uploadExt(file.name) as UploadExt;
  const [site, replaced] = await Promise.all([readSiteBytes(), replaceId === undefined ? 0 : storedBytes(git, replaceId)]);
  return spaceProblem(site, file.size, ext, replaced);
}

// ---- encoding ------------------------------------------------------------------------------------

async function sha256Hex(file: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const partCount = (size: number): number => Math.max(1, Math.ceil(size / PART_BYTES));

// ---- the upload --------------------------------------------------------------------------------------

/** running: steps under way; offline / failed: stopped at a step, "Try again" resumes it. */
export type UploadStatus = "running" | "offline" | "failed";

/** An upload as the owner's views see it. */
export interface UploadView {
  id: string;
  name: string;
  fileName: string;
  replaces: boolean;
  status: UploadStatus;
}

interface Job {
  id: string;
  file: Blob;
  fileName: string;
  ext: UploadExt;
  name: string;
  /** Add: the list it goes to. Replace: null. */
  place: DocPlace | null;
  at: string;
  git: Git;
  author: Identity;
  /** The next step to run (2–9, 50 §50.9); 10 when done. */
  step: number;
  status: UploadStatus;
  sha256: string | null;
  parts: string[];
  uploadBlob: string | null;
  tree: string | null;
  commit: string | null;
  /** Add: the files shown before step 8 commits them. */
  shown: string[];
}

const jobs = new Map<string, Job>();
let views: readonly UploadView[] = [];
const listeners = new Set<() => void>();

function changed(): void {
  views = [...jobs.values()].map((j) => ({ id: j.id, name: j.name, fileName: j.fileName, replaces: j.place === null, status: j.status }));
  for (const l of listeners) l();
}

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const getViews = (): readonly UploadView[] => views;

/** Uploads not finished (steps 3–9 still to run or stopped). */
export function useUploads(): readonly UploadView[] {
  return useSyncExternalStore(subscribe, getViews);
}

export const uploadsInProgress = (): readonly UploadView[] => views;

/** `beforeunload` warns while an upload has steps left (50 §50.9). */
export function onUploadBeforeUnload(e: BeforeUnloadEvent): void {
  if (jobs.size > 0) {
    e.preventDefault();
    e.returnValue = "";
  }
}

/** Forget every upload (tests; sign-out never cancels one). */
export function resetUploadsForTests(): void {
  jobs.clear();
  changed();
}

/** A failure in steps 3–7 is retried 3 times, 2 s, 4 s and 8 s apart. */
async function withRetries<T>(step: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await step();
    } catch (e) {
      if (!(e instanceof NetworkError || e instanceof ApiError)) throw e;
      const delay = STEP_RETRY_MS[attempt];
      if (delay === undefined) throw e;
      await retry.sleep(delay);
    }
  }
}

/** A §50.4 commit's outcome as a step result: saved is recorded; anything else stops the upload. */
async function settle(outcome: DocOutcome): Promise<void> {
  if (outcome.kind === "saved") {
    if (outcome.files.size > 0) await recordSaved(outcome.files, outcome.commit);
    return;
  }
  if (outcome.kind === "offline") throw new NetworkError();
  throw new Error(`The upload's commit on main was not saved (${outcome.kind})`);
}

/** Step 7's first half: deletes inbox branches left more than 24 h ago; returns the refs that remain. */
async function clearStaleBranches(git: Git): Promise<Map<string, string>> {
  const refs = await git.matchingRefs("heads/inbox/");
  const left = new Map<string, string>();
  for (const r of refs) {
    if (Date.now() - Date.parse(await git.commitDate(r.sha)) > STALE_BRANCH_MS) await git.deleteRef(r.ref);
    else left.set(r.ref, r.sha);
  }
  return left;
}

const STEPS: Record<number, (j: Job) => Promise<void>> = {
  2: async (j) => {
    j.sha256 = await sha256Hex(j.file);
  },
  3: async (j) => {
    for (let i = j.parts.length; i < partCount(j.file.size); i++) {
      const bytes = new Uint8Array(await j.file.slice(i * PART_BYTES, (i + 1) * PART_BYTES).arrayBuffer());
      j.parts.push(await j.git.createBlob(base64(bytes), "base64"));
    }
  },
  4: async (j) => {
    const upload: UploadFile = {
      v: 1, id: j.id, fileName: j.fileName, ext: j.ext, size: j.file.size, sha256: j.sha256 ?? "", parts: j.parts.length, replaces: j.place === null ? true : null,
    };
    j.uploadBlob = await j.git.createBlob(serializeFile(inboxUploadPath(j.id), upload));
  },
  5: async (j) => {
    const dir = inboxItemDir(j.id);
    j.tree = await j.git.createTree([
      ...j.parts.map((sha, i) => ({ path: `${dir}/${partName(i)}`, sha })),
      { path: inboxUploadPath(j.id), sha: j.uploadBlob ?? "" },
    ]);
  },
  6: async (j) => {
    j.commit = await j.git.createCommit(`Inbox: ${j.fileName.replace(/[\r\n]+/g, " ")}`, j.tree ?? "", [await j.git.ref()], j.author);
  },
  7: async (j) => {
    const ref = `refs/heads/inbox/${j.id}`;
    const existing = (await clearStaleBranches(j.git)).get(ref);
    if (existing === j.commit) return;
    // A newer upload for the same document replaces the branch of the one before it.
    if (existing !== undefined) await j.git.deleteRef(ref);
    await j.git.createRef(ref, j.commit ?? "");
  },
  8: async (j) => {
    if (j.place !== null) {
      const record = processingRecord(j.id, j.name, UPLOAD_KIND[j.ext], j.fileName);
      await settle(await addDocRecord({ git: j.git, author: j.author, place: j.place, record }));
      dropUnsaved(j.shown);
      j.shown = [];
    } else {
      await settle(await markReplacing({ git: j.git, author: j.author, docId: j.id, fileName: j.fileName, at: j.at }));
    }
  },
  9: async (j) => {
    await j.git.dispatch(PROCESS_WORKFLOW, { item: j.id });
  },
};

async function run(j: Job): Promise<void> {
  j.status = "running";
  changed();
  try {
    while (j.step <= 9) {
      const step = STEPS[j.step] as (job: Job) => Promise<void>;
      await (j.step >= 3 && j.step <= 7 ? withRetries(() => step(j)) : step(j));
      j.step += 1;
    }
    jobs.delete(j.id);
    changed();
  } catch (e) {
    if (e instanceof SignedOutError) {
      if (await waitForSignIn()) return run(j);
      j.status = "offline";
    } else if (e instanceof NetworkError) {
      j.status = "offline";
    } else {
      console.error("Upload failed", e);
      j.status = "failed";
    }
    changed();
  }
}

/** "Try again": resumes the upload at the step that failed; the parts already uploaded are kept. */
export function retryUpload(id: string): Promise<void> {
  const j = jobs.get(id);
  return j && j.status !== "running" ? run(j) : Promise.resolve();
}

export interface StartUpload {
  git: Git;
  author: Identity;
  file: File;
  /** Add: the name she gave, and the list. Replace: the document's id. */
  name: string;
  place?: DocPlace;
  replaceId?: string;
}

/**
 * Starts adding or replacing a document (the checks have passed). An added document shows at the end
 * of its list at once (§50.5 overlay); the upload then runs in the background. Resolves once it shows.
 */
export async function startUpload(req: StartUpload): Promise<string> {
  const ext = uploadExt(req.file.name);
  if (ext === null) throw new Error(`Not a file type she can add: ${req.file.name}`);
  const id = req.replaceId ?? newId("d");
  const j: Job = {
    id, file: req.file, fileName: req.file.name, ext, name: req.name.trim(), place: req.place ?? null, at: new Date().toISOString(),
    git: req.git, author: req.author, step: 2, status: "running", sha256: null, parts: [], uploadBlob: null, tree: null, commit: null, shown: [],
  };
  if (j.place !== null) {
    const files = await addedFiles(await Snapshot.at(req.git), j.place, processingRecord(id, j.name, UPLOAD_KIND[ext], j.fileName));
    showUnsaved(files);
    j.shown = [...files.keys()];
  }
  jobs.set(id, j);
  void run(j);
  return id;
}

// ---- Download original while processing (D1) or after it failed (E1) ------------------------------

/** Her file, from this tab's upload while it has steps left (before the inbox branch exists). */
export function localOriginal(docId: string): { fileName: string; blob: Blob } | null {
  const j = jobs.get(docId);
  return j ? { fileName: j.fileName, blob: j.file } : null;
}

/** Her file, from the inbox branch's parts while it is processed; null when the branch is gone. */
export async function inboxOriginal(git: Git, docId: string): Promise<{ fileName: string; blob: Blob } | null> {
  const ref = (await git.matchingRefs(`heads/inbox/${docId}`)).find((r) => r.ref === `refs/heads/inbox/${docId}`);
  if (!ref) return null;
  const files = await git.files(ref.sha);
  const dir = inboxItemDir(docId);
  const uploadSha = files.get(`${dir}/${UPLOAD_NAME}`);
  if (uploadSha === undefined) return null;
  const upload = parseFile<UploadFile>(inboxUploadPath(docId), await git.blobText(uploadSha));
  const parts: Uint8Array[] = [];
  for (let i = 0; i < upload.parts; i++) {
    const sha = files.get(`${dir}/${partName(i)}`);
    if (sha === undefined) return null;
    parts.push(await git.blobBytes(sha));
  }
  return { fileName: upload.fileName, blob: new Blob(parts as BlobPart[]) };
}

/** A stored file of the document at main's head (`content/files/<d>/<name>`), or null. */
export async function storedOriginal(git: Git, docId: string, name: string): Promise<Blob | null> {
  const sha = (await git.files(await git.ref())).get(`content/files/${docId}/${name}`);
  return sha === undefined ? null : new Blob([(await git.blobBytes(sha)) as BlobPart]);
}

/** Saves `blob` under `fileName` through a temporary link. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
