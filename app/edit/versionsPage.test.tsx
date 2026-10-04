// The Versions page as rendered (plan 50 §50.6, UI versions): owner-only, the list with its badges,
// View under the "Viewing the version from …" bar, and Restore after its confirm, back on the page
// with the "Restored" banner.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, type ReactNode } from "react";
import { commitMessage, type BlockFile, type DocJSON } from "../../lib/content/index.ts";
import { R, B } from "../../tools/build/test-fixture.ts";
import { DEVICE_KEY } from "../auth/config.ts";
import { setOwner } from "../shell/owner.tsx";
import { asOwner, click, mount, until, type Mounted } from "../testing.tsx";
import { versionTime } from "./format.ts";
import { memoryStore } from "./idb.ts";
import { setOverlayStoreForTests, stopOverlay, type OverlayEntry } from "./overlay.ts";
import { discardEdit, getEditStore } from "./session.ts";
import { Snapshot } from "./snapshot.ts";
import { loadFixture, startWorld, type Fixture, type World } from "./testkit.ts";
import { buildSave, loadUnit, type Part } from "./units.ts";
import { pageHash, rememberVersionsOrigin } from "./versions.ts";
import { VersionsPage } from "./VersionsPage.tsx";

const KEY = `topic:fm:${R(101)}`;
const BLOCK = `content/guides/fm/cardiovascular/blocks/${B(10)}.json`;

type Node = { type: string; attrs?: Record<string, unknown>; content?: Node[]; text?: string };

let fx: Fixture;
let w: World;
let mounted: Mounted[] = [];

beforeAll(async () => {
  fx = await loadFixture();
}, 60_000);

beforeEach(() => {
  w = startWorld(fx);
  localStorage.setItem(DEVICE_KEY, "0123456789");
  sessionStorage.clear();
  setOverlayStoreForTests(memoryStore<OverlayEntry>());
});

afterEach(() => {
  mounted.forEach((m) => m.unmount());
  mounted = [];
  act(() => {
    setOwner({ owner: false });
    discardEdit();
  });
  stopOverlay();
  w.stop();
});

async function render(node: ReactNode): Promise<HTMLDivElement> {
  const m = await mount(node);
  mounted.push(m);
  return m.container;
}

const q = (root: ParentNode, ref: string): HTMLElement | null => root.querySelector<HTMLElement>(`[data-ref="${ref}"]`);

/** Commits an edit of R102's middle cell on the topic page, at `date`. */
async function editR102(text: string, date: string): Promise<string> {
  const unit = await loadUnit(KEY, await Snapshot.at(w.git));
  const part = unit.parts.find((p): p is Extract<Part, { kind: "rows" }> => p.kind === "rows");
  if (!part) throw new Error("no rows part");
  const doc = JSON.parse(JSON.stringify(part.slot.doc)) as DocJSON;
  const row = ((doc.content[0] as Node).content ?? []).find((r) => r.attrs?.id === R(102));
  if (!row?.content) throw new Error("no R102");
  row.content[1] = { type: "table_cell", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
  const build = buildSave(unit, new Map([[part.slot.id, doc]]), "2026-10-04");
  const files = Object.fromEntries(build.changes.map((c) => [c.path, "content" in c ? c.content : null]));
  return w.fake.commitFiles(files, {
    message: commitMessage("Edit: Atrial fibrillation", { kind: "edit", page: KEY, changed: build.changed, device: "0123456789" }),
    date,
  });
}

describe("VersionsPage", () => {
  it("a visitor gets the not-on-site page, and nothing is read from GitHub", async () => {
    const root = await render(<VersionsPage pageKey={KEY} />);
    expect(root.querySelector('[data-surface="versions"]')).toBeNull();
    expect(w.fake.requests.filter((r) => new URL(r.url).pathname.includes("/commits"))).toEqual([]);
  });

  it("lists the versions newest first with Current and Original, Views one read-only, and Restores it", async () => {
    const first = await editR102("first wording", "2026-10-02T09:00:00Z");
    await editR102("second wording", "2026-10-03T09:00:00Z");
    const back = pageHash(KEY) ?? "";
    rememberVersionsOrigin(KEY, { title: "Atrial fibrillation", back });
    asOwner(true);
    const root = await render(<VersionsPage pageKey={KEY} />);

    const list = await until(() => q(root, "versions-list"), "the versions list");
    expect(root.querySelector("h1")?.textContent).toBe("Versions of “Atrial fibrillation”");
    const rows = [...list.querySelectorAll("li")].map((li) => li.textContent);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain(versionTime("2026-10-03T09:00:00Z"));
    expect(rows[0]).toContain("Your edit");
    expect(rows[0]).toContain("Current");
    expect(q(root, "version-restore-0")).toBeNull();
    expect(rows[1]).toContain(versionTime("2026-10-02T09:00:00Z"));
    expect(rows[1]).toContain("Original — converted from your Word file");

    await click(q(root, "version-view-1"));
    const preview = await until(() => (q(root, "version-preview")?.textContent?.includes("first wording") ? q(root, "version-preview") : null), "the version's rows");
    expect(preview.textContent).toContain(`Viewing the version from ${versionTime("2026-10-02T09:00:00Z")}`);
    expect(preview.querySelector("[contenteditable]")).toBeNull();
    expect(q(root, "version-view-1")?.textContent).toBe("Hide");

    await click(q(root, "version-restore-1"));
    expect(document.body.textContent).toContain("Restore this version?");
    await click(document.querySelector<HTMLElement>('[data-ref="restore-confirm"]'));
    const banner = await until(() => getEditStore().pageBanner, "the Restored banner");
    expect(banner).toMatchObject({ key: KEY, banner: { kind: "restored", from: versionTime("2026-10-02T09:00:00Z") } });
    expect(location.hash).toBe(back);
    expect(w.fake.readFile(BLOCK)).toBe(w.fake.readFile(BLOCK, first));
    expect(JSON.stringify(JSON.parse(w.fake.readFile(BLOCK) ?? "null") as BlockFile)).toContain("first wording");
  });
});
