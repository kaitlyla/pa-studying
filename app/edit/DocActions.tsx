// The owner's document actions (plan 50 §50.7–§50.9; UI other-tab/add-doc and the signed mockup's
// DocActs / AddDocButton / RemovedDocs): Rename, Replace and Remove on a document's page, Add document
// on its lists, Restore from "Removed documents", the processing (D1) and failed (E1) pages, an
// upload's problem, and the failed-replacement note with Dismiss (Orchestrator ruling 2026-10-04
// 20:39Z, amending 50 §50.9 step 4).
import { useEffect, useState, type ChangeEvent, type ReactNode } from "react";
import type { AsIsFile, WordDocFile } from "../../lib/content/index.ts";
import type { DocJson, PendingDoc, RemovedDoc, SiteJson } from "../../lib/derive/published.ts";
import { waitForSignIn } from "../auth/auth.ts";
import { SignedOutError } from "../auth/session.ts";
import { DataOfflineError } from "../data/load.ts";
import { Icon } from "../shell/Icon.tsx";
import { Link } from "../shell/Link.tsx";
import { NotOnSite } from "../shell/NotOnSite.tsx";
import { useOwner } from "../shell/owner.tsx";
import { PageHead } from "../shell/Page.tsx";
import { fileHash, navigate, stripQuery, useRoute } from "../shell/route.ts";
import { showToast } from "../shell/toast.tsx";
import { Dialog } from "./dialogs.tsx";
import { dismissReplaceFailed, docRecordPath, removeDoc, renameDoc, restoreDoc, type DocOutcome, type DocPlace } from "./docs.ts";
import { shortDate, versionTime } from "./format.ts";
import { NetworkError, type Git, type Identity } from "./github.ts";
import { recordSaved } from "./overlay.ts";
import { repo, SAVE_FAILED, SAVE_OFFLINE, useIsEditing } from "./session.ts";
import { Snapshot } from "./snapshot.ts";
import {
  CHOOSE_FILE, checkUpload, defaultName, DOC_ACCEPT, fileProblem, inboxOriginal, localOriginal, NAME_BLANK, retryUpload, saveBlob, startUpload,
  storedOriginal, useUploads,
} from "./upload.ts";

// ---- wording (signed mockup ui-edit.js / ui-app.js; D1 and E1 as the plan quotes them) ---------------

/** The failed-replacement note (design editing/docs/rules/replacefail). */
export const REPLACE_FAILED_NOTE = (fileName: string, date: string): string =>
  `Couldn’t replace with ${fileName} (${date}). The old file is still here. Try again.`;
/** Its control (design editing/docs/rules/replacefail). */
export const DISMISS = "Dismiss";
export const ADD_INTRO = "Word files become editable, searchable pages like your other Word files. PDFs, images and PowerPoints show as they are. It’s added at the end of the list.";
export const ADDED = (name: string): string => `Added “${name}”. Everyone will see it within a few minutes, and search includes it.`;
export const REPLACED = (name: string, fileName: string): string => `Replaced “${name}” with ${fileName}. The previous file is kept in Versions.`;
export const RENAMED = (name: string): string => `Renamed to “${name}”.`;
export const REMOVED = (name: string): string => `Removed “${name}”.`;
export const RESTORED = (name: string): string => `Restored “${name}”.`;
export const REMOVE_BODY = "It will no longer show on the site or in search. Links to it from other pages are removed too. You can restore it later from “Removed documents” at the bottom of this section.";
export const DOWNLOAD_ORIGINAL = "Download original";
export const PROCESSING_NOTE = "It will show here within a few minutes.";
export const FAILED_NOTE = "This file couldn’t be shown on the site. You can download it, or remove it and try another copy.";
export const TRY_AGAIN = "Try again";

/** How long the Removed toast (with Undo) stays (mockup ui-app.js removeDoc). */
const REMOVED_TOAST_MS = 8000;

// ---- running an action as the owner ----------------------------------------------------------------

interface Failure {
  offline: string;
  failed: string;
}
const SAVE_FAILURE: Failure = { offline: SAVE_OFFLINE, failed: SAVE_FAILED.title };
/** "Download original" could not get her file (wording proposed to the operator by the Leader, 2026-10-05; not yet approved). */
export const DOWNLOAD_FAILURE: Failure = {
  offline: "Couldn’t download the file — no internet connection.",
  failed: "Couldn’t download the file.",
};

const authorOf = (site: SiteJson): Identity => ({ name: site.owner.commitName, email: site.owner.commitEmail });
const isOffline = (e: unknown): boolean => e instanceof NetworkError || e instanceof DataOfflineError;

/**
 * Runs `fn` with the repository and her commit identity. A lapsed sign-in waits for her to sign in
 * again, then runs it again; a failure is shown as a toast and gives null.
 */
async function asOwner<T>(fn: (git: Git, author: Identity) => Promise<T>, failure: Failure = SAVE_FAILURE): Promise<T | null> {
  try {
    const { git, site } = await repo();
    return await fn(git, authorOf(site));
  } catch (e) {
    if (e instanceof SignedOutError) return (await waitForSignIn()) ? asOwner(fn, failure) : null;
    if (isOffline(e)) {
      showToast(failure.offline);
    } else {
      console.error("Document action failed", e);
      showToast(failure.failed);
    }
    return null;
  }
}

type Saved = DocOutcome & { kind: "saved" };

/** Writes a document commit; when saved, shows it in this tab at once and returns it. */
async function runDoc(write: (git: Git, author: Identity) => Promise<DocOutcome>): Promise<Saved | null> {
  const r = await asOwner(write);
  if (r === null) return null;
  if (r.kind === "saved") {
    if (r.files.size > 0) await recordSaved(r.files, r.commit);
    return r;
  }
  showToast(r.kind === "offline" ? SAVE_OFFLINE : SAVE_FAILED.title);
  return null;
}

async function restore(docId: string, name: string): Promise<void> {
  const r = await runDoc((git, author) => restoreDoc({ git, author, docId }));
  if (r && r.files.size > 0) showToast(RESTORED(name));
}

// ---- the failed-replacement note ---------------------------------------------------------------------

/** Owner only: the document's last replacement failed. */
export function ReplaceFailedNote({ doc }: { doc: DocJson }): ReactNode {
  const { owner } = useOwner();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const failed = doc.replaceFailed;
  if (!owner || !failed || dismissed === failed.at) return null;

  const dismiss = async (): Promise<void> => {
    setBusy(true);
    const r = await runDoc((git, author) => dismissReplaceFailed({ git, author, docId: doc.id }));
    setBusy(false);
    if (r) setDismissed(failed.at);
  };

  return (
    <div className="banner err" role="status" data-ref="replace-failed">
      <span className="bt">{REPLACE_FAILED_NOTE(failed.fileName, shortDate(failed.at))}</span>
      <span className="ba">
        <button type="button" className="btn" disabled={busy} onClick={() => void dismiss()} data-ref="replace-failed-dismiss">{DISMISS}</button>
      </span>
    </div>
  );
}

// ---- Rename / Replace / Remove ------------------------------------------------------------------------

/**
 * Rename, Replace and Remove on a document's page (owner only, not while editing). After Remove she
 * goes back to `from`, else to the document's first placement.
 */
export function DocActions({ doc, from = null }: { doc: DocJson; from?: string | null }): ReactNode {
  const { owner } = useOwner();
  const editing = useIsEditing();
  const [mode, setMode] = useState<"rename" | "remove" | null>(null);
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  if (!owner || editing) return null;

  const close = (): void => {
    setMode(null);
    setErr("");
  };

  const rename = async (): Promise<void> => {
    const next = name.trim();
    if (!next) {
      setErr(NAME_BLANK);
      return;
    }
    close();
    const before = doc.name;
    const r = await runDoc((git, author) => renameDoc({ git, author, docId: doc.id, name: next }));
    if (r && r.files.size > 0) {
      showToast(RENAMED(next), { undo: () => void runDoc((git, author) => renameDoc({ git, author, docId: doc.id, name: before })) });
    }
  };

  const replace = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const bad = fileProblem(file);
    if (bad) {
      showToast(bad);
      return;
    }
    const problem = await asOwner(async (git, author) => {
      const p = await checkUpload(git, file, doc.id);
      if (p === null) await startUpload({ git, author, file, name: doc.name, replaceId: doc.id });
      return p ?? "";
    });
    if (problem === null) return;
    showToast(problem === "" ? REPLACED(doc.name, file.name) : problem);
  };

  const remove = async (): Promise<void> => {
    close();
    const removedName = doc.name;
    const r = await runDoc((git, author) => removeDoc({ git, author, docId: doc.id }));
    if (!r || r.files.size === 0) return;
    await navigate(from ?? doc.home ?? "#/");
    showToast(REMOVED(removedName), { ms: REMOVED_TOAST_MS, undo: () => void restore(doc.id, removedName) });
  };

  return (
    <>
      <button type="button" className="btn" onClick={() => { setName(doc.name); setMode("rename"); }} data-ref="doc-rename">Rename</button>
      <label className="btn" data-ref="doc-replace">
        Replace
        <input type="file" accept={DOC_ACCEPT} onChange={(e) => void replace(e)} className="sr-file" data-ref="doc-replace-file" />
      </label>
      <button type="button" className="btn danger" onClick={() => setMode("remove")} data-ref="doc-remove">Remove</button>
      {mode === "rename" && (
        <Dialog
          title="Rename document"
          onClose={close}
          actions={<>
            <button type="button" className="btn" onClick={close} data-ref="doc-rename-cancel">Cancel</button>
            <button type="button" className="btn pri" onClick={() => void rename()} data-ref="doc-rename-save">Rename</button>
          </>}
        >
          <label className="fld">
            <span>Name shown on the site</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void rename(); }} data-ref="doc-rename-name" />
          </label>
          {err && <p className="fld-err" role="alert">{err}</p>}
        </Dialog>
      )}
      {mode === "remove" && (
        <Dialog
          title={`Remove “${doc.name}”?`}
          onClose={close}
          actions={<>
            <button type="button" className="btn" onClick={close} data-ref="doc-remove-cancel">Cancel</button>
            <button type="button" className="btn danger" onClick={() => void remove()} data-ref="doc-remove-confirm">Remove</button>
          </>}
        >
          <p>{REMOVE_BODY}</p>
        </Dialog>
      )}
    </>
  );
}

// ---- Add document ---------------------------------------------------------------------------------------

/** "+ Add document" on an Other section or a reference tab (owner only, not while editing). */
export function AddDocument({ place, title }: { place: DocPlace; title: string }): ReactNode {
  const { owner } = useOwner();
  const editing = useIsEditing();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  if (!owner || editing) return null;

  const close = (): void => {
    setOpen(false);
    setFile(null);
    setName("");
    setErr("");
  };

  const pick = (e: ChangeEvent<HTMLInputElement>): void => {
    const f = e.target.files?.[0];
    setErr("");
    if (!f) return;
    const bad = fileProblem(f);
    if (bad) {
      setFile(null);
      setErr(bad);
      return;
    }
    setFile(f);
    if (!name) setName(defaultName(f.name));
  };

  const add = async (): Promise<void> => {
    if (!file) {
      setErr(CHOOSE_FILE);
      return;
    }
    const n = name.trim();
    if (!n) {
      setErr(NAME_BLANK);
      return;
    }
    setBusy(true);
    const problem = await asOwner(async (git, author) => {
      const p = await checkUpload(git, file);
      if (p === null) await startUpload({ git, author, file, name: n, place });
      return p ?? "";
    });
    setBusy(false);
    if (problem === null) return;
    if (problem !== "") {
      setErr(problem);
      return;
    }
    close();
    showToast(ADDED(n));
  };

  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)} data-ref="add-doc"><span aria-hidden="true">+</span> Add document</button>
      {open && (
        <Dialog
          title={`Add a document to ${title}`}
          onClose={close}
          actions={<>
            <button type="button" className="btn" onClick={close} data-ref="add-doc-cancel">Cancel</button>
            <button type="button" className="btn pri" disabled={busy} onClick={() => void add()} data-ref="add-doc-confirm">Add</button>
          </>}
        >
          <p style={{ marginTop: 0 }}>{ADD_INTRO}</p>
          <label className="fld"><span>File</span><input type="file" accept={DOC_ACCEPT} onChange={pick} data-ref="add-doc-file" /></label>
          <label className="fld"><span>Name shown on the site</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} data-ref="add-doc-name" /></label>
          {err && <p className="fld-err" role="alert" data-ref="add-doc-error">{err}</p>}
        </Dialog>
      )}
    </>
  );
}

// ---- Removed documents ------------------------------------------------------------------------------------

/** "Show removed documents (n)" with Restore for each (owner only). */
export function RemovedDocs({ items }: { items: readonly RemovedDoc[] }): ReactNode {
  const { owner } = useOwner();
  const [open, setOpen] = useState(false);
  if (!owner || items.length === 0) return null;
  return (
    <div className="gsec rm-docs" data-ref="removed-docs">
      <button type="button" className="linkbtn" aria-expanded={open} onClick={() => setOpen(!open)} data-ref="removed-docs-toggle">
        {open ? "Hide" : "Show"} removed documents ({items.length})
      </button>
      {open && (
        <ul className="vlist">
          {items.map((r) => (
            <li key={r.id}>
              <span className="vt"><b>{r.name}</b><small>Removed {versionTime(r.at)}</small></span>
              <button type="button" className="btn" onClick={() => void restore(r.id, r.name)} data-ref={`restore-doc-${r.id}`}>Restore</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- uploads: their problems, and the processing and failed documents ---------------------------------

/** The upload of document `id` stopped at a step: its banner, with "Try again" (owner only). */
export function UploadProblem({ id }: { id: string }): ReactNode {
  const { owner } = useOwner();
  const upload = useUploads().find((u) => u.id === id);
  if (!owner || !upload || upload.status === "running") return null;
  return (
    <div className="banner err" role="alert" data-ref="upload-failed">
      <span className="bt"><b>{upload.status === "offline" ? SAVE_OFFLINE : SAVE_FAILED.title}</b></span>
      <span className="ba">
        <button type="button" className="btn pri" onClick={() => void retryUpload(id)} data-ref="upload-retry">{TRY_AGAIN}</button>
      </span>
    </div>
  );
}

/** Her documents still processing or failed in a list (owner only): each opens its page. */
export function PendingDocs({ items }: { items: readonly PendingDoc[] }): ReactNode {
  const { owner } = useOwner();
  const route = useRoute();
  if (!owner || items.length === 0) return null;
  return (
    <ul className="vlist pend-docs" data-ref="pending-docs">
      {items.map((p) => (
        <li key={p.id}>
          <span className="vt"><Link to={fileHash(p.id, stripQuery(route.path))}><b>{p.name}</b></Link></span>
          <UploadProblem id={p.id} />
        </li>
      ))}
    </ul>
  );
}

type PendingState =
  | { kind: "loading" }
  | { kind: "processing"; name: string }
  | { kind: "failed"; record: AsIsFile }
  | { kind: "gone" };

/** The document's state from main's head: processing, failed, or not a pending document. */
async function pendingState(id: string): Promise<PendingState> {
  const state = await asOwner(async (git) => {
    const head = await Snapshot.at(git);
    const path = docRecordPath(head, id);
    if (!head.has(path)) return { kind: "gone" } as const;
    const record = await head.json<WordDocFile | AsIsFile>(path);
    if (record.removed || !("state" in record)) return { kind: "gone" } as const;
    if (record.state === "failed") return { kind: "failed", record } as const;
    if (record.state === "processing") return { kind: "processing", name: record.name } as const;
    return { kind: "gone" } as const;
  });
  return state ?? { kind: "gone" };
}

/** "Download original": this tab's upload, else the inbox branch's parts (D1), else her stored file (E1). */
async function downloadOriginal(id: string, failed: AsIsFile | null): Promise<void> {
  const local = localOriginal(id);
  if (local) {
    saveBlob(local.blob, local.fileName);
    return;
  }
  await asOwner(async (git) => {
    if (failed?.original) {
      const blob = await storedOriginal(git, id, failed.original);
      if (blob) {
        saveBlob(blob, failed.original);
        return;
      }
    }
    const inbox = await inboxOriginal(git, id);
    if (inbox) {
      saveBlob(inbox.blob, inbox.fileName);
      return;
    }
    throw new Error(`No original for ${id}`);
  }, DOWNLOAD_FAILURE);
}

/**
 * The owner's page for a document with no published page: processing (D1), failed (E1), or neither
 * ("isn't on the site"). An upload in this tab shows as processing at once.
 */
export function PendingDocPage({ id }: { id: string }): ReactNode {
  const upload = useUploads().find((u) => u.id === id && !u.replaces);
  const [state, setState] = useState<PendingState>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    void pendingState(id).then((s) => {
      if (live) setState(s);
    });
    return () => {
      live = false;
    };
  }, [id]);

  const shown: PendingState = upload ? { kind: "processing", name: upload.name } : state;
  if (shown.kind === "loading") return null;
  if (shown.kind === "gone") return <NotOnSite />;
  const failed = shown.kind === "failed" ? shown.record : null;
  const name = shown.kind === "failed" ? shown.record.name : shown.name;
  return (
    <div className="file-page" data-ref="pending-doc">
      <PageHead
        crumbs={[{ label: name }]}
        title={name}
        actions={
          <>
            {failed && <DocActions doc={{ id, name: failed.name, kind: failed.kind, notes: {} }} />}
            <button type="button" className="btn" onClick={() => void downloadOriginal(id, failed)} data-ref="pending-download">
              <Icon n="dl" size={14} />
              {DOWNLOAD_ORIGINAL}
            </button>
          </>
        }
      />
      <UploadProblem id={id} />
      <p data-ref={failed ? "doc-failed" : "doc-processing"}>{failed ? FAILED_NOTE : PROCESSING_NOTE}</p>
    </div>
  );
}
