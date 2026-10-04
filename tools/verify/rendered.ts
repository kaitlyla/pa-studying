// Rendered check (30 §30.13): builds the site from the working tree, serves it with `vite preview`,
// and checks in Chromium that each block's page shows its paragraph texts in order and loads its images.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import type { BlockFile } from "../../lib/content/index.ts";
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

/** The paragraph texts and image assets a stored block shows. */
export function blockContent(block: BlockFile): { texts: string[]; assets: string[] } {
  const s = readStored([block.doc]);
  const stories = [s.main, ...s.textboxes, ...s.groupTexts];
  return {
    texts: s.main.paragraphs.map((p) => p.text).concat(s.textboxes.flatMap((t) => t.paragraphs.map((p) => p.text)), s.groupTexts.flatMap((t) => t.paragraphs.map((p) => p.text))),
    assets: stories.flatMap((st) => st.pictures.map((p) => p.asset)),
  };
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`))));
  });
}

/** `npm run build:data`, `vite build`, then `vite preview` on a free port. */
export async function buildAndPreview(root: string): Promise<{ base: string; stop: () => Promise<void> }> {
  const win = process.platform === "win32";
  await run(win ? "npm.cmd" : "npm", ["run", "build:data"], root);
  await run(win ? "npx.cmd" : "npx", ["vite", "build"], root);
  const port = 4173 + Math.floor(Math.random() * 1000);
  const child: ChildProcess = spawn(win ? "npx.cmd" : "npx", ["vite", "preview", "--port", String(port), "--strictPort"], {
    cwd: root, shell: win, stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    child.on("exit", (code) => reject(new Error(`vite preview exited ${code}`)));
    child.stdout?.on("data", (d: Buffer) => { if (String(d).includes(String(port))) resolve(); });
  });
  return {
    base: `http://localhost:${port}/pa-studying/`,
    stop: async () => { child.kill(); },
  };
}

/** Adds rendered-check discrepancies (and `unhosted` info at the import run) to each report. */
export async function renderedCheck(
  root: string, blocksBySource: Map<SourceReport, BlockFile[]>, opts: RenderedOptions,
): Promise<void> {
  const server = await (opts.serve ?? buildAndPreview)(root);
  const browser = await chromium.launch();
  try {
    const hosts = JSON.parse(await readFile(join(root, "dist", "data", "hosts.json"), "utf8")) as Record<string, Host>;
    const page = await browser.newPage();
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
      await page.goto(server.base + route, { waitUntil: "networkidle" });
      const loaded = await page.evaluate(async () => {
        const imgs = [...document.querySelectorAll("img")];
        for (const img of imgs) img.loading = "eager";
        await Promise.all(imgs.map((img) => img.decode().catch(() => undefined)));
        return { text: document.body.innerText, imgs: imgs.map((img) => ({ src: img.getAttribute("src") ?? "", ok: img.naturalWidth > 0 })) };
      });
      for (const { report, block } of items) {
        const { texts, assets } = blockContent(block);
        const r = textsInOrder(loaded.text, texts);
        if (r.missing !== null) {
          report.discrepancies.push({ kind: "rendered", story: block.id, index: r.missing, expected: texts[r.missing], actual: `not shown in order on ${route}` });
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
