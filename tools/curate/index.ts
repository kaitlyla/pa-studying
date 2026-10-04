// `node tools/curate/index.ts <command> …` (plan 90 §90.1): the curation CLI. Run from the
// repository root. Every write is validated through lib/content and refused when the resulting
// tree breaks a 20 or 40 §40.1 invariant; nothing is written then.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as cmd from "./commands.ts";
import { commitChanges, CurateError, load } from "./tree.ts";

export const USAGE = `usage: node tools/curate/index.ts <command> …
  split <blockId> <paragraphIndex>
  rows <tableBlockId> <rowId>=heading|content …
  structure <guide> <system> <file.json>
  pharm-parts <file-slug> <file.json>
  cards <file.json>
  general <guide> <file.json>
  places <file.json>
  gap <g_id|new> <file.json>
  slides <guide> <file.json>
  flags <file.json>
  concepts <file.json>`;

const COMMANDS: readonly (string | undefined)[] = ["split", "rows", "structure", "pharm-parts", "cards", "general", "places", "gap", "slides", "flags", "concepts"];

/** A curator-authored draft file; its shape is checked by the command and by lib/content. */
async function readDraft<T>(path: string): Promise<T> {
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new CurateError(`${path}: not JSON: ${(e as Error).message}`);
  }
}

function arity(args: readonly string[], n: number): void {
  if (args.length !== n) throw new CurateError(USAGE);
}

/** Run one command against the content tree under `root`; returns the lines to print. */
export async function run(root: string, argv: readonly string[]): Promise<string[]> {
  const [name, ...args] = argv;
  if (!COMMANDS.includes(name)) throw new CurateError(USAGE);
  /** Argument `i`; a missing one is a usage error. */
  const at = (i: number): string => {
    const v = args[i];
    if (v === undefined) throw new CurateError(USAGE);
    return v;
  };
  const c = await load(root);
  let planned: cmd.Planned;
  switch (name) {
    case "split":
      arity(args, 2);
      planned = cmd.split(c, at(0), Number(at(1)));
      break;
    case "rows":
      if (args.length < 2) throw new CurateError(USAGE);
      planned = cmd.rows(c, at(0), args.slice(1));
      break;
    case "structure":
      arity(args, 3);
      planned = cmd.structure(c, at(0), at(1), await readDraft(at(2)));
      break;
    case "pharm-parts":
      arity(args, 2);
      planned = cmd.pharmParts(c, at(0), await readDraft(at(1)));
      break;
    case "cards":
      arity(args, 1);
      planned = cmd.cards(c, await readDraft(at(0)));
      break;
    case "general":
      arity(args, 2);
      planned = cmd.general(c, at(0), await readDraft(at(1)));
      break;
    case "places":
      arity(args, 1);
      planned = cmd.places(c, await readDraft(at(0)));
      break;
    case "gap":
      arity(args, 2);
      planned = cmd.gap(c, at(0), await readDraft(at(1)));
      break;
    case "slides":
      arity(args, 2);
      planned = cmd.slides(c, at(0), await readDraft(at(1)));
      break;
    case "flags":
      arity(args, 1);
      planned = cmd.flags(c, await readDraft(at(0)));
      break;
    case "concepts":
      arity(args, 1);
      planned = cmd.concepts(c, await readDraft(at(0)));
      break;
    default:
      throw new CurateError(USAGE);
  }
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
