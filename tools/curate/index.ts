// `node tools/curate/index.ts <command> …` (plan 90 §90.1): the curation CLI. Run from the
// repository root. Every write is validated through lib/content and refused when the resulting
// tree breaks a 20 or 40 §40.1 invariant; nothing is written then.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Content } from "../../lib/derive/model.ts";
import * as cmd from "./commands.ts";
import { commitChanges, CurateError, load } from "./tree.ts";

/** A curator-authored draft file; its shape is checked by the command and by lib/content. */
async function readDraft<T>(path: string): Promise<T> {
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new CurateError(`${path}: not JSON: ${(e as Error).message}`);
  }
}

interface Command {
  name: string;
  usage: string;
  /** The number of arguments; with `more`, the least number. */
  arity: number;
  more?: boolean;
  /** Plan the command's writes; `at(i)` is argument `i`, `args` all of them. */
  run(c: Content, at: (i: number) => string, args: readonly string[]): cmd.Planned | Promise<cmd.Planned>;
}

const COMMANDS: readonly Command[] = [
  { name: "split", usage: "<blockId> <paragraphIndex>", arity: 2, run: (c, at) => cmd.split(c, at(0), Number(at(1))) },
  { name: "rows", usage: "<tableBlockId> <rowId>=heading|content …", arity: 2, more: true, run: (c, at, args) => cmd.rows(c, at(0), args.slice(1)) },
  { name: "structure", usage: "<guide> <system> <file.json>", arity: 3, run: async (c, at) => cmd.structure(c, at(0), at(1), await readDraft(at(2))) },
  { name: "pharm-parts", usage: "<file-slug> <file.json>", arity: 2, run: async (c, at) => cmd.pharmParts(c, at(0), await readDraft(at(1))) },
  { name: "cards", usage: "<file.json>", arity: 1, run: async (c, at) => cmd.cards(c, await readDraft(at(0))) },
  { name: "general", usage: "<guide> <file.json>", arity: 2, run: async (c, at) => cmd.general(c, at(0), await readDraft(at(1))) },
  { name: "places", usage: "<file.json>", arity: 1, run: async (c, at) => cmd.places(c, await readDraft(at(0))) },
  { name: "gap", usage: "<g_id|new> <file.json>", arity: 2, run: async (c, at) => cmd.gap(c, at(0), await readDraft(at(1))) },
  { name: "slides", usage: "<guide> <file.json>", arity: 2, run: async (c, at) => cmd.slides(c, at(0), await readDraft(at(1))) },
  { name: "flags", usage: "<file.json>", arity: 1, run: async (c, at) => cmd.flags(c, await readDraft(at(0))) },
  { name: "concepts", usage: "<file.json>", arity: 1, run: async (c, at) => cmd.concepts(c, await readDraft(at(0))) },
];

export const USAGE = ["usage: node tools/curate/index.ts <command> …", ...COMMANDS.map((k) => `  ${k.name} ${k.usage}`)].join("\n");

/** Run one command against the content tree under `root`; returns the lines to print. */
export async function run(root: string, argv: readonly string[]): Promise<string[]> {
  const [name, ...args] = argv;
  const command = COMMANDS.find((k) => k.name === name);
  if (!command || (command.more ? args.length < command.arity : args.length !== command.arity)) throw new CurateError(USAGE);
  /** Argument `i`; a missing one is a usage error. */
  const at = (i: number): string => {
    const v = args[i];
    if (v === undefined) throw new CurateError(USAGE);
    return v;
  };
  const planned = await command.run(await load(root), at, args);
  const written = await commitChanges(root, planned.changes);
  return [...planned.notes, ...written.map((p) => `wrote ${p}`)];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(process.cwd(), process.argv.slice(2)).then(
    (lines) => {
      for (const l of lines) console.log(l);
    },
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    },
  );
}
