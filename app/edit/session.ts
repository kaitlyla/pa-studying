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
import { buildSave, loadUnit, UnitError, type EditUnit, type SaveBuild } from "./units.ts";
import { currentHash, guideViewHash, navigate, parseHash } from "../shell/route.ts";

/** Edit start failed for want of a connection (plan wording). */
export const OPEN_OFFLINE = "Couldn’t open this page for editing — no internet connection.";
/**
 * Edit start found the page gone from its system, e.g. its first row was deleted on another device
 * after this tab loaded its sidebar (design editing/edit/edges/stale).
 */
export const OPEN_PAGE_CHANGED = "This page changed since you opened it. Reload the page to edit the current version.";
/** Edit start failed for another reason; the error is logged to the console (design openfail). */
export const OPEN_FAILED = "Couldn’t open this page for editing.";
/** The save banner when GitHub refused the save or the files didn't validate (design savefail). */
export const SAVE_FAILED = {
  title: "Couldn’t save.",
  body: "Something went wrong. Your changes are still here, and the last saved version is unchanged.",
} as const;

export type Banner =
  | { kind: "saved" }
  | { kind: "offline" }
  /** GitHub refused the save or the files didn't validate (not a connection problem): SAVE_FAILED. */
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
/**
 * The page whose stored draft stays until she saves or lets the changes go: kept by a save conflict,
 * or restored for a save that was waiting on sign-in.
 */
let keptDraftKey: string | null = null;
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
    if (views.get(slot)?.view !== view) return;
    views.delete(slot);
    // The editor went away while its edit is still open (she was signed out, or the page re-suspended):
    // its changes wait for it to mount again, and save and drafts still take them meanwhile.
    if (store.edit && !view.state.doc.eq(schema.nodeFromJSON(initial))) {
      (pendingDocs ??= new Map()).set(slot, view.state.doc.toJSON() as DocJSON);
    }
  };
}

/** Changes of editors that are not mounted: a restored draft waiting for them, or a closed editor's. */
function unmountedDocs(): [string, DocJSON][] {
  return [...(pendingDocs ?? [])].filter(([slot]) => !views.has(slot));
}

/** The mounted editor of `slot` in the open edit. */
export function mountedEditor(slot: string): EditorView | undefined {
  return views.get(slot)?.view;
}

function isDirty(): boolean {
  for (const { view, initial } of views.values()) {
    if (!view.state.doc.eq(schema.nodeFromJSON(initial))) return true;
  }
  return unmountedDocs().length > 0;
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
  for (const [slot, doc] of unmountedDocs()) out.set(slot, doc);
  return out;
}

// ---- edit start ---------------------------------------------------------------------------------

async function load(key: string, commit?: string): Promise<EditUnit> {
  const { git } = await repo();
  return loadUnit(key, await Snapshot.at(git, commit));
}

/** `e` is a lost connection (to GitHub or to the site's data), not an error of GitHub or the code. */
export const isOffline = (e: unknown): boolean => e instanceof NetworkError || e instanceof DataOfflineError;

/** The message for an edit start that threw `e`; anything but a lost connection or a vanished page is logged. */
function openError(e: unknown): string {
  if (isOffline(e)) return OPEN_OFFLINE;
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
  /** It came from the draft store: delete it there once its docs are in the editors. */
  stored?: boolean;
  /** Run the save again once its docs are in the editors (a save was waiting on sign-in). */
  resumeSave?: boolean;
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
  pendingDraftKey = null;
  resumeAfterApply = false;
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
      // Set before the editors mount: mounted regions register (and apply the draft) as soon as the unit is in the store.
      pendingDraftKey = draft.stored === true ? key : null;
      resumeAfterApply = pendingDocs !== null && draft.resumeSave === true;
    }
    setEdit({ unit, generation: now.generation + 1 });
    // No doc of the draft fits the page any more: nothing to apply.
    if (draft && pendingDocs === null) draftApplied();
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
  resumeAfterApply = false;
  copiedEdits = null;
  dropKeptDraft();
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

/**
 * The page to show after a save deleted the open topic's first row (its id): the topic its other rows
 * joined in place of the old id, or the system page when they are in no topic.
 */
function hashAfterTopicMoved(old: string, moved: NonNullable<SaveBuild["topicMoved"]>): string {
  const route = parseHash(currentHash());
  const ids = route.kind === "guide" && route.view.kind === "topics" ? route.view.ids : [old];
  const next = [...new Set(ids.flatMap((id) => (id !== old ? [id] : moved.topic !== null ? [moved.topic] : [])))];
  return next.length > 0
    ? guideViewHash(moved.guide, { kind: "topics", ids: next })
    : guideViewHash(moved.guide, { kind: "system", system: moved.system });
}

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
      pendingDocs = null;
      copiedEdits = null;
      dropKeptDraft();
      const moved = build.topicMoved;
      const key = moved ? (moved.topic !== null ? `topic:${moved.guide}:${moved.topic}` : `system:${moved.guide}:${moved.system}`) : edit.key;
      set({ edit: null, unsaved: null, pageBanner: { key, banner: { kind: "saved" } } });
      if (moved && unit.topic !== null) await navigate(hashAfterTopicMoved(unit.topic, moved));
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
    const offline = isOffline(e);
    if (!offline) console.error("Save failed", e);
    setEdit({ saving: false, banner: { kind: offline ? "offline" : "failed" } });
    return false;
  }
}

/** Toast after "Copy my changes" put them on the clipboard (mockup wording). */
export const COPY_DONE = "Your changes were copied.";
/** The browser refused the clipboard write (design copyfail). */
export const COPY_FAILED = "Copy didn’t work. Select the text and copy it yourself.";

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
    pendingDocs = null;
    copiedEdits = null;
    dropKeptDraft();
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
    keptDraftKey = key;
  } catch (e) {
    console.warn("Couldn’t keep the conflicting changes on this device", e);
  }
}

/**
 * She stopped being the owner on this device (the sign-in expired, or she signed out in another tab)
 * with unsaved changes open: they are kept on the device too, until she saves or lets them go.
 */
export async function keepEditsSignedOut(): Promise<void> {
  const key = store.edit?.key;
  if (key === undefined || !isDirty()) return;
  try {
    await saveDraft();
    keptDraftKey = key;
  } catch (e) {
    console.warn("Couldn’t keep the unsaved changes on this device", e);
  }
}

function dropKeptDraft(): void {
  const key = keptDraftKey;
  keptDraftKey = null;
  if (key !== null) drafts.delete(key).catch((e: unknown) => console.warn("Couldn’t delete the kept draft", e));
}

/** The restored draft wants its save run again once its docs are in the editors. */
let resumeAfterApply = false;

function draftApplied(): void {
  const key = pendingDraftKey;
  pendingDraftKey = null;
  if (resumeAfterApply) {
    resumeAfterApply = false;
    // The stored copy stays until that save lands (or she lets the changes go).
    keptDraftKey = key;
    showToast(SAVING_AGAIN);
    // After the registering editor's own setup finishes.
    queueMicrotask(() => void save());
  } else if (key !== null) {
    drafts.delete(key).catch((e: unknown) => console.warn("Couldn’t delete the restored draft", e));
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
  return startEdit(key, d.title, { docs: new Map(Object.entries(d.docs)), commit: d.commit, stored: true, resumeSave: d.resumeSave === true });
}

/** `beforeunload` while an edit has unsaved changes shows the browser's prompt. */
export function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (store.edit && isDirty()) {
    e.preventDefault();
    e.returnValue = "";
  }
}
