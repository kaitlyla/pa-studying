// Test support for app/search: a small published search index served by a fake fetch, and an
// in-process stand-in for the search Worker that runs the real engine.
import { buildIndex, SHARD_SIZE, Vocab, type SearchUnit } from "../../lib/search/index.ts";
import type { VocabFile } from "../../lib/content/types.ts";
import type { WorkerLike } from "./client.ts";
import { serveEngine, type WorkerRequest, type WorkerResponse } from "./engine.ts";

export const BASE = "http://site.test/pa-studying/data/search/";

export const VOCAB: VocabFile = {
  v: 1,
  entries: [
    { abbr: ["MI"], meanings: ["myocardial infarction"] },
    { abbr: ["HTN"], meanings: ["hypertension"] },
  ],
};

/** Unit numbers of the named fixture units; every other unit up to SHARD_SIZE + 100 is imaging filler. */
export const U = { ie: 0, angina: 1, gap: 2, acs: 3, update: 4, troponin: 5, liP1: 6, liP2: 7, cushion: SHARD_SIZE + 50 } as const;

/** Imaging filler units: every unit number not in `U`. */
export const FILLER_COUNT = SHARD_SIZE + 100 - Object.keys(U).length;

function unit(tab: string, title: string, loc: string, route: string, at: string | null, label: SearchUnit["label"], text: string): Omit<SearchUnit, "ord"> {
  return { tab, title, loc, route, at, label, text };
}

/** Units in site order (`ord` equals the unit number, as the build emits them). */
export function fixtureUnits(): SearchUnit[] {
  const named = new Map<number, Omit<SearchUnit, "ord">>([
    [U.ie, unit("eor", "Infective endocarditis", "EOR › Family Medicine › Cardiovascular", "#/eor/fm/t/r_ie", "r_ie", "notes", "Fever and a new murmur. Duke criteria. Antibiotic prophylaxis before dental work.")],
    [U.angina, unit("eor", "Stable angina", "EOR › Family Medicine › Cardiovascular", "#/eor/fm/t/r_sa", "r_sa", "notes", "Chest pain with exertion; rule out MI. Nitrates first line. Endocarditis is not a cause.")],
    [U.gap, unit("eor", "Endocarditis prophylaxis", "EOR › Family Medicine › Guidelines", "#/eor/fm/general/guidelines", "g_ie", "gap", "AHA guidance limits prophylaxis to the highest-risk cardiac conditions.")],
    [U.acs, unit("pance", "Acute coronary syndrome", "PANCE › Cardiovascular", "#/pance/t/r_acs", "r_acs", "notes", "STEMI and NSTEMI: a myocardial infarction workup with serial troponin.")],
    [U.update, unit("other", "ACC/AHA heart failure guideline", "Other › Guidelines › Updated guidelines", "#/other/guidelines/updates", "f_hf", "update", "New edition published. Treat hypertension in heart failure.")],
    [U.troponin, unit("labs", "Troponin", "Labs", "#/labs/s_trop", "s_trop", "notes", "Rises in myocardial injury.")],
    // Two pages of one document: they share a route and differ only in `at`.
    [U.liP1, unit("other", "Lithium handout · p. 1", "Other › Physical exam", "#/file/d_li", "p1", "notes", "Lithium levels: draw 12 hours after the dose.")],
    [U.liP2, unit("other", "Lithium handout · p. 2", "Other › Physical exam", "#/file/d_li", "p2", "notes", "Lithium toxicity: tremor, ataxia, confusion.")],
    [U.cushion, unit("anatomy", "Endocardial cushion", "Anatomy", "#/anatomy/s_heart", "s_heart", "notes", "Embryology of the heart septa.")],
  ]);
  const out: SearchUnit[] = [];
  for (let n = 0; n < SHARD_SIZE + 100; n++) {
    const u = named.get(n) ?? unit("imaging", `Film ${n}`, "Imaging", `#/imaging/s_${n}`, null, "notes", `Plain radiograph series ${n}.`);
    out.push({ ...u, ord: n });
  }
  return out;
}

export interface FakeSite {
  fetch: typeof fetch;
  /** Every requested file name under BASE, in order. */
  requests: string[];
  /** Make requests for this file fail with HTTP 500 until cleared. */
  failing: Set<string>;
}

/** Serves `index.json`, `vocab.json` and `units-<k>.json` built from `units` with the real indexer. */
export function fakeSite(units: SearchUnit[] = fixtureUnits(), vocabFile: VocabFile = VOCAB): FakeSite {
  const files = new Map<string, string>();
  files.set("index.json", JSON.stringify(buildIndex(new Vocab(vocabFile.entries), units)));
  files.set("vocab.json", JSON.stringify(vocabFile));
  for (let k = 0; k * SHARD_SIZE < units.length; k++) {
    files.set(`units-${k}.json`, JSON.stringify(units.slice(k * SHARD_SIZE, (k + 1) * SHARD_SIZE)));
  }
  const requests: string[] = [];
  const failing = new Set<string>();
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(BASE)) return new Response("not found", { status: 404 });
    const name = url.slice(BASE.length);
    requests.push(name);
    const body = files.get(name);
    if (body === undefined || failing.has(name)) return new Response("error", { status: body === undefined ? 404 : 500 });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: fetcher, requests, failing };
}

/** A Worker stand-in: messages cross asynchronously, as they do between threads, into the real engine. */
export function inProcessWorker(fetcher: typeof fetch): WorkerLike {
  const page: WorkerLike = {
    onmessage: null,
    postMessage(message: WorkerRequest) {
      queueMicrotask(() => scope.onmessage?.({ data: message } as MessageEvent<WorkerRequest>));
    },
  };
  const scope = {
    onmessage: null as ((ev: MessageEvent<WorkerRequest>) => void) | null,
    postMessage(message: WorkerResponse) {
      queueMicrotask(() => page.onmessage?.({ data: message } as MessageEvent<WorkerResponse>));
    },
  };
  serveEngine(scope, fetcher);
  return page;
}
