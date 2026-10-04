import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BlockFile } from "../../lib/content/index.ts";
import { newId } from "../../lib/content/ids.ts";
import type { DocJSON } from "../../lib/content/types.ts";
import type { SourceReport } from "./index.ts";
import { renderedCheck, startPreview } from "./rendered.ts";

/**
 * A hash-routed page like the site's: each route shows "Loading…", then fetches its text (served
 * after a delay) and renders it. Routes differ only in the hash.
 */
const APP = `<!doctype html><html><body><script>
async function show() {
  const route = location.hash.slice(2) || "a";
  document.body.textContent = "Loading\\u2026";
  const data = await (await fetch("data/" + route + ".json")).json();
  document.body.innerHTML = "<main><h1>" + data.title + "</h1><p>" + data.body + "</p></main>";
}
addEventListener("hashchange", show);
show();
</script></body></html>`;

const ROUTES: Record<string, { title: string; body: string }> = {
  a: { title: "Alpha page", body: "First words" },
  b: { title: "Beta page", body: "Second words" },
};

function serveApp(): Promise<Server> {
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    const data = /^\/pa-studying\/data\/(\w+)\.json$/.exec(url);
    if (data && ROUTES[data[1]!]) {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(ROUTES[data[1]!]));
      }, 300);
      return;
    }
    if (url === "/pa-studying/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(APP);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const block = (...paras: string[]): BlockFile => ({
  v: 1, id: newId("b"), kind: "prose", meta: {},
  doc: { type: "doc", content: paras.map((t) => ({ type: "paragraph", content: [{ type: "text", text: t }] })) } as DocJSON,
});

describe("renderedCheck in Chromium", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pa-rendered-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads each hash route's own rendered text and still reports text a page lacks", async () => {
    const onA = block("Alpha page", "First words");
    const onB = block("Beta page", "Second words");
    const missing = block("Beta page", "Words the page never shows");
    const unhosted = block("Nowhere");
    await mkdir(join(root, "dist", "data"), { recursive: true });
    await writeFile(join(root, "dist", "data", "hosts.json"), JSON.stringify({
      [onA.id]: { route: "#/a", loc: "" }, [onB.id]: { route: "#/b", loc: "" }, [missing.id]: { route: "#/b", loc: "" },
    }));
    const report: SourceReport = { source: "notes.docx", counts: {}, discrepancies: [], info: [] };
    const server = await serveApp();
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/pa-studying/`;
    let stopped = false;
    const lines: string[] = [];
    try {
      await renderedCheck(root, new Map([[report, [onA, onB, missing, unhosted]]]), {
        postCuration: false,
        log: (l) => lines.push(l),
        serve: async () => ({ base, stop: async () => { stopped = true; } }),
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(report.discrepancies).toEqual([
      { kind: "rendered", story: missing.id, index: 1, expected: "Words the page never shows", actual: "not shown in order on #/b" },
    ]);
    expect(report.info).toEqual([{ kind: "unhosted", block: unhosted.id }]);
    expect(lines).toEqual(["rendered #/a: 1 blocks", "rendered #/b: 2 blocks"]);
    expect(stopped).toBe(true);
  }, 60_000);

  it("reports an unhosted block as a discrepancy after curation", async () => {
    const lone = block("Lone");
    await mkdir(join(root, "dist", "data"), { recursive: true });
    await writeFile(join(root, "dist", "data", "hosts.json"), "{}");
    const report: SourceReport = { source: "x.docx", counts: {}, discrepancies: [], info: [] };
    await renderedCheck(root, new Map([[report, [lone]]]), {
      postCuration: true, log: () => undefined, serve: async () => ({ base: "http://127.0.0.1:9/", stop: async () => undefined }),
    });
    expect(report.discrepancies).toEqual([{ kind: "rendered", story: lone.id, index: -1, expected: "a hosting page", actual: "unhosted" }]);
  }, 60_000);
});

describe("startPreview", () => {
  it("serves the built site and stop() shuts the server itself down", async () => {
    const root = await mkdtemp(join(tmpdir(), "pa-preview-"));
    try {
      await mkdir(join(root, "dist"), { recursive: true });
      await writeFile(join(root, "dist", "index.html"), "<!doctype html><title>built</title>");
      const preview = await startPreview(root);
      const url = `http://localhost:${preview.port}/`;
      expect((await fetch(url)).status).toBe(200);
      await preview.stop();
      await expect(fetch(url)).rejects.toThrow();
      await preview.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
