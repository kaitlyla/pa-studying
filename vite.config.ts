import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const authConfigPath = fileURLToPath(new URL("./app/auth-config.json", import.meta.url));

/** The token `app/index.html` carries inside its CSP `connect-src`, replaced with the Worker origin at build. */
export const WORKER_ORIGIN_PLACEHOLDER = "__PA_WORKER_ORIGIN__";

/** Reads the Worker origin from `app/auth-config.json`, the single source the app and the CSP share (10 §10.7). */
export function readWorkerOrigin(path: string = authConfigPath): string {
  const config = JSON.parse(readFileSync(path, "utf8")) as { workerOrigin?: unknown };
  const value = config.workerOrigin;
  if (typeof value !== "string") {
    throw new Error(`${path}: workerOrigin is missing`);
  }
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value) {
    throw new Error(`${path}: workerOrigin must be a bare https origin, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Puts the Worker origin into the CSP meta of `index.html`; fails the build if the placeholder is absent. */
export function workerOriginCsp(origin: () => string = () => readWorkerOrigin()): Plugin {
  return {
    name: "pa-worker-origin-csp",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        if (!html.includes(WORKER_ORIGIN_PLACEHOLDER)) {
          throw new Error(`index.html has no ${WORKER_ORIGIN_PLACEHOLDER} in its CSP connect-src`);
        }
        return html.replaceAll(WORKER_ORIGIN_PLACEHOLDER, origin());
      },
    },
  };
}

export default defineConfig({
  root: "app",
  base: "/pa-studying/",
  publicDir: "public",
  plugins: [react(), workerOriginCsp()],
  build: {
    outDir: "../dist",
    // `npm run build:data` writes dist/data/ before `vite build` runs (40 §40.1).
    emptyOutDir: false,
  },
  test: {
    root: projectRoot,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["{lib,tools,worker}/**/*.test.ts"],
          exclude: ["**/node_modules/**"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "app",
          include: ["app/**/*.test.{ts,tsx}"],
          exclude: ["**/node_modules/**", "app/e2e/**"],
          environment: "jsdom",
        },
      },
    ],
  },
});
