// Shared pieces of the one-time GitHub App setup (plan 10 §10.7, setup steps 3–5).
import { spawn } from "node:child_process";
import { createPrivateKey, createSign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

export const HOST = "127.0.0.1";
export const PORT = 8977;
export const LOOPBACK = `http://${HOST}:${PORT}`;
export const SITE_URL = "https://kaitlyla.github.io/pa-studying/";
export const OWNER = "kaitlyla";
export const REPO = "pa-studying";
export const API = "https://api.github.com";
export const API_VERSION = "2026-03-10";

export const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
export const workerDir = fileURLToPath(new URL("../../worker/", import.meta.url));
export const authConfigPath = fileURLToPath(new URL("../../app/auth-config.json", import.meta.url));

export function readAuthConfig() {
  return JSON.parse(readFileSync(authConfigPath, "utf8"));
}

export function writeAuthConfig(update) {
  const next = { ...readAuthConfig(), ...update };
  writeFileSync(authConfigPath, `${JSON.stringify({ workerOrigin: next.workerOrigin, clientId: next.clientId }, null, 2)}\n`);
}

export function apiHeaders(authorization) {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "pa-studying-setup",
    "X-GitHub-Api-Version": API_VERSION,
    ...(authorization ? { Authorization: authorization } : {}),
  };
}

/** The app private key as PKCS#8 PEM (GitHub issues PKCS#1; WebCrypto imports only PKCS#8). */
export function toPkcs8(pem) {
  return createPrivateKey(pem).export({ type: "pkcs8", format: "pem" });
}

/** An RS256 app JWT: iat now − 60 s, exp now + 540 s, iss the client ID. */
export function appJwt(clientId, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: clientId })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKeyPem).toString("base64url");
  return `${unsigned}.${signature}`;
}

const wranglerBin = fileURLToPath(new URL("../../worker/node_modules/wrangler/bin/wrangler.js", import.meta.url));

/** Runs wrangler in worker/, optionally feeding `input` on stdin; rejects on a non-zero exit. */
export function wrangler(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wranglerBin, ...args], {
      cwd: workerDir,
      stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`wrangler ${args.join(" ")} exited ${code}`))));
    if (input !== undefined) child.stdin.end(input);
  });
}

/** Stores a Worker secret through wrangler's stdin, so the value is never written to disk. */
export function putSecret(name, value) {
  return wrangler(["secret", "put", name], value);
}

/** Opens a URL in her default browser without passing it through a shell. */
export function openInBrowser(url) {
  const child =
    process.platform === "win32"
      ? spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { stdio: "ignore", detached: true })
      : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

export const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * The setup's loopback server on 127.0.0.1:8977. Handlers are registered per path and return
 * `{status?, html}`; anything unregistered is 404. Responses are never cached and send no referrer,
 * so a one-time code in the URL goes nowhere else.
 */
export function createLoopback() {
  const handlers = new Map();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", LOOPBACK);
    const handler = req.method === "GET" ? handlers.get(url.pathname) : undefined;
    const send = (status, html) => {
      res.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      res.end(html);
    };
    if (!handler) return send(404, page("Not found", "<p>Not found.</p>"));
    Promise.resolve()
      .then(() => handler(url))
      .then(
        ({ status = 200, html }) => send(status, html),
        (error) => send(500, page("Setup error", `<p>${escapeHtml(error instanceof Error ? error.message : error)}</p>`)),
      );
  });
  return {
    on: (path, handler) => handlers.set(path, handler),
    off: (path) => handlers.delete(path),
    listen: () => new Promise((resolve, reject) => server.once("error", reject).listen(PORT, HOST, resolve)),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem}button{font-size:1.1rem;padding:.6rem 1.4rem}</style>
</head><body>${body}</body></html>`;
}
