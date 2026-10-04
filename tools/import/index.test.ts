// The import CLI's argument handling and exit codes (30 §30.1).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./index.ts";

let root: string;
let errors: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pa-import-cli-"));
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")); });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("main", () => {
  it.each([[["convert"]], [["commit", "now"]], [["--help"]]])("prints usage and exits 2 for %j", async (argv) => {
    expect(await main(argv, root)).toBe(2);
    expect(errors).toEqual(["usage: node tools/import/index.ts [commit]"]);
  });

  it("exits 1 with the reason when the import fails", async () => {
    expect(await main([], root)).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^import failed: .*sources\.json/);
  });

  it("exits 1 with the reason when the commit step fails", async () => {
    expect(await main(["commit"], root)).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^import failed: /);
  });
});
