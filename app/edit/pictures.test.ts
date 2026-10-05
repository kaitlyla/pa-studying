// Pictures she adds while editing: the checks on the file, keeping it on this device, showing it
// before the site serves it, and the tree entries a save adds for it (against the GitHub fake).
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assetName, type DocJSON } from "../../lib/content/index.ts";
import { DATA_BASE } from "../data/load.ts";
import { assetUrl } from "../render/index.ts";
import { memoryStore, type KvStore } from "./idb.ts";
import {
  addPictureFile, assetPath, MAX_PICTURE_BYTES, PICTURE_TOO_BIG, PICTURE_TYPE_REFUSED, PICTURE_UNREADABLE, pictureChanges,
  pictureSize, setPictureStoreForTests, startLocalPictures, stopLocalPictures,
} from "./pictures.ts";
import { loadFixture, startWorld, type Fixture, type World } from "./testkit.ts";

const BYTES = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
const png = (bytes: Uint8Array = BYTES, name = "ecg.png"): File => new File([bytes as BlobPart], name, { type: "image/png" });
const withPicture = (asset: string): DocJSON =>
  ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "image", attrs: { asset, widthPt: 10, heightPt: 10 } }] }] }) as DocJSON;

let fx: Fixture;
let w: World;
let store: KvStore<Blob>;
let urls: number;

beforeAll(async () => {
  fx = await loadFixture();
}, 60_000);

// jsdom has no object URLs; each picture kept on the device gets a distinct one.
beforeAll(() => {
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => `blob:test/${++urls}` });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });
});
afterAll(() => {
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
});

beforeEach(() => {
  urls = 0;
  w = startWorld(fx);
  store = memoryStore<Blob>();
  setPictureStoreForTests(store);
  vi.spyOn(pictureSize, "of").mockResolvedValue({ width: 640, height: 480 });
});

afterEach(() => {
  stopLocalPictures();
  w.stop();
});

describe("adding a picture", () => {
  it("names it by its bytes, reports its pixel size, and keeps it on this device", async () => {
    const pic = await addPictureFile(png());
    const name = await assetName(BYTES, ".png");
    expect(pic).toEqual({ asset: name, widthPx: 640, heightPx: 480 });
    expect(new Uint8Array(await ((await store.get(name)) as Blob).arrayBuffer())).toEqual(BYTES);
  });

  it("refuses a file that is not a PNG, JPG or GIF picture, and keeps nothing", async () => {
    expect(await addPictureFile(new File(["<svg/>"], "chart.svg"))).toBe(PICTURE_TYPE_REFUSED);
    expect(await addPictureFile(new File(["x"], "notes"))).toBe(PICTURE_TYPE_REFUSED);
    expect(await store.entries()).toEqual([]);
  });

  it("takes a picture of exactly the limit and refuses one byte more", async () => {
    expect(typeof (await addPictureFile(png(new Uint8Array(MAX_PICTURE_BYTES), "big.jpg")))).toBe("object");
    expect(await addPictureFile(png(new Uint8Array(MAX_PICTURE_BYTES + 1), "bigger.jpg"))).toBe(PICTURE_TOO_BIG);
  });

  it("refuses a file that does not open as a picture", async () => {
    vi.mocked(pictureSize.of).mockRejectedValueOnce(new Error("decode failed"));
    expect(await addPictureFile(png())).toBe(PICTURE_UNREADABLE);
    expect(await store.entries()).toEqual([]);
  });
});

describe("showing pictures before the site serves them", () => {
  it("while she is signed in, a kept picture shows from this device; after sign-out, from the site", async () => {
    const pic = await addPictureFile(png());
    if (typeof pic === "string") throw new Error(pic);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })));
    await startLocalPictures();
    expect(assetUrl(pic.asset)).toMatch(/^blob:test\//);
    expect(await store.get(pic.asset)).toBeDefined();

    stopLocalPictures();
    expect(assetUrl(pic.asset)).toBe(`${DATA_BASE}assets/${pic.asset}`);
  });

  it("a picture kept from an earlier visit shows again, and is forgotten on this device once the site serves it", async () => {
    const name = await assetName(BYTES, ".png");
    await store.put(name, new Blob([BYTES as BlobPart]));
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200, headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    await startLocalPictures();
    expect(fetchMock).toHaveBeenCalledWith(`${DATA_BASE}assets/${name}`, expect.objectContaining({ method: "HEAD" }));
    expect(await store.get(name)).toBeUndefined();
    // This visit still shows it from the device.
    expect(assetUrl(name)).toMatch(/^blob:test\//);
  });
});

describe("what a save adds", () => {
  it("a new blob under content/assets/ for each picture the docs use that main lacks, with the picture's bytes", async () => {
    const pic = await addPictureFile(png());
    if (typeof pic === "string") throw new Error(pic);
    const already = "0123456789abcdef0123456789abcdef.png";
    const changes = await pictureChanges(w.git, [withPicture(pic.asset), withPicture(already)], [], new Map([[assetPath(already), "sha"]]));
    expect(changes).toHaveLength(1);
    const change = changes[0] as { path: string; sha: string };
    expect(change.path).toBe(`content/assets/${pic.asset}`);
    // Git's blob id of the picture's bytes: the blob holds exactly them.
    const gitSha = createHash("sha1").update(`blob ${BYTES.length}\0`).update(BYTES).digest("hex");
    expect(change.sha).toBe(gitSha);
  });

  it("reads a picture's bytes back from the device store after a reload", async () => {
    const pic = await addPictureFile(png());
    if (typeof pic === "string") throw new Error(pic);
    setPictureStoreForTests(store); // forgets this page's copies, as a reload does
    expect(await pictureChanges(w.git, [withPicture(pic.asset)], [], new Map())).toHaveLength(1);
  });

  it("fails when a picture she added is not on this device", async () => {
    await expect(pictureChanges(w.git, [withPicture("ffffffffffffffffffffffffffffffff.png")], [], new Map())).rejects.toThrow("is not on this device");
  });

  it("adds nothing for a picture the page already had when opened", async () => {
    const had = withPicture("ffffffffffffffffffffffffffffffff.png");
    expect(await pictureChanges(w.git, [had], [had], new Map())).toEqual([]);
  });
});
