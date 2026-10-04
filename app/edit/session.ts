// The one open edit (plan 50 §50.3–§50.4): edit start from Git, dirty tracking, Save with its banners,
// conflicts, the unsaved-changes guard and the draft store. React components read it with useEdit().
import { useSyncExternalStore } from "react";
import type { EditorView } from "prosemirror-view";
import { commitMessage, type DocJSON } from "../../lib/content/index.ts";
import type { SiteJson } from "../../lib/derive/published.ts";
import { SignedOutError } from "../auth/session.ts";
import { SAVING_AGAIN, waitForSignIn } from "../auth/auth.ts";
import { showToast } from "../shell/toast.tsx";
import { schema } from "../../lib/schema.ts";
import { docLines } from "./editor/commands.ts";
import { commitChanges } from "./commit.ts";
import { DataOfflineError, loadData } from "../data/load.ts";
import { deviceId, versionTime } from "./format.ts";
import { Git, NetworkError } from "./github.ts";
import { kvStore, type KvStore } from "./idb.ts";
import { recordSaved } from "./overlay.ts";
import { Snapshot } from "./snapshot.ts";
import { buildSave, loadUnit, UnitError, type EditUnit } from "./units.ts";

/** Edit start failed for want of a connection (plan wording). */
export const OPEN_OFFLINE = "Couldn’t open this page for editing — no internet connection.";
/**
 * PLACEHOLDER wording (no signed design text yet): edit start found the page gone from its system,
 * e.g. its first row was deleted on another device after this tab loaded its sidebar.
 */
export const OPEN_PAGE_CHANGED = "This page was changed on another device. Reload the page to edit the current version.";
/** PLACEHOLDER wording: edit start failed for another reason (the error is logged to the console). */
export const OPEN_FAILED = "Couldn’t open this page for editing.";

export type Banner =
  | { kind: "saved" }
  | { kind: "offline" }
  /** PLACEHOLDER wording in SaveBanner: GitHub refused the save or the files didn't validate (not a connection problem). */
  | { kind: "failed" }
  | { kind: "conflict"; at: string }
  /** `copied`: her changes were copied before the reload, so the banner may say they're on the clipboard. */
  | { kind: "loaded"; at: string; copied: boolean }
  | { kind: "restored"; from: string };

export interface EditState {
  key: string;
  title: string;
  unit: EditUnit | null;
  /** Edit start failed (e.g. no connection). */
  error: string | null;
  dirty: boolean;
  saving: boolean;
  banner: Banner | null;
  /** Bumped whenever the editors must be rebuilt from `unit` (edit start, Load newer version). */
  generation: number;
}

export interface UnsavedPrompt {
  resolve: (choice: "stay" | "discard" | "save") => void;
}

interface Store {
  edit: EditState | null;
  /** A banner shown on a page after its edit closed ("Saved.", "Restored"), by page key. */
  pageBanner: { key: string; banner: Banner } | null;
  unsaved: UnsavedPrompt | null;
}

let store: Store = { edit: null, pageBanner: null, unsaved: null };
const listeners = new Set<() => void>();
const views = new Map<string, { view: EditorView; initial: DocJSON }>();
/** Docs to put into the editors once they mount (a restored draft). */
let pendingDocs: Map<string, DocJSON> | null = null;
/** The stored draft being restored: deleted once all its docs are in mounted editors. */
let pendingDraftKey: string | null = null;
/** The edited docs (as JSON) the last successful "Copy my changes" put on the clipboard. */
let copiedEdits: string | null = null;
/** The page whose edits a save conflict kept in the draft store, until she saves or lets them go. */
let conflictDraftKey: string | null = null;
/** "Load newer version" is reading the page. */
let loadingNewer = false;

function set(next: Partial<Store>): void {
  store = { ...store, ...next };
  for (const l of listeners) l();
}

function setEdit(next: Partial<EditState>): void {
  if (store.edit) set({ edit: { ...store.edit, ...next } });
}

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export const getEditStore = (): Store => store;

export function useEdit(): Store {
  return useSyncExternalStore(subscribe, getEditStore);
}

/** Whether an edit is open (on this page key, when given). */
export function useIsEditing(pageKey?: string): boolean {
  const s = useEdit();
  return s.edit !== null && (pageKey === undefined || s.edit.key === pageKey);
}

let gitPromise: Promise<{ git: Git; site: SiteJson }> | null = null;

export async function repo(): Promise<{ git: Git; site: SiteJson }> {
  gitPromise ??= loadData<SiteJson>("site.json").then((site) => ({ git: new Git(site.repo), site }));
  return gitPromise.catch((e: unknown) => {
    gitPromise = null;
    throw e;
  });
}

// ---- editors ------------------------------------------------------------------------------------

/** An editor view of the open edit mounted (slot id); returns its unregister function. */
export function registerView(slot: string, view: EditorView, initial: DocJSON): () => void {
  views.set(slot, { view, initial });
  const draft = pendingDocs?.get(slot);
  if (draft) {
    const doc = schema.nodeFromJSON(draft);
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content));
    pendingDocs?.delete(slot);
    if (pendingDocs?.size === 0) {
      pendingDocs = null;
      draftApplied();
    }
  }
  viewChanged();
  return () => {
    if (views.get(slot)?.view === view) views.delete(slot);
  };
}

function isDirty(): boolean {
  for (const { view, initial } of views.values()) {
    if (!view.state.doc.eq(schema.nodeFromJSON(initial))) return true;
  }
  return false;
}

/** An editor's document changed: recompute dirty. */
export function viewChanged(): void {
  const dirty = isDirty();
  if (store.edit && store.edit.dirty !== dirty) setEdit({ dirty });
}

function editedDocs(): Map<string, DocJSON> {
  const out = new Map<string, DocJSON>();
  for (const [slot, { view, initial }] of views) {
    if (!view.state.doc.eq(schema.nodeFromJSON(initial))) out.set(slot, view.state.doc.toJSON() as DocJSON);
  }
  return out;
}

// ---- edit start ---------------------------------------------------------------------------------

async function load(key: string, commit?: string): Promise<EditUnit> {
  const { git } = await repo();
  return loadUnit(key, await Snapshot.at(git, commit));
}

/** The message for an edit start that threw `e`; anything but a lost connection or a vanished page is logged. */
function openError(e: unknown): string {
  if (e instanceof NetworkError || e instanceof DataOfflineError) return OPEN_OFFLINE;
  if (e instanceof UnitError) return OPEN_PAGE_CHANGED;
  console.error("Edit start failed", e);
  return OPEN_FAILED;
}

/** Slot ids of a unit's editors. */
function slotIds(unit: EditUnit): Set<string> {
  const ids = new Set<string>();
  for (const p of unit.parts) {
    if (p.kind === "stub") continue;
    if (p.kind === "gap") {
      ids.add(p.doc.id);
      if (p.differs) ids.add(p.differs.id);
    } else ids.add(p.slot.id);
  }
  return ids;
}

/** A draft to reopen: its docs by slot id, edited against `commit`. */
export interface DraftStart {
  docs: Map<string, DocJSON>;
  commit: string;
}

/**
 * Edit: read the page's files from Git (50 §50.4 edit start) and open the editors. A restored draft
 * edits against the commit it was made at, so a save made since then shows the conflict banner.
 * Resolves to whether the unit loaded.
 */
export async function startEdit(key: string, title: string, draft?: DraftStart): Promise<boolean> {
  if (store.edit) return false;
  views.clear();
  pendingDocs = null;
  copiedEdits = null;
  set({ edit: { key, title, unit: null, error: null, dirty: false, saving: false, banner: null, generation: 0 }, pageBanner: null });
  try {
    const unit = await load(key, draft?.commit);
    const now = getEditStore().edit;
    if (now?.key !== key) return false;
    if (draft) {
      const slots = slotIds(unit);
      const docs = new Map([...draft.docs].filter(([slot]) => slots.has(slot)));
      pendingDocs = docs.size > 0 ? docs : null;
    }
    setEdit({ unit, generation: now.generation + 1 });
    return true;
  } catch (e) {
    if (getEditStore().edit?.key === key) setEdit({ error: openError(e) });
    return false;
  }
}

/** Leave edit mode without saving: she let the changes go, so a conflict's kept draft goes too. */
export function discardEdit(): void {
  views.clear();
  pendingDocs = null;
  pendingDraftKey = null;
  copiedEdits = null;
  dropConflictDraft();
  set({ edit: null, unsaved: null });
}

// ---- unsaved changes ------------------------------------------------------------------------------

/** Opens "You have unsaved changes" and resolves to her choice. */
async function askUnsaved(): Promise<"stay" | "discard" | "save"> {
  const choice = await new Promise<"stay" | "discard" | "save">((resolve) => set({ unsaved: { resolve } }));
  set({ unsaved: null });
  return choice;
}

/** Opens "You have unsaved changes"; resolves to whether the requested action may go ahead. */
export async function confirmLeave(): Promise<boolean> {
  if (!store.edit || !isDirty()) {
    if (store.edit) discardEdit();
    return true;
  }
  const choice = await askUnsaved();
  if (choice === "stay") return false;
  if (choice === "discard") {
    discardEdit();
    return true;
  }
  return save();
}

export function resolveUnsaved(choice: "stay" | "discard" | "save"): void {
  store.unsaved?.resolve(choice);
}

/** Done: with unsaved changes, the dialog; otherwise leave edit mode. */
export async function done(): Promise<void> {
  await confirmLeave();
}

// ---- saving -------------------------------------------------------------------------------------

/** Save (50 §50.4). Resolves to whether the edit closed with everything saved. */
export async function save(): Promise<boolean> {
  const edit = store.edit;
  const unit = edit?.unit;
  if (!edit || !unit || edit.saving) return false;
  setEdit({ saving: true, banner: null });
  try {
    const build = buildSave(unit, editedDocs());
    if (build.changes.length === 0) {
      discardEdit();
      return true;
    }
    const { git, site } = await repo();
    const message = commitMessage(`Edit: ${edit.title}`, {
      kind: "edit", page: edit.key, changed: build.changed.length > 0 ? build.changed : unit.ids.slice(0, 1), device: deviceId(),
    });
    const outcome = await commitChanges({
      git, base: unit.snapshot.commit, baseFiles: unit.snapshot.files, scope: unit.scope, changes: build.changes, message,
      author: { name: site.owner.commitName, email: site.owner.commitEmail },
    });
    if (outcome.kind === "saved") {
      await recordSaved(build.files, outcome.commit);
      views.clear();
      copiedEdits = null;
      dropConflictDraft();
      set({ edit: null, unsaved: null, pageBanner: { key: edit.key, banner: { kind: "saved" } } });
      return true;
    }
    if (outcome.kind === "conflict") await keepConflictDraft();
    setEdit({ saving: false, banner: outcome.kind === "conflict" ? { kind: "conflict", at: versionTime(outcome.at) } : { kind: "offline" } });
    return false;
  } catch (e) {
    if (e instanceof SignedOutError) {
      setEdit({ saving: false });
      // The edits stay in the views; after sign-in the same save runs again.
      return (await waitForSignIn()) ? save() : false;
    }
    const offline = e instanceof NetworkError || e instanceof DataOfflineError;
    if (!offline) console.error("Save failed", e);
    setEdit({ saving: false, banner: { kind: offline ? "offline" : "failed" } });
    return false;
  }
}

/** Toast after "Copy my changes" put them on the clipboard (mockup wording). */
export const COPY_DONE = "Your changes were copied.";
/** PLACEHOLDER wording (no signed design text yet): the browser refused the clipboard write. */
export const COPY_FAILED = "Couldn’t copy your changes. They are still here.";

const editsKey = (docs: Map<string, DocJSON>): string => JSON.stringify([...docs]);

/**
 * "Copy my changes": the edited views' text (the same docs Save and drafts take), paragraphs and rows
 * as lines, cells tab-separated. Resolves to whether the clipboard took it.
 */
export async function copyChanges(): Promise<boolean> {
  const edited = editedDocs();
  const lines: string[] = [];
  for (const [slot, { view }] of views) if (edited.has(slot)) lines.push(...docLines(view.state.doc));
  try {
    await navigator.clipboard.writeText(lines.join("\n"));
  } catch (e) {
    console.warn("Copy my changes: the clipboard refused", e);
    return false;
  }
  copiedEdits = editsKey(edited);
  return true;
}

/**
 * "Load newer version": re-run edit start and show the loaded banner. Changes she hasn't copied are
 * only let go after "You have unsaved changes"; the editors are replaced only once the newer version
 * has loaded, so a failed load leaves them as they were.
 */
export async function loadNewer(): Promise<void> {
  const edit = store.edit;
  if (!edit?.unit || edit.saving || loadingNewer) return;
  const edited = editedDocs();
  const copied = edited.size > 0 && copiedEdits === editsKey(edited);
  if (edited.size > 0 && !copied) {
    const choice = await askUnsaved();
    if (choice === "stay") return;
    if (choice === "save") {
      await save();
      return;
    }
  }
  const at = edit.banner?.kind === "conflict" ? edit.banner.at : "";
  loadingNewer = true;
  setEdit({ error: null });
  try {
    const unit = await load(edit.key);
    const now = getEditStore().edit;
    if (now?.key !== edit.key) return;
    views.clear();
    copiedEdits = null;
    dropConflictDraft();
    setEdit({ unit, dirty: false, generation: now.generation + 1, banner: { kind: "loaded", at, copied } });
  } catch (e) {
    if (getEditStore().edit?.key === edit.key) setEdit({ error: openError(e) });
  } finally {
    loadingNewer = false;
  }
}

export function dismissBanner(): void {
  if (store.edit?.banner) setEdit({ banner: null });
  else set({ pageBanner: null });
}

/** A page-level banner after the edit closed (Restore uses it). */
export function showPageBanner(key: string, banner: Banner): void {
  set({ pageBanner: { key, banner } });
}

// ---- drafts (50 §50.3) ------------------------------------------------------------------------------

export interface Draft {
  title: string;
  docs: Record<string, DocJSON>;
  /** The commit the edit started from: the restored edit saves against it (conflicts stay conflicts). */
  commit: string;
  /** She had pressed Save and was signing in again when the page left: save once the draft is back. */
  resumeSave?: true;
}

let drafts: KvStore<Draft> = kvStore<Draft>("pa-drafts");

/** Replaces the IndexedDB store (tests). */
export function setDraftStoreForTests(s: KvStore<Draft>): void {
  drafts = s;
}

/**
 * Keep the dirty views' docs under the page key: before a full-page navigation the app starts
 * (`resumeSave` when a save is waiting on that sign-in), and when a save hits a conflict.
 */
export async function saveDraft(resumeSave = false): Promise<void> {
  const edit = store.edit;
  if (!edit?.unit || !isDirty()) return;
  const draft: Draft = { title: edit.title, docs: Object.fromEntries(editedDocs()), commit: edit.unit.snapshot.commit };
  if (resumeSave) draft.resumeSave = true;
  await drafts.put(edit.key, draft);
}

/** A conflict keeps her edits on the device until she saves or lets them go. */
async function keepConflictDraft(): Promise<void> {
  const key = store.edit?.key;
  if (key === undefined) return;
  try {
    await saveDraft();
    conflictDraftKey = key;
  } catch (e) {
    console.warn("Couldn’t keep the conflicting changes on this device", e);
  }
}

function dropConflictDraft(): void {
  const key = conflictDraftKey;
  conflictDraftKey = null;
  if (key !== null) drafts.delete(key).catch((e: unknown) => console.warn("Couldn’t delete the kept draft", e));
}

/** The restored draft wants its save run again once its docs are in the editors. */
let resumeAfterApply = false;

function draftApplied(): void {
  const key = pendingDraftKey;
  pendingDraftKey = null;
  if (key !== null) drafts.delete(key).catch((e: unknown) => console.warn("Couldn’t delete the restored draft", e));
  if (resumeAfterApply) {
    resumeAfterApply = false;
    showToast(SAVING_AGAIN);
    // After the registering editor's own setup finishes.
    queueMicrotask(() => void save());
  }
}

/**
 * On return: reopen edit mode on `key` with its draft. The stored draft is deleted only once its docs
 * are in the mounted editors, so a failed edit start keeps it for the next visit. A draft kept while
 * a save waited on sign-in saves again once it is back in the editors (the caller has checked that she
 * is the owner).
 */
export async function restoreDraft(key: string): Promise<boolean> {
  const d = await drafts.get(key);
  if (!d) return false;
  const loaded = await startEdit(key, d.title, { docs: new Map(Object.entries(d.docs)), commit: d.commit });
  if (!loaded) return false;
  pendingDraftKey = key;
  resumeAfterApply = pendingDocs !== null && d.resumeSave === true;
  // No doc of the draft fits the page any more: nothing to apply.
  if (pendingDocs === null) draftApplied();
  return true;
}

/** `beforeunload` while an edit has unsaved changes shows the browser's prompt. */
export function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (store.edit && isDirty()) {
    e.preventDefault();
    e.returnValue = "";
  }
}
