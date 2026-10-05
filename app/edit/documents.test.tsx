// Documents (plan 50 §50.7–§50.9): rename, remove and restore as commits; adding and replacing through
// the browser upload with its checks, steps, retry rule and resume; and the owner's controls for them.
// Replace's `replacing` commit is a doc-marker commit (Orchestrator ruling 2026-10-05 00:55Z).
import { createHash } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { inboxUploadPath, parseTrailers, serializeFile, type AsIsFile, type OtherFile, type UploadFile, type WordDocFile } from "../../lib/content/index.ts";
import { BUILD_PATH, docPath, OTHER_PATH, type DocJson, type OtherJson } from "../../lib/derive/published.ts";
import { D } from "../../tools/build/test-fixture.ts";
import { loadData } from "../data/load.ts";
import type { FakeRequest } from "../e2e/fake-github.ts";
import { setOwner } from "../shell/owner.tsx";
import { hideToast, Toast } from "../shell/toast.tsx";
import { asOwner, byText, click, mount, until, type Mounted } from "../testing.tsx";
import {
  ADDED, AddDocument, DocActions, FAILED_NOTE, PendingDocPage, PROCESSING_NOTE, RemovedDocs, RENAMED, REMOVE_BODY, REMOVED, REPLACED, RESTORED,
  UploadProblem,
} from "./DocActions.tsx";
import { removeDoc, renameDoc, restoreDoc } from "./docs.ts";
import { retry } from "./github.ts";
import { memoryStore } from "./idb.ts";
import { setOverlayStoreForTests, stopOverlay, type OverlayEntry } from "./overlay.ts";
import { SAVE_OFFLINE } from "./session.ts";
import {
  CHOOSE_FILE, checkUpload, defaultName, fileProblem, inboxOriginal, MAX_FILE_BYTES, NAME_BLANK, PROCESS_WORKFLOW, resetUploadsForTests, retryUpload,
  SITE_FULL, SITE_LIMIT_BYTES, spaceProblem, startUpload, storedBytes, TOO_BIG, TYPE_REFUSED, uploadExt, uploadsInProgress,
} from "./upload.ts";
import { loadFixture, startWorld, type Fixture, type World } from "./testkit.ts";

const AUTHOR = { name: "kaitlyla", email: "337482200+kaitlyla@users.noreply.github.com" };
const PDF = `content/files/${D(1)}/file.json`;
const WORD = `content/docs/${D(5)}/doc.json`;
const OTHER = "content/places/other.json";

let fx: Fixture;
let w: World;
let mounted: Mounted[] = [];

beforeAll(async () => {
  fx = await loadFixture();
}, 60_000);

/** The fixture's published data plus `build.json` (written by the build, absent from the fixture). */
const withBuild = (siteBytes: number): Map<string, unknown> =>
  new Map(fx.published).set(BUILD_PATH, { commit: "c", builtAt: "2026-10-01T00:00:00Z", siteBytes, dropped: [], uncoveredGlyphs: [] });

beforeEach(() => {
  w = startWorld(fx, withBuild(1000));
  setOverlayStoreForTests(memoryStore<OverlayEntry>());
});

afterEach(() => {
  mounted.forEach((m) => m.unmount());
  mounted = [];
  act(() => setOwner({ owner: false }));
  hideToast();
  resetUploadsForTests();
  stopOverlay();
  w.stop();
});

async function render(node: ReactNode): Promise<HTMLDivElement> {
  const m = await mount(<>{node}<Toast /></>);
  mounted.push(m);
  return m.container;
}

const record = <T,>(path: string, at?: string): T => JSON.parse(w.fake.readFile(path, at) ?? "null") as T;
const trailersAt = (sha: string): unknown => parseTrailers(w.fake.commit(sha)?.message ?? "");
const under = (dir: string, at?: string): Map<string, string> =>
  new Map([...w.fake.listFiles(at)].filter(([p]) => p.startsWith(dir)));
const toastShows = (text: string): Promise<true> => until(() => (document.body.textContent?.includes(text) ? true : null), `the toast "${text}"`);
const ref = (root: ParentNode, name: string): HTMLElement | null => root.querySelector<HTMLElement>(`[data-ref="${name}"]`);
const blobPost = (r: FakeRequest): boolean => r.method === "POST" && new URL(r.url).pathname.endsWith("/git/blobs");
const blobPosts = (encoding: string): number => w.fake.requests.filter((r) => blobPost(r) && (r.body ?? "").includes(`"encoding":"${encoding}"`)).length;

async function typeInto(el: HTMLElement | null, value: string): Promise<void> {
  if (!(el instanceof HTMLInputElement)) throw new Error("no input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pickFile(el: HTMLElement | null, file: File): Promise<void> {
  if (!(el instanceof HTMLInputElement)) throw new Error("no file input");
  await act(async () => {
    Object.defineProperty(el, "files", { configurable: true, value: [file] });
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

const BYTES = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55, 10, 1, 2, 3]);
const pdfFile = (name = "Lipids 2024.pdf", bytes: Uint8Array = BYTES): File => new File([bytes as BlobPart], name, { type: "application/pdf" });
const finished = (): Promise<true> => until(() => (uploadsInProgress().length === 0 ? true : null), "the upload to finish");

// ---- the checks ------------------------------------------------------------------------------------

describe("upload checks (50 §50.7)", () => {
  it("takes the last extension, case-insensitive, of the types she can add", () => {
    expect(uploadExt("Scan.JPG")).toBe("jpg");
    expect(uploadExt("notes.v2.docx")).toBe("docx");
    expect(uploadExt("deck.pptx")).toBe("pptx");
    expect(uploadExt("archive.tar.gz")).toBeNull();
    expect(uploadExt("README")).toBeNull();
  });

  it("defaults the name to the file name without its last extension", () => {
    expect(defaultName("Lipids 2024.pdf")).toBe("Lipids 2024");
    expect(defaultName("a.b.docx")).toBe("a.b");
  });

  it("refuses other file types, then files over 100 MB, at exactly the limit", () => {
    expect(fileProblem({ name: "notes.txt", size: 1 })).toBe(TYPE_REFUSED);
    expect(TYPE_REFUSED).toBe("That file type can’t be added. Use a Word file, a PDF, an image (PNG or JPG) or a PowerPoint.");
    expect(fileProblem({ name: "big.pdf", size: MAX_FILE_BYTES })).toBeNull();
    expect(fileProblem({ name: "big.pdf", size: MAX_FILE_BYTES + 1 })).toBe(TOO_BIG(MAX_FILE_BYTES + 1));
    expect(TOO_BIG(150 * 1048576)).toBe("This file is 150 MB. The site’s free hosting holds files up to 100 MB.");
  });

  it("refuses a file that would take the site past 1 GB, counting PowerPoints and .doc twice and subtracting a replaced file", () => {
    expect(spaceProblem(SITE_LIMIT_BYTES - 10, 10, "pdf")).toBeNull();
    expect(spaceProblem(SITE_LIMIT_BYTES - 10, 11, "pdf")).toBe(SITE_FULL);
    expect(spaceProblem(SITE_LIMIT_BYTES - 20, 10, "pptx")).toBeNull();
    expect(spaceProblem(SITE_LIMIT_BYTES - 19, 10, "pptx")).toBe(SITE_FULL);
    expect(spaceProblem(SITE_LIMIT_BYTES - 19, 10, "doc")).toBe(SITE_FULL);
    expect(spaceProblem(SITE_LIMIT_BYTES - 19, 10, "docx")).toBeNull();
    expect(spaceProblem(SITE_LIMIT_BYTES, 10, "pdf", 10)).toBeNull();
    expect(SITE_FULL).toBe("The site’s free hosting is full (1 GB). Remove a document to make room.");
  });

  it("checkUpload reads the deployed siteBytes and, for a replace, subtracts the document's stored bytes at main", async () => {
    const stored = [...under(`content/files/${D(1)}/`).keys()].reduce((n, p) => n + (w.fake.readBytes(p)?.byteLength ?? 0), 0);
    expect(stored).toBeGreaterThan(0);
    expect(await storedBytes(w.git, D(1))).toBe(stored);
    w.stop();
    w = startWorld(fx, withBuild(SITE_LIMIT_BYTES - 5));
    const file = { name: "ACLS 2025.pdf", size: stored + 5 };
    expect(await checkUpload(w.git, file, D(1))).toBeNull();
    expect(await checkUpload(w.git, file)).toBe(SITE_FULL);
    expect(await checkUpload(w.git, { name: "x.txt", size: 1 })).toBe(TYPE_REFUSED);
  });
});

// ---- rename, remove, restore -------------------------------------------------------------------------

describe("renameDoc", () => {
  it("stores the trimmed name as a doc-rename commit and changes nothing else", async () => {
    const before = record<AsIsFile>(PDF);
    const r = await renameDoc({ git: w.git, author: AUTHOR, docId: D(1), name: "  ACLS 2025  " });
    expect(r.kind).toBe("saved");
    expect(record<AsIsFile>(PDF)).toEqual({ ...before, name: "ACLS 2025" });
    expect(trailersAt(w.fake.head())).toEqual({ kind: "doc-rename", changed: [D(1)] });
  });

  it("renames a Word page's doc.json", async () => {
    await renameDoc({ git: w.git, author: AUTHOR, docId: D(5), name: "Thyroid" });
    expect(record<WordDocFile>(WORD).name).toBe("Thyroid");
  });

  it("writes nothing for the same name", async () => {
    const head = w.fake.head();
    const r = await renameDoc({ git: w.git, author: AUTHOR, docId: D(1), name: " ACLS algorithms " });
    expect(r).toEqual({ kind: "saved", commit: head, files: new Map() });
    expect(w.fake.writes()).toEqual([]);
  });
});

describe("removeDoc and restoreDoc", () => {
  it("Remove marks the record removed from the previous head and deletes its stored files; Restore brings them back unchanged", async () => {
    const dir = `content/files/${D(1)}/`;
    const original = under(dir);
    expect([...original.keys()].sort()).toEqual([PDF, `${dir}ACLS algorithms.pdf`, `${dir}text.json`].sort());
    const before = w.fake.head();

    const removed = await removeDoc({ git: w.git, author: AUTHOR, docId: D(1), at: "2026-10-05T01:00:00Z" });
    expect(removed.kind).toBe("saved");
    expect(record<AsIsFile>(PDF).removed).toEqual({ at: "2026-10-05T01:00:00Z", from: before });
    expect([...under(dir).keys()]).toEqual([PDF]);
    expect(trailersAt(w.fake.head())).toEqual({ kind: "doc-remove", changed: [D(1)] });
    // Its place in every list stays, so Restore puts it back where it was.
    expect(record<OtherFile>(OTHER)).toEqual(record<OtherFile>(OTHER, before));

    const restored = await restoreDoc({ git: w.git, author: AUTHOR, docId: D(1) });
    expect(restored.kind).toBe("saved");
    expect(under(dir)).toEqual(original);
    expect(trailersAt(w.fake.head())).toEqual({ kind: "doc-restore", changed: [D(1)] });
  });

  it("removing a Word page deletes its blocks and keeps doc.json", async () => {
    const dir = `content/docs/${D(5)}/`;
    expect(under(dir).size).toBeGreaterThan(1);
    await removeDoc({ git: w.git, author: AUTHOR, docId: D(5) });
    expect([...under(dir).keys()]).toEqual([WORD]);
    expect(record<WordDocFile>(WORD).removed).not.toBeNull();
  });

  it("removing her own review deck's document also deletes the deck's slide blocks; restoring brings them back", async () => {
    const path = `content/files/${D(4)}/file.json`;
    w.fake.commitFiles({ [path]: serializeFile(path, { ...record<AsIsFile>(path), removed: null }) }, { message: "Shown again" });
    const blocks = "content/slides/psy/blocks/";
    const slides = under(blocks);
    expect(slides.size).toBeGreaterThan(0);

    await removeDoc({ git: w.git, author: AUTHOR, docId: D(4) });
    expect(under(blocks).size).toBe(0);
    expect(w.fake.readFile("content/slides/psy/deck.json")).toBeDefined();

    await restoreDoc({ git: w.git, author: AUTHOR, docId: D(4) });
    expect(under(blocks)).toEqual(slides);
  });

  it("Remove of a removed document and Restore of a shown one write nothing", async () => {
    const head = w.fake.head();
    expect(await removeDoc({ git: w.git, author: AUTHOR, docId: D(6) })).toEqual({ kind: "saved", commit: head, files: new Map() });
    expect(await restoreDoc({ git: w.git, author: AUTHOR, docId: D(1) })).toEqual({ kind: "saved", commit: head, files: new Map() });
    expect(w.fake.writes()).toEqual([]);
  });
});

// ---- the upload ------------------------------------------------------------------------------------------

describe("adding a document (50 §50.9)", () => {
  it("uploads the parts to an inbox branch, commits the processing record at the end of the list, and starts processing", async () => {
    const main = w.fake.head();
    const id = await startUpload({ git: w.git, author: AUTHOR, file: pdfFile(), name: " Lipids ", place: { kind: "other", section: "guidelines" } });
    await finished();

    // Steps 3–7: the inbox branch, one commit on main's head holding only the parts and upload.json.
    const branch = `refs/heads/inbox/${id}`;
    expect(w.fake.hasRef(branch)).toBe(true);
    const inboxCommit = w.fake.commit(w.fake.head(branch));
    expect(inboxCommit?.message).toBe("Inbox: Lipids 2024.pdf");
    expect(inboxCommit?.parents).toEqual([main]);
    expect([...w.fake.listFiles(branch).keys()].sort()).toEqual([`inbox/${id}/part-000`, inboxUploadPath(id)]);
    expect(w.fake.readBytes(`inbox/${id}/part-000`, branch)).toEqual(BYTES);
    const upload = JSON.parse(w.fake.readFile(inboxUploadPath(id), branch) ?? "null") as UploadFile;
    expect(upload).toEqual({
      v: 1, id, fileName: "Lipids 2024.pdf", ext: "pdf", size: BYTES.byteLength, sha256: createHash("sha256").update(BYTES).digest("hex"), parts: 1, replaces: null,
    });

    // Step 8: the doc-add commit on main.
    const recordPath = `content/files/${id}/file.json`;
    expect(record<AsIsFile>(recordPath)).toEqual({
      v: 1, id, name: "Lipids", kind: "pdf", original: "Lipids 2024.pdf", view: null, pages: null, text: null, removed: null, state: "processing",
    });
    expect(record<OtherFile>(OTHER).sections.find((s) => s.id === "guidelines")?.files).toEqual([D(1), id]);
    expect(trailersAt(w.fake.head())).toEqual({ kind: "doc-add", changed: [id] });

    // Step 9.
    expect(w.fake.dispatches).toEqual([{ workflow: PROCESS_WORKFLOW, ref: "main", inputs: { item: id } }]);
  });

  it("shows the added document in its list before its record is committed", async () => {
    asOwner(true);
    w.fake.fail(blobPost, "network", 1000);
    const id = await startUpload({ git: w.git, author: AUTHOR, file: pdfFile(), name: "Lipids", place: { kind: "other", section: "guidelines" } });
    await until(() => (uploadsInProgress()[0]?.status === "offline" ? true : null), "the upload to stop");
    expect(w.fake.readFile(`content/files/${id}/file.json`)).toBeUndefined();
    const other = await loadData<OtherJson>(OTHER_PATH);
    expect(other.sections.find((s) => s.id === "guidelines")?.files.pending).toEqual([{ id, name: "Lipids", state: "processing" }]);
  });

  it("retries a failed step after 2 s, 4 s and 8 s, on top of each call's own retries", async () => {
    // Each blob call is tried 3 times (2 s, 4 s apart) before the step fails; the step then waits 2 s.
    w.fake.fail(blobPost, { status: 502 }, 3);
    await startUpload({ git: w.git, author: AUTHOR, file: pdfFile(), name: "Lipids", place: { kind: "other", section: "guidelines" } });
    await finished();
    expect(vi.mocked(retry.sleep).mock.calls).toEqual([[2000], [4000], [2000]]);
    expect(w.fake.dispatches).toHaveLength(1);
  });

  it("stops offline after the last retry, and Try again resumes at that step without uploading the parts again", async () => {
    const uploadJson = (r: FakeRequest): boolean => blobPost(r) && (r.body ?? "").includes('"encoding":"utf-8"');
    w.fake.fail(uploadJson, "network", 12);
    const id = await startUpload({ git: w.git, author: AUTHOR, file: pdfFile(), name: "Lipids", place: { kind: "other", section: "guidelines" } });
    await until(() => (uploadsInProgress()[0]?.status === "offline" ? true : null), "the upload to stop");
    expect(vi.mocked(retry.sleep).mock.calls.filter(([ms]) => ms === 8000)).toHaveLength(1);
    expect(blobPosts("base64")).toBe(1);
    expect(w.fake.hasRef(`refs/heads/inbox/${id}`)).toBe(false);

    await act(async () => {
      await retryUpload(id);
    });
    await finished();
    expect(blobPosts("base64")).toBe(1);
    expect(w.fake.hasRef(`refs/heads/inbox/${id}`)).toBe(true);
    expect(record<AsIsFile>(`content/files/${id}/file.json`).state).toBe("processing");
  });

  it("deletes inbox branches left more than 24 hours ago and keeps newer ones", async () => {
    const stale = "refs/heads/inbox/d_OLD0000000";
    const fresh = "refs/heads/inbox/d_NEW0000000";
    w.fake.commitFiles({ "inbox/d_OLD0000000/upload.json": "{}" }, { message: "old", date: new Date(Date.now() - 25 * 3600_000).toISOString(), ref: stale });
    w.fake.commitFiles({ "inbox/d_NEW0000000/upload.json": "{}" }, { message: "new", date: new Date(Date.now() - 3600_000).toISOString(), ref: fresh });
    await startUpload({ git: w.git, author: AUTHOR, file: pdfFile(), name: "Lipids", place: { kind: "other", section: "guidelines" } });
    await finished();
    expect(w.fake.hasRef(stale)).toBe(false);
    expect(w.fake.hasRef(fresh)).toBe(true);
  });

  it("Download original while processing returns her file from the inbox branch", async () => {
    const id = await startUpload({ git: w.git, author: AUTHOR, file: pdfFile(), name: "Lipids", place: { kind: "other", section: "guidelines" } });
    await finished();
    const original = await inboxOriginal(w.git, id);
    expect(original?.fileName).toBe("Lipids 2024.pdf");
    expect(new Uint8Array(await (original as { blob: Blob }).blob.arrayBuffer())).toEqual(BYTES);
    expect(await inboxOriginal(w.git, D(1))).toBeNull();
  });
});

describe("replacing a document", () => {
  it("marks the document as being replaced with a doc-marker commit, then starts processing", async () => {
    await startUpload({ git: w.git, author: AUTHOR, file: pdfFile("ACLS 2025.pdf"), name: "ACLS algorithms", replaceId: D(1) });
    await finished();
    const upload = JSON.parse(w.fake.readFile(inboxUploadPath(D(1)), `refs/heads/inbox/${D(1)}`) ?? "null") as UploadFile;
    expect(upload.replaces).toBe(true);
    const rec = record<AsIsFile>(PDF);
    expect(rec.replacing?.fileName).toBe("ACLS 2025.pdf");
    expect(rec.name).toBe("ACLS algorithms");
    expect(trailersAt(w.fake.head())).toEqual({ kind: "doc-marker", changed: [D(1)] });
    expect(w.fake.dispatches).toEqual([{ workflow: PROCESS_WORKFLOW, ref: "main", inputs: { item: D(1) } }]);
  });
});

// ---- the owner's controls --------------------------------------------------------------------------------

const publishedDoc = (id: string): DocJson => fx.published.get(docPath(id)) as DocJson;

describe("DocActions", () => {
  it("shows a visitor nothing", async () => {
    const root = await render(<DocActions doc={publishedDoc(D(1))} />);
    expect(ref(root, "doc-rename")).toBeNull();
  });

  it("Rename saves the trimmed name and its Undo renames it back", async () => {
    asOwner(true);
    const root = await render(<DocActions doc={publishedDoc(D(1))} />);
    await click(ref(root, "doc-rename"));
    expect((ref(document.body, "doc-rename-name") as HTMLInputElement).value).toBe("ACLS algorithms");
    await typeInto(ref(document.body, "doc-rename-name"), " ACLS 2025 ");
    await click(ref(document.body, "doc-rename-save"));
    await toastShows(RENAMED("ACLS 2025"));
    expect(record<AsIsFile>(PDF).name).toBe("ACLS 2025");

    await click(byText(document.body, "button", "Undo"));
    await until(() => (record<AsIsFile>(PDF).name === "ACLS algorithms" ? true : null), "the name back");
  });

  it("Rename with a blank name says so and writes nothing", async () => {
    asOwner(true);
    const root = await render(<DocActions doc={publishedDoc(D(1))} />);
    await click(ref(root, "doc-rename"));
    await typeInto(ref(document.body, "doc-rename-name"), "   ");
    await click(ref(document.body, "doc-rename-save"));
    expect(document.body.querySelector(".fld-err")?.textContent).toBe(NAME_BLANK);
    expect(w.fake.writes()).toEqual([]);
  });

  it("Remove asks first, then removes, returns to where she came from, and Undo restores it", async () => {
    asOwner(true);
    const root = await render(<DocActions doc={publishedDoc(D(1))} from="#/other/guidelines" />);
    await click(ref(root, "doc-remove"));
    expect(document.body.textContent).toContain(REMOVE_BODY);
    expect(w.fake.writes()).toEqual([]);
    await click(ref(document.body, "doc-remove-confirm"));
    await toastShows(REMOVED("ACLS algorithms"));
    expect(location.hash).toBe("#/other/guidelines");
    expect(record<AsIsFile>(PDF).removed).not.toBeNull();

    await click(byText(document.body, "button", "Undo"));
    await toastShows(RESTORED("ACLS algorithms"));
    expect(record<AsIsFile>(PDF).removed).toBeNull();
  });

  it("Replace refuses a file of another type without uploading", async () => {
    asOwner(true);
    const root = await render(<DocActions doc={publishedDoc(D(1))} />);
    await pickFile(ref(root, "doc-replace-file"), new File(["x"], "notes.txt"));
    await toastShows(TYPE_REFUSED);
    expect(w.fake.writes()).toEqual([]);
  });

  it("Replace checks the space, starts the upload and says the previous file is kept", async () => {
    asOwner(true);
    const root = await render(<DocActions doc={publishedDoc(D(1))} />);
    await pickFile(ref(root, "doc-replace-file"), pdfFile("ACLS 2025.pdf"));
    await toastShows(REPLACED("ACLS algorithms", "ACLS 2025.pdf"));
    await finished();
    expect(record<AsIsFile>(PDF).replacing?.fileName).toBe("ACLS 2025.pdf");
  });
});

describe("AddDocument", () => {
  const place = { kind: "other", section: "guidelines" } as const;

  it("asks for a file, refuses other types, fills the name from the file, and adds it", async () => {
    asOwner(true);
    const root = await render(<AddDocument place={place} title="Guidelines" />);
    await click(ref(root, "add-doc"));
    expect(document.body.querySelector("[role=dialog]")?.getAttribute("aria-label")).toBe("Add a document to Guidelines");

    await click(ref(document.body, "add-doc-confirm"));
    expect(ref(document.body, "add-doc-error")?.textContent).toBe(CHOOSE_FILE);

    await pickFile(ref(document.body, "add-doc-file"), new File(["x"], "notes.txt"));
    expect(ref(document.body, "add-doc-error")?.textContent).toBe(TYPE_REFUSED);

    await pickFile(ref(document.body, "add-doc-file"), pdfFile());
    expect((ref(document.body, "add-doc-name") as HTMLInputElement).value).toBe("Lipids 2024");
    await click(ref(document.body, "add-doc-confirm"));
    await toastShows(ADDED("Lipids 2024"));
    expect(document.body.querySelector("[role=dialog]")).toBeNull();
    await finished();
    expect(w.fake.dispatches).toHaveLength(1);
  });

  it("keeps a name she typed when she picks the file after", async () => {
    asOwner(true);
    const root = await render(<AddDocument place={place} title="Guidelines" />);
    await click(ref(root, "add-doc"));
    await typeInto(ref(document.body, "add-doc-name"), "Lipid guideline");
    await pickFile(ref(document.body, "add-doc-file"), pdfFile());
    expect((ref(document.body, "add-doc-name") as HTMLInputElement).value).toBe("Lipid guideline");
  });

  it("refuses a file that would fill the site, in the dialog, without uploading", async () => {
    w.stop();
    w = startWorld(fx, withBuild(SITE_LIMIT_BYTES));
    asOwner(true);
    const root = await render(<AddDocument place={place} title="Guidelines" />);
    await click(ref(root, "add-doc"));
    await pickFile(ref(document.body, "add-doc-file"), pdfFile());
    await click(ref(document.body, "add-doc-confirm"));
    await until(() => (ref(document.body, "add-doc-error")?.textContent === SITE_FULL ? true : null), "the space error");
    expect(w.fake.writes()).toEqual([]);
  });

  it("shows a visitor nothing", async () => {
    const root = await render(<AddDocument place={place} title="Guidelines" />);
    expect(ref(root, "add-doc")).toBeNull();
  });
});

describe("RemovedDocs", () => {
  it("lists removed documents behind a toggle, and Restore puts one back", async () => {
    await removeDoc({ git: w.git, author: AUTHOR, docId: D(1), at: "2026-10-05T01:00:00Z" });
    asOwner(true);
    const root = await render(<RemovedDocs items={[{ id: D(1), name: "ACLS algorithms", at: "2026-10-05T01:00:00Z" }]} />);
    const toggle = ref(root, "removed-docs-toggle");
    expect(toggle?.textContent).toBe("Show removed documents (1)");
    await click(toggle);
    expect(ref(root, "removed-docs-toggle")?.textContent).toBe("Hide removed documents (1)");
    expect(root.querySelector(".vlist b")?.textContent).toBe("ACLS algorithms");
    await click(ref(root, `restore-doc-${D(1)}`));
    await toastShows(RESTORED("ACLS algorithms"));
    expect(record<AsIsFile>(PDF).removed).toBeNull();
  });

  it("shows nothing to a visitor or with nothing removed", async () => {
    const visitor = await render(<RemovedDocs items={[{ id: D(6), name: "Old handout", at: "2026-10-03T10:00:00Z" }]} />);
    expect(visitor.innerHTML).not.toContain("removed-docs");
    asOwner(true);
    const empty = await render(<RemovedDocs items={[]} />);
    expect(ref(empty, "removed-docs")).toBeNull();
  });
});

describe("UploadProblem", () => {
  it("shows a stopped upload with Try again, which finishes it", async () => {
    asOwner(true);
    w.fake.fail(blobPost, "network", 12);
    const id = await startUpload({ git: w.git, author: AUTHOR, file: pdfFile(), name: "Lipids", place: { kind: "other", section: "guidelines" } });
    const root = await render(<UploadProblem id={id} />);
    await until(() => ref(root, "upload-failed"), "the upload banner");
    expect(ref(root, "upload-failed")?.textContent).toContain(SAVE_OFFLINE);
    await click(ref(root, "upload-retry"));
    await finished();
    expect(ref(root, "upload-failed")).toBeNull();
  });
});

describe("PendingDocPage", () => {
  const fileJson = `content/files/${D(7)}/file.json`;

  it("shows a processing document's name, Download original and the processing note", async () => {
    asOwner(true);
    const root = await render(<PendingDocPage id={D(7)} />);
    await until(() => ref(root, "doc-processing"), "the processing page");
    expect(root.querySelector("h1")?.textContent).toBe("New upload");
    expect(ref(root, "doc-processing")?.textContent).toBe(PROCESSING_NOTE);
    expect(ref(root, "pending-download")).not.toBeNull();
    expect(ref(root, "doc-rename")).toBeNull();
  });

  it("shows a failed document with the failed note and Rename / Replace / Remove", async () => {
    w.fake.commitFiles({ [fileJson]: serializeFile(fileJson, { ...record<AsIsFile>(fileJson), state: "failed" }) }, { message: "Inbox failed" });
    asOwner(true);
    const root = await render(<PendingDocPage id={D(7)} />);
    await until(() => ref(root, "doc-failed"), "the failed page");
    expect(ref(root, "doc-failed")?.textContent).toBe(FAILED_NOTE);
    expect(ref(root, "doc-remove")).not.toBeNull();
  });

  it("says a removed document isn't on the site", async () => {
    asOwner(true);
    const root = await render(<PendingDocPage id={D(6)} />);
    await until(() => (root.textContent?.includes("This page isn't on the site") ? true : null), "not on the site");
  });
});
