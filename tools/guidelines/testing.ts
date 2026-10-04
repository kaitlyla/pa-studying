// Test doubles for the guideline job: a network whose responses are produced per URL, a clock that
// advances only through `sleep`, and builders for USPSTF and PubMed responses shaped as recorded in
// 80 §80.1.
import type { Net } from "./http.ts";
import { AB_HEADERS } from "./uspstf.ts";

export interface FakeNet {
  net: Net;
  /** Every fetched URL, in order. */
  requests: string[];
  /** The init of every fetch, in order. */
  inits: (RequestInit | undefined)[];
  /** Every sleep, in milliseconds. */
  sleeps: number[];
}

/** `route` answers a URL with a response; undefined means a network error. */
export function fakeNet(route: (url: URL) => Response | undefined): FakeNet {
  let clock = 1_000;
  const requests: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const sleeps: number[] = [];
  const net: Net = {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      requests.push(url.href);
      inits.push(init);
      const response = route(url);
      if (!response) throw new TypeError("fetch failed");
      return response;
    },
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  };
  return { net, requests, inits, sleeps };
}

export const html = (body: string, status = 200): Response => new Response(body, { status, headers: { "Content-Type": "text/html" } });
export const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
export const notFound = (): Response => html("Not found", 404);

export interface AbRow {
  subject: string;
  /** Inner HTML of the statement cell. */
  statement: string;
  grade: string;
  /** Inner HTML of the date cell. */
  date: string;
  href: string;
}

/** The A and B page: one table whose first row holds the header cells (inside tbody, as live). */
export function abPage(rows: readonly AbRow[], headers: readonly string[] = AB_HEADERS): string {
  const head = headers.map((h, i) => (i === 0 || i === 3 ? `<th scope="col"><a href='?SORT=${i}'>${h}</a></th>` : `<th>${h}</th>`)).join("\n");
  const body = rows.map((r) => `\t\t\t<tr>
\t\t\t<td><a href='${r.href}'>${r.subject}</a></td>
\t\t\t<td>${r.statement}</td>
     \t\t<td>${r.grade}</td>
\t\t\t<td>${r.date}</td>
\t\t</tr>`).join("\n");
  return `<!DOCTYPE html><html><head><title>A and B</title><script>var x = "<table>";</script></head><body>
<h1>USPSTF A and B Recommendations</h1>
<table>\n\t<tbody>\n\t\t<tr>${head}</tr>\n${body}\n\t</tbody>\n</table>
<table><tr><th>Other</th></tr></table>
</body></html>`;
}

export interface SummaryRow {
  population: string;
  recommendation: string;
  grade: string;
}

/** A recommendation page with a "Recommendation Summary" heading followed by its table. */
export function recommendationPage(rows: readonly SummaryRow[], date: string): string {
  const body = rows.map((r) => `<tr class='spec_recom'><td>${r.population}</td><td>${r.recommendation}</td> <td><span> ${r.grade}</span></td></tr>`).join("\n");
  return `<!DOCTYPE html><html><head><script>window.built = "January 1, 2019";</script><style>p::after { content: "February 2, 2018"; }</style></head><body>
<table><tr><td>Population</td><td>A navigation table before the heading</td><td>X</td></tr></table>
<p>Final Recommendation Statement</p><p>${date}</p>
<h3>Recommendation Summary</h3>
<div><table class="table"><thead><tr><th>Population</th><th>Recommendation</th><th><a href="/uspstf/grade-definitions">Grade</a></th></tr></thead>
<tbody>${body}</tbody></table></div>
<h3>Clinician Summary</h3><p>Updated March 3, 2025</p>
</body></html>`;
}

export interface PubmedFixture {
  pmid: number;
  title: string;
  pubdate: string;
  doi?: string;
}

/** Answers E-utilities requests: esearch by `term` (ids in the given order), esummary by id. */
export function pubmedRoute(byTerm: Record<string, readonly PubmedFixture[]>): (url: URL) => Response | undefined {
  const byId = new Map(Object.values(byTerm).flat().map((f) => [String(f.pmid), f]));
  return (url) => {
    if (url.pathname.endsWith("/esearch.fcgi")) {
      const items = byTerm[url.searchParams.get("term") ?? ""] ?? [];
      return json({ header: { type: "esearch" }, esearchresult: { count: String(items.length), idlist: items.map((i) => String(i.pmid)) } });
    }
    if (url.pathname.endsWith("/esummary.fcgi")) {
      const ids = (url.searchParams.get("id") ?? "").split(",");
      const result: Record<string, unknown> = { uids: ids };
      for (const id of ids) {
        const f = byId.get(id);
        if (!f) continue;
        result[id] = {
          uid: id, title: f.title, pubdate: f.pubdate, source: "Circulation",
          articleids: [{ idtype: "pubmed", value: id }, ...(f.doi ? [{ idtype: "doi", value: f.doi }] : [])],
        };
      }
      return json({ header: { type: "esummary" }, result });
    }
    return undefined;
  };
}
