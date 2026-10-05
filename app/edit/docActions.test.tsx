// The failed-replacement note on a document's page and its Dismiss (Orchestrator ruling 2026-10-04
// 20:39Z, amending plan 50 §50.9 step 4; design editing/docs/rules/replacefail).
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, type ReactNode } from "react";
import { parseTrailers, serializeFile, type AsIsFile, type WordDocFile } from "../../lib/content/index.ts";
import { docPath, type DocJson } from "../../lib/derive/published.ts";
import { D } from "../../tools/build/test-fixture.ts";
import { DEVICE_KEY } from "../auth/config.ts";
import type { FakeRequest } from "../e2e/fake-github.ts";
import { setOwner } from "../shell/owner.tsx";
import { hideToast, Toast } from "../shell/toast.tsx";
import { asOwner, click, mount, until, type Mounted } from "../testing.tsx";
import { DISMISS, ReplaceFailedNote } from "./DocActions.tsx";
import { dismissReplaceFailed } from "./docs.ts";
import { memoryStore } from "./idb.ts";
import { overlayEntries, setOverlayStoreForTests, stopOverlay, type OverlayEntry } from "./overlay.ts";
import { loadFixture, startWorld, type Fixture, type World } from "./testkit.ts";

const MARKER = { fileName: "chart2.png", at: "2026-10-04T12:00:00Z" };
const AUTHOR = { name: "kaitlyla", email: "337482200+kaitlyla@users.noreply.github.com" };
const PDF = `content/files/${D(1)}/file.json`;
const WORD = `content/docs/${D(5)}/doc.json`;

let fx: Fixture;
let w: World;
let mounted: Mounted[] = [];

beforeAll(async () => {
  fx = await loadFixture();
}, 60_000);

beforeEach(() => {
  w = startWorld(fx);
  localStorage.setItem(DEVICE_KEY, "0123456789");
  setOverlayStoreForTests(memoryStore<OverlayEntry>());
});

afterEach(() => {
  mounted.forEach((m) => m.unmount());
  mounted = [];
  act(() => setOwner({ owner: false }));
  hideToast();
  stopOverlay();
  w.stop();
});

async function render(node: ReactNode): Promise<HTMLDivElement> {
  const m = await mount(node);
  mounted.push(m);
  return m.container;
}

const record = <T,>(path: string, at?: string): T => JSON.parse(w.fake.readFile(path, at) ?? "null") as T;

/** Puts the marker on the document's record at main, as the inbox job does after a failed replace. */
function markFailed(path: string): string {
  return w.fake.commitFiles({ [path]: serializeFile(path, { ...record<object>(path), replaceFailed: MARKER }) }, { message: "Replace failed", date: "2026-10-04T12:00:00Z" });
}

const published = (id: string): DocJson => ({ ...(fx.published.get(docPath(id)) as DocJson), replaceFailed: MARKER });
const note = (root: ParentNode): HTMLElement | null => root.querySelector<HTMLElement>('[data-ref="replace-failed"]');

describe("ReplaceFailedNote", () => {
  it("shows the owner the note with the new file's name and the short date, and Dismiss", async () => {
    asOwner(true);
    const root = await render(<ReplaceFailedNote doc={published(D(1))} />);
    expect(note(root)?.querySelector(".bt")?.textContent).toBe("Couldn’t replace with chart2.png (Oct 4). The old file is still here. Try again.");
    expect(note(root)?.querySelector("button")?.textContent).toBe(DISMISS);
    expect(DISMISS).toBe("Dismiss");
  });

  it("shows a visitor nothing", async () => {
    const root = await render(<ReplaceFailedNote doc={published(D(1))} />);
    expect(root.innerHTML).toBe("");
  });

  it("shows nothing when the document has no marker", async () => {
    asOwner(true);
    const root = await render(<ReplaceFailedNote doc={fx.published.get(docPath(D(1))) as DocJson} />);
    expect(note(root)).toBeNull();
  });

  it("Dismiss commits the record without the marker as an owner edit, overlays it, and hides the note", async () => {
    const before = markFailed(PDF);
    asOwner(true);
    const root = await render(<ReplaceFailedNote doc={published(D(1))} />);
    await click(root.querySelector<HTMLElement>('[data-ref="replace-failed-dismiss"]'));
    await until(() => (note(root) === null ? true : null), "the note to go");

    const head = w.fake.head();
    expect(head).not.toBe(before);
    const { replaceFailed, ...rest } = record<AsIsFile>(PDF, before);
    expect(replaceFailed).toEqual(MARKER);
    expect(record<AsIsFile>(PDF)).toEqual(rest);
    expect(parseTrailers(w.fake.commit(head)?.message ?? "")).toEqual({ kind: "edit", page: `doc:${D(1)}`, changed: [D(1)], device: "0123456789" });
    expect(overlayEntries().get(PDF)).toEqual({ commit: head, json: rest });
  });

  it("Dismiss that GitHub refuses keeps the note and says it couldn't save", async () => {
    markFailed(PDF);
    asOwner(true);
    const root = await render(<><ReplaceFailedNote doc={published(D(1))} /><Toast /></>);
    const before = w.fake.head();
    w.fake.fail((r: FakeRequest) => r.method === "PATCH" && r.url.endsWith("/git/refs/heads/main"), { status: 422 }, 5);
    await click(root.querySelector<HTMLElement>('[data-ref="replace-failed-dismiss"]'));
    await until(() => (document.body.textContent?.includes("Couldn’t save.") ? true : null), "the failure toast");
    expect(note(root)).not.toBeNull();
    expect(w.fake.head()).toBe(before);
  });
});

describe("dismissReplaceFailed", () => {
  it("removes the marker from a Word page's doc.json", async () => {
    markFailed(WORD);
    const r = await dismissReplaceFailed({ git: w.git, author: AUTHOR, docId: D(5) });
    expect(r.kind).toBe("saved");
    expect(record<WordDocFile>(WORD)).not.toHaveProperty("replaceFailed");
    expect(record<WordDocFile>(WORD).name).toBe("Thyroid notes");
    expect(w.fake.readFile(`content/files/${D(5)}/file.json`)).toBeUndefined();
  });

  it("writes nothing when the record has no marker", async () => {
    const head = w.fake.head();
    const r = await dismissReplaceFailed({ git: w.git, author: AUTHOR, docId: D(1) });
    expect(r).toEqual({ kind: "saved", commit: head, files: new Map() });
    expect(w.fake.head()).toBe(head);
    expect(w.fake.writes()).toEqual([]);
  });
});
