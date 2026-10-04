// The import commit and inbox hand-off (30 §30.14, §30.10) against a real local git repository
// with a bare "origin"; only the gh dispatch is recorded instead of run.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GUIDE_IDS, parseTrailers } from "../../lib/content/index.ts";
import type { AsIsFile, UploadFile } from "../../lib/content/index.ts";
import { writeContent } from "../../lib/content/fs.ts";
import { commitImport, ghPath, IMPORT_SUBJECT, PART_BYTES, spawnRunner } from "./commit.ts";
import type { Runner } from "./commit.ts";
import { SITE } from "./site.ts";

const D = "d_0000000001";
const PPTX = "Antibiotic Flower Charts.pptx";
const SRC = `M/${PPTX}`;

let root: string;
let remote: string;
let git: Runner;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "pa-commit-"));
  root = join(base, "work");
  remote = join(base, "origin.git");
  await mkdir(root);
  await spawnRunner(base)("git", ["init", "--bare", "-b", "main", remote]);
  git = spawnRunner(root);
  await git("git", ["init", "-b", "main"]);
  await git("git", ["remote", "add", "origin", remote]);
});
afterEach(async () => { await rm(join(root, ".."), { recursive: true, force: true }); });

async function writeSources(rows: unknown[]): Promise<void> {
  const guides = GUIDE_IDS.map((g) => ({ path: `G/${g}.docx`, kind: "guide", name: g, placement: { guide: g } }));
  await mkdir(join(root, "tools", "import"), { recursive: true });
  await writeFile(join(root, "tools", "import", "sources.json"), JSON.stringify({ v: 1, sources: [...guides, ...rows] }));
}

async function setUp(pptxBytes: Uint8Array): Promise<void> {
  await writeContent(root, "content/site.json", SITE);
  const file: AsIsFile = { v: 1, id: D, name: "Antibiotic Flower Charts", kind: "slides", original: PPTX, view: null, pages: null, text: null, removed: null, state: "processing" };
  await writeContent(root, `content/files/${D}/file.json`, file);
  await writeContent(root, "content/files/d_0000000002/file.json", { v: 1, id: "d_0000000002", name: "Pic", kind: "image", original: "a.png", view: "a.png", removed: null } satisfies AsIsFile);
  await writeSources([{ path: SRC, kind: "slides", name: "Antibiotic Flower Charts", placement: { pharm: ["ID"] } }]);
  await mkdir(join(root, "M"), { recursive: true });
  await writeFile(join(root, ...SRC.split("/")), pptxBytes);
  await mkdir(join(root, "tools", "import", "reports"), { recursive: true });
  await writeFile(join(root, "tools", "import", "reports", "summary.json"), "{}\n");
}

/** Real git; gh is recorded. */
function runner(ghCalls: string[][]): Runner {
  return (cmd, args, opts) => {
    if (cmd === "gh-test") {
      ghCalls.push([...args]);
      return Promise.resolve("");
    }
    return git(cmd, args, opts);
  };
}

const show = (ref: string): Promise<string> => spawnRunner(remote)("git", ["show", "-s", "--format=%an <%ae>|%cn <%ce>|%P|%B", ref]);
const blob = async (ref: string, path: string): Promise<Buffer> => {
  const out: Buffer[] = [];
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const c = spawn("git", ["cat-file", "blob", `${ref}:${path}`], { cwd: remote });
    c.stdout.on("data", (b: Buffer) => out.push(b));
    c.on("error", reject);
    c.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`cat-file ${path} exited ${code}`))));
  });
};

describe("commitImport", () => {
  it("commits content and reports as her, pushes main, then pushes the PowerPoint in 16 MiB parts on inbox/<d_id> and dispatches it", async () => {
    // Just over one part, so the file is cut in two.
    const pptx = new Uint8Array(PART_BYTES + 1000).map((_, i) => (i * 31 + 7) & 255);
    await setUp(pptx);
    const gh: string[][] = [];
    const logs: string[] = [];
    const result = await commitImport(root, { run: runner(gh), gh: "gh-test", log: (l) => logs.push(l) });

    // main on origin: her identity, the import message and trailer, content and reports, nothing else.
    const [who, committer, parents, message] = (await show("main")).split("|");
    expect(who).toBe(`${SITE.owner.commitName} <${SITE.owner.commitEmail}>`);
    expect(committer).toBe(who);
    expect(parents).toBe("");
    expect(message?.split("\n")[0]).toBe(IMPORT_SUBJECT);
    expect(parseTrailers(message ?? "")).toEqual({ kind: "import" });
    expect((await show("main")).length).toBeGreaterThan(0);
    const files = (await spawnRunner(remote)("git", ["ls-tree", "-r", "--name-only", "main"])).trim().split("\n");
    expect(files.sort()).toEqual(["content/files/d_0000000001/file.json", "content/files/d_0000000002/file.json", "content/site.json", "tools/import/reports/summary.json"]);
    expect(result.commit).toBe((await spawnRunner(remote)("git", ["rev-parse", "main"])).trim());

    // inbox/<d_id>: child of the import commit, 20 §20.2 layout, original bytes intact.
    const ref = `inbox/${D}`;
    const [, , inboxParents, inboxMessage] = (await show(ref)).split("|");
    expect(inboxParents).toBe(result.commit);
    expect(inboxMessage?.trim()).toBe(`Inbox: ${PPTX}`);
    expect((await spawnRunner(remote)("git", ["ls-tree", "-r", "--name-only", ref])).trim().split("\n"))
      .toEqual([`inbox/${D}/part-000`, `inbox/${D}/part-001`, `inbox/${D}/upload.json`]);
    const part0 = await blob(ref, `inbox/${D}/part-000`);
    const part1 = await blob(ref, `inbox/${D}/part-001`);
    expect(part0.length).toBe(PART_BYTES);
    expect(Buffer.concat([part0, part1]).equals(Buffer.from(pptx))).toBe(true);
    const upload = JSON.parse((await blob(ref, `inbox/${D}/upload.json`)).toString("utf8")) as UploadFile;
    const sha = Buffer.from(await crypto.subtle.digest("SHA-256", pptx)).toString("hex");
    expect(upload).toEqual({ v: 1, id: D, fileName: PPTX, ext: "pptx", size: pptx.length, sha256: sha, parts: 2, replaces: null });

    expect(gh).toEqual([["workflow", "run", "process-inbox.yml", "-f", `item=${D}`]]);
    expect(result.inbox).toEqual([D]);
    expect(logs.at(-1)).toContain(`inbox/${D}`);
  });

  it("refuses before committing anything when a processing document has no slides source", async () => {
    await setUp(new Uint8Array([1, 2, 3]));
    await writeSources([]);
    await expect(commitImport(root, { run: runner([]), gh: "gh-test", log: () => undefined })).rejects.toThrow(`content/files/${D}: no slides source named ${PPTX}`);
    await expect(git("git", ["rev-parse", "HEAD"])).rejects.toThrow(/exited/);
  });

  it("commits without reports when tools/import/reports does not exist, and hands off a one-part file", async () => {
    await setUp(new Uint8Array([1, 2, 3]));
    await rm(join(root, "tools", "import", "reports"), { recursive: true });
    const gh: string[][] = [];
    await commitImport(root, { run: runner(gh), gh: "gh-test", log: () => undefined });
    const files = (await spawnRunner(remote)("git", ["ls-tree", "-r", "--name-only", "main"])).trim().split("\n");
    expect(files.some((f) => f.startsWith("tools/"))).toBe(false);
    expect((await spawnRunner(remote)("git", ["ls-tree", "-r", "--name-only", `inbox/${D}`])).trim().split("\n")).toEqual([`inbox/${D}/part-000`, `inbox/${D}/upload.json`]);
    expect(gh).toHaveLength(1);
  });
});

describe("spawnRunner", () => {
  it("passes stdin and returns stdout; a non-zero exit or a missing program rejects", async () => {
    // A git blob id is SHA-1 of "blob <size>\0<bytes>".
    const want = createHash("sha1").update("blob 1\0x").digest("hex");
    expect((await git("git", ["hash-object", "--stdin"], { input: "x" })).trim()).toBe(want);
    await expect(git("git", ["no-such-subcommand"])).rejects.toThrow(/git no-such-subcommand exited 1/);
    await expect(git("pa-no-such-program-xyz", [])).rejects.toThrow();
  });
});

describe("ghPath", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  it("uses PA_GH when set, else gh (or her machine's install path on Windows)", () => {
    vi.stubEnv("PA_GH", "/opt/gh");
    expect(ghPath()).toBe("/opt/gh");
    delete process.env.PA_GH;
    expect(["gh", "C:\\Program Files\\GitHub CLI\\gh.exe"]).toContain(ghPath());
  });
});
