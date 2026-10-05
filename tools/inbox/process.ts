// Processing one added or replaced document (50 §50.9 Processing job, steps 1–4). The item's
// original is converted in a staging tree first, so a conversion failure leaves the content tree
// untouched apart from the failure record itself. A failure while moving the staged result into
// the tree throws instead: the job fails with nothing committed and the inbox branch kept, so the
// item can be re-run from a fresh checkout.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { commitMessage, newId } from "../../lib/content/index.ts";
import type { AsIsFile, BlockFile, DeckFile, FileKind, Trailers, UploadExt, UploadFile, WordDocFile } from "../../lib/content/index.ts";
import { listDir, readContentIfExists, removeContent, writeAsset, writeContent, writeStoredFile } from "../../lib/content/fs.ts";
import { convertDocx, toBlocks } from "../../lib/docx/index.ts";
import { pdfText } from "../import/pdf.ts";
import { convertDeck, slideTexts } from "../import/pptx.ts";
import type { SourceReport } from "../verify/index.ts";

/** Converts `bytes` (a `.from` file) to a `.to` file with LibreOffice. */
export type Soffice = (bytes: Uint8Array, from: UploadExt, to: "docx" | "pptx" | "pdf") => Promise<Uint8Array>;

export interface ProcessDeps {
  soffice: Soffice;
  /** The 30 §30.13 extractor and comparison of a Word page against its `.docx`. */
  verifyWordDoc(root: string, docId: string, docx: Uint8Array): Promise<SourceReport>;
  log(line: string): void;
  error(line: string): void;
}

/** The commit that records a processed item. */
export interface Processed {
  ok: boolean;
  message: string;
}

const KIND_OF: Record<UploadExt, FileKind> = {
  doc: "word", docx: "word", pdf: "pdf", png: "image", jpg: "image", jpeg: "image", ppt: "slides", pptx: "slides",
};

function sofficePath(): string {
  const win = "C:\\Program Files\\LibreOffice\\program\\soffice.exe";
  return process.env.PA_SOFFICE ?? (process.platform === "win32" && existsSync(win) ? win : "soffice");
}

/** LibreOffice headless, with a throwaway profile so concurrent runs never share one. */
export const sofficeConvert: Soffice = async (bytes, from, to) => {
  const dir = await mkdtemp(join(tmpdir(), "pa-soffice-"));
  try {
    const input = join(dir, `item.${from}`);
    const out = join(dir, "out");
    await writeFile(input, bytes);
    const args = ["--headless", `-env:UserInstallation=${pathToFileURL(join(dir, "profile")).href}`, "--convert-to", to, "--outdir", out, input];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(sofficePath(), args, { stdio: ["ignore", "ignore", "pipe"] });
      const err: Buffer[] = [];
      child.stderr.on("data", (b: Buffer) => err.push(b));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`soffice --convert-to ${to} exited ${code}: ${Buffer.concat(err).toString("utf8").trim()}`));
      });
    });
    const result = join(out, `item.${to}`);
    if (!existsSync(result)) throw new Error(`soffice did not convert the .${from} file to .${to}`);
    return new Uint8Array(await readFile(result));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const stem = (name: string): string => (name.lastIndexOf(".") > 0 ? name.slice(0, name.lastIndexOf(".")) : name);
const oneLine = (s: string): string => s.replace(/[\r\n]+/g, " ");

/** The document an item belongs to, as it stands on `main`. */
type Current = { kind: "word"; file: WordDocFile } | { kind: "as-is"; file: AsIsFile };

async function currentDoc(root: string, id: string): Promise<Current | null> {
  const word = await readContentIfExists<WordDocFile>(root, `content/docs/${id}/doc.json`);
  if (word) return { kind: "word", file: word };
  const file = await readContentIfExists<AsIsFile>(root, `content/files/${id}/file.json`);
  return file ? { kind: "as-is", file } : null;
}

/** The review deck whose document is `id` (the psych deck, 30 §30.10), if any. */
async function deckOf(root: string, id: string): Promise<{ path: string; deck: DeckFile } | null> {
  for (const g of await listDir(root, "content/slides")) {
    const path = `content/slides/${g}/deck.json`;
    const deck = await readContentIfExists<DeckFile>(root, path);
    if (deck?.file === id) return { path, deck };
  }
  return null;
}

/**
 * Converts the item into `stage` (an empty content root). Returns the directories under
 * `content/` that the conversion replaces in the real tree.
 */
async function convertInto(stage: string, root: string, upload: UploadFile, bytes: Uint8Array, name: string, removed: AsIsFile["removed"], deps: ProcessDeps): Promise<string[]> {
  const id = upload.id;
  const ext = upload.ext;
  const kind = KIND_OF[ext];
  if (kind === "word") {
    const docx = ext === "doc" ? await deps.soffice(bytes, "doc", "docx") : bytes;
    const conv = await convertDocx(docx, { storeAsset: (b, e) => writeAsset(stage, b, e) });
    for (const entry of conv.report) deps.log(`${upload.fileName}: ${JSON.stringify(entry)}`);
    const blocks: string[] = [];
    for (const block of toBlocks(conv.body)) {
      const b = newId("b");
      await writeContent(stage, `content/docs/${id}/blocks/${b}.json`, { v: 1, id: b, kind: block.kind, doc: block.doc, meta: {} } satisfies BlockFile);
      blocks.push(b);
    }
    const doc: WordDocFile = { v: 1, id, name, kind: "word", source: upload.fileName, page: conv.page, basePt: conv.basePt, blocks, removed };
    await writeContent(stage, `content/docs/${id}/doc.json`, doc);
    const report = await deps.verifyWordDoc(stage, id, docx);
    deps.log(JSON.stringify(report, null, 1));
    if (report.discrepancies.length > 0) throw new Error(`the converted page differs from the Word file in ${report.discrepancies.length} place(s)`);
    return [`content/docs/${id}`];
  }

  const original = upload.fileName;
  let file: AsIsFile;
  const replaced = [`content/files/${id}`];
  if (kind === "pdf") {
    const pages = await pdfText(bytes);
    await writeContent(stage, `content/files/${id}/text.json`, { pages });
    file = { v: 1, id, name, kind, original, view: original, pages: pages.length, text: "text.json", removed, state: "ready" };
  } else if (kind === "image") {
    file = { v: 1, id, name, kind, original, view: original, removed, state: "ready" };
  } else {
    const deck = upload.replaces ? await deckOf(root, id) : null;
    const pptx = ext === "ppt" ? await deps.soffice(bytes, "ppt", "pptx") : bytes;
    if (deck) {
      // The psych deck's document: its slides are rebuilt from the new file (30 §30.10 Replace).
      const dir = deck.path.slice(0, -"/deck.json".length);
      const slides: string[] = [];
      for (const doc of convertDeck(pptx)) {
        const s = newId("s");
        await writeContent(stage, `${dir}/blocks/${s}.json`, { v: 1, id: s, kind: "slide", doc, meta: {} } satisfies BlockFile);
        slides.push(s);
      }
      await writeContent(stage, deck.path, { ...deck.deck, slides });
      replaced.push(`${dir}/blocks`);
      file = { v: 1, id, name, kind, original, view: null, pages: slides.length, text: null, removed, state: "ready" };
    } else {
      const texts = slideTexts(pptx);
      const view = `${stem(original)}.pdf`;
      await writeStoredFile(stage, id, view, await deps.soffice(bytes, ext, "pdf"));
      await writeContent(stage, `content/files/${id}/text.json`, { pages: texts });
      file = { v: 1, id, name, kind, original, view, pages: texts.length, text: "text.json", removed, state: "ready" };
    }
  }
  await writeStoredFile(stage, id, original, bytes);
  await writeContent(stage, `content/files/${id}/file.json`, file);
  return replaced;
}

/**
 * Processes inbox item `upload` (its parts concatenated in `bytes`) into the content tree at
 * `root`. Returns the commit to record, or null when there is nothing to process: an add whose
 * `file.json` is missing or no longer processing, or a replace with no replacement in progress.
 */
export async function processItem(root: string, upload: UploadFile, bytes: Uint8Array, deps: ProcessDeps): Promise<Processed | null> {
  const id = upload.id;
  const current = await currentDoc(root, id);
  const replace = upload.replaces === true;
  if (!current) {
    deps.log(`${id}: no document on main; nothing to process`);
    return null;
  }
  if (replace ? current.file.replacing === undefined : current.kind !== "as-is" || current.file.state !== "processing") {
    deps.log(`${id}: ${replace ? "no replacement in progress" : "not processing"}; nothing to process`);
    return null;
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const intact = bytes.length === upload.size && sha256 === upload.sha256;
  const stage = await mkdtemp(join(tmpdir(), "pa-inbox-"));
  try {
    let replaced: string[];
    try {
      if (!intact) throw new Error(`the uploaded parts are ${bytes.length} bytes with SHA-256 ${sha256}; upload.json says ${upload.size} bytes with ${upload.sha256}`);
      replaced = await convertInto(stage, root, upload, bytes, current.file.name, current.file.removed, deps);
    } catch (e) {
      deps.error(`::error::${upload.fileName} (${id}) couldn't be processed: ${(e as Error).stack ?? String(e)}`);
      if (replace && current.file.replacing) {
        // The document stays as it was, with a note for her that the replacement failed (Orchestrator
        // ruling 2026-10-04 20:39Z, amending 50 §50.9 step 4).
        const { replacing, ...rest } = current.file;
        const marked = { ...rest, replaceFailed: { fileName: replacing.fileName, at: replacing.at } };
        await writeContent(root, current.kind === "word" ? `content/docs/${id}/doc.json` : `content/files/${id}/file.json`, marked);
      } else {
        const pending = current.file as AsIsFile;
        // Only bytes that match upload.json are stored as her original.
        if (intact) await writeStoredFile(root, id, pending.original, bytes);
        await writeContent(root, `content/files/${id}/file.json`, { ...pending, state: "failed" } satisfies AsIsFile);
      }
      return { ok: false, message: commitMessage(`Inbox: ${oneLine(upload.fileName)} couldn't be shown`, { kind: "inbox", changed: [id] }) };
    }
    // Outside the catch: a throw here leaves the tree half-replaced, so it must fail the job
    // rather than be recorded and committed as a failed item.
    // The document moves directory when its kind changes (50 §50.9 step 3).
    for (const dir of new Set([`content/docs/${id}`, `content/files/${id}`, ...replaced])) await removeContent(root, dir);
    await mkdir(join(root, "content"), { recursive: true });
    await cp(join(stage, "content"), join(root, "content"), { recursive: true, force: true });
    const trailers: Trailers = replace ? { kind: "doc-replace", changed: [id], file: oneLine(upload.fileName) } : { kind: "inbox", changed: [id] };
    const subject = replace ? `Replace ${oneLine(current.file.name)} with ${oneLine(upload.fileName)}` : `Inbox: ${oneLine(upload.fileName)}`;
    deps.log(`${id}: ${upload.fileName} processed`);
    return { ok: true, message: commitMessage(subject, trailers) };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
