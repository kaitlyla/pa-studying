// Edit mode on a page (plan 50 §50.2–§50.4) as rendered: the Edit and Versions buttons, the region
// that swaps the page body for editors, the toolbar's Done, the save banners and their copy toast,
// the page banner, and the confirm and unsaved-changes dialogs.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { EditorView } from "prosemirror-view";
import { serializeFile, type DocJSON, type MedsFile } from "../../lib/content/index.ts";
import { B, C, G, R } from "../../tools/build/test-fixture.ts";
import { OWN_VERSION } from "../pharm/MedsPanel.tsx";
import { setOwner } from "../shell/owner.tsx";
import { hideToast, Toast } from "../shell/toast.tsx";
import { asOwner, click, mount, until, type Mounted } from "../testing.tsx";
import { askConfirm, UnsavedDialog } from "./dialogs.tsx";
import { BELOW_HEADING } from "../../lib/derive/topics.ts";
import { docText } from "../../lib/derive/text.ts";
import { EditControls, EditRegion, PageBanner, SaveBanner } from "./EditRegion.tsx";
import { createEditorState } from "./editor/state.ts";
import { markViews, nodeViews } from "./editor/views.ts";
import { memoryStore, type KvStore } from "./idb.ts";
import { cancelSignIn, checkOwner, continueWithGithub, getAuthUi, SAVING_AGAIN, startOwnerCheck } from "../auth/auth.ts";
import { AUTH_KEY, CHANNEL_NAME } from "../auth/config.ts";
import { startEditing } from "./boot.ts";
import { setOverlayStoreForTests, stopOverlay, type OverlayEntry } from "./overlay.ts";
import {
  confirmLeave, COPY_DONE, COPY_FAILED, discardEdit, getEditStore, LOAD_NEWER, loadNewer, mountedEditor, registerView, save, SAVE_CONFLICT, SAVE_FAILED,
  SAVE_OFFLINE, saveDraft,
  setDraftStoreForTests, showPageBanner, startEdit, viewChanged, type Draft,
} from "./session.ts";
import { loadFixture, startWorld, type Fixture, type World } from "./testkit.ts";
import { fileChoice, shownMedsSlots } from "./units.ts";
import { ADD_CARD, ADDED_LATER, MEDS_HEADING, PUT_BACK, REMOVED_HEADING } from "./MedsEdit.tsx";

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
    const slots = p.kind === "stub" ? [] : p.kind === "gap" ? [p.doc, ...(p.differs ? [p.differs] : [])] : p.kind === "meds" ? shownMedsSlots(p, fileChoice(p)) : [p.slot];
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

function need<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error("missing element");
  return v;
}

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
    // The topic's rows, then one editor per piece of each card in its meds panel, then its below area.
    const unit = edit().unit;
    if (!unit) throw new Error("no unit");
    const meds = unit.parts.flatMap((p) => (p.kind === "meds" ? shownMedsSlots(p, fileChoice(p)) : []));
    expect(meds.length).toBeGreaterThan(0);
    const editors = [...root.querySelectorAll('[data-ref="edit-area"] [contenteditable="true"]')];
    expect(editors).toHaveLength(2 + meds.length);
    expect(editors[0]?.closest(".below-edit, .meds-edit")).toBeNull();
    for (const e of editors.slice(1, -1)) expect(e.closest(`section.meds-edit[aria-label="${MEDS_HEADING}"]`)).not.toBeNull();
    expect(editors.at(-1)?.closest(`section.below-edit[aria-label="${BELOW_HEADING}"]`)).not.toBeNull();
    expect(q(root, "edit-area")?.textContent).not.toContain("Opening for editing…");
    expect(published(root).closest("[hidden]")).not.toBeNull();
    expect(q(root, "edit-page")).toBeNull();
    expect(q(root, "edit-versions")).toBeNull();
  });

  it("while editing, the topic's meds panel is between its rows and the Additional info editor, with Add a card", async () => {
    asOwner(true);
    const root = await render(page());
    const area = await openEdit(root);
    const panel = await until(() => area.querySelector<HTMLElement>(`section.meds-edit[aria-label="${MEDS_HEADING}"]`), "the meds panel");
    const [rows] = [...area.querySelectorAll('[contenteditable="true"]')];
    const below = area.querySelector(".below-edit");
    if (!rows || !below) throw new Error("no rows editor and below area");
    expect(rows.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel.compareDocumentPosition(below) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(q(panel, "meds-add")?.textContent).toBe("Add a card");
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

  describe("the meds panel's buttons (AF R101 shows CCBs C1; the page also has Nitrates C2 and Beta Blockers C3)", () => {
    const MEDS_FILE = `content/guides/fm/cardiovascular/meds/${R(101)}.json`;
    const card = (panel: ParentNode, id: string): HTMLElement | null => panel.querySelector<HTMLElement>(`section.phc[data-anchor="meds-${id}"]`);
    const shownCards = (panel: ParentNode): string[] => [...panel.querySelectorAll<HTMLElement>("section.phc")].map((s) => s.dataset.anchor ?? "");
    const count = (panel: ParentNode): string | null | undefined => panel.querySelector(".meds-hd .n")?.textContent;
    const dirtyState = (root: ParentNode): string | null | undefined => q(root, "edit-dirty-state")?.textContent;
    const editorText = (el: ParentNode): string => [...el.querySelectorAll('[contenteditable="true"]')].map((e) => e.textContent).join("\n");
    async function openPanel(): Promise<{ root: HTMLElement; panel: HTMLElement }> {
      asOwner(true);
      const root = await render(page());
      const area = await openEdit(root);
      const panel = await until(() => area.querySelector<HTMLElement>(`section.meds-edit[aria-label="${MEDS_HEADING}"]`), "the meds panel");
      return { root, panel };
    }
    function type(input: HTMLInputElement, value: string): void {
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }

    it("Remove from this condition moves a card to the Removed list; Put back returns it and the edit is clean again", async () => {
      const { root, panel } = await openPanel();
      expect(shownCards(panel)).toEqual([`meds-${C(1)}`]);
      expect(q(panel, "meds-removed")).toBeNull();

      await click(q(need(card(panel, C(1))), "meds-remove"));
      await until(() => card(panel, C(1)) === null, "the CCB card off the panel");
      expect(count(panel)).toBe("0");
      const removed = need(q(panel, "meds-removed"));
      expect(removed.textContent).toContain(REMOVED_HEADING);
      expect([...removed.querySelectorAll("li")].map((li) => li.textContent)).toEqual([`Calcium Channel Blockers ${PUT_BACK}`]);
      expect(dirtyState(root)).not.toBe("No changes yet");

      await click(q(removed, "meds-put-back"));
      await until(() => card(panel, C(1)), "the CCB card back");
      expect(q(panel, "meds-removed")).toBeNull();
      expect(count(panel)).toBe("1");
      expect(dirtyState(root)).toBe("No changes yet");
    });

    it("Add a card finds a card the panel doesn't show by her words, adds it with editors, and Remove takes it off again", async () => {
      const { root, panel } = await openPanel();
      await click(q(panel, "meds-add"));
      const open = need(q(panel, "meds-add-open"));
      const picks = (): string[] => [...open.querySelectorAll('[data-ref="meds-add-pick"]')].map((b) => b.textContent ?? "");
      // The card already on the panel is not offered.
      expect(picks()).toEqual(expect.arrayContaining(["Beta Blockers", "Nitrates"]));
      expect(picks()).not.toContain("Calcium Channel Blockers");
      type(need(q(open, "meds-add-find")) as HTMLInputElement, "nitr");
      expect(picks()).toEqual(["Nitrates"]);

      await click(q(open, "meds-add-pick"));
      const added = await until(() => card(panel, C(2)), "the Nitrates card");
      expect(shownCards(panel)).toEqual([`meds-${C(1)}`, `meds-${C(2)}`]);
      expect(q(panel, "meds-add-open")).toBeNull();
      expect(q(panel, "meds-add")?.textContent).toBe(ADD_CARD);
      expect(added.querySelectorAll('[contenteditable="true"]').length).toBeGreaterThan(0);
      expect(dirtyState(root)).not.toBe("No changes yet");

      // A card she added goes away on Remove; it is not one to put back.
      await click(q(added, "meds-remove"));
      await until(() => card(panel, C(2)) === null, "the Nitrates card off");
      expect(q(panel, "meds-removed")).toBeNull();
      expect(dirtyState(root)).toBe("No changes yet");
    });

    it("with her stored version: its label and text, Use the original and Use my version; a card this page has no notes of shows as added later", async () => {
      const mine = "My CCB note for AF";
      const stored: MedsFile = {
        v: 1,
        add: [C(9)],
        remove: [],
        own: [{ target: C(1), pieces: [{ kind: "notes", basePt: 9, title: null, file: "Cardio med list", doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: mine }] }] } as DocJSON }] }],
      };
      w.fake.commitFiles({ [MEDS_FILE]: serializeFile(MEDS_FILE, stored) });
      const { root, panel } = await openPanel();
      const ccb = need(card(panel, C(1)));
      expect(ccb.querySelector(".phn-k.own-only")?.textContent).toBe(OWN_VERSION);
      expect(editorText(ccb)).toBe(mine);
      expect(q(ccb, "meds-mine")).toBeNull();

      await click(q(ccb, "meds-original"));
      await until(() => !editorText(ccb).includes(mine), "the card's own text in the editors");
      expect(editorText(ccb)).not.toBe("");
      expect(ccb.querySelector(".phn-k.own-only")).toBeNull();
      expect(q(ccb, "meds-original")).toBeNull();
      expect(dirtyState(root)).not.toBe("No changes yet");

      await click(q(ccb, "meds-mine"));
      await until(() => editorText(ccb) === mine, "her version back");
      expect(ccb.querySelector(".phn-k.own-only")?.textContent).toBe(OWN_VERSION);
      expect(dirtyState(root)).toBe("No changes yet");

      const later = need(q(panel, "meds-later"));
      expect(later.textContent).toContain(C(9));
      expect(later.textContent).toContain(ADDED_LATER);
      expect(count(panel)).toBe("2");
      await click(q(later, "meds-remove"));
      await until(() => q(panel, "meds-later") === null, "the added-later card off");
      expect(count(panel)).toBe("1");
    });

    it("a sourced card placed in her file is edited inside the panel, ordered by its role, and comes off and back like a card", async () => {
      const stored: MedsFile = {
        v: 1, add: [], remove: [], own: [], gaps: [G(3)],
        roles: [{ target: G(3), roles: [{ role: "adjunct", drugs: null, note: null, sources: [{ name: "Atrial Fibrillation", org: "MSD Manual", year: "2026", url: null }] }] }],
      };
      w.fake.commitFiles({ [MEDS_FILE]: serializeFile(MEDS_FILE, stored) });
      const { root, panel } = await openPanel();
      const gapPart = edit().unit?.parts.find((p) => p.kind === "gap" && p.gap.id === G(3));
      if (gapPart?.kind !== "gap") throw new Error("no sourced card part");
      // The labeled entry comes first; the unlabeled card keeps its place after it.
      expect(shownCards(panel)).toEqual([G(3), `meds-${C(1)}`]);
      expect(count(panel)).toBe("2");
      const sourced = need(panel.querySelector<HTMLElement>(`section.phc[data-anchor="${G(3)}"]`));
      expect(sourced.querySelector(".phc-h .rolec")?.textContent).toBe("Adjunct");
      expect(editorText(sourced)).not.toBe("");
      // Its editor is in the panel only: outside it are just the rows editor and the below area.
      const area = need(q(root, "edit-area"));
      const outside = [...area.querySelectorAll('[contenteditable="true"]')].filter((e) => e.closest(".meds-edit, .below-edit") === null);
      expect(outside).toHaveLength(1);

      await click(q(sourced, "meds-remove"));
      await until(() => panel.querySelector(`section.phc[data-anchor="${G(3)}"]`) === null, "the sourced card off the panel");
      const removed = need(q(panel, "meds-removed"));
      expect([...removed.querySelectorAll("li")].map((li) => li.textContent)).toEqual([`${gapPart.gap.meta.title} ${PUT_BACK}`]);
      expect(dirtyState(root)).not.toBe("No changes yet");

      await click(q(removed, "meds-put-back"));
      await until(() => panel.querySelector(`section.phc[data-anchor="${G(3)}"]`), "the sourced card back");
      expect(q(panel, "meds-removed")).toBeNull();
      expect(dirtyState(root)).toBe("No changes yet");
    });

    it("the gap block her version holds is edited under her version, inside its card, and goes and comes back with Use the original / Use my version", async () => {
      const mine = "My CCB note for AF";
      const stored: MedsFile = {
        v: 1, add: [], remove: [],
        own: [{ target: C(1), pieces: [{ kind: "notes", basePt: 9, title: null, file: "Cardio med list", doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: mine }] }] } as DocJSON }], gap: G(3) }],
      };
      w.fake.commitFiles({ [MEDS_FILE]: serializeFile(MEDS_FILE, stored) });
      const { panel } = await openPanel();
      const gapPart = edit().unit?.parts.find((p) => p.kind === "gap" && p.gap.id === G(3));
      if (gapPart?.kind !== "gap") throw new Error("no gap part");
      const gapText = docText(gapPart.gap.doc);
      expect(gapText).not.toBe("");
      // Not an entry of its own: the panel shows just the CCB card, holding her notes then the block.
      expect(shownCards(panel)).toEqual([`meds-${C(1)}`]);
      const ccb = need(card(panel, C(1)));
      await until(() => editorText(ccb).includes(gapText), "the block's editor in her version");
      expect(editorText(ccb).indexOf(mine)).toBeLessThan(editorText(ccb).indexOf(gapText));

      await click(q(ccb, "meds-original"));
      await until(() => !editorText(ccb).includes(gapText), "the block gone with her version");
      await click(q(ccb, "meds-mine"));
      await until(() => editorText(ccb).includes(gapText), "the block back with her version");
    });
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
    expect(root.querySelector(".bt b")?.textContent).toBe(SAVE_OFFLINE);
    expect(SAVE_OFFLINE).toBe("Couldn’t save — no internet connection.");
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
    expect(root.querySelector(".bt b")?.textContent).toBe(SAVE_CONFLICT("Oct 4, 2026, 3:15 PM"));
    expect(SAVE_CONFLICT("Oct 4, 2026, 3:15 PM")).toBe("Not saved — this page was saved from another device at Oct 4, 2026, 3:15 PM after you opened it.");
    expect(q(root, "conflict-copy")?.textContent).toBe("Copy my changes");
    expect(q(root, "conflict-load-newer")?.textContent).toBe(LOAD_NEWER);
    expect(LOAD_NEWER).toBe("Load newer version");
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

  it("after a conflict, Load newer version's dialog has no Save and continue; Copy my changes copies and loads", async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => { written.push(t); } } });
    await openAndType();
    await render(<><Toast /><UnsavedDialog /></>);
    const block = `content/guides/fm/cardiovascular/blocks/${B(10)}.json`;
    const theirs = (w.fake.readFile(block) ?? "").replace("chest pain on exertion", "chest pain on exertion, relieved by rest");
    w.fake.commitFiles({ [block]: theirs }, { message: "Edit: Stable angina" });
    expect(await inAct(() => save())).toBe(false);
    expect(edit().banner?.kind).toBe("conflict");

    const load = inAct(() => loadNewer());
    expect(dialog()?.textContent).toContain("You have unsaved changes");
    expect(button("Save and continue")).toBeUndefined();
    expect(button("Keep editing")).toBeDefined();
    expect(button("Discard changes")).toBeDefined();
    await click(button("Copy my changes"));
    await load;

    expect(written).toHaveLength(1);
    await until(() => document.body.textContent?.includes(COPY_DONE), "the copied toast");
    expect(dialog()).toBeNull();
    expect(edit().banner).toMatchObject({ kind: "loaded", copied: true });
    expect(edit().unit?.snapshot.commit).toBe(w.fake.head());
  });
});

describe("a draft kept while a save waited on sign-in, reopened by the page's mounted region", () => {
  const page = (
    <>
      <Toast />
      <EditRegion pageKey={KEY}><p>published body</p></EditRegion>
    </>
  );

  /** A stored resume-save draft of KEY with " (new)" typed; `deletedAt` records main's head at each delete. */
  async function keptDraft(): Promise<{ store: KvStore<Draft>; deletedAt: string[] }> {
    const inner = memoryStore<Draft>();
    const deletedAt: string[] = [];
    const store: KvStore<Draft> = {
      get: (k) => inner.get(k),
      put: (k, v) => inner.put(k, v),
      entries: () => inner.entries(),
      delete: (k) => {
        deletedAt.push(w.fake.head());
        return inner.delete(k);
      },
    };
    setDraftStoreForTests(store);
    await openAndType();
    await saveDraft(true);
    views.forEach((v) => v.destroy());
    views = [];
    act(() => discardEdit());
    expect(await store.entries()).toHaveLength(1);
    return { store, deletedAt };
  }

  it("saves once with the signed-in-again toast, and deletes the draft only after the commit", async () => {
    const { store, deletedAt } = await keptDraft();
    const before = w.fake.head();
    // The region is on the page before she is known to be the owner, as after the sign-in redirect.
    const root = await render(page);
    asOwner(true);

    await until(() => (getEditStore().pageBanner?.banner.kind === "saved" ? true : null), "the saved banner");
    const head = w.fake.head();
    expect(head).not.toBe(before);
    expect(w.fake.commit(head)?.parents).toEqual([before]);
    expect(w.fake.commit(head)?.message).toContain("Pa-Studying-Kind: edit");
    expect(root.textContent).toContain(SAVING_AGAIN);
    await vi.waitFor(async () => expect(await store.entries()).toEqual([]));
    expect(deletedAt).toEqual([head]);
  });

  it("keeps the draft when that save can't reach GitHub", async () => {
    const { store, deletedAt } = await keptDraft();
    w.fake.fail((r) => r.method === "POST" && r.url.endsWith("/git/blobs"), "network", 10);
    await render(page);
    asOwner(true);

    await until(() => (getEditStore().edit?.banner?.kind === "offline" ? true : null), "the offline banner");
    expect(await store.entries()).toHaveLength(1);
    expect(deletedAt).toEqual([]);
  });
});

// Runs last in this file: the boot wiring and the owner check it starts stay registered for the module.
describe("her unsaved changes when she stops being the owner while the edit is open", () => {
  const page = (
    <>
      <Toast />
      <EditRegion pageKey={KEY}><p>published body</p></EditRegion>
    </>
  );
  const TYPED = "more AF text (kept)";
  let drafts: KvStore<Draft>;
  let other: BroadcastChannel;

  beforeEach(() => {
    drafts = memoryStore<Draft>();
    setDraftStoreForTests(drafts);
    startEditing();
    startOwnerCheck();
    other = new BroadcastChannel(CHANNEL_NAME);
  });

  afterEach(() => {
    other.close();
    act(() => cancelSignIn());
  });

  const editorIn = (root: ParentNode): Element | null => root.querySelector('[data-ref="edit-area"] [contenteditable="true"]');
  const atHead = (text: string): boolean => [...w.fake.listFiles().keys()].some((p) => w.fake.readFile(p)?.includes(text) === true);

  /** Signs in as the owner with a fresh token pair, the way a finished sign-in stores it. */
  function storeNewSignIn(): void {
    const t = w.fake.issueTokens();
    const exp = Date.now() + 3600_000;
    localStorage.setItem(AUTH_KEY, JSON.stringify({ access: t.access_token, accessExp: exp, refresh: t.refresh_token, refreshExp: exp }));
  }

  /** The owner opens the page's real EditRegion for editing and types " (kept)" into its editor. */
  async function openAndTypeInRegion(): Promise<HTMLElement> {
    await act(async () => {
      expect(await checkOwner()).toBe(true);
    });
    const root = await render(page);
    await act(async () => {
      expect(await startEdit(KEY, "Atrial fibrillation")).toBe(true);
    });
    await until(() => editorIn(root), "the editor");
    const unit = edit().unit;
    const slots = unit?.parts.flatMap((p) => (p.kind === "stub" || p.kind === "gap" ? [] : p.kind === "meds" ? shownMedsSlots(p, fileChoice(p)).map((s) => s.id) : [p.slot.id])) ?? [];
    act(() => {
      for (const slot of slots) {
        const view = mountedEditor(slot);
        let at = -1;
        view?.state.doc.descendants((node, pos) => {
          if (at === -1 && node.isText && node.text?.includes("more AF text")) at = pos + node.text.indexOf("more AF text") + "more AF text".length;
          return at === -1;
        });
        if (view && at !== -1) {
          view.dispatch(view.state.tr.insertText(" (kept)", at));
          return;
        }
      }
      throw new Error("no mounted editor holds the AF text");
    });
    expect(edit().dirty).toBe(true);
    expect(atHead(TYPED)).toBe(false);
    return root;
  }

  /** Save runs into an expired sign-in: the refresh is refused, so she is signed out mid-save. */
  async function saveIntoExpiredSignIn(root: HTMLElement): Promise<void> {
    w.fake.validTokens.delete("test-token");
    await click(q(root, "edit-save"));
    await until(() => getAuthUi().dialog === "expired", "the sign-in-again dialog");
    // The editors closed with the owner state: what she typed is no longer in any mounted editor.
    await until(() => editorIn(root) === null, "the editors to close");
  }

  it("a sign-in that expires during Save, renewed in the popup, saves what she typed", async () => {
    const root = await openAndTypeInRegion();
    const before = w.fake.head();
    await saveIntoExpiredSignIn(root);

    storeNewSignIn();
    await act(async () => {
      other.postMessage({ type: "signed-in" });
      await new Promise((r) => setTimeout(r, 0));
    });

    await until(() => (getEditStore().pageBanner?.banner.kind === "saved" ? true : null), "the saved banner");
    const head = w.fake.head();
    expect(w.fake.commit(head)?.parents).toEqual([before]);
    expect(atHead(TYPED)).toBe(true);
    await vi.waitFor(async () => expect(await drafts.entries()).toEqual([]));
  });

  it("with the sign-in popup blocked, the stored draft holds what she typed and saves after the return", async () => {
    const root = await openAndTypeInRegion();
    await saveIntoExpiredSignIn(root);
    vi.spyOn(window, "open").mockReturnValue(null);
    // jsdom logs the sign-in page load it can't perform.
    vi.spyOn(console, "error").mockImplementation(() => {});
    await until(() => getAuthUi().prepared, "the sign-in attempt");
    continueWithGithub();

    const stored = await vi.waitFor(async () => {
      const d = await drafts.get(KEY);
      expect(d?.resumeSave).toBe(true);
      return d;
    });
    expect(JSON.stringify(stored?.docs)).toContain(TYPED);

    // The page load leaves only the stored draft: this page's editors and memory go.
    mounted.forEach((m) => m.unmount());
    mounted = [];
    act(() => discardEdit());
    if (stored) await drafts.put(KEY, stored);

    storeNewSignIn();
    await render(page);
    await act(async () => {
      expect(await checkOwner()).toBe(true);
    });
    await until(() => (getEditStore().pageBanner?.banner.kind === "saved" ? true : null), "the saved banner");
    expect(atHead(TYPED)).toBe(true);
    await vi.waitFor(async () => expect(await drafts.entries()).toEqual([]));
  });

  it("a sign-out in another tab keeps what she typed, on the device and back in the editor when she signs in", async () => {
    const root = await openAndTypeInRegion();
    localStorage.removeItem(AUTH_KEY);
    await act(async () => {
      other.postMessage({ type: "signed-out" });
      await new Promise((r) => setTimeout(r, 0));
    });
    await until(() => editorIn(root) === null, "the editors to close");
    expect(edit().dirty).toBe(true);
    await vi.waitFor(async () => expect(JSON.stringify((await drafts.get(KEY))?.docs)).toContain(TYPED));

    storeNewSignIn();
    await act(async () => {
      other.postMessage({ type: "signed-in" });
      await new Promise((r) => setTimeout(r, 0));
    });
    await until(() => editorIn(root)?.textContent?.includes(TYPED), "the editor with her text");

    await click(q(root, "edit-save"));
    await until(() => (getEditStore().pageBanner?.banner.kind === "saved" ? true : null), "the saved banner");
    expect(atHead(TYPED)).toBe(true);
    await vi.waitFor(async () => expect(await drafts.entries()).toEqual([]));
  });
});
