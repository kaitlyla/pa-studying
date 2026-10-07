// Search coverage (Orchestrator ruling 2026-10-04 04:45Z, adding to plan 60 §60.1): every piece of
// her text the site shows must land in at least one search unit, or search cannot find it.
import type { BlockFile } from "../content/types.ts";
import type { SearchUnit } from "../search/index.ts";
import type { PMNode } from "../schemaTypes.ts";
import type { Content } from "./model.ts";
import { panelEntries } from "./panel.ts";
import { HOSTS_PATH, SYSTEM_PATH_RE, type HostsJson, type SystemJson } from "./published.ts";
import { nodeText, searchText } from "./text.ts";

export interface Uncovered {
  /**
   * The row holding the text when the build hosts that row, else its block; `<doc>#p<N>` for a page
   * of an as-is file.
   */
  id: string;
  text: string;
}

const TEXTBLOCKS = new Set(["paragraph", "heading_line"]);
const WORD = /[\p{L}\p{N}]+/gu;

/**
 * Every text block (paragraph or heading line, wherever it sits: cells, text boxes, drawings) with
 * text, by owner: the hosted row holding it, else `block.id`; always `block.id` when `byRow` is false.
 */
function textBlocks(block: Pick<BlockFile<unknown>, "id" | "doc">, hosts: HostsJson, out: Uncovered[], byRow = true): void {
  const walk = (n: PMNode, owner: string): void => {
    const row = byRow && n.type === "table_row" && typeof n.attrs?.id === "string" ? n.attrs.id : null;
    const here = row !== null && hosts[row] !== undefined ? row : owner;
    if (TEXTBLOCKS.has(n.type)) {
      const text = searchText(nodeText(n));
      if (text.trim() !== "") out.push({ id: here, text });
      return;
    }
    for (const c of n.content ?? []) walk(c, here);
  };
  walk(block.doc as PMNode, block.id);
}

/**
 * The text the site shows that is in no search unit's text. "Shown" is what the build (`files`, the
 * published files) hosts (hosts.json: every displayed block and row), her versions of meds panel
 * entries that the published panels show, and the pages of as-is files with extracted text; removed
 * and pending documents and unused pharm-notes blocks are not shown, so not checked.
 */
export function uncoveredText(content: Content, units: readonly SearchUnit[], files: ReadonlyMap<string, unknown>): Uncovered[] {
  const hosts = files.get(HOSTS_PATH) as HostsJson;
  const blocks: BlockFile<unknown>[] = [];
  for (const g of content.guides) {
    blocks.push(...g.preamble);
    for (const s of g.systems) blocks.push(...s.blocks);
  }
  for (const d of content.docs.values()) if (d.kind === "word") blocks.push(...d.blocks);
  // A pharm file made from a Word page shows that page's blocks, checked with the page.
  for (const p of content.pharm) if (p.file.page === undefined) blocks.push(...p.blocks);
  for (const gap of content.gaps.values()) blocks.push(gap.block);
  for (const deck of content.decks.values()) blocks.push(...deck.slides);

  const shown: Uncovered[] = [];
  for (const b of blocks) {
    if (hosts[b.id] === undefined) continue;
    textBlocks(b, hosts, shown);
  }
  // Her own version of a card under a condition shows on the condition's page (its topic id's host),
  // copied guide rows included, so each piece the published panel shows is checked against that page.
  for (const [path, value] of files) {
    if (!SYSTEM_PATH_RE.test(path)) continue;
    for (const t of (value as SystemJson).topics) {
      if (hosts[t.id] === undefined) continue;
      for (const e of panelEntries(t)) {
        for (const p of e.own ?? []) textBlocks({ id: t.id, doc: p.doc }, hosts, shown, false);
      }
    }
  }
  for (const [id, d] of content.docs) {
    if (d.kind !== "file" || d.text === null || hosts[id] === undefined) continue;
    d.text.pages.forEach((page, i) => {
      const text = searchText(page);
      if (text.trim() !== "") shown.push({ id: `${id}#p${i + 1}`, text });
    });
  }

  // Candidate units by word, so each text is substring-checked only against units sharing its longest word.
  const byWord = new Map<string, number[]>();
  units.forEach((u, i) => {
    for (const w of new Set(u.text.match(WORD) ?? [])) {
      const list = byWord.get(w);
      if (list) list.push(i);
      else byWord.set(w, [i]);
    }
  });
  // A text counts only when a unit that opens the page showing it holds it, so the same words
  // elsewhere on the site don't hide a gap.
  const covered = (x: Uncovered): boolean => {
    const route = hosts[x.id.split("#")[0] as string]?.route;
    const words = x.text.match(WORD) ?? [];
    const longest = words.reduce((a, w) => (w.length > a.length ? w : a), "");
    const candidates = longest === "" ? units.map((_, i) => i) : (byWord.get(longest) ?? []);
    return candidates.some((i) => {
      const u = units[i] as SearchUnit;
      return u.route === route && u.text.includes(x.text);
    });
  };
  return shown.filter((x) => !covered(x));
}
