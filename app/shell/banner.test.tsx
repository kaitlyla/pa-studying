// The page banner in the whole app: after a real save from a topic page, "Saved." shows once on
// that page and on no other page she moves to.
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { act } from "react";
import { R } from "../../tools/build/test-fixture.ts";
import { memoryStore } from "../edit/idb.ts";
import { setOverlayStoreForTests, stopOverlay, type OverlayEntry } from "../edit/overlay.ts";
import { discardEdit, getEditStore, mountedEditor, setDraftStoreForTests, type Draft } from "../edit/session.ts";
import { loadFixture, startWorld, type Fixture, type World } from "../edit/testkit.ts";
import { asOwner, click, go, renderApp, until, type Mounted } from "../testing.tsx";
import { hideToast } from "./toast.tsx";

const TOPIC = `#/eor/fm/t/${R(101)}`;

let fx: Fixture;
let w: World;
let app: Mounted | null = null;

beforeAll(async () => {
  fx = await loadFixture();
}, 60_000);

beforeEach(() => {
  w = startWorld(fx);
  setDraftStoreForTests(memoryStore<Draft>());
  setOverlayStoreForTests(memoryStore<OverlayEntry>());
});

afterEach(() => {
  app?.unmount();
  app = null;
  act(() => {
    hideToast();
    discardEdit();
  });
  asOwner(false);
  stopOverlay();
  w.stop();
});

const savedBanners = (root: HTMLElement): number => root.querySelectorAll('[data-ref="save-success"]').length;

it("after a save, Saved. shows once on the saved page and not on the next page", async () => {
  asOwner(true);
  app = await renderApp(TOPIC);
  const root = app.container;
  await click(await until(() => root.querySelector('[data-ref="edit-page"]'), "the topic's Edit button"));
  await until(() => root.querySelector('[data-ref="edit-area"] [contenteditable="true"]'), "the editor");

  const unit = getEditStore().edit?.unit;
  if (!unit) throw new Error("the unit has not loaded");
  const slots = unit.parts.flatMap((p) => (p.kind === "stub" || p.kind === "gap" ? [] : [p.slot.id]));
  act(() => {
    for (const slot of slots) {
      const view = mountedEditor(slot);
      let at = -1;
      view?.state.doc.descendants((node, pos) => {
        if (at === -1 && node.isText && node.text?.includes("more AF text")) at = pos + node.text.indexOf("more AF text") + "more AF text".length;
        return at === -1;
      });
      if (view && at !== -1) {
        view.dispatch(view.state.tr.insertText(" (new)", at));
        return;
      }
    }
    throw new Error("no mounted editor holds the AF text");
  });

  const before = w.fake.head();
  await click(root.querySelector('[data-ref="edit-save"]'));
  await until(() => (getEditStore().pageBanner?.banner.kind === "saved" ? true : null), "the saved banner");
  expect(w.fake.head()).not.toBe(before);
  await until(() => root.querySelector('[data-ref="save-success"]'), "Saved. on the page");
  expect(savedBanners(root)).toBe(1);

  await go("#/eor/fm/s/pulmonary");
  await until(() => (root.querySelector("main h1")?.textContent?.includes("Pulmonary") ? true : null), "the pulmonary page");
  expect(getEditStore().pageBanner?.banner.kind).toBe("saved");
  expect(savedBanners(root)).toBe(0);
});
