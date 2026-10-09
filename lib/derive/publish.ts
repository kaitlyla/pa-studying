// Published data (plan 40 §40.8) derived from the loaded content, with the content invariants of
// 40 §40.1 and the search units of 60 §60.1. Pure and browser-safe; tools/build does the I/O.
import { topicMedsPath } from "../content/files.ts";
import { citeKey, slug } from "../content/ids.ts";
import { listedHead, tableNode } from "../content/tables.ts";
import { GENERAL_KEYS, type BlockFile, type BlockNote, type Flag, type GeneralKey, type GuideId, type OtherFile, type PlaceNote, type RefLink } from "../content/types.ts";
import type { SearchUnit } from "../search/index.ts";
import { columnView, noteView } from "./columns.ts";
import { BuildError } from "./errors.ts";
import type { Content, DocData, GuideData, SystemData } from "./model.ts";
import {
  CardMatcher, conditionKey, conditionUses, hasPharm, medsPanel, panelHome, placeCards, sectionCards, sectionKey, stubLabel, topicText, type PharmSystem, type Placements,
} from "./pharm.ts";
import type {
  DocJson, DocList, FlagNote, GeneralJson, HomeJson, HostsJson, NavJson, Notes, OtherJson, PartCut, Place, PubBlock, PubCard, PubNote,
  PubFlag, PubGap, PubLink, PubMedsCard, PubMedsClass, PubMedsEdit, PubMedsPart, PubOtherNote, PubPart, PubRefLink, PubPharmSection, PubTopic, RefTabJson, SiteJson, SlidesJson, SystemJson, UpdatesJson,
  VisitsJson, WorkupJson,
} from "./published.ts";
import { pubFigures } from "./published.ts";
import {
  fileHash, fileLocation, GENERAL_LABELS, generalLoc, guideBase, guideLoc, guideViewHash, otherHash, otherLoc, PANCE, pharmLoc, REF_TABS,
  refHash, refLoc, slidesLoc, systemLoc, TAB_LABELS, UPDATES_LOC, UPDATES_PART, UPDATES_ROUTE, visitLoc, workupLoc, type GuideView, type SiteIndex,
} from "./routes.ts";
import { assetsOf, codePointsOf, collapse, docText, firstCell, nodeText, searchText, tableOf, type PMNode } from "./text.ts";
import { blockSection, checkMembers, deriveTopics, navEntries, publishedRows, publishedSections, publishedTopics, rowSection, type SystemTopics, type Topic } from "./topics.ts";
import { keptOwn, panelEntries, publishedEdit } from "./panel.ts";
import { addDoc } from "./doclist.ts";
import { shownItems, type ShownItems } from "./placeNotes.ts";
import {
  docPath, generalPath, homePath, HOSTS_PATH, navPath, OTHER_PATH, refPath, SITE_PATH, slidesPath, systemPath, UPDATES_PATH, visitsPath, workupPath,
} from "./published.ts";

export interface PublishResult {
  /** Path relative to `dist/data/` → JSON value. */
  files: Map<string, unknown>;
  /** Search units in site order (`ord` = index). */
  units: SearchUnit[];
  /** Asset file names referenced by published blocks. */
  assets: Set<string>;
  /** Stored files of visible as-is documents to copy to `files/<doc>/<name>`. */
  stored: { doc: string; name: string }[];
  dropped: { file: string; id: string }[];
  /** Code points of every published doc's text and markers. */
  codePoints: Set<number>;
}

interface Sys {
  guide: GuideData;
  data: SystemData;
  topics: SystemTopics;
  pharm: PharmSystem;
}

/** A route on the system's guide. */
const view = (s: Sys, v: GuideView): string => guideViewHash(s.guide.file.id, v);
const pharmView = (system: string, section: string | null = null, target: string | null = null): GuideView =>
  ({ kind: "pharm", system, section, target });

const pub = (b: BlockFile): PubBlock => ({ id: b.id, kind: b.kind, doc: b.doc });

/** The row ids of a table block, in order; none for a prose block. */
function tableRowIds(b: BlockFile): string[] {
  const table = b.kind === "table" ? tableNode(b) : null;
  return table ? (table.content ?? []).map((r) => String(r.attrs?.id)) : [];
}

/** The rows of a table block a place note shows: all, all but the first for one column, or the first and its listed rows. */
function shownRows(n: BlockNote, b: BlockFile): string[] {
  const all = tableRowIds(b);
  const { rows } = n;
  if (rows) return all.filter((r, i) => i === 0 || rows.includes(r));
  return n.column === undefined ? all : all.slice(1);
}

/**
 * The outline part each item of an Other section's outline belongs to: a heading's own part slug
 * (unique in the section; a sub heading's is prefixed with its top heading's, so the same sub title
 * under several top headings reads apart), the slug of the heading above any other item, null
 * before the first heading.
 */
function outlineParts(sec: OtherFile["sections"][number]): (string | null)[] {
  // Guidelines' `updates` segment is the Updated guidelines route.
  const used = new Set<string>(sec.id === "guidelines" ? [UPDATES_PART] : []);
  let cur: string | null = null;
  let top: string | null = null;
  return (sec.notes ?? []).map((n) => {
    if (!("heading" in n)) return cur;
    const own = slug(n.heading) || "part";
    const base = n.sub && top !== null ? `${top}-${own}` : own;
    let id = base;
    for (let k = 2; used.has(id); k++) id = `${base}-${k}`;
    used.add(id);
    if (!n.sub) top = id;
    cur = id;
    return id;
  });
}

/** True when the document is shown to visitors. */
function visible(d: DocData): boolean {
  if (d.file.removed) return false;
  return d.kind === "word" || d.file.state === undefined || d.file.state === "ready";
}

/** Gap block text the evidence claims must match (90 §90.4). */
function gapText(g: Content["gaps"] extends Map<string, infer V> ? V : never): string {
  const differs = g.block.meta.differs ? docText(g.block.meta.differs.doc) : "";
  return collapse(`${docText(g.block.doc)}\n${differs}`);
}

/** The items of a generated slide: every slide_card paragraph after the card heading (90 §90.5). */
function slideItems(doc: { content: unknown[] }): string[] {
  const items: string[] = [];
  for (const n of doc.content as PMNode[]) {
    if (n.type !== "slide_card") continue;
    (n.content ?? []).slice(1).forEach((p) => items.push(nodeText(p)));
  }
  return items;
}

export function publish(c: Content): PublishResult {
  const files = new Map<string, unknown>();
  const units: Omit<SearchUnit, "ord">[] = [];
  const assets = new Set<string>();
  const codePoints = new Set<number>();
  const stored: PublishResult["stored"] = [];
  const dropped: PublishResult["dropped"] = [];
  const hosts: HostsJson = {};
  const usedBlocks = (bs: Iterable<{ doc: BlockFile["doc"] }>): void => {
    for (const b of bs) {
      assetsOf(b.doc, assets);
      codePointsOf(b.doc, codePoints);
    }
  };

  // ---- index and per-system derivations --------------------------------------------------------
  const ix: SiteIndex = {
    pance: PANCE,
    guideNames: { ...c.site.guideNames },
    systems: Object.fromEntries(c.guides.map((g) => [g.file.id, Object.fromEntries(g.file.systems.map((s) => [s.id, s.title]))])),
    other: Object.fromEntries(c.other.sections.map((s) => [s.id, s.title])),
  };
  const isPanceGuide = (g: GuideData): boolean => g.file.id === PANCE;
  const tabOf = (g: GuideData): string => (isPanceGuide(g) ? "pance" : "eor");

  const parts = new Map<string, { part: Content["pharm"][number]["file"]["parts"][number]; file: Content["pharm"][number] }>();
  const pharmBlocks = new Map<string, BlockFile>();
  for (const pf of c.pharm) {
    for (const p of pf.file.parts) parts.set(p.id, { part: p, file: pf });
    for (const b of pf.blocks) pharmBlocks.set(b.id, b);
  }
  const cardIds = new Set(c.cards.cards.map((x) => x.id));
  const partFiles = new Map([...parts].map(([id, p]) => [id, p.file.file.id]));

  const systems: Sys[] = [];
  const rowSys = new Map<string, Sys>();
  const blockSys = new Map<string, Sys>();
  for (const g of c.guides) {
    for (const data of g.systems) {
      const topics = deriveTopics(data.blocks, data.structure);
      const s: Sys = { guide: g, data, topics, pharm: { guide: g.file.id, system: data.file.id, structure: data.structure, topics, partFiles } };
      systems.push(s);
      for (const b of data.blocks) blockSys.set(b.id, s);
      for (const id of topics.rows.keys()) rowSys.set(id, s);
    }
  }
  for (const s of systems) checkStructure(s);
  for (const s of systems) checkMembers(`${s.guide.file.id}/${s.data.file.id}`, s.topics, s.data.structure);

  function checkStructure(s: Sys): void {
    const st = s.data.structure;
    const here = (id: string): boolean => blockSys.get(id) === s || rowSys.get(id) === s;
    const unknown = (id: string, what: string): never => {
      throw new BuildError(id, `structure.json of ${s.guide.file.id}/${s.data.file.id} names ${what} that does not exist`);
    };
    for (const id of Object.keys(st.members)) if (!here(id)) unknown(id, "a row or block");
    for (const id of Object.keys(st.listed)) if (blockSys.get(id) !== s) unknown(id, "a block");
    const sections = new Set(st.pharmSections.map((p) => p.id));
    for (const d of st.drugTables) {
      if (!s.topics.tables.has(d.block)) unknown(d.block, "a table block");
      for (const r of d.conditionRows) if (s.topics.rows.get(r)?.block !== d.block) unknown(r, "a row of its drug table");
      if (!sections.has(d.pharmSection)) unknown(d.pharmSection, "a pharm section");
    }
    for (const ps of st.pharmSections) {
      for (const t of ps.tables) if (!st.drugTables.some((d) => d.block === t)) unknown(t, "a drug table");
      for (const p of [ps.overview, ps.lo]) if (p !== null && !parts.has(p)) unknown(p, "a pharm part");
      for (const card of ps.also) if (!cardIds.has(card)) unknown(card, "a card");
    }
    for (const d of st.pharmFiles) if (!c.docs.has(d)) unknown(d, "a document");
  }

  // ---- evidence invariants (90 §90.4, §90.5) ------------------------------------------------------
  for (const [id, g] of c.gaps) {
    const ev = g.evidence;
    if (!ev || ev.verification.result !== "pass") throw new BuildError(id, "gap block lacks a passing evidence record");
    const claims = collapse(ev.claims.map((x) => x.text).join(" "));
    if (g.block.meta.ownerEdits.length === 0 && claims !== gapText(g)) throw new BuildError(id, "gap block text no longer matches its verified claims");
  }
  for (const deck of c.decks.values()) {
    if (deck.file.kind !== "generated") continue;
    for (const slide of deck.slides) {
      const items = slideItems(slide.doc);
      if (items.length === 0 || (slide.meta.ownerEdits?.length ?? 0) > 0) continue;
      const evidence = (slide.meta.evidence ?? []).map((e) => e.item);
      if (slide.meta.verification?.result !== "pass" || items.length !== evidence.length || items.some((t, i) => t !== evidence[i])) {
        throw new BuildError(slide.id, "generated slide lacks a passing evidence record for its current items");
      }
    }
  }

  // ---- pharm cards --------------------------------------------------------------------------------
  const partDiseases = new Map<string, string[][]>();
  for (const p of c.pharm.flatMap((f) => f.file.parts)) {
    if (p.card !== null && p.diseases !== undefined) partDiseases.set(p.card, [...(partDiseases.get(p.card) ?? []), p.diseases]);
  }
  const matcher = new CardMatcher(c.cards.cards, partDiseases);
  const placements: Placements = placeCards(systems.map((s) => s.pharm), matcher, new Set(c.pharm.map((p) => p.file.id)));
  const panels = conditionUses(c.uses.conditions, systems.map((s) => s.pharm));
  /** The parts of a class card's whole group: its own, then those of each card shown inside it, each with its card's `for`. */
  const cardParts = (card: string): { part: Content["pharm"][number]["file"]["parts"][number]; file: Content["pharm"][number]; for: string[] | undefined }[] =>
    matcher.membersOf(card).flatMap((m) => [...parts.values()].filter((p) => p.part.role === "card" && p.part.card === m.id).map((p) => ({ ...p, for: m.for })));
  const cardTitle = (card: string): string => cardParts(card)[0]?.part.title ?? c.cards.cards.find((x) => x.id === card)?.aliases[0] ?? card;

  // ---- existence and flags -------------------------------------------------------------------------
  const docBlocks = new Map<string, string>();
  /** The blocks of visible Word pages, each with its page's base size. */
  const wordBlocks = new Map<string, { block: BlockFile; basePt: number }>();
  for (const [d, doc] of c.docs) {
    if (doc.kind !== "word" || !visible(doc)) continue;
    for (const b of doc.blocks) {
      docBlocks.set(b.id, d);
      wordBlocks.set(b.id, { block: b, basePt: doc.file.basePt });
    }
  }
  const preambleBlock = new Map<string, GuideData>();
  for (const g of c.guides) for (const b of g.preamble) preambleBlock.set(b.id, g);
  const slideIds = new Set<string>();
  for (const deck of c.decks.values()) for (const s of deck.slides) slideIds.add(s.id);
  const exists = (id: string): boolean =>
    rowSys.has(id) || blockSys.has(id) || preambleBlock.has(id) || c.gaps.has(id) || c.docs.has(id) || docBlocks.has(id) || pharmBlocks.has(id) || slideIds.has(id);
  const shown = (id: string): boolean => {
    const d = c.docs.get(id);
    return d === undefined || visible(d);
  };

  // ---- pharm files on her Word pages, and parts that cut a table -------------------------------
  // A page's blocks are hosted on her page when it is placed (the documents' hosts, below, come
  // after the cards'), else on the card showing them.
  const pharmPages = new Map<string, string>();
  for (const pf of c.pharm) {
    const d = pf.file.page;
    if (d === undefined) continue;
    const where = `content/pharm/${pf.file.id}/pharmfile.json`;
    const other = pharmPages.get(d);
    if (other !== undefined) throw new BuildError(d, `pharm files ${other} and ${pf.file.id} are both made from Word page ${d}`);
    pharmPages.set(d, pf.file.id);
    if (c.docs.get(d)?.kind !== "word") throw new BuildError(d, `${where} is made from ${d}, which is not a Word page`);
    const own = new Set(pf.blocks.map((b) => b.id));
    for (const id of pf.file.blocks) {
      if (own.has(id)) continue;
      if (exists(id)) throw new BuildError(id, `${where} lists ${id}, which is not a block of ${d}`);
      // Deleted from her page (or the page removed): the parts show the rest.
      dropped.push({ file: where, id });
    }
  }
  /** Each cutting part's cut as published: its rows still in the table. */
  const cuts = new Map<string, PartCut>();
  /** Row parts whose rows have all gone from her table: they show nothing, as a part whose block went. */
  const emptied = new Set<string>();
  /** Column parts whose column no longer fits her table: they show nothing. */
  const columnGone = new Set<string>();
  for (const pf of c.pharm) {
    const where = `content/pharm/${pf.file.id}/pharmfile.json`;
    for (const p of pf.file.parts) {
      if (p.column === undefined && p.rows === undefined) continue;
      const b = pharmBlocks.get(p.blocks[0] as string);
      if (!b) continue;
      if (b.kind !== "table" || !tableNode(b)) throw new BuildError(p.id, `${where} part ${p.id} cuts ${b.id}, which is not a table`);
      const column = p.column === undefined
        ? {}
        : { column: p.column, ...(p.label === undefined ? {} : { label: p.label }), ...(p.columns === undefined ? {} : { columns: p.columns }) };
      const fits = (at: number): boolean => (p.columns === undefined ? columnView(b.doc, at, p.label) : columnView(b.doc, at, null, p.columns)) !== null;
      if (p.column !== undefined && !fits(p.column)) {
        dropped.push({ file: where, id: p.id });
        columnGone.add(p.id);
      }
      if (p.rows !== undefined) {
        const inTable = tableRowIds(b);
        for (const r of p.rows) if (!inTable.includes(r)) dropped.push({ file: where, id: r });
        const rows = p.rows.filter((r) => inTable.includes(r));
        if (rows.length === 0) emptied.add(p.id);
        else cuts.set(p.id, { rows, ...column });
        continue;
      }
      cuts.set(p.id, column);
    }
  }
  /** Guide topic id → the `topic` parts attached to it (content PharmPart `topics`), in file order. */
  const topicParts = new Map<string, { part: Content["pharm"][number]["file"]["parts"][number]; file: Content["pharm"][number] }[]>();
  for (const pf of c.pharm) {
    for (const p of pf.file.parts) for (const t of p.topics ?? []) topicParts.set(t, [...(topicParts.get(t) ?? []), { part: p, file: pf }]);
  }
  /** Topic ids published so far: a topic part naming none of them names a topic no guide has. */
  const publishedTopicIds = new Set<string>();
  /** A part as published: its blocks still stored, and its cut. */
  const pubPartOf = (part: Content["pharm"][number]["file"]["parts"][number]): { blocks: string[] } & PartCut =>
    ({ blocks: emptied.has(part.id) ? [] : part.blocks.filter((b) => pharmBlocks.has(b)), ...cuts.get(part.id) });

  const placedFlags = new Map<string, Flag[]>();
  for (const concept of c.concepts.concepts) {
    for (const target of concept.targets) {
      if (!exists(target)) {
        dropped.push({ file: "content/updates/concepts.json", id: target });
        continue;
      }
      if (!shown(target)) continue;
      for (const flag of c.flags.flags) {
        // A retired flag's recommendation is gone from its source, so it is listed but never placed;
        // concepts name flags by identity key (Orchestrator rulings, 2026-10-04 03:06Z/03:07Z).
        if (flag.kind !== "rec" || flag.supersededBy !== null || flag.retired !== undefined) continue;
        if (flag.by === "agent" && flag.verification?.result !== "pass") continue;
        if (!(concept.sourceKeys[flag.source] ?? []).includes(flag.key)) continue;
        const list = placedFlags.get(target) ?? [];
        if (!list.includes(flag)) list.push(flag);
        placedFlags.set(target, list);
      }
    }
  }
  const note = (f: Flag): FlagNote => ({ id: f.id, guideline: f.guideline, org: f.org, published: f.published, quote: f.quote, grade: f.grade, url: f.url, flagged: f.flagged });
  const notesFor = (ids: Iterable<string>): Notes => {
    const out: Notes = {};
    for (const id of ids) {
      const fs = placedFlags.get(id);
      if (fs) out[id] = fs.map(note);
    }
    return out;
  };

  // ---- hosts: guide blocks, rows, pharm -------------------------------------------------------
  for (const g of c.guides) for (const b of g.preamble) hosts[b.id] = { route: guideBase(g.file.id), loc: guideLoc(ix, g.file.id) };
  const secTitle = (s: Sys, id: string | null): string | null => (id === null ? null : (s.data.structure.sections.find((x) => x.id === id)?.title ?? null));
  const sysRoute = (s: Sys): string => view(s, { kind: "system", system: s.data.file.id });
  const secRoute = (s: Sys, sec: string): string => view(s, { kind: "section", system: s.data.file.id, section: sec });
  const topicRoute = (s: Sys, topic: string): string => view(s, { kind: "topics", ids: [topic] });
  const pharmSectionOf = (s: Sys, block: string): string | null => s.data.structure.drugTables.find((d) => d.block === block)?.pharmSection ?? null;
  const g0 = (s: Sys): string => s.guide.file.id;
  for (const s of systems) {
    const st = s.data.structure;
    const sys = s.data.file.id;
    for (const b of s.data.blocks) {
      const ps = pharmSectionOf(s, b.id);
      if (ps !== null) hosts[b.id] = { route: view(s, pharmView(sys, ps)), loc: pharmLoc(ix, g0(s), sys) };
      else if (listedHead(st, b.id) !== null) {
        hosts[b.id] = { route: view(s, { kind: "block", id: listedHead(st, b.id) as string }), loc: systemLoc(ix, g0(s), sys, secTitle(s, blockSection(st, b.id))) };
      } else if (s.topics.proseBlocks.includes(b.id) && st.members[b.id] !== undefined && st.sections.length > 0) {
        hosts[b.id] = { route: secRoute(s, st.members[b.id] as string), loc: systemLoc(ix, g0(s), sys, secTitle(s, st.members[b.id] ?? null)) };
      } else hosts[b.id] = { route: sysRoute(s), loc: systemLoc(ix, g0(s), sys) };
    }
    for (const [id, info] of s.topics.rows) {
      const ps = pharmSectionOf(s, info.block);
      // A drug table is shown in full only on its pharm section, heading rows included.
      const inDrugTable = info.drug || (info.kind === "heading" && st.drugTables.some((d) => d.block === info.block));
      if (inDrugTable && ps !== null) hosts[id] = { route: view(s, pharmView(sys, ps, id)), loc: pharmLoc(ix, g0(s), sys) };
      else if (info.topic !== null) {
        hosts[id] = { route: topicRoute(s, info.topic), loc: systemLoc(ix, g0(s), sys, secTitle(s, rowSection(s.topics, st, id))) };
      } else {
        const sec = info.kind === "content" ? rowSection(s.topics, st, id) : null;
        hosts[id] = sec ? { route: secRoute(s, sec), loc: systemLoc(ix, g0(s), sys, secTitle(s, sec)) } : { route: sysRoute(s), loc: systemLoc(ix, g0(s), sys) };
      }
    }
  }
  /**
   * Every pharm section using each card, its class sections first (those whose Overview or LO comes
   * from the card's own med list), then in site order; and the first section using each overview/LO part.
   */
  const cardPlaces = new Map<string, { s: Sys; section: string; own: boolean }[]>();
  const pharmHome = new Map<string, { s: Sys; section: string }>();
  for (const s of systems) {
    for (const ps of s.data.structure.pharmSections) {
      const lists = [ps.overview, ps.lo].flatMap((p) => (p === null ? [] : [partFiles.get(p)]));
      for (const card of sectionCards(placements.get(sectionKey(g0(s), s.data.file.id, ps.id)))) {
        const own = lists.includes(matcher.fileOf(card));
        cardPlaces.set(card, [...(cardPlaces.get(card) ?? []), { s, section: ps.id, own }]);
      }
      for (const p of [ps.overview, ps.lo]) if (p !== null && !pharmHome.has(p)) pharmHome.set(p, { s, section: ps.id });
    }
  }
  for (const places of cardPlaces.values()) places.sort((a, b) => Number(b.own) - Number(a.own));
  /**
   * A card part's home: the first section using its card where the part shows (its card's `for`). A
   * part written for some conditions (`diseases`) whose card is written for no section shows in no
   * section, so it has none: it shows on those conditions' meds panels, and search finds it on her
   * file page.
   */
  const partHome = new Map<string, { s: Sys; section: string }>();
  for (const [card, places] of cardPlaces) {
    for (const p of cardParts(card)) {
      if (p.part.diseases !== undefined && p.for === undefined) continue;
      const home = places.find((h) => p.for === undefined || p.for.includes(h.section));
      if (!home) throw new BuildError(p.part.id, `card part is for pharm sections ${p.for?.join(", ")}, where its card "${card}" is never placed`);
      partHome.set(p.part.id, home);
    }
  }
  const place = (h: { s: Sys; section: string }, id: string): Place =>
    // The target opens the card (or Overview/LO card) holding the id; a collapsed card shows nothing.
    ({ route: view(h.s, pharmView(h.s.data.file.id, h.section, id)), loc: pharmLoc(ix, g0(h.s), h.s.data.file.id) });
  for (const [id, h] of pharmHome) {
    hosts[id] = place(h, id);
    for (const b of parts.get(id)?.part.blocks ?? []) hosts[b] = hosts[id];
  }
  for (const [card, places] of cardPlaces) {
    hosts[card] = place(places[0] as { s: Sys; section: string }, card);
    for (const m of matcher.membersOf(card)) if (m.id !== card) hosts[m.id] = hosts[card];
    for (const p of cardParts(card)) {
      const home = partHome.get(p.part.id);
      if (home === undefined) continue;
      // The class card opens at the part's home, which differs from the card's when the part is for another use.
      const at = place(home, card);
      hosts[p.part.id] = at;
      if (p.part.card !== card) hosts[p.part.card as string] = at;
      for (const b of p.part.blocks) hosts[b] = at;
    }
  }

  // ---- first placements of documents and gap blocks (site order) ----------------------------------
  // A document's first placement is the list route it is first opened from (its File page `from`).
  const docHome = new Map<string, { from: string; tab: string }>();
  const gapHome = new Map<string, { place: Place; tab: string }>();
  const placeDoc = (id: string, from: string, tab: string): void => {
    if (!docHome.has(id)) docHome.set(id, { from, tab });
  };
  const placeGap = (id: string, place: Place, tab: string): void => {
    if (!gapHome.has(id)) gapHome.set(id, { place, tab });
  };
  for (const g of c.guides) {
    const gid = g.file.id;
    for (const data of g.systems) for (const d of data.structure.pharmFiles) placeDoc(d, guideViewHash(gid, pharmView(data.file.id)), tabOf(g));
    for (const t of g.general?.topics ?? []) {
      const route = guideViewHash(gid, { kind: "general", key: t.key });
      for (const d of t.files) placeDoc(d, route, tabOf(g));
      for (const gap of t.gaps) placeGap(gap, { route, loc: generalLoc(ix, gid, t.key) }, tabOf(g));
    }
    for (const w of g.general?.workup ?? []) placeGap(w.gap, { route: guideViewHash(gid, { kind: "workup", item: w.id }), loc: workupLoc(ix, gid) }, tabOf(g));
    for (const v of g.general?.visits ?? []) {
      for (const gap of v.gaps) placeGap(gap, { route: guideViewHash(gid, { kind: "visits", item: v.id }), loc: visitLoc(ix, gid, v.title) }, tabOf(g));
    }
    // A sourced card she placed under a dx (MedsFile `gaps`) is placed on that dx's page.
    for (const s of systems) {
      if (s.guide !== g) continue;
      for (const [topicId, file] of s.data.meds) {
        const topic = s.topics.topics.find((x) => x.id === topicId);
        if (!topic) continue;
        const place = { route: topicRoute(s, topicId), loc: systemLoc(ix, gid, s.data.file.id, secTitle(s, topic.section)) };
        for (const id of file.gaps ?? []) placeGap(id, place, tabOf(g));
        for (const o of keptOwn(file)) if (o.gap !== undefined) placeGap(o.gap, place, tabOf(g));
      }
    }
    if (g.file.sidebarEnd) placeDoc(g.file.sidebarEnd, guideBase(gid), tabOf(g));
    const deck = c.decks.get(gid);
    if (deck?.file.kind === "own" && deck.file.file) placeDoc(deck.file.file, guideViewHash(gid, { kind: "slides", n: 1 }), tabOf(g));
  }
  for (const tab of REF_TABS) {
    for (const sub of c.reftabs[tab].subs) for (const gap of sub.gaps) placeGap(gap, { route: refHash(tab, sub.id), loc: refLoc(tab, sub) }, tab);
    for (const d of c.reftabs[tab].files) placeDoc(d, refHash(tab), tab);
  }
  for (const sec of c.other.sections) {
    const place = { route: otherHash(sec.id), loc: otherLoc(ix, sec.id) };
    // A gap block in the outline is placed on its part's page.
    const parts = outlineParts(sec);
    (sec.notes ?? []).forEach((n, i) => {
      if ("gap" in n) placeGap(n.gap, { ...place, route: otherHash(sec.id, parts[i] ?? null) }, "other");
    });
    if (sec.lead) placeGap(sec.lead, place, "other");
    for (const d of sec.files) placeDoc(d, place.route, "other");
    for (const gap of sec.gaps ?? []) placeGap(gap, place, "other");
  }
  const docLoc = (d: string): string => {
    const home = docHome.get(d);
    return home ? (fileLocation(ix, home.from) ?? "") : "";
  };
  for (const [d, doc] of c.docs) {
    if (!visible(doc) || !docHome.has(d)) continue;
    const place = { route: fileHash(d, null), loc: docLoc(d) };
    hosts[d] = place;
    if (doc.kind === "word") for (const b of doc.blocks) hosts[b.id] = place;
  }
  for (const [id, home] of gapHome) if (c.gaps.has(id)) hosts[id] = home.place;
  /** The Word blocks an Other section's outline shows, each with its part: its block items, and every block of its visible Word doc items. */
  const otherShown = (sec: OtherFile["sections"][number]): { note: PlaceNote; part: string | null }[] => {
    const parts = outlineParts(sec);
    return (sec.notes ?? []).flatMap((n, i) => {
      const part = parts[i] ?? null;
      if ("block" in n) return [{ note: n, part }];
      const d = "doc" in n ? c.docs.get(n.doc) : undefined;
      return d?.kind === "word" && visible(d) ? d.blocks.map((b) => ({ note: { block: b.id }, part })) : [];
    });
  };
  // A block of her Word pages shown as notes on a place page opens there (its first such place), not on the File page;
  // a table row opens on the first place showing it, which for a note showing some rows can be a later one.
  const noteHome = new Map<string, { place: Place; tab: string; title: string }>();
  const rowHome = new Map<string, { place: Place; tab: string; title: string; block: string }>();
  const placeNotes = (notes: readonly PlaceNote[] | undefined, place: Place, tab: string, title: string): void => {
    for (const n of notes ?? []) {
      if (!("block" in n)) continue;
      const w = wordBlocks.get(n.block);
      if (!w) continue;
      if (!noteHome.has(n.block)) noteHome.set(n.block, { place, tab, title });
      for (const r of shownRows(n, w.block)) if (!rowHome.has(r)) rowHome.set(r, { place, tab, title, block: n.block });
    }
  };
  for (const tab of REF_TABS) for (const sub of c.reftabs[tab].subs) placeNotes(sub.notes, { route: refHash(tab, sub.id), loc: refLoc(tab, sub) }, tab, sub.title);
  // An Other outline's block opens on its part's page.
  for (const sec of c.other.sections) {
    for (const { note, part } of otherShown(sec)) placeNotes([note], { route: otherHash(sec.id, part), loc: otherLoc(ix, sec.id) }, "other", sec.title);
  }
  for (const [id, home] of noteHome) hosts[id] = home.place;
  // A row is hosted by its block unless it first shows on another page.
  for (const [id, home] of rowHome) if (home.place.route !== noteHome.get(home.block)?.place.route) hosts[id] = home.place;
  for (const g of c.guides) {
    const deck = c.decks.get(g.file.id);
    if (!deck || !deckShown(deck)) continue;
    deck.slides.forEach((s, i) => {
      hosts[s.id] = { route: guideViewHash(g.file.id, { kind: "slides", n: i + 1 }), loc: slidesLoc(ix, g.file.id) };
    });
  }
  for (const f of c.flags.flags) hosts[f.id] = { route: UPDATES_ROUTE, loc: UPDATES_LOC };

  function deckShown(deck: NonNullable<ReturnType<typeof c.decks.get>>): boolean {
    if (deck.file.kind !== "own" || deck.file.file === null) return true;
    const d = c.docs.get(deck.file.file);
    return d !== undefined && visible(d);
  }

  // ---- shared resolvers ---------------------------------------------------------------------------
  const docList = (ids: readonly string[]): DocList => {
    const out: DocList = { files: [], removed: [], pending: [] };
    for (const id of ids) {
      const d = c.docs.get(id);
      if (!d) throw new BuildError(id, "listed document does not exist");
      addDoc(out, id, { name: d.file.name, kind: d.file.kind, removed: d.file.removed, ...(d.kind === "file" ? { state: d.file.state } : {}) });
    }
    return out;
  };
  /** Only reference-tab links carry `gap` (RefLink); it passes through as stored. */
  const links = (file: string, ls: readonly RefLink[]): PubRefLink[] => {
    const out: PubRefLink[] = [];
    for (const l of ls) {
      const host = hosts[l.target];
      if (!exists(l.target) || !host) {
        dropped.push({ file, id: l.target });
        continue;
      }
      out.push({
        target: l.target, title: targetTitle(l.target), covers: l.covers, route: host.route, loc: host.loc, flagged: placedFlags.has(l.target),
        ...(l.gap !== undefined ? { gap: l.gap } : {}),
      });
    }
    return out;
  };
  const gap = (id: string): PubGap => {
    const g = c.gaps.get(id);
    if (!g) throw new BuildError(id, "listed gap block does not exist");
    const m = g.block.meta;
    usedBlocks([g.block, ...(m.differs ? [m.differs] : [])]);
    const figures = pubFigures(m);
    for (const f of figures) assets.add(f.asset);
    return {
      id, title: m.title, relevantTo: m.relevantTo, written: m.written, doc: g.block.doc, differs: m.differs?.doc ?? null,
      sources: m.sources.map((s) => ({ name: s.name, org: s.org, year: s.year, url: s.url })), ownerEdits: m.ownerEdits, figures,
      asNotes: m.asNotes === true, notes: (placedFlags.get(id) ?? []).map(note),
    };
  };
  const gapUnits = new Set<string>();
  /** `at`: where its search result lands, when not on the block itself (a block inside an entry lands on the entry, which opens it). */
  const gapUnit = (id: string, at: string = id): void => {
    const g = c.gaps.get(id);
    const home = gapHome.get(id);
    if (!g || !home || gapUnits.has(id)) return;
    gapUnits.add(id);
    const m = g.block.meta;
    const text = [
      docText(g.block.doc), m.relevantTo, m.differs ? docText(m.differs.doc) : "", ...m.sources.map((s) => s.name), ...(m.figures ?? []).map((f) => f.caption),
    ].join("\n");
    // A block she shows as her own notes is labelled as her notes in search too.
    const label = m.asNotes === true ? "notes" : "gap";
    units.push({ tab: home.tab, title: collapse(m.title), loc: home.place.loc, route: home.place.route, at, label, text: searchText(text) });
  };
  type UnitBase = Omit<SearchUnit, "ord" | "title" | "at" | "text">;
  /** Search units of one of her Word-page blocks: one per table row (`rowAt`: a row found elsewhere), else one for the block. */
  const wordBlockUnits = (base: UnitBase, title: string, b: BlockFile, rowAt?: (row: string) => { base: UnitBase; title: string } | undefined): void => {
    const table = b.kind === "table" ? (tableNode(b) as PMNode | null) : null;
    if (table) {
      for (const r of table.content ?? []) {
        const at = String(r.attrs?.id);
        const here = rowAt?.(at) ?? { base, title };
        units.push({ ...here.base, title: here.title, at, text: searchText(nodeText(r)) });
      }
    } else units.push({ ...base, title, at: b.id, text: searchText(docText(b.doc)) });
  };
  const docUnits = new Set<string>();
  const docUnit = (id: string): void => {
    const d = c.docs.get(id);
    const home = docHome.get(id);
    if (!d || !home || !visible(d) || docUnits.has(id)) return;
    docUnits.add(id);
    const base = { tab: home.tab, loc: docLoc(id), route: fileHash(id, null), label: "notes" as const };
    if (d.kind === "word") {
      // A block shown as notes on a place page is found there instead (noteUnit).
      for (const b of d.blocks) if (!noteHome.has(b.id)) wordBlockUnits(base, d.file.name, b);
    } else {
      (d.text?.pages ?? []).forEach((t, i) => units.push({ ...base, title: `${d.file.name} · p. ${i + 1}`, at: `p${i + 1}`, text: searchText(t) }));
    }
  };
  /** The shownItems rule for a place listing `docs`: blocks show while on a visible Word page. */
  const placeShown = (docs: DocList | null): ShownItems => shownItems(docs, (id) => wordBlocks.has(id));
  /** A place's notes; a block no longer on a visible Word page (its page removed, or the block deleted) is dropped. */
  const placeNoteList = (file: string, ns: readonly PlaceNote[] | undefined, shown: ShownItems = placeShown(null)): PubNote[] => {
    const out: PubNote[] = [];
    for (const n of ns ?? []) {
      if ("heading" in n) {
        out.push({ heading: n.heading });
        continue;
      }
      const w = shown.block(n.block) ? wordBlocks.get(n.block) : undefined;
      if (!w) {
        dropped.push({ file, id: n.block });
        continue;
      }
      // A listed row no longer in the table (deleted on an edit) is dropped; the rest still show.
      const inTable = tableRowIds(w.block);
      for (const r of n.rows ?? []) if (!inTable.includes(r)) dropped.push({ file, id: r });
      const rows = n.rows?.filter((r) => inTable.includes(r)) ?? null;
      out.push({ block: pub(w.block), basePt: w.basePt, column: n.column ?? null, rows });
    }
    return out;
  };
  const noteUnits = new Set<string>();
  const noteUnit = (id: string): void => {
    const home = noteHome.get(id);
    const w = wordBlocks.get(id);
    if (!home || !w || noteUnits.has(id)) return;
    noteUnits.add(id);
    const at = (h: { place: Place; tab: string; title: string }): { base: UnitBase; title: string } =>
      ({ base: { tab: h.tab, loc: h.place.loc, route: h.place.route, label: "notes" }, title: h.title });
    const own = at(home);
    // A row shown first on another page (a note showing some rows) is found there.
    wordBlockUnits(own.base, own.title, w.block, (row) => {
      const h = rowHome.get(row);
      return h ? at(h) : undefined;
    });
  };
  const noteUnitsOf = (ns: readonly PlaceNote[] | undefined): void => {
    for (const n of ns ?? []) if ("block" in n) noteUnit(n.block);
  };
  /** Text of a pharm part's notes blocks as the part shows them: a cut part, only its cut. */
  const partText = (part: Content["pharm"][number]["file"]["parts"][number]): string => {
    const { blocks, ...cut } = pubPartOf(part);
    return blocks.map((id) => {
      const b = pharmBlocks.get(id);
      const view = b ? noteView(b.doc, cut, { firstRow: false }) : null;
      return view ? [view.title ?? "", docText(view.doc)].filter((t) => t !== "").join("\n") : "";
    }).join("\n");
  };
  const firstLine = (b: BlockFile): string => collapse(docText(b.doc).split("\n").find((l) => l.trim() !== "") ?? "");
  /** A link target's name, as search titles it. */
  const targetTitle = (id: string): string => {
    const rs = rowSys.get(id);
    if (rs) {
      const info = rs.topics.rows.get(id);
      const topic = rs.topics.topics.find((t) => t.id === info?.topic);
      if (topic) return topic.title;
      if (info?.kind === "heading") return collapse(rs.topics.headings.get(id)?.label ?? "");
      const row = rs.topics.tables.get(info?.block ?? "")?.rows.find((r) => r.id === id);
      return row ? collapse(firstCell(row)) : "";
    }
    const bs = blockSys.get(id);
    const block = bs?.data.blocks.find((b) => b.id === id) ?? preambleBlock.get(id)?.preamble.find((b) => b.id === id);
    if (block) {
      const st = bs?.data.structure;
      return (st && st.listed[listedHead(st, id) ?? id]) ?? firstLine(block);
    }
    const g = c.gaps.get(id);
    if (g) return collapse(g.block.meta.title);
    const d = c.docs.get(docBlocks.get(id) ?? id);
    return d ? d.file.name : "";
  };

  // ---- guides ---------------------------------------------------------------------------------
  const site: SiteJson = {
    name: c.site.name,
    repo: c.site.repo,
    owner: { ...c.site.owner },
    tabs: c.site.tabs,
    eors: [],
    pance: { id: PANCE, name: c.site.guideNames[PANCE], systems: [] },
    guideNames: { ...c.site.guideNames },
    index: ix,
  };
  for (const g of c.guides) {
    const gid = g.file.id;
    const base = guideBase(gid);
    const tab = tabOf(g);
    const summaries = g.file.systems.map((s) => ({ id: s.id, title: s.title, pct: s.pct }));
    if (isPanceGuide(g)) site.pance.systems = summaries;
    else site.eors.push({ id: gid, name: c.site.guideNames[gid], systems: summaries, general: g.general?.topics.length ?? 0 });

    // home
    usedBlocks(g.preamble);
    const home: HomeJson = { guide: gid, title: c.site.guideNames[gid], preamble: g.preamble.map(pub), systems: summaries, notes: notesFor(g.preamble.map((b) => b.id)) };
    files.set(homePath(gid), home);
    for (const b of g.preamble) {
      units.push({ tab, title: firstLine(b), loc: guideLoc(ix, gid), route: base, at: b.id, label: "notes", text: searchText(docText(b.doc)) });
    }

    // systems
    const navSystems: NavJson["systems"] = [];
    for (const data of g.systems) {
      const s = systems.find((x) => x.data === data) as Sys;
      navSystems.push(systemPages(s));
    }

    // general topics and workup
    const general: NavJson["general"] = [];
    if (g.general) {
      for (const key of GENERAL_KEYS) {
        const t = g.general.topics.find((x) => x.key === key);
        if (!t) continue;
        general.push({ key, label: GENERAL_LABELS[key] });
        const out: GeneralJson = {
          guide: gid, key, label: GENERAL_LABELS[key], howto: t.howto,
          links: links(`content/guides/${gid}/general.json`, t.links), files: docList(t.files), gaps: t.gaps.map(gap),
        };
        files.set(generalPath(gid, key), out);
        for (const d of t.files) docUnit(d);
        for (const id of t.gaps) gapUnit(id);
      }
      if (g.general.workup.length > 0) {
        const workup: WorkupJson = { guide: gid, items: g.general.workup.map((w) => ({ id: w.id, title: w.title, conds: w.conds, gap: gap(w.gap) })) };
        files.set(workupPath(gid), workup);
        for (const w of g.general.workup) {
          units.push({ tab, title: collapse(w.title), loc: workupLoc(ix, gid), route: guideViewHash(gid, { kind: "workup", item: w.id }), at: null, label: "notes", text: searchText(`${w.title}\n${w.conds}`) });
          gapUnit(w.gap);
        }
      }
      for (const v of g.general.visits ?? []) {
        const route = guideViewHash(gid, { kind: "visits", item: v.id });
        units.push({ tab, title: collapse(v.title), loc: generalLoc(ix, gid, "visits"), route, at: null, label: "notes", text: searchText(v.title) });
        for (const id of v.gaps) gapUnit(id);
      }
      if (g.general.visits?.length) {
        const out: VisitsJson = {
          guide: gid,
          items: g.general.visits.map((v) => ({ id: v.id, title: v.title, links: links(`content/guides/${gid}/general.json`, v.links), gaps: v.gaps.map(gap) })),
        };
        files.set(visitsPath(gid), out);
      }
    }
    const visitsNav: NavJson["visits"] = (g.general?.visits ?? []).map((v) => ({ id: v.id, title: v.title }));

    // slides
    let slidesNav: NavJson["slides"] = null;
    const removed: NavJson["removed"] = [];
    const pending: NavJson["pending"] = [];
    const deck = c.decks.get(gid);
    if (deck) {
      const own = deck.file.kind === "own" && deck.file.file !== null;
      if (own) {
        const list = docList([deck.file.file as string]);
        removed.push(...list.removed);
        pending.push(...list.pending);
      }
      if (deckShown(deck)) {
        const title = own ? (c.docs.get(deck.file.file as string)?.file.name ?? deck.file.title) : deck.file.title;
        slidesNav = { title };
        usedBlocks(deck.slides);
        const out: SlidesJson = {
          guide: gid, kind: deck.file.kind, title, file: deck.file.file,
          slides: deck.slides.map((sl) => ({
            id: sl.id, doc: sl.doc,
            summarizes: (sl.meta.summarizes ?? []).flatMap((r) => {
              const rs = rowSys.get(r);
              const host = hosts[r];
              if (!rs || !host) {
                dropped.push({ file: `content/slides/${gid}/blocks/${sl.id}.json`, id: r });
                return [];
              }
              const topic = rs.topics.rows.get(r)?.topic ?? null;
              return [{ id: r, title: rs.topics.topics.find((x) => x.id === topic)?.title ?? "", route: host.route }];
            }),
            ownerEdits: sl.meta.ownerEdits ?? [],
          })),
        };
        files.set(slidesPath(gid), out);
        deck.slides.forEach((sl, i) => {
          const heading = (sl.doc.content as PMNode[]).find((n) => n.type === "heading_line");
          units.push({
            tab, title: collapse(heading ? nodeText(heading) : ""), loc: slidesLoc(ix, gid), route: guideViewHash(gid, { kind: "slides", n: i + 1 }),
            at: sl.id, label: "slides", text: searchText(docText(sl.doc)),
          });
        });
      }
    }

    // PANCE sidebar end
    let sidebarEnd: NavJson["sidebarEnd"] = null;
    if (g.file.sidebarEnd) {
      const list = docList([g.file.sidebarEnd]);
      sidebarEnd = list.files[0] ?? null;
      removed.push(...list.removed);
      pending.push(...list.pending);
      docUnit(g.file.sidebarEnd);
    }

    const nav: NavJson = {
      guide: gid, title: c.site.guideNames[gid], source: g.file.source, page: g.file.page, basePt: g.file.basePt,
      systems: navSystems, general, visits: visitsNav, slides: slidesNav, sidebarEnd, removed, pending,
    };
    files.set(navPath(gid), nav);
  }
  for (const [topic, list] of topicParts) {
    const first = list[0];
    if (first && !publishedTopicIds.has(topic)) throw new BuildError(first.part.id, `pharm part is attached to topic ${topic}, which no guide has`);
  }

  function systemPages(s: Sys): NavJson["systems"][number] {
    const gid = s.guide.file.id as GuideId;
    const sys = s.data.file.id;
    const st = s.data.structure;
    const t = s.topics;
    const tab = tabOf(s.guide);
    const summary = s.guide.file.systems.find((x) => x.id === sys);
    const blockOrder = s.data.blocks.map((b) => b.id);
    usedBlocks(s.data.blocks);

    const panelSections: SystemJson["panelSections"] = {};
    for (const section of st.drugTables.length > 0 ? (st.sections.length > 0 ? st.sections.map((x) => x.id) : [null]) : []) {
      panelSections[conditionKey(section)] = [...(panels.get(sectionKey(gid, sys, conditionKey(section))) ?? [])];
    }
    const relevantTo = (topic: { section: string | null }): ReadonlySet<string> => new Set(panelSections[conditionKey(topic.section)] ?? []);
    const home = (card: string, prefer?: ReadonlySet<string>): ReturnType<typeof panelHome> =>
      panelHome((cardPlaces.get(card) ?? []).map((p) => ({ guide: g0(p.s), system: p.s.data.file.id, section: p.section })), gid, sys, prefer);
    const sectionsOf = (card: string): ReadonlySet<string> => new Set((cardPlaces.get(card) ?? []).map((p) => p.section));
    // Her pharm-notes parts attached to a topic follow the cards its notes name; a part with nothing left to show is left off.
    const attached = (topic: { id: string }): PubMedsPart[] =>
      (topicParts.get(topic.id) ?? [])
        .filter(({ part }) => !columnGone.has(part.id) && pubPartOf(part).blocks.length > 0)
        .map(({ part }) => ({ card: null, part: part.id, title: part.title, rows: [], section: null, system: null, target: part.id }));
    // Her own panel for a topic: a card she added shows as it would where the panel finds it.
    const addedCard = (topic: Topic, id: string): PubMedsClass | null => {
      const at = c.cards.cards.some((x) => x.id === id) ? home(id, relevantTo(topic)) : null;
      return at ? { card: id, title: cardTitle(id), rows: [], section: at.section, system: at.system, target: id } : null;
    };
    const medsEdit = (topic: Topic, derived: PubMedsCard[]): PubMedsEdit | null => {
      const file = s.data.meds.get(topic.id);
      if (!file) return null;
      const where = topicMedsPath(gid, sys, topic.id);
      return publishedEdit(file, derived, (id) => addedCard(topic, id), (id) => dropped.push({ file: where, id }), (id) => (c.gaps.has(id) ? gap(id) : null));
    };
    const topics: PubTopic[] = publishedTopics(t, (topic) => [...medsPanel(s.pharm, blockOrder, topic, matcher, cardTitle, relevantTo(topic), home, sectionsOf), ...attached(topic)], medsEdit, s.data.below);
    for (const id of s.data.meds.keys()) {
      if (!topics.some((x) => x.id === id)) dropped.push({ file: topicMedsPath(gid, sys, id), id });
    }
    for (const topic of topics) publishedTopicIds.add(topic.id);
    usedBlocks(topics.flatMap((x) => (x.below ? [x.below] : [])));

    // section pages
    const sections = publishedSections(t, st, blockOrder);

    // stubs
    const stubs: SystemJson["stubs"] = {};
    for (const d of st.drugTables) {
      const table = t.tables.get(d.block);
      if (table) stubs[d.block] = { label: stubLabel(table), section: d.pharmSection };
    }

    // pharm
    const cards: Record<string, PubCard> = {};
    const partsOut: Record<string, PubPart> = {};
    const notesBlocks: Record<string, PubBlock> = {};
    const useCard = (card: string): void => {
      if (cards[card]) return;
      const ps = cardParts(card);
      const file = c.pharm.find((p) => p.file.id === c.cards.cards.find((x) => x.id === card)?.file) ?? ps[0]?.file;
      const pubParts = ps.map((p) => ({ id: p.part.id, ...pubPartOf(p.part), file: p.file.file.fileName, basePt: p.file.file.basePt, ...(p.for ? { for: p.for } : {}), ...(p.part.diseases ? { diseases: p.part.diseases } : {}) }));
      const blocks = pubParts.flatMap((p) => p.blocks);
      cards[card] = { title: cardTitle(card), file: file?.file.fileName ?? "", basePt: file?.file.basePt ?? 0, blocks, parts: pubParts };
      for (const id of blocks) {
        const b = pharmBlocks.get(id);
        if (b) notesBlocks[id] = pub(b);
      }
    };
    const usePart = (id: string | null): void => {
      const p = id === null ? undefined : parts.get(id);
      if (!p || id === null || (p.part.role !== "overview" && p.part.role !== "lo")) return;
      partsOut[id] = { title: p.part.title, role: p.part.role, file: p.file.file.fileName, basePt: p.file.file.basePt, ...pubPartOf(p.part) };
      for (const b of p.part.blocks) {
        const block = pharmBlocks.get(b);
        if (block) notesBlocks[b] = pub(block);
      }
    };
    const useTopicPart = (id: string): void => {
      const p = parts.get(id);
      if (!p || partsOut[id]) return;
      const out: PubPart = { title: p.part.title, role: "topic", file: p.file.file.fileName, basePt: p.file.file.basePt, ...pubPartOf(p.part) };
      partsOut[id] = out;
      for (const b of out.blocks) {
        const block = pharmBlocks.get(b);
        if (block) notesBlocks[b] = pub(block);
      }
    };
    for (const topic of topics) {
      // The cards she added, and every derived entry: one she removed stays published so she can put it back while editing.
      for (const m of [...topic.meds, ...(topic.medsEdit?.add ?? [])]) {
        if (m.part !== undefined) useTopicPart(m.part);
        else if (m.card) useCard(m.card);
      }
    }
    let pharm: SystemJson["pharm"] = null;
    if (hasPharm(s.pharm, placements)) {
      const pharmSections: PubPharmSection[] = st.pharmSections.map((ps) => {
        const placed = placements.get(sectionKey(gid, sys, ps.id));
        const list = sectionCards(placed);
        list.forEach(useCard);
        usePart(ps.overview);
        usePart(ps.lo);
        const treats = topics.filter((tp) => tp.meds.some((m) => m.rows.some((r) => ps.tables.includes(t.rows.get(r)?.block ?? "")))).map((tp) => tp.id);
        return { id: ps.id, title: ps.title, tables: ps.tables, cards: list, alsoFrom: placed?.tableCards.length ?? 0, overview: ps.overview, lo: ps.lo, treats };
      });
      pharm = { sections: pharmSections, files: docList(st.pharmFiles) };
    }
    usedBlocks(Object.values(notesBlocks));

    // Judged lines of this page's cards, with the covering rows that are on this page.
    const trims: SystemJson["trims"] = {};
    const cardBlocks = new Set(Object.values(cards).flatMap((x) => x.blocks));
    for (const l of c.trims.lines) {
      if (!cardBlocks.has(l.block)) continue;
      const rows = l.rows.filter((r) => t.rows.has(r)).map((r) => ({ id: r, text: c.trims.rows[r] ?? "" }));
      if (!l.label && rows.length === 0) continue;
      (trims[l.block] ??= []).push({ text: l.text, label: l.label, rows });
    }
    const uses: SystemJson["uses"] = {};
    for (const l of c.uses.lines) if (cardBlocks.has(l.block)) (uses[l.block] ??= []).push({ text: l.text, for: l.for });

    const pageIds = [...blockOrder, ...t.rows.keys()];
    const out: SystemJson = {
      guide: gid, id: sys, title: summary?.title ?? sys, pct: summary?.pct ?? "",
      blocks: s.data.blocks.map(pub),
      ...publishedRows(t),
      topics, stubs, sections, pharm, panelSections, cards, parts: partsOut, notesBlocks, trims, uses, notes: notesFor(pageIds),
    };
    files.set(systemPath(gid, sys), out);

    // search units: block/row order, then pharm units, then pharm files
    for (const b of s.data.blocks) {
      if (t.proseBlocks.includes(b.id)) {
        const sec = st.sections.length > 0 ? blockSection(st, b.id) : null;
        const head = listedHead(st, b.id);
        const title = st.listed[head ?? b.id] ?? firstLine(b);
        const loc = systemLoc(ix, gid, sys, secTitle(s, sec));
        const route = hosts[b.id]?.route ?? sysRoute(s);
        if (head === null || head === b.id) {
          units.push({ tab, title, loc, route, at: b.id, label: "notes", text: searchText(docText(b.doc)) });
          continue;
        }
        // A table recorded into a listed run forms no topics, but each of its rows stays searchable
        // by its own name (its first cell), landing on that row of the run's page.
        const names = new Map((tableOf(b)?.rows ?? []).map((r) => [r.id, collapse(firstCell(r))]));
        const base: UnitBase = { tab, loc, route, label: "notes" };
        wordBlockUnits(base, title, b, (row) => ({ base, title: names.get(row) || title }));
        continue;
      }
      for (const r of t.tables.get(b.id)?.rows ?? []) {
        const info = t.rows.get(r.id);
        const topic = t.topics.find((x) => x.id === r.id);
        if (topic) {
          const below = s.data.below.get(topic.id);
          units.push({
            tab, title: topic.title, loc: systemLoc(ix, gid, sys, secTitle(s, topic.section)), route: topicRoute(s, topic.id),
            at: topic.id, label: "notes", text: searchText(below ? `${topicText(t, topic)}\n${docText(below.doc)}` : topicText(t, topic)),
          });
          // Her own version of a card under this condition is text of hers that only its page shows.
          const pub = topics.find((x) => x.id === topic.id);
          for (const e of pub ? panelEntries(pub) : []) {
            if (!e.own) continue;
            units.push({
              tab, title: e.med.title, loc: systemLoc(ix, gid, sys, secTitle(s, topic.section)), route: topicRoute(s, topic.id),
              at: `meds-${e.med.target}`, label: "notes", text: searchText(e.own.map((p) => docText(p.doc)).join("\n")),
            });
            if (e.gap) gapUnit(e.gap.id, `meds-${e.med.target}`);
          }
          for (const g of pub?.medsEdit?.gaps ?? []) gapUnit(g.id);
        } else if (info?.drug) {
          units.push({ tab, title: collapse(firstCell(r)), loc: pharmLoc(ix, gid, sys), route: hosts[r.id]?.route ?? "", at: r.id, label: "notes", text: searchText(r.cells.join("\n")) });
        } else if (info && (info.kind === "heading" || info.topic === null)) {
          // Heading rows and untitled rows belong to no topic unit, so each is its own unit, routed
          // to the page that shows it (Orchestrator ruling 2026-10-04 04:45Z, adding to 60 §60.1).
          const label = info.heading === null ? "" : collapse(t.headings.get(info.heading)?.label ?? "");
          const host = hosts[r.id];
          units.push({
            tab, title: label || st.listed[b.id] || (summary?.title ?? sys), loc: host?.loc ?? systemLoc(ix, gid, sys), route: host?.route ?? sysRoute(s),
            at: r.id, label: "notes", text: searchText(r.cells.join("\n")),
          });
        }
      }
    }
    for (const ps of st.pharmSections) {
      const here = (id: string): boolean => {
        const h = pharmHome.get(id);
        return h?.s === s && h.section === ps.id;
      };
      for (const p of [ps.overview, ps.lo]) {
        const part = p === null ? undefined : parts.get(p);
        if (!part || p === null || !here(p)) continue;
        units.push({
          tab, title: part.part.role === "overview" ? "Overview" : "Learning objectives", loc: pharmLoc(ix, gid, sys), route: hosts[p]?.route ?? "",
          at: p, label: "notes", text: searchText(partText(part.part)),
        });
      }
      // Each card part is one unit, at its home: the first section using its card where it shows.
      for (const card of sectionCards(placements.get(sectionKey(gid, sys, ps.id)))) {
        for (const p of cardParts(card)) {
          const h = partHome.get(p.part.id);
          if (h?.s !== s || h.section !== ps.id) continue;
          units.push({
            tab, title: collapse(p.part.title), loc: pharmLoc(ix, gid, sys), route: hosts[p.part.id]?.route ?? "",
            at: p.part.id, label: "notes", text: searchText(partText(p.part)),
          });
        }
      }
    }
    for (const d of st.pharmFiles) docUnit(d);

    return {
      id: sys, title: summary?.title ?? sys, pct: summary?.pct ?? "",
      ...navEntries(t, st, blockOrder),
      pharm: hasPharm(s.pharm, placements) ? { sections: st.pharmSections.map((ps) => ({ id: ps.id, title: ps.title })) } : null,
    };
  }

  // ---- reference tabs and Other ---------------------------------------------------------------
  for (const tab of REF_TABS) {
    const rt = c.reftabs[tab];
    const out: RefTabJson = {
      tab, label: TAB_LABELS[tab],
      subs: rt.subs.map((sub) => ({
        id: sub.id, title: sub.title, group: sub.group ?? null, intro: sub.intro ?? null, notes: placeNoteList("content/places/reftabs.json", sub.notes), links: links("content/places/reftabs.json", sub.links), gaps: sub.gaps.map(gap),
      })),
      files: docList(rt.files),
    };
    files.set(refPath(tab), out);
    for (const sub of rt.subs) {
      noteUnitsOf(sub.notes);
      for (const id of sub.gaps) gapUnit(id);
    }
    for (const d of rt.files) docUnit(d);
  }
  /** An Other section's outline. Headings get part slugs unique in the section; hidden items are left out (shownItems). */
  const otherNotes = (sec: OtherFile["sections"][number], secLinks: readonly PubLink[], docs: DocList): PubOtherNote[] => {
    const parts = outlineParts(sec);
    const shown = placeShown(docs);
    const out: PubOtherNote[] = [];
    for (const [i, n] of (sec.notes ?? []).entries()) {
      if ("heading" in n) {
        out.push({ heading: n.heading, sub: n.sub === true, id: parts[i] ?? "" });
      } else if ("block" in n) {
        for (const p of placeNoteList("content/places/other.json", [n], shown)) if ("block" in p) out.push(p);
      } else if ("doc" in n) {
        const d = shown.doc(n.doc);
        if (d) out.push({ doc: d });
      } else if ("original" in n) {
        const d = shown.doc(n.original);
        if (d) out.push({ original: d });
      } else if ("gap" in n) {
        out.push({ gap: gap(n.gap) });
      } else {
        const l = secLinks.find((x) => x.target === n.link);
        if (l) out.push({ link: l });
      }
    }
    return out;
  };
  const other: OtherJson = {
    sections: c.other.sections.map((sec) => {
      const secLinks = links("content/places/other.json", sec.links);
      const docs = docList(sec.files);
      return {
        id: sec.id, title: sec.title, lead: sec.lead ? gap(sec.lead) : null, notes: otherNotes(sec, secLinks, docs), links: secLinks, files: docs,
        ...(sec.gaps ? { gaps: sec.gaps.map(gap) } : {}),
      };
    }),
  };
  files.set(OTHER_PATH, other);
  for (const sec of c.other.sections) {
    if (sec.lead) gapUnit(sec.lead);
    noteUnitsOf(otherShown(sec).map((s) => s.note));
    for (const d of sec.files) docUnit(d);
    for (const id of sec.gaps ?? []) gapUnit(id);
    if (sec.id === "guidelines") {
      for (const f of c.flags.flags) {
        units.push({ tab: "other", title: collapse(f.guideline), loc: UPDATES_LOC, route: UPDATES_ROUTE, at: f.id, label: "update", text: searchText([f.guideline, f.org, f.quote ?? ""].join("\n")) });
      }
    }
  }

  // ---- documents ---------------------------------------------------------------------------------
  for (const [id, d] of c.docs) {
    if (!visible(d)) continue;
    const homeRoute = docHome.get(id)?.from;
    const extra = { ...(homeRoute ? { home: homeRoute } : {}), ...(d.file.replaceFailed ? { replaceFailed: d.file.replaceFailed } : {}) };
    if (d.kind === "word") {
      usedBlocks(d.blocks);
      const out: DocJson = {
        id, name: d.file.name, kind: "word", basePt: d.file.basePt, page: d.file.page, blocks: d.blocks.map(pub), notes: notesFor([id, ...d.blocks.map((b) => b.id)]), ...extra,
      };
      files.set(docPath(id), out);
    } else {
      const f = d.file;
      const names = [f.original, ...(f.view && f.view !== f.original ? [f.view] : [])];
      for (const name of names) stored.push({ doc: id, name });
      const out: DocJson = {
        id, name: f.name, kind: f.kind, original: `files/${id}/${f.original}`, view: f.view === null ? null : `files/${id}/${f.view}`,
        pages: f.pages ?? null, notes: notesFor([id]), ...extra,
      };
      files.set(docPath(id), out);
    }
  }

  // ---- updates ---------------------------------------------------------------------------------
  const series = new Map<string, { id: string; label: string; org: string }>();
  for (const g of c.gaps.values()) {
    for (const src of g.block.meta.sources) {
      if (src.track && src.track.method !== "fixed") series.set(src.track.series, { id: citeKey(src.track.series), label: src.track.label, org: src.track.org });
    }
  }
  const placedAt = new Map<string, string[]>();
  for (const [target, fs] of placedFlags) for (const f of fs) placedAt.set(f.id, [...(placedAt.get(f.id) ?? []), target]);
  const pubFlag = (f: Flag): PubFlag => {
    const addedTo: Place[] = [];
    for (const target of placedAt.get(f.id) ?? []) {
      const h = hosts[target];
      if (h && !addedTo.some((p) => p.route === h.route && p.loc === h.loc)) addedTo.push(h);
    }
    return {
      id: f.id, kind: f.kind, source: f.source, key: f.key, subject: f.subject, guideline: f.guideline, org: f.org, published: f.published,
      quote: f.quote, grade: f.grade, url: f.url, flagged: f.flagged, supersededBy: f.supersededBy, addedTo,
    };
  };
  const updates: UpdatesJson = {
    lastRun: c.checks.lastRun,
    nextRun: c.checks.nextRun,
    sources: c.checks.sources,
    series: [...series.values()].sort((a, b) => a.label.localeCompare(b.label)),
    flags: [...c.flags.flags]
      .sort((a, b) => (a.published === b.published ? b.flagged.localeCompare(a.flagged) : b.published.localeCompare(a.published)))
      .map(pubFlag),
  };
  files.set(UPDATES_PATH, updates);
  for (const f of c.flags.flags) for (const s of [f.guideline, f.org, f.quote ?? ""]) for (const ch of s) codePoints.add(ch.codePointAt(0) ?? 0);

  files.set(SITE_PATH, site);
  files.set(HOSTS_PATH, hosts);
  return { files, units: units.map((u, ord) => ({ ...u, ord })), assets, stored, dropped, codePoints };
}

export { GENERAL_KEYS };
export type { GeneralKey };
