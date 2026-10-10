// Rendered check (30 §30.13): builds the site from the working tree, serves it with `vite preview`,
// and checks in Chromium that each block's page shows its paragraph texts in order and loads its images.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import type { BlockFile } from "../../lib/content/index.ts";
import { HOSTS_PATH } from "../../lib/derive/published.ts";
import { readStored } from "./compare.ts";
import type { SourceReport } from "./index.ts";

export interface Host {
  route: string;
  loc: string;
}

export interface RenderedOptions {
  postCuration: boolean;
  log: (line: string) => void;
  /** Serves the built site and returns its base URL (ending in `/pa-studying/`) and a stop function. */
  serve?: (root: string) => Promise<{ base: string; stop: () => Promise<void> }>;
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Index just past the last of `texts` found in order in `page`, or the index of the first one missing. */
export function textsInOrder(page: string, texts: readonly string[]): { missing: number | null } {
  const hay = collapse(page);
  let from = 0;
  for (const [i, t] of texts.entries()) {
    const needle = collapse(t);
    if (!needle) continue;
    const at = hay.indexOf(needle, from);
    if (at < 0) return { missing: i };
    from = at + needle.length;
  }
  return { missing: null };
}

/**
 * The paragraph texts a stored block shows, per story (its main flow, then each text box and group
 * text), and its image assets. A text box renders at its anchor inside the main flow, so the texts of
 * each story are in order only within that story.
 */
export function blockContent(block: BlockFile): { stories: { label: string; texts: string[] }[]; assets: string[] } {
  const s = readStored([block.doc]);
  const texts = (st: { paragraphs: { text: string }[] }): string[] => st.paragraphs.map((p) => p.text);
  return {
    stories: [
      { label: "main", texts: texts(s.main) },
      ...s.textboxes.map((t, i) => ({ label: `text box ${i + 1}`, texts: texts(t) })),
      ...s.groupTexts.map((t, i) => ({ label: `group text ${i + 1}`, texts: texts(t) })),
    ],
    assets: [s.main, ...s.textboxes, ...s.groupTexts].flatMap((st) => st.pictures.map((p) => p.asset)),
  };
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`))));
  });
}

/**
 * Vite's preview server for `root`'s built site, in its own process (preview-server.ts) run with `root` as
 * its working directory, on the free port the server bound. `stop()` asks the server to close rather than
 * killing it, and resolves once that process has exited — which it does only after everything it started
 * has ended, so nothing it ran is left holding `root` open.
 */
export async function startPreview(root: string): Promise<{ port: number; stop: () => Promise<void> }> {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./preview-server.ts", import.meta.url))], {
    cwd: root, stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const port = await new Promise<number>((resolve, reject) => {
    child.once("exit", (code) => reject(new Error(`vite preview exited ${code}`)));
    child.once("message", (m) => resolve((m as { port: number }).port));
  });
  return {
    port,
    stop: async () => {
      if (child.connected) child.disconnect();
      await exited;
    },
  };
}

/** `npm run build:data`, `vite build`, then `vite preview`. */
export async function buildAndPreview(root: string): Promise<{ base: string; stop: () => Promise<void> }> {
  const win = process.platform === "win32";
  await run(win ? "npm.cmd" : "npm", ["run", "build:data"], root);
  await run(win ? "npx.cmd" : "npx", ["vite", "build"], root);
  const preview = await startPreview(root);
  return { base: `http://localhost:${preview.port}/pa-studying/`, stop: preview.stop };
}

/** Adds rendered-check discrepancies (and `unhosted` info at the import run) to each report. */
export async function renderedCheck(
  root: string, blocksBySource: Map<SourceReport, BlockFile[]>, opts: RenderedOptions,
): Promise<void> {
  const server = await (opts.serve ?? buildAndPreview)(root);
  const browser = await chromium.launch();
  try {
    const hosts = JSON.parse(await readFile(join(root, "dist", "data", ...HOSTS_PATH.split("/")), "utf8")) as Record<string, Host>;
    const byRoute = new Map<string, { report: SourceReport; block: BlockFile }[]>();
    for (const [report, blocks] of blocksBySource) {
      for (const block of blocks) {
        const host = hosts[block.id];
        if (!host) {
          if (opts.postCuration) report.discrepancies.push({ kind: "rendered", story: block.id, index: -1, expected: "a hosting page", actual: "unhosted" });
          else report.info.push({ kind: "unhosted", block: block.id });
          continue;
        }
        const list = byRoute.get(host.route) ?? [];
        list.push({ report, block });
        byRoute.set(host.route, list);
      }
    }
    for (const [route, items] of byRoute) {
      // A fresh page per route: routes differ only in the hash, and a hash-only goto on a reused page
      // loads no new document, so networkidle would return while the previous route is still shown.
      const page = await browser.newPage();
      let loaded: { text: string; imgs: { src: string; ok: boolean }[] };
      try {
        await page.goto(server.base + route, { waitUntil: "networkidle" });
        loaded = await page.evaluate(async () => {
          const imgs = [...document.querySelectorAll("img")];
          for (const img of imgs) img.loading = "eager";
          await Promise.all(imgs.map((img) => img.decode().catch(() => undefined)));
          return { text: document.body.innerText, imgs: imgs.map((img) => ({ src: img.getAttribute("src") ?? "", ok: img.naturalWidth > 0 })) };
        });
      } finally {
        await page.close();
      }
      for (const { report, block } of items) {
        const { stories, assets } = blockContent(block);
        for (const { label, texts } of stories) {
          const r = textsInOrder(loaded.text, texts);
          if (r.missing !== null) {
            const where = label === "main" ? "" : ` (${label})`;
            report.discrepancies.push({ kind: "rendered", story: block.id, index: r.missing, expected: texts[r.missing], actual: `not shown in order on ${route}${where}` });
          }
        }
        for (const asset of assets) {
          if (!loaded.imgs.some((i) => i.src.endsWith(asset) && i.ok)) {
            report.discrepancies.push({ kind: "rendered", story: block.id, index: -1, expected: `loaded <img> ${asset}`, actual: `missing on ${route}` });
          }
        }
      }
      opts.log(`rendered ${route}: ${items.length} blocks`);
    }
  } finally {
    await browser.close();
    await server.stop();
  }
}
