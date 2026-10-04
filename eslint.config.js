// Two TypeScript versions are installed on purpose. typescript-eslint 8.71 parses through the
// `typescript` package's compiler API and supports only typescript < 6.1; TypeScript 7.0 has no such
// API. So `typescript` is pinned to 6.0.3 solely as typescript-eslint's parser, and the project's type
// checker is TypeScript 7.0.2, installed as `typescript7` and run by `npm run typecheck`. Remove the
// 6.0.3 pin once typescript-eslint supports TypeScript 7.
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "**/.wrangler/**", "**/test-results/**", "**/playwright-report/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["app/**/*.{ts,tsx}"],
    ignores: ["app/e2e/**"],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["app/e2e/**", "lib/**", "tools/**", "vite.config.ts", "eslint.config.js"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["worker/src/**"],
    languageOptions: { globals: globals.serviceworker },
  },
);
