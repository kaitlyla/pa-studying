// The owner's GitHub calls for saving, versions and documents (plan 50): the retry rule of 50 §50.4
// Failures and the Git data API on `main` of `site.json.repo`.
import { githubFetch, type ApiInit } from "../auth/api.ts";

/** No connection, or GitHub kept failing: the offline banner (save-failed). */
export class NetworkError extends Error {
  constructor(message = "No connection to GitHub") {
    super(message);
    this.name = "NetworkError";
  }
}

/** GitHub answered with a status the caller did not expect. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Waits between attempts: 2 s, then 4 s (three attempts in all). Replaceable for tests. */
export const retry = {
  delaysMs: [2000, 4000],
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

async function isSecondaryRateLimit(res: Response): Promise<boolean> {
  if (res.status !== 403 && res.status !== 429) return false;
  if (res.headers.get("retry-after") !== null) return true;
  const text = await res.clone().text().catch(() => "");
  return /secondary rate limit/i.test(text);
}

/**
 * One API call with the 50 §50.4 failure rule: a rejected fetch, a 5xx or a secondary rate limit is
 * tried 3 times, 2 s and 4 s apart, then fails with NetworkError. A 401 is refreshed once inside
 * githubFetch; a sign-in that cannot be refreshed throws SignedOutError.
 */
export async function ghCall(path: string, init: ApiInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let retryable: boolean;
    let res: Response | null = null;
    try {
      res = await githubFetch(path, init);
      retryable = res.status >= 500 || (await isSecondaryRateLimit(res));
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      retryable = true;
    }
    if (!retryable && res) return res;
    const delay = retry.delaysMs[attempt];
    if (delay === undefined) throw new NetworkError();
    await retry.sleep(delay);
  }
}

async function expectJson<T>(res: Response, ok: number[], what: string): Promise<T> {
  if (!ok.includes(res.status)) throw new ApiError(res.status, `${what}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

/** A tree change for POST /git/trees: new text content, an existing blob, or a deletion (`sha: null`). */
export type TreeChange =
  | { path: string; content: string }
  | { path: string; sha: string }
  | { path: string; sha: null };

export interface CommitInfo {
  sha: string;
  message: string;
  /** Author date (ISO). */
  date: string;
  parents: string[];
}

export interface Identity {
  name: string;
  email: string;
}

/** At most `limit` of `tasks` running at once (6 for blob reads and commit lists, 50 §50.4/§50.6). */
export async function pool<T, R>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await task(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const RAW = "application/vnd.github.raw+json";

/** The Git data API of one repository (`owner/name`). */
export class Git {
  readonly repo: string;
  readonly base: string;

  constructor(repo: string) {
    this.repo = repo;
    this.base = `/repos/${repo}`;
  }

  /** `GET /git/ref/heads/<branch>` → the commit sha. */
  async ref(branch = "main"): Promise<string> {
    const res = await ghCall(`${this.base}/git/ref/heads/${branch}`);
    const body = await expectJson<{ object: { sha: string } }>(res, [200], `ref ${branch}`);
    return body.object.sha;
  }

  /** The tree sha of a commit (`GET /git/commits/<sha>`); a trees read echoes the commit sha instead. */
  async treeOf(commit: string): Promise<string> {
    const res = await ghCall(`${this.base}/git/commits/${commit}`);
    return (await expectJson<{ tree: { sha: string } }>(res, [200], `commit ${commit}`)).tree.sha;
  }

  /** Every blob of a commit's tree, by path (`GET /git/trees/<sha>?recursive=1`). */
  async files(commit: string): Promise<Map<string, string>> {
    const res = await ghCall(`${this.base}/git/trees/${commit}?recursive=1`);
    const body = await expectJson<{ truncated: boolean; tree: TreeEntry[] }>(res, [200], `tree ${commit}`);
    if (body.truncated) throw new ApiError(200, `tree ${commit}: truncated`);
    const out = new Map<string, string>();
    for (const e of body.tree) if (e.type === "blob") out.set(e.path, e.sha);
    return out;
  }

  async blobBytes(sha: string): Promise<Uint8Array> {
    const res = await ghCall(`${this.base}/git/blobs/${sha}`, { accept: RAW });
    if (res.status !== 200) throw new ApiError(res.status, `blob ${sha}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async blobText(sha: string): Promise<string> {
    return new TextDecoder().decode(await this.blobBytes(sha));
  }

  /** `POST /git/blobs`; UTF-8 text, or base64 for binary parts. */
  async createBlob(content: string, encoding: "utf-8" | "base64" = "utf-8"): Promise<string> {
    const res = await ghCall(`${this.base}/git/blobs`, { method: "POST", json: { content, encoding } });
    return (await expectJson<{ sha: string }>(res, [201], "create blob")).sha;
  }

  /** `POST /git/trees` (mode 100644 for every file); without `baseTree` the tree holds only `changes`. */
  async createTree(changes: readonly TreeChange[], baseTree?: string): Promise<string> {
    const tree = changes.map((c) => ({ path: c.path, mode: "100644", type: "blob", ...("content" in c ? { content: c.content } : { sha: c.sha }) }));
    const res = await ghCall(`${this.base}/git/trees`, { method: "POST", json: baseTree ? { base_tree: baseTree, tree } : { tree } });
    return (await expectJson<{ sha: string }>(res, [201], "create tree")).sha;
  }

  async createCommit(message: string, tree: string, parents: readonly string[], author?: Identity): Promise<string> {
    const json: Record<string, unknown> = { message, tree, parents };
    if (author) json.author = { name: author.name, email: author.email };
    const res = await ghCall(`${this.base}/git/commits`, { method: "POST", json });
    return (await expectJson<{ sha: string }>(res, [201], "create commit")).sha;
  }

  /**
   * `PATCH /git/refs/heads/<branch> {sha, force: false}`, sent once: any outcome other than 200 is
   * classified by the caller re-reading the ref (50 §50.4 step 4). Rejected fetches return null.
   */
  async moveRef(sha: string, branch = "main"): Promise<number | null> {
    try {
      const res = await githubFetch(`${this.base}/git/refs/heads/${branch}`, { method: "PATCH", json: { sha, force: false } });
      return res.status;
    } catch (e) {
      if (e instanceof TypeError) return null;
      throw e;
    }
  }

  async createRef(ref: string, sha: string): Promise<void> {
    const res = await ghCall(`${this.base}/git/refs`, { method: "POST", json: { ref, sha } });
    if (res.status !== 201) throw new ApiError(res.status, `create ${ref}: HTTP ${res.status}`);
  }

  /** `DELETE /git/refs/…` for a full ref name (`refs/heads/…`); a ref already gone (422) is fine. */
  async deleteRef(ref: string): Promise<void> {
    const res = await ghCall(`${this.base}/git/${ref}`, { method: "DELETE" });
    if (res.status !== 204 && res.status !== 422) throw new ApiError(res.status, `delete ${ref}: HTTP ${res.status}`);
  }

  /** `GET /git/matching-refs/<prefix>` (e.g. `heads/inbox/`) → full ref names and their commit shas. */
  async matchingRefs(prefix: string): Promise<{ ref: string; sha: string }[]> {
    const res = await ghCall(`${this.base}/git/matching-refs/${prefix}`);
    const body = await expectJson<{ ref: string; object: { sha: string } }[]>(res, [200], `refs ${prefix}`);
    return body.map((r) => ({ ref: r.ref, sha: r.object.sha }));
  }

  /** A commit's author date. */
  async commitDate(sha: string): Promise<string> {
    const res = await ghCall(`${this.base}/git/commits/${sha}`);
    return (await expectJson<{ author: { date: string } }>(res, [200], `commit ${sha}`)).author.date;
  }

  /** `GET /commits?sha=main&path=<path>&per_page=<n>&page=<p>`, newest first. */
  async commits(path: string, opts: { perPage?: number; page?: number } = {}): Promise<CommitInfo[]> {
    const q = new URLSearchParams({ sha: "main", path, per_page: String(opts.perPage ?? 100) });
    if (opts.page !== undefined && opts.page > 1) q.set("page", String(opts.page));
    const res = await ghCall(`${this.base}/commits?${q.toString()}`);
    const body = await expectJson<{ sha: string; commit: { message: string; author: { date: string } }; parents: { sha: string }[] }[]>(
      res, [200], `commits ${path}`,
    );
    return body.map((c) => ({ sha: c.sha, message: c.commit.message, date: c.commit.author.date, parents: c.parents.map((p) => p.sha) }));
  }

  /** `GET /compare/<base>...<head>` → its status (identical, ahead, behind, diverged). */
  async compare(base: string, head: string): Promise<string> {
    const res = await ghCall(`${this.base}/compare/${base}...${head}`);
    return (await expectJson<{ status: string }>(res, [200], `compare ${base}...${head}`)).status;
  }

  async dispatch(workflow: string, inputs: Record<string, string>): Promise<void> {
    const res = await ghCall(`${this.base}/actions/workflows/${workflow}/dispatches`, { method: "POST", json: { ref: "main", inputs } });
    if (res.status !== 204) throw new ApiError(res.status, `dispatch ${workflow}: HTTP ${res.status}`);
  }
}
