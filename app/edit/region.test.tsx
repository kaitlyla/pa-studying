// Edit mode on a page (plan 50 §50.2–§50.4) as rendered: the Edit and Versions buttons, the region
// that swaps the page body for editors, the toolbar's Done, the save banners and their copy toast,
// the page banner, and the confirm and unsaved-changes dialogs.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { EditorView } from "prosemirror-view";
import { R } from "../../tools/build/test-fixture.ts";
import { setOwner } from "../shell/owner.tsx";
import { hideToast, Toast } from "../shell/toast.tsx";
import { asOwner, click, mount, until, type Mounted } from "../testing.tsx";
import { askConfirm, UnsavedDialog } from "./dialogs.tsx";
import { EditControls, EditRegion, PageBanner, SaveBanner } from "./EditRegion.tsx";
import { createEditorState } from "./editor/state.ts";
import { markViews, nodeViews } from "./editor/views.ts";
import { memoryStore } from "./idb.ts";
import { setOverlayStoreForTests, stopOverlay, type OverlayEntry } from "./overlay.ts";
import {
  confirmLeave, COPY_DONE, COPY_FAILED, discardEdit, getEditStore, registerView, SAVE_FAILED, setDraftStoreForTests,
  showPageBanner, startEdit, viewChanged, type Draft,
} from "./session.ts";
import { loadFixture, startWorld, type Fixture, type World } from "./testkit.ts";

const KEY = `topic:fm:${R(101)}`;

let fx: Fixture;
let w: World;
let views: EditorView[] = [];
let mounted: Mounted[] = [];

beforeAll(async () => {
  fx = await loadFixture();
}, 60_000);

beforeEach(() => {
  w = startWorld(fx);
  setDraftStoreForTests(memoryStore<Draft>());
  setOverlayStoreForTests(memoryStore<OverlayEntry>());
});

afterEach(() => {
  mounted.forEach((m) => m.unmount());
  mounted = [];
  views.forEach((v) => v.destroy());
  views = [];
  act(() => {
    hideToast();
    setOwner({ owner: false });
    discardEdit();
  });
  Reflect.deleteProperty(navigator, "clipboard");
  stopOverlay();
  w.stop();
});

async function render(node: ReactNode): Promise<HTMLDivElement> {
  const m = await mount(node);
  mounted.push(m);
  return m.container;
}

/** Runs `f` inside act (it changes stores that mounted components read) and returns its result. */
function inAct<T>(f: () => T): T {
  const box: { v?: T } = {};
  act(() => {
    box.v = f();
  });
  if (box.v === undefined) throw new Error("no result");
  return box.v;
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

async function openAndType(): Promise<void> {
  expect(await startEdit(KEY, "Atrial fibrillation")).toBe(true);
  mountEditors();
  typeAfter("more AF text", " (new)");
  expect(edit().dirty).toBe(true);
}

function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
}

const q = (root: ParentNode, ref: string): HTMLElement | null => root.querySelector<HTMLElement>(`[data-ref="${ref}"]`);

describe("EditControls and EditRegion", () => {
  const page = (key = KEY): ReactNode => (
    <>
      <EditControls pageKey={key} title="Atrial fibrillation" />
      <EditRegion pageKey={key}><p data-testid="published">published body</p></EditRegion>
    </>
  );
  const published = (root: ParentNode): HTMLElement => {
    const el = root.querySelector<HTMLElement>('[data-testid="published"]');
    if (!el) throw new Error("no published body");
    return el;
  };

  /** Clicks Edit and waits for the editors (or the stub) to appear. */
  async function openEdit(root: HTMLElement): Promise<HTMLElement> {
    await click(q(root, "edit-page"));
    return until(() => (edit().unit ? q(root, "edit-area") : null), "the edit area with its unit");
  }

  it("a visitor sees the published body and no Edit or Versions", async () => {
    const root = await render(page());
    expect(q(root, "edit-page")).toBeNull();
    expect(q(root, "edit-versions")).toBeNull();
    expect(published(root).closest("[hidden]")).toBeNull();
    expect(published(root).textContent).toBe("published body");
  });

  it("the owner's Edit shows the loading line, then an editor in place of the hidden published body", async () => {
    asOwner(true);
    const root = await render(page());
    const editButton = q(root, "edit-page");
    expect(editButton?.textContent).toBe("Edit");
    expect(q(root, "edit-versions")?.textContent).toBe("Versions");

    act(() => {
      editButton?.click();
    });
    expect(q(root, "edit-area")?.textContent).toContain("Opening for editing…");

    const editor = await until(() => root.querySelector('[data-ref="edit-area"] [contenteditable="true"]'), "the editor");
    expect(editor.closest("[hidden]")).toBeNull();
    expect(root.querySelectorAll('[data-ref="edit-area"] [contenteditable="true"]')).toHaveLength(1);
    expect(q(root, "edit-area")?.textContent).not.toContain("Opening for editing…");
    expect(published(root).closest("[hidden]")).not.toBeNull();
    expect(q(root, "edit-page")).toBeNull();
    expect(q(root, "edit-versions")).toBeNull();
  });

  it("with no changes the toolbar says so and disables Save; Done closes edit mode", async () => {
    asOwner(true);
    const root = await render(page());
    await openEdit(root);
    await until(() => root.querySelector('[data-ref="edit-area"] [contenteditable="true"]'), "the editor");

    expect(q(root, "edit-dirty-state")?.textContent).toBe("No changes yet");
    const saveButton = q(root, "edit-save");
    expect(saveButton).toBeInstanceOf(HTMLButtonElement);
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);

    await click(q(root, "edit-done"));
    await until(() => getEditStore().edit === null && q(root, "edit-area") === null, "edit mode to close");
    expect(published(root).closest("[hidden]")).toBeNull();
    expect(q(root, "edit-page")).not.toBeNull();
  });

  it("a system page shows its drug table as a stub, not an editor", async () => {
    asOwner(true);
    const root = await render(page("system:fm:cardiovascular"));
    const area = await openEdit(root);
    const stub = await until(
      () => [...area.querySelectorAll(".stub")].find((s) => s.textContent === "ANTIANGINALS drug table — edited on its pharm section"),
      "the ANTIANGINALS stub",
    );
    expect(area.textContent).toContain("ANTIANGINALS drug table — edited on its pharm section");
    expect(stub.querySelector("[contenteditable]")).toBeNull();
    expect(stub.closest("[contenteditable]")).toBeNull();
  });
});

describe("SaveBanner", () => {
  it("saved", async () => {
    const root = await render(<SaveBanner banner={{ kind: "saved" }} />);
    expect(root.textContent).toContain("Saved.");
    expect(root.textContent).toContain("Everyone will see the change on the site within a few minutes.");
  });

  it("offline offers Try again", async () => {
    const root = await render(<SaveBanner banner={{ kind: "offline" }} />);
    expect(root.textContent).toContain("Couldn’t save — no internet connection.");
    expect(q(root, "save-retry")?.textContent).toBe("Try again");
  });

  it("failed offers Copy my changes and no Try again", async () => {
    const root = await render(<SaveBanner banner={{ kind: "failed" }} />);
    expect(root.textContent).toContain(SAVE_FAILED.title);
    expect(root.textContent).toContain(SAVE_FAILED.body);
    expect(q(root, "save-error-copy")?.textContent).toBe("Copy my changes");
    expect(q(root, "save-retry")).toBeNull();
    expect(root.textContent).not.toContain("Try again");
  });

  it("conflict names the other save's time and offers copy and load newer", async () => {
    const root = await render(<SaveBanner banner={{ kind: "conflict", at: "Oct 4, 2026, 3:15 PM" }} />);
    expect(root.textContent).toContain("Oct 4, 2026, 3:15 PM");
    expect(q(root, "conflict-copy")?.textContent).toBe("Copy my changes");
    expect(q(root, "conflict-load-newer")?.textContent).toBe("Load newer version");
  });

  it("loaded mentions the clipboard only when the changes were copied", async () => {
    const copied = await render(<SaveBanner banner={{ kind: "loaded", at: "X", copied: true }} />);
    expect(copied.querySelector(".bt")?.textContent).toContain("Your copied changes are on the clipboard.");
    const notCopied = await render(<SaveBanner banner={{ kind: "loaded", at: "X", copied: false }} />);
    expect(notCopied.querySelector(".bt")?.textContent).toBe("Showing the newer version saved at X.");
  });

  it("Copy my changes toasts whether the clipboard took them", async () => {
    const written: string[] = [];
    stubClipboard(async (text) => {
      written.push(text);
    });
    await openAndType();
    const root = await render(<><SaveBanner banner={{ kind: "conflict", at: "Oct 4, 2026, 3:15 PM" }} /><Toast /></>);

    await click(q(root, "conflict-copy"));
    await until(() => root.querySelector(".toast")?.textContent?.includes(COPY_DONE), "the copied toast");
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("more AF text (new)");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubClipboard(() => Promise.reject(new DOMException("denied", "NotAllowedError")));
    await click(q(root, "conflict-copy"));
    await until(() => root.querySelector(".toast")?.textContent?.includes(COPY_FAILED), "the copy-failed toast");
    expect(warn).toHaveBeenCalled();
  });
});

describe("PageBanner", () => {
  it("shows on its own page only, and Dismiss removes it", async () => {
    inAct(() => {
      showPageBanner(KEY, { kind: "restored", from: "Oct 1, 2026, 9:00 AM" });
      return true;
    });
    const root = await render(<PageBanner pageKey={KEY} />);
    const other = await render(<PageBanner pageKey="topic:fm:elsewhere" />);

    expect(q(root, "restored")?.textContent).toContain("Restored");
    expect(q(root, "restored")?.textContent).toContain("Oct 1, 2026, 9:00 AM");
    expect(other.innerHTML).toBe("");

    const dismiss = [...root.querySelectorAll("button")].find((b) => b.textContent === "Dismiss");
    await click(dismiss);
    expect(getEditStore().pageBanner).toBeNull();
    expect(q(root, "restored")).toBeNull();
  });
});

describe("dialogs", () => {
  const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"]');
  const button = (label: string): HTMLButtonElement | undefined =>
    [...(dialog()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === label);

  it("a confirm resolves true on its action and false on Cancel, then closes", async () => {
    await render(<UnsavedDialog />);

    const first = inAct(() => askConfirm("Delete this row?", ["It holds a picture."], { action: "Delete", danger: true }));
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Delete this row?");
    expect(dialog()?.textContent).toContain("It holds a picture.");
    await click(button("Delete"));
    expect(await first).toBe(true);
    expect(dialog()).toBeNull();

    const second = inAct(() => askConfirm("Delete this row?", ["It holds a picture."], { action: "Delete", danger: true }));
    expect(dialog()).not.toBeNull();
    await click(button("Cancel"));
    expect(await second).toBe(false);
    expect(dialog()).toBeNull();
  });

  it("unsaved changes: Keep editing stays in the edit, Discard changes closes it", async () => {
    await openAndType();
    await render(<UnsavedDialog />);
    expect(dialog()).toBeNull();

    const stay = inAct(() => confirmLeave());
    expect(dialog()?.textContent).toContain("You have unsaved changes");
    await click(button("Keep editing"));
    expect(await stay).toBe(false);
    expect(edit().dirty).toBe(true);
    expect(dialog()).toBeNull();

    const discard = inAct(() => confirmLeave());
    expect(dialog()).not.toBeNull();
    await click(button("Discard changes"));
    expect(await discard).toBe(true);
    expect(getEditStore().edit).toBeNull();
    expect(dialog()).toBeNull();
  });
});
