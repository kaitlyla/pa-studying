import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const PORT = 4173;

// Runs against the already-built site in dist/ (`npm run build:data` then `npx vite build`).
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}/pa-studying/`,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    cwd: projectRoot,
    url: `http://127.0.0.1:${PORT}/pa-studying/`,
    reuseExistingServer: !process.env.CI,
  },
});
