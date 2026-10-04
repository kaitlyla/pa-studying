// HTTP access for the guideline check (80 §80.1, §80.2): Node fetch with the job's User-Agent,
// redirects followed and a 30 s timeout; NCBI E-utilities requests spaced at least 400 ms apart.

export const USER_AGENT = "PA-Studying-guideline-check (+https://kaitlyla.github.io/pa-studying/)";
export const FETCH_TIMEOUT_MS = 30_000;
export const EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
export const EUTILS_TOOL = "pa-studying-guideline-check";
export const EUTILS_SPACING_MS = 400;

/** The outside world the job touches: the network and the clock. */
export interface Net {
  fetch: typeof fetch;
  /** Milliseconds, monotonic enough to space requests. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realNet: Net = {
  fetch: (input, init) => fetch(input, init),
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class Http {
  readonly net: Net;
  #lastEutils = Number.NEGATIVE_INFINITY;

  constructor(net: Net) {
    this.net = net;
  }

  /** GET `url`; throws on a network error, a timeout or a non-2xx status. */
  async get(url: string): Promise<Response> {
    const response = await this.net.fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
    return response;
  }

  async text(url: string): Promise<string> {
    return (await this.get(url)).text();
  }

  async json(url: string): Promise<unknown> {
    const body = await this.text(url);
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error(`GET ${url}: invalid JSON`);
    }
  }

  /** One E-utilities request (`esearch.fcgi`, `esummary.fcgi`), with the `tool` parameter. */
  async eutils(utility: string, params: Record<string, string>): Promise<unknown> {
    const wait = this.#lastEutils + EUTILS_SPACING_MS - this.net.now();
    if (wait > 0) await this.net.sleep(wait);
    const query = new URLSearchParams({ db: "pubmed", retmode: "json", ...params, tool: EUTILS_TOOL });
    try {
      return await this.json(`${EUTILS_BASE}/${utility}?${query.toString()}`);
    } finally {
      this.#lastEutils = this.net.now();
    }
  }
}
