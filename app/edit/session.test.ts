// The edit session (plan 50 §50.3–§50.4) end to end against the GitHub fake: Save and its banners,
// conflicts, the unsaved-changes guard, drafts across the sign-in page load, and edit-start failures.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "prosemirror-view";
import { createElement } from "react";
import { parseTrailers, serializeFile, type BlockFile, type DocJSON, type GapFile } from "../../lib/content/index.ts";
import { B, G, R } from "../../tools/build/test-fixture.ts";
import { DATA_BASE, loadData } from "../data/load.ts";
import { systemPath, type NavJson, type SystemJson } from "../../lib/derive/published.ts";
import { currentHash, guideViewHash, navigate, setNavigationGuard } from "../shell/route.ts";
import { guardNavigation } from "./boot.ts";
import { buildPageKey } from "./pageKey.ts";
import { createEditorState } from "./editor/state.ts";
import { markViews, nodeViews } from "./editor/views.ts";
import { memoryStore, type KvStore } from "./idb.ts";
import { overlayEntries, setOverlayStoreForTests, stopOverlay, type OverlayEntry } from "./overlay.ts";
import {
  confirmLeave, copyChanges, currentLook, discardEdit, getEditStore, loadNewer, onBeforeUnload, OPEN_FAILED, OPEN_OFFLINE,
  OPEN_PAGE_CHANGED, registerView, resolveUnsaved, restoreDraft, save, saveDraft, setDraftStoreForTests, setGapLook, startEdit,
  viewChanged, type Draft,
} from "./session.ts";
import { gapLook } from "./units.ts";
import { addPictureFile, pictureSize, setPictureStoreForTests, stopLocalPictures } from "./pictures.ts";
import { loadFixture, startWorld, type Fixture, type World } from "./testkit.ts";
import { docLines } from "./editor/commands.ts";
import { SAVING_AGAIN } from "../auth/auth.ts";
import { Toast } from "../shell/toast.tsx";
import { flush, mount, until } from "../testing.tsx";

const KEY = `topic:fm:${R(101)}`;
const BLOCK = `content/guides/fm/cardiovascular/blocks/${B(10)}.json`;

let fx: Fixture;
let w: World;
let views: EditorView[] = [];
let drafts: KvStore<Draft>;

beforeAll(async () => {
  fx = await loadFixture();
}, 60_000);

beforeEach(() => {
  w = startWorld(fx);
  drafts = memoryStore<Draft>();
  setDraftStoreForTests(drafts);
  setOverlayStoreForTests(memoryStore<OverlayEntry>());
});

afterEach(() => {
  destroyEditors();
  discardEdit();
  stopOverlay();
  w.stop();
});

function destroyEditors(): void {
  views.forEach((v) => v.destroy());
  views = [];
}

const edit = () => {
  const e = getEditStore().edit;
  if (!e) throw new Error("no edit open");
  return e;
};

/** Mounts an editor for every slot of the open unit, the way EditRegion does. */
function mountEditors(): void {
  const unit = edit().unit;
  if (!unit) throw new Error("the unit has not loaded");
  for (const p of unit.parts) {
    const slots = p.kind === "stub" ? [] : p.kind === "gap" ? [p.doc, ...(p.differs ? [p.differs] : [])] : [p.slot];
    for (const slot of slots) {
      const view: EditorView = new EditorView(document.createElement("div"), {
        state: createEditorState(slot.doc),
        nodeViews: nodeViews(slot.basePt),
        markViews: markViews(slot.basePt),
        dispatchTransaction(tr) {
          view.updateState(view.state.apply(tr));
          viewChanged();
        },
      });
      registerView(slot.id, view, slot.doc);
      views.push(view);
    }
  }
}

/** Types `added` right after the first occurrence of `text` in the mounted editors. */
function typeAfter(text: string, added: string): void {
  for (const view of views) {
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (at === -1 && node.isText && node.text?.includes(text)) at = pos + (node.text.indexOf(text)) + text.length;
      return at === -1;
    });
    if (at !== -1) {
      view.dispatch(view.state.tr.insertText(added, at));
      return;
    }
  }
  throw new Error(`"${text}" is in no editor`);
}

/** Deletes table row `id` in whichever mounted editor holds it. */
function deleteRow(id: string): void {
  for (const view of views) {
    let row: { from: number; to: number } | null = null;
    view.state.doc.descendants((node, pos) => {
      if (row === null && node.type.name === "table_row" && node.attrs.id === id) row = { from: pos, to: pos + node.nodeSize };
      return row === null;
    });
    if (row !== null) {
      const { from, to } = row;
      view.dispatch(view.state.tr.delete(from, to));
      return;
    }
  }
  throw new Error(`no row ${id} in the editors`);
}

const editorText = (): string => views.map((v) => v.state.doc.textContent).join("\n");
const repoText = (): string => w.fake.readFile(BLOCK) ?? "";

/** Another device saves the block with one cell's text changed. */
function otherDeviceSaves(): string {
  const block = JSON.parse(repoText()) as BlockFile;
  const text = serializeFile(BLOCK, JSON.parse(JSON.stringify(block).replace("chest pain on exertion", "chest pain on exertion, relieved by rest")));
  w.fake.commitFiles({ [BLOCK]: text }, { message: "Edit: Stable angina" });
  return text;
}

async function openAndType(): Promise<void> {
  expect(await startEdit(KEY, "Atrial fibrillation")).toBe(true);
  mountEditors();
  typeAfter("more AF text", " (new)");
}

describe("save", () => {
  it("commits the edited row, closes edit mode with Saved. on the page, and writes the edit trailers", async () => {
    await openAndType();
    expect(edit().dirty).toBe(true);

    expect(await save()).toBe(true);

    expect(getEditStore().edit).toBeNull();
    expect(getEditStore().pageBanner).toEqual({ key: KEY, banner: { kind: "saved" }, hash: currentHash() });
    expect(repoText()).toContain("more AF text (new)");
    const head = w.fake.commit(w.fake.head());
    expect(head?.message.split("\n")[0]).toBe("Edit: Atrial fibrillation");
    const trailers = parseTrailers(head?.message ?? "");
    expect(trailers).toMatchObject({ kind: "edit", page: KEY, changed: [R(102)] });
    expect(trailers?.device).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(overlayEntries().get(BLOCK)?.commit).toBe(w.fake.head());
  });

  it("a save that deletes the topic's first row lands, then shows the topic its other rows are in now, sidebar included", async () => {
    await navigate(guideViewHash("fm", { kind: "topics", ids: [R(101)] }));
    expect(await startEdit(KEY, "Atrial fibrillation")).toBe(true);
    mountEditors();
    deleteRow(R(101));

    expect(await save()).toBe(true);

    expect(repoText()).not.toContain(R(101));
    const banner = getEditStore().pageBanner;
    expect(banner?.banner).toEqual({ kind: "saved" });
    expect(banner?.key).toBe(`topic:fm:${R(102)}`);
    expect(currentHash()).toBe(guideViewHash("fm", { kind: "topics", ids: [R(102)] }));
    const sys = await loadData<SystemJson>("g/fm/s/cardiovascular.json");
    expect(sys.topics.map((t) => t.id)).not.toContain(R(101));
    expect(sys.topics.find((t) => t.id === R(102))?.rows).toContain(R(102));
    const nav = await loadData<NavJson>("g/fm/nav.json");
    const entries = nav.systems.flatMap((s) => [...s.entries, ...s.sections.flatMap((x) => x.entries)]).map((e) => e.id);
    expect(entries).toContain(R(102));
    expect(entries).not.toContain(R(101));
  });

  it("deleting a one-row topic on a compare page shows Saved. on the page she lands on, and not on a page she opens later", async () => {
    const off = setNavigationGuard(guardNavigation);
    try {
      const sys = await loadData<SystemJson>(systemPath("fm", "cardiovascular"));
      const lone = sys.topics.find((t) => t.rows.at(-1) === t.id && t.rows.length <= 2);
      const other = sys.topics.find((t) => t !== lone);
      if (!lone || !other) throw new Error("the fixture has no one-row topic beside another topic");
      await navigate(guideViewHash("fm", { kind: "topics", ids: [lone.id, other.id] }));
      expect(await startEdit(buildPageKey("topic", "fm", lone.id), lone.title)).toBe(true);
      mountEditors();
      deleteRow(lone.id);

      expect(await save()).toBe(true);

      const landed = guideViewHash("fm", { kind: "topics", ids: [other.id] });
      expect(currentHash()).toBe(landed);
      expect(getEditStore().pageBanner).toEqual({ key: buildPageKey("topic", "fm", other.id), banner: { kind: "saved" }, hash: landed });
      expect(await navigate(guideViewHash("fm", { kind: "system", system: "cardiovascular" }))).toBe(true);
      expect(getEditStore().pageBanner).toBeNull();
    } finally {
      off();
    }
  });

  it("ends in Saved. when the commit landed but the device couldn't keep the overlay copy", async () => {
    const failing: KvStore<OverlayEntry> = { ...memoryStore<OverlayEntry>(), put: () => Promise.reject(new DOMException("quota", "QuotaExceededError")) };
    setOverlayStoreForTests(failing);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await openAndType();

    expect(await save()).toBe(true);

    expect(getEditStore().pageBanner?.banner).toEqual({ kind: "saved" });
    expect(repoText()).toContain("more AF text (new)");
    expect(overlayEntries().get(BLOCK)?.commit).toBe(w.fake.head());
    expect(warn).toHaveBeenCalled();
  });

  it("a picture added under the topic is committed with its bytes in the same save as the below block", async () => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:test/1" });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });
    setPictureStoreForTests(memoryStore<Blob>());
    vi.spyOn(pictureSize, "of").mockResolvedValue({ width: 40, height: 20 });
    try {
      const bytes = new Uint8Array([137, 80, 78, 71, 9, 9]);
      const pic = await addPictureFile(new File([bytes as BlobPart], "ecg.png"));
      if (typeof pic === "string") throw new Error(pic);
      expect(await startEdit(KEY, "Atrial fibrillation")).toBe(true);
      mountEditors();
      const below = views[edit().unit?.parts.findIndex((p) => p.kind === "below") ?? -1];
      if (!below) throw new Error("no below editor");
      below.dispatch(below.state.tr.insert(1, below.state.schema.node("image", { asset: pic.asset, widthPt: 30, heightPt: 15 })));

      expect(await save()).toBe(true);

      expect(w.fake.readBytes(`content/assets/${pic.asset}`)).toEqual(bytes);
      const block = JSON.parse(w.fake.readFile(`content/guides/fm/cardiovascular/below/${R(101)}.json`) ?? "null") as BlockFile;
      expect(JSON.stringify(block.doc)).toContain(pic.asset);
      expect(w.fake.commit(w.fake.head())?.parents).toHaveLength(1);
    } finally {
      stopLocalPictures();
      Reflect.deleteProperty(URL, "createObjectURL");
      Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });

  it("closes without a commit when nothing changed", async () => {
    expect(await startEdit(KEY, "Atrial fibrillation")).toBe(true);
    mountEditors();
    const before = w.fake.head();
    expect(await save()).toBe(true);
    expect(w.fake.head()).toBe(before);
    expect(getEditStore().edit).toBeNull();
  });

  it("shows the conflict and overwrites nothing when another device saved the page after it was opened", async () => {
    await openAndType();
    const theirs = otherDeviceSaves();

    expect(await save()).toBe(false);

    expect(edit().banner?.kind).toBe("conflict");
    expect(repoText()).toBe(theirs);
    expect(editorText()).toContain("more AF text (new)");
  });

  it("a refusal from GitHub is reported as not saved, not as offline; a lost connection is offline", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await openAndType();
    w.fake.fail((r) => r.method === "POST" && r.url.endsWith("/git/trees"), { status: 422, body: { message: "tree invalid" } });

    expect(await save()).toBe(false);
    expect(edit().banner).toEqual({ kind: "failed" });
    expect(error).toHaveBeenCalled();

    w.fake.fail((r) => r.method === "POST" && r.url.endsWith("/git/blobs"), "network", 3);
    expect(await save()).toBe(false);
    expect(edit().banner).toEqual({ kind: "offline" });
  });

  it("GitHub refusing the ref update with main unmoved shows the failed banner, not offline", async () => {
    await openAndType();
    const before = w.fake.head();
    w.fake.fail((r) => r.method === "PATCH" && r.url.includes("/git/refs/heads/main"), { status: 422 }, 5);

    expect(await save()).toBe(false);
    expect(edit().banner).toEqual({ kind: "failed" });
    expect(w.fake.head()).toBe(before);
    expect(editorText()).toContain("more AF text (new)");
  });
});

describe("unsaved changes", () => {
  it("leaving with no changes closes edit mode at once", async () => {
    expect(await startEdit(KEY, "Atrial fibrillation")).toBe(true);
    mountEditors();
    expect(await confirmLeave()).toBe(true);
    expect(getEditStore().edit).toBeNull();
  });

  it("with changes, asks: Stay keeps the edit, Discard closes it", async () => {
    await openAndType();

    const stay = confirmLeave();
    expect(getEditStore().unsaved).not.toBeNull();
    resolveUnsaved("stay");
    expect(await stay).toBe(false);
    expect(edit().dirty).toBe(true);

    const discard = confirmLeave();
    resolveUnsaved("discard");
    expect(await discard).toBe(true);
    expect(getEditStore().edit).toBeNull();
    expect(repoText()).not.toContain("(new)");
  });

  it("Save and continue saves, then lets the action go ahead", async () => {
    await openAndType();
    const leave = confirmLeave();
    expect(getEditStore().unsaved?.conflict).toBe(false);
    resolveUnsaved("save");
    expect(await leave).toBe(true);
    expect(repoText()).toContain("more AF text (new)");
  });

  it("the browser's leave prompt appears only with unsaved changes", async () => {
    expect(await startEdit(KEY, "Atrial fibrillation")).toBe(true);
    mountEditors();
    const clean = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    onBeforeUnload(clean);
    expect(clean.defaultPrevented).toBe(false);

    typeAfter("more AF text", "!");
    const dirty = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    onBeforeUnload(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });
});

describe("drafts across the sign-in page load", () => {
  /** Edit, keep the draft (as before the redirect), then lose the page (as the redirect does). */
  async function draftThenReload(): Promise<string> {
    await openAndType();
    const commit = edit().unit?.snapshot.commit ?? "";
    await saveDraft();
    destroyEditors();
    discardEdit();
    return commit;
  }

  it("reopens the edit with the draft's changes and deletes the draft once they are in the editors", async () => {
    const commit = await draftThenReload();
    expect(await drafts.entries()).toHaveLength(1);

    expect(await restoreDraft(KEY)).toBe(true);
    expect(edit().unit?.snapshot.commit).toBe(commit);
    expect(await drafts.entries()).toHaveLength(1);
    mountEditors();
    await vi.waitFor(async () => expect(await drafts.entries()).toEqual([]));
    expect(editorText()).toContain("more AF text (new)");
    expect(edit().dirty).toBe(true);

    expect(await save()).toBe(true);
    expect(repoText()).toContain("more AF text (new)");
  });

  it("a save made on another device after the draft was taken is a conflict: nothing is overwritten", async () => {
    await draftThenReload();
    const theirs = otherDeviceSaves();

    expect(await restoreDraft(KEY)).toBe(true);
    mountEditors();
    expect(await save()).toBe(false);

    expect(edit().banner?.kind).toBe("conflict");
    expect(repoText()).toBe(theirs);
    expect(editorText()).toContain("more AF text (new)");
  });

  it("a return with no connection keeps the stored draft and says no internet connection", async () => {
    await draftThenReload();
    w.fake.fail(() => true, "network", 100);

    expect(await restoreDraft(KEY)).toBe(false);

    expect(edit().error).toBe(OPEN_OFFLINE);
    expect(await drafts.entries()).toHaveLength(1);
  });

  it("no draft: nothing opens", async () => {
    expect(await restoreDraft(KEY)).toBe(false);
    expect(getEditStore().edit).toBeNull();
  });
});

describe("a gap box's look (a figure's size, Show as my notes)", () => {
  const LABS = "general:fm:labs";
  const GAP = `content/gapfill/${G(1)}.json`;
  const gapOf = (): GapFile => {
    const p = edit().unit?.parts.find((x) => x.kind === "gap");
    if (!p || p.kind !== "gap") throw new Error("no gap part");
    return p.gap;
  };

  it("a look change alone makes the edit dirty; changing it back makes it clean; Save writes it", async () => {
    expect(await startEdit(LABS, "Labs")).toBe(true);
    mountEditors();
    const gap = gapOf();
    setGapLook(gap, { widths: {}, asNotes: true });
    expect(edit().dirty).toBe(true);
    expect(currentLook(gap).asNotes).toBe(true);
    setGapLook(gap, gapLook(gap));
    expect(edit().dirty).toBe(false);
    expect(currentLook(gap).asNotes).toBe(false);

    setGapLook(gap, { widths: {}, asNotes: true });
    expect(await save()).toBe(true);
    expect((JSON.parse(w.fake.readFile(GAP) ?? "null") as GapFile).meta.asNotes).toBe(true);
  });

  it("a look change survives the sign-in page load in the draft", async () => {
    expect(await startEdit(LABS, "Labs")).toBe(true);
    mountEditors();
    setGapLook(gapOf(), { widths: {}, asNotes: true });
    await saveDraft();
    destroyEditors();
    discardEdit();

    expect(await restoreDraft(LABS)).toBe(true);
    mountEditors();
    expect(currentLook(gapOf()).asNotes).toBe(true);
    expect(edit().dirty).toBe(true);
    expect(await save()).toBe(true);
    expect((JSON.parse(w.fake.readFile(GAP) ?? "null") as GapFile).meta.asNotes).toBe(true);
  });
});

describe("after a conflict: Copy my changes and Load newer version", () => {
  let written: string[];

  beforeEach(() => {
    written = [];
    stubClipboard(async (text) => {
      written.push(text);
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
  });

  function stubClipboard(writeText: (text: string) => Promise<void>): void {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  }

  /** Edits, another device saves, and Save shows the conflict. Resolves to the conflict's time. */
  async function conflict(): Promise<string> {
    await openAndType();
    otherDeviceSaves();
    expect(await save()).toBe(false);
    const banner = edit().banner;
    if (banner?.kind !== "conflict") throw new Error("no conflict");
    return banner.at;
  }

  it("copies exactly the edited editors' text, not the untouched ones", async () => {
    expect(await startEdit("system:fm:cardiovascular", "Cardiovascular")).toBe(true);
    mountEditors();
    typeAfter("more AF text", " (new)");
    const changed = views.find((v) => v.state.doc.textContent.includes("(new)"));
    const untouched = views.filter((v) => v !== changed && v.state.doc.textContent.trim() !== "");
    if (!changed || untouched.length === 0) throw new Error("expected one changed and other filled editors");

    expect(await copyChanges()).toBe(true);

    expect(written).toEqual([docLines(changed.state.doc).join("\n")]);
    for (const v of untouched) expect(written[0]).not.toContain(docLines(v.state.doc)[0]);
  });

  it("a refused clipboard reports failure; Load newer version then asks before letting the changes go", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubClipboard(() => Promise.reject(new DOMException("denied", "NotAllowedError")));
    const at = await conflict();

    expect(await copyChanges()).toBe(false);

    const stay = loadNewer();
    expect(getEditStore().unsaved).not.toBeNull();
    resolveUnsaved("stay");
    await stay;
    expect(edit().banner).toEqual({ kind: "conflict", at });
    expect(editorText()).toContain("more AF text (new)");
    expect(edit().dirty).toBe(true);

    const discard = loadNewer();
    resolveUnsaved("discard");
    await discard;
    expect(edit().unit?.snapshot.commit).toBe(w.fake.head());
    expect(edit().banner).toEqual({ kind: "loaded", at, copied: false });
    expect(edit().dirty).toBe(false);
    destroyEditors();
    mountEditors();
    expect(editorText()).toContain("more AF text");
    expect(editorText()).not.toContain("(new)");
  });

  it("after a real copy it reloads without asking and says the changes are on the clipboard; a later edit asks again", async () => {
    const at = await conflict();
    expect(await copyChanges()).toBe(true);
    typeAfter("more AF text", "!");

    const asks = loadNewer();
    expect(getEditStore().unsaved).not.toBeNull();
    resolveUnsaved("stay");
    await asks;

    expect(await copyChanges()).toBe(true);
    await loadNewer();
    expect(getEditStore().unsaved).toBeNull();
    expect(edit().banner).toEqual({ kind: "loaded", at, copied: true });
    expect(edit().unit?.snapshot.commit).toBe(w.fake.head());
  });

  it("a reload with no connection keeps the editors and their changes", async () => {
    const at = await conflict();
    const base = edit().unit?.snapshot.commit;
    const generation = edit().generation;
    expect(await copyChanges()).toBe(true);
    w.fake.fail(() => true, "network", 100);

    await loadNewer();

    expect(edit().error).toBe(OPEN_OFFLINE);
    expect(edit().banner).toEqual({ kind: "conflict", at });
    expect(edit().unit?.snapshot.commit).toBe(base);
    expect(edit().generation).toBe(generation);
    expect(edit().dirty).toBe(true);
    // The session still holds the edited editors: copying again still copies her change.
    written = [];
    expect(await copyChanges()).toBe(true);
    expect(written[0]).toContain("more AF text (new)");
  });

  it("Load newer version's dialog offers Copy my changes instead of a Save that would conflict again; Copy then loads", async () => {
    const at = await conflict();
    const head = w.fake.head();

    const load = loadNewer();
    expect(getEditStore().unsaved?.conflict).toBe(true);
    resolveUnsaved("copy");
    await load;

    expect(written).toHaveLength(1);
    expect(written[0]).toContain("more AF text (new)");
    expect(edit().banner).toEqual({ kind: "loaded", at, copied: true });
    expect(edit().unit?.snapshot.commit).toBe(head);
    expect(w.fake.head()).toBe(head);
  });

  it("a Copy the clipboard refuses keeps her in the conflict with her changes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubClipboard(() => Promise.reject(new DOMException("denied", "NotAllowedError")));
    const at = await conflict();
    const base = edit().unit?.snapshot.commit;

    const load = loadNewer();
    resolveUnsaved("copy");
    await load;

    expect(edit().banner).toEqual({ kind: "conflict", at });
    expect(edit().unit?.snapshot.commit).toBe(base);
    expect(editorText()).toContain("more AF text (new)");
  });

  it("leaving the page after a conflict offers Copy my changes, not Save; Copy lets her leave with nothing committed", async () => {
    await conflict();
    const head = w.fake.head();

    const leave = confirmLeave();
    expect(getEditStore().unsaved?.conflict).toBe(true);
    resolveUnsaved("copy");
    expect(await leave).toBe(true);

    expect(written[0]).toContain("more AF text (new)");
    expect(getEditStore().edit).toBeNull();
    expect(w.fake.head()).toBe(head);
  });

  it("the conflict keeps her changes in the draft store until she lets them go", async () => {
    await conflict();
    const base = edit().unit?.snapshot.commit;

    const kept = await drafts.get(KEY);
    expect(kept?.commit).toBe(base);
    expect(JSON.stringify(kept?.docs)).toContain("more AF text (new)");

    const discard = loadNewer();
    resolveUnsaved("discard");
    await discard;
    await vi.waitFor(async () => expect(await drafts.entries()).toEqual([]));
  });
});

describe("a save waiting on sign-in when the page left for GitHub", () => {
  it("saves once the restored draft is in the editors, with the signed-in-again toast", async () => {
    const toast = await mount(createElement(Toast));
    await openAndType();
    await saveDraft(true);
    destroyEditors();
    discardEdit();

    expect(await restoreDraft(KEY)).toBe(true);
    mountEditors();

    await vi.waitFor(() => expect(repoText()).toContain("more AF text (new)"));
    expect(getEditStore().edit).toBeNull();
    expect(getEditStore().pageBanner?.banner).toEqual({ kind: "saved" });
    await until(() => toast.container.textContent?.includes(SAVING_AGAIN), "the signed-in-again toast");
    toast.unmount();
  });

  it("a draft kept for a plain sign-in only reopens the edit", async () => {
    await openAndType();
    const before = w.fake.head();
    await saveDraft();
    destroyEditors();
    discardEdit();

    expect(await restoreDraft(KEY)).toBe(true);
    mountEditors();
    await flush(50);

    expect(w.fake.head()).toBe(before);
    expect(edit().dirty).toBe(true);
  });
});

describe("edit start failures", () => {
  it("a topic that is gone from Git (deleted on another device) says the page changed", async () => {
    const block = JSON.parse(repoText()) as BlockFile;
    const doc = block.doc as DocJSON & { content: { content: { attrs: { id: string } }[] }[] };
    const table = doc.content[0];
    if (!table) throw new Error("no table");
    table.content = table.content.filter((r) => r.attrs.id !== R(101) && r.attrs.id !== R(102));
    w.fake.commitFiles({ [BLOCK]: serializeFile(BLOCK, block) });

    expect(await startEdit(KEY, "Atrial fibrillation")).toBe(false);
    expect(edit().error).toBe(OPEN_PAGE_CHANGED);
  });

  it("published data that can't be fetched says no internet connection", async () => {
    const github = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith(DATA_BASE) ? Promise.reject(new TypeError("Failed to fetch")) : github(input, init));

    expect(await startEdit(KEY, "Atrial fibrillation")).toBe(false);
    expect(edit().error).toBe(OPEN_OFFLINE);
  });

  it("any other failure is logged and reported without blaming the connection", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const github = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith(DATA_BASE) ? Promise.resolve(new Response("oops", { status: 500 })) : github(input, init));

    expect(await startEdit(KEY, "Atrial fibrillation")).toBe(false);
    expect(edit().error).toBe(OPEN_FAILED);
    expect(error).toHaveBeenCalled();
  });
});
