// In-memory fake of the GitHub REST API (Git Data, commits, compare, Actions dispatch, user/repo)
// and of the site's token Worker, for unit tests (through fakeFetch) and Playwright e2e tests
// (through routeFakeGithub). Response shapes and error messages follow what the real API
// answered when checked; object ids are real git sha1s for blobs and deterministic for the rest.
import { createHash } from "node:crypto";
import type { Page, Route } from "@playwright/test";

export interface FakeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface FakeResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array | null;
}

export type Fault = { status: number; body?: unknown } | "network";

export interface FakePerson {
  name: string;
  email: string;
  date: string;
}

export interface FakeCommit {
  tree: string;
  parents: string[];
  message: string;
  author: FakePerson;
  committer: FakePerson;
}

export interface FakeGithubOptions {
  owner?: string;
  repo?: string;
  user?: { login: string; id: number; avatar_url: string };
  push?: boolean;
  workerOrigin?: string;
  maxBlobBytes?: number;
  requireAuth?: boolean;
}

interface Entry {
  name: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
}

type PathOp =
  | { kind: "blob"; sha: string; mode: string }
  | { kind: "tree"; sha: string }
  | { kind: "delete" };

interface QueuedFault {
  match: (r: FakeRequest) => boolean;
  fault: Fault;
  remaining: number;
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "*",
};
const JSON_TYPE = "application/json; charset=utf-8";
const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const DEFAULT_AUTHOR = { name: "kaitlyla", email: "337482200+kaitlyla@users.noreply.github.com" };
const TREE_MODE = "040000";
const BLOB_MODE = "100644";
const TRANSPARENT_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";

function sha1(data: string | Uint8Array): string {
  return createHash("sha1").update(data).digest("hex");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function secondPrecision(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function splitPath(path: string): string[] {
  return path.split("/").filter((s) => s !== "");
}

function byName(a: Entry, b: Entry): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function json(status: number, data: unknown): FakeResponse {
  return { status, headers: { ...CORS, "content-type": JSON_TYPE }, body: JSON.stringify(data) };
}

function noContent(): FakeResponse {
  return { status: 204, headers: { ...CORS }, body: null };
}

function notFound(): FakeResponse {
  return json(404, { message: "Not Found" });
}

function base64Lines(bytes: Uint8Array): string {
  const b64 = Buffer.from(bytes).toString("base64");
  let out = "";
  for (let i = 0; i < b64.length; i += 60) out += b64.slice(i, i + 60) + "\n";
  return out;
}

export class FakeGithub {
  owner: string;
  repo: string;
  user: { login: string; id: number; avatar_url: string };
  push: boolean;
  workerOrigin: string;
  maxBlobBytes: number;
  requireAuth: boolean;
  now: () => Date = () => new Date();

  requests: FakeRequest[] = [];
  dispatches: { workflow: string; ref: string; inputs: Record<string, unknown> }[] = [];
  onRequest?: (r: FakeRequest) => void;

  validTokens: Set<string> = new Set(["test-token"]);
  refreshTokens: Map<string, string> = new Map();
  revoked: string[] = [];
  tokenRequests: { code: string; code_verifier: string }[] = [];

  private blobs = new Map<string, Uint8Array>();
  private trees = new Map<string, Entry[]>();
  private commits = new Map<string, FakeCommit>();
  private refs = new Map<string, string>();
  private faults: QueuedFault[] = [];
  private commitCounter = 0;
  private tokenCounter = 0;
  private generations = new Map<string, number>();

  constructor(opts: FakeGithubOptions = {}) {
    this.owner = opts.owner ?? "kaitlyla";
    this.repo = opts.repo ?? "pa-studying";
    this.user = opts.user ?? {
      login: "kaitlyla",
      id: 337482200,
      avatar_url: "https://avatars.githubusercontent.com/u/337482200",
    };
    this.push = opts.push ?? true;
    this.workerOrigin = opts.workerOrigin ?? "https://pa-studying-auth.kaitlyla.workers.dev";
    this.maxBlobBytes = opts.maxBlobBytes ?? 40 * 1024 * 1024;
    this.requireAuth = opts.requireAuth ?? true;

    const date = "2026-01-01T00:00:00Z";
    const initial = this.createCommit({
      tree: this.putTree([]),
      parents: [],
      message: "Initial",
      author: { ...DEFAULT_AUTHOR, date },
      committer: { ...DEFAULT_AUTHOR, date },
    });
    this.refs.set("refs/heads/main", initial);
  }

  // ---- object store ----

  private putBlob(bytes: Uint8Array): string {
    const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
    const full = new Uint8Array(header.byteLength + bytes.byteLength);
    full.set(header, 0);
    full.set(bytes, header.byteLength);
    const sha = sha1(full);
    if (!this.blobs.has(sha)) this.blobs.set(sha, bytes.slice());
    return sha;
  }

  private putTree(entries: Entry[]): string {
    const sorted = [...entries].sort(byName);
    const sha = sha1("tree\0" + JSON.stringify(sorted));
    if (!this.trees.has(sha)) this.trees.set(sha, sorted);
    return sha;
  }

  private createCommit(c: FakeCommit): string {
    this.commitCounter += 1;
    const sha = sha1("commit\0" + JSON.stringify(c) + String(this.commitCounter));
    this.commits.set(sha, c);
    return sha;
  }

  /** Returns the new tree sha, or null when the resulting tree is empty. */
  private updatePath(treeSha: string | null, segs: string[], op: PathOp): string | null {
    const entries = treeSha === null ? [] : [...(this.trees.get(treeSha) ?? [])];
    const [name, ...rest] = segs;
    if (name === undefined) return treeSha;
    const idx = entries.findIndex((e) => e.name === name);
    const existing = idx >= 0 ? entries[idx] : undefined;
    let next: Entry | null = null;
    if (rest.length === 0) {
      if (op.kind === "blob") {
        next = { name, mode: op.mode, type: "blob", sha: op.sha };
      } else if (op.kind === "tree") {
        const sub = this.trees.get(op.sha);
        next = sub !== undefined && sub.length > 0 ? { name, mode: TREE_MODE, type: "tree", sha: op.sha } : null;
      }
    } else {
      const sub = existing?.type === "tree" ? existing.sha : null;
      const newSub = this.updatePath(sub, rest, op);
      next = newSub === null ? null : { name, mode: TREE_MODE, type: "tree", sha: newSub };
    }
    if (idx >= 0) entries.splice(idx, 1);
    if (next !== null) entries.push(next);
    return entries.length === 0 ? null : this.putTree(entries);
  }

  private applyOps(baseTree: string | null, ops: { path: string; op: PathOp }[]): string {
    let tree = baseTree;
    for (const { path, op } of ops) {
      const segs = splitPath(path);
      if (segs.length === 0) continue;
      tree = this.updatePath(tree, segs, op);
    }
    return tree ?? this.putTree([]);
  }

  private resolveCommit(x: string): string | undefined {
    if (this.commits.has(x)) return x;
    for (const name of [x, `refs/heads/${x}`, `refs/tags/${x}`, `refs/${x}`]) {
      const sha = this.refs.get(name);
      if (sha !== undefined) return sha;
    }
    return undefined;
  }

  private lookupEntry(treeSha: string, path: string): { type: "blob" | "tree"; sha: string } | undefined {
    const segs = splitPath(path);
    if (segs.length === 0) return { type: "tree", sha: treeSha };
    let current = treeSha;
    for (let i = 0; i < segs.length; i++) {
      const entry = this.trees.get(current)?.find((e) => e.name === segs[i]);
      if (entry === undefined) return undefined;
      if (i === segs.length - 1) return { type: entry.type, sha: entry.sha };
      if (entry.type !== "tree") return undefined;
      current = entry.sha;
    }
    return undefined;
  }

  private entryAt(path: string, at: string): { type: "blob" | "tree"; sha: string } | undefined {
    const commitSha = this.resolveCommit(at);
    const c = commitSha === undefined ? undefined : this.commits.get(commitSha);
    return c === undefined ? undefined : this.lookupEntry(c.tree, path);
  }

  private reachable(sha: string): Set<string> {
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length > 0) {
      const s = stack.pop();
      if (s === undefined || seen.has(s)) continue;
      seen.add(s);
      for (const p of this.commits.get(s)?.parents ?? []) stack.push(p);
    }
    return seen;
  }

  private generation(sha: string): number {
    const cached = this.generations.get(sha);
    if (cached !== undefined) return cached;
    const parents = this.commits.get(sha)?.parents ?? [];
    let gen = 0;
    for (const p of parents) gen = Math.max(gen, this.generation(p) + 1);
    this.generations.set(sha, gen);
    return gen;
  }

  private walkTree(treeSha: string, prefix: string, visit: (path: string, e: Entry) => void): void {
    for (const e of this.trees.get(treeSha) ?? []) {
      const path = prefix === "" ? e.name : `${prefix}/${e.name}`;
      visit(path, e);
      if (e.type === "tree") this.walkTree(e.sha, path, visit);
    }
  }

  // ---- public helpers for tests ----

  commitFiles(
    changes: Record<string, string | Uint8Array | null>,
    opts: { message?: string; date?: string; ref?: string; author?: { name: string; email: string } } = {},
  ): string {
    const ref = opts.ref ?? "refs/heads/main";
    const parent = this.refs.get(ref);
    const base = parent === undefined ? null : (this.commits.get(parent)?.tree ?? null);
    const ops: { path: string; op: PathOp }[] = Object.entries(changes).map(([path, content]) => {
      if (content === null) return { path, op: { kind: "delete" } };
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      return { path, op: { kind: "blob", sha: this.putBlob(bytes), mode: BLOB_MODE } };
    });
    const date = opts.date ?? secondPrecision(this.now());
    const author = { ...(opts.author ?? DEFAULT_AUTHOR), date };
    const sha = this.createCommit({
      tree: this.applyOps(base, ops),
      parents: parent === undefined ? [] : [parent],
      message: opts.message ?? "seed",
      author,
      committer: { ...author },
    });
    this.refs.set(ref, sha);
    return sha;
  }

  head(ref = "refs/heads/main"): string {
    const sha = this.refs.get(ref);
    if (sha === undefined) throw new Error(`FakeGithub: no ref ${ref}`);
    return sha;
  }

  setRef(ref: string, sha: string): void {
    this.refs.set(ref, sha);
  }

  hasRef(ref: string): boolean {
    return this.refs.has(ref);
  }

  readBytes(path: string, at = "refs/heads/main"): Uint8Array | undefined {
    const e = this.entryAt(path, at);
    return e?.type === "blob" ? this.blobs.get(e.sha) : undefined;
  }

  readFile(path: string, at = "refs/heads/main"): string | undefined {
    const bytes = this.readBytes(path, at);
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  }

  fileSha(path: string, at = "refs/heads/main"): string | undefined {
    const e = this.entryAt(path, at);
    return e?.type === "blob" ? e.sha : undefined;
  }

  listFiles(at = "refs/heads/main"): Map<string, string> {
    const out = new Map<string, string>();
    const commitSha = this.resolveCommit(at);
    const c = commitSha === undefined ? undefined : this.commits.get(commitSha);
    if (c === undefined) return out;
    this.walkTree(c.tree, "", (path, e) => {
      if (e.type === "blob") out.set(path, e.sha);
    });
    return out;
  }

  commit(sha: string): FakeCommit | undefined {
    return this.commits.get(sha);
  }

  log(ref = "refs/heads/main"): string[] {
    const out: string[] = [];
    let sha = this.resolveCommit(ref);
    while (sha !== undefined) {
      out.push(sha);
      sha = this.commits.get(sha)?.parents[0];
    }
    return out;
  }

  writes(): FakeRequest[] {
    return this.requests.filter((r) => WRITE_METHODS.has(r.method) && new URL(r.url).hostname === "api.github.com");
  }

  fail(match: (r: FakeRequest) => boolean, fault: Fault, times = 1): void {
    this.faults.push({ match, fault, remaining: times });
  }

  issueTokens(): { access_token: string; refresh_token: string } {
    this.tokenCounter += 1;
    const access_token = `ghu_${this.tokenCounter}`;
    const refresh_token = `ghr_${this.tokenCounter}`;
    this.validTokens.add(access_token);
    this.refreshTokens.set(refresh_token, access_token);
    return { access_token, refresh_token };
  }

  // ---- request handling ----

  async handle(req: FakeRequest): Promise<FakeResponse> {
    const fault = this.faults.find((f) => f.remaining > 0 && f.match(req));
    if (fault !== undefined) {
      fault.remaining -= 1;
      if (fault.fault === "network") throw new TypeError("Failed to fetch");
      return json(fault.fault.status, fault.fault.body ?? { message: "injected" });
    }
    this.requests.push(req);
    this.onRequest?.(req);

    if (req.method.toUpperCase() === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
          "access-control-allow-headers": "*",
          "access-control-max-age": "86400",
          "access-control-expose-headers": "*",
        },
        body: null,
      };
    }
    if (req.url.startsWith(this.workerOrigin)) return this.handleWorker(req);
    const url = new URL(req.url);
    if (url.hostname === "api.github.com") return this.handleApi(req, url);
    return notFound();
  }

  private parseBody(req: FakeRequest): { ok: true; body: Record<string, unknown> } | { ok: false; res: FakeResponse } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(req.body ?? "");
    } catch {
      return { ok: false, res: json(400, { message: "Problems parsing JSON" }) };
    }
    if (!isRecord(parsed)) return { ok: false, res: json(422, { message: "Invalid request." }) };
    return { ok: true, body: parsed };
  }

  private tokenResponse(): FakeResponse {
    const { access_token, refresh_token } = this.issueTokens();
    return json(200, { access_token, expires_in: 28800, refresh_token, refresh_token_expires_in: 15897600 });
  }

  private handleWorker(req: FakeRequest): FakeResponse {
    if (req.method.toUpperCase() !== "POST") return notFound();
    const path = new URL(req.url).pathname;
    if (path !== "/token" && path !== "/refresh" && path !== "/revoke") return notFound();
    const parsed = this.parseBody(req);
    if (!parsed.ok) return parsed.res;
    const body = parsed.body;

    if (path === "/token") {
      const code = typeof body.code === "string" ? body.code : "";
      const verifier = typeof body.code_verifier === "string" ? body.code_verifier : "";
      this.tokenRequests.push({ code, code_verifier: verifier });
      if (code === "bad") return json(400, { error: "bad_verification_code" });
      return this.tokenResponse();
    }
    if (path === "/refresh") {
      const rt = body.refresh_token;
      const access = typeof rt === "string" ? this.refreshTokens.get(rt) : undefined;
      if (typeof rt !== "string" || access === undefined) return json(400, { error: "bad_refresh_token" });
      this.refreshTokens.delete(rt);
      this.validTokens.delete(access);
      return this.tokenResponse();
    }
    const at = typeof body.access_token === "string" ? body.access_token : "";
    this.revoked.push(at);
    this.validTokens.delete(at);
    return noContent();
  }

  private refJson(ref: string, sha: string): { ref: string; object: { sha: string; type: "commit" } } {
    return { ref, object: { sha, type: "commit" } };
  }

  private commitJson(sha: string, c: FakeCommit): unknown {
    return {
      sha,
      tree: { sha: c.tree },
      parents: c.parents.map((p) => ({ sha: p })),
      message: c.message,
      author: c.author,
      committer: c.committer,
    };
  }

  private handleApi(req: FakeRequest, url: URL): FakeResponse {
    if (this.requireAuth) {
      const auth = req.headers["authorization"] ?? "";
      const m = /^Bearer (.+)$/.exec(auth);
      if (m === null || m[1] === undefined || !this.validTokens.has(m[1])) {
        return json(401, { message: "Bad credentials" });
      }
    }
    const method = req.method.toUpperCase();
    const segs = url.pathname.split("/").filter((s) => s !== "").map((s) => decodeURIComponent(s));

    if (method === "GET" && segs.length === 1 && segs[0] === "user") return json(200, this.user);
    if (segs[0] !== "repos" || segs[1] !== this.owner || segs[2] !== this.repo) return notFound();
    const rest = segs.slice(3);

    let body: Record<string, unknown> = {};
    if (method === "POST" || method === "PATCH") {
      const parsed = this.parseBody(req);
      if (!parsed.ok) return parsed.res;
      body = parsed.body;
    }

    if (rest.length === 0) {
      if (method !== "GET") return notFound();
      return json(200, {
        id: 1,
        full_name: `${this.owner}/${this.repo}`,
        permissions: { admin: true, push: this.push, pull: true },
      });
    }

    const [a, b, c] = rest;
    if (a === "git") {
      if (method === "GET" && b === "ref" && rest.length > 2) return this.getRef(rest.slice(2).join("/"));
      if (method === "GET" && b === "matching-refs") return this.matchingRefs(rest.slice(2).join("/"));
      if (b === "refs") {
        if (method === "POST" && rest.length === 2) return this.createRef(body);
        if (method === "PATCH" && rest.length > 2) return this.updateRef(`refs/${rest.slice(2).join("/")}`, body);
        if (method === "DELETE" && rest.length > 2) return this.deleteRef(`refs/${rest.slice(2).join("/")}`);
      }
      if (b === "trees") {
        if (method === "GET" && c !== undefined && rest.length === 3) return this.getTree(c, url.searchParams.has("recursive"));
        if (method === "POST" && rest.length === 2) return this.createTree(body);
      }
      if (b === "blobs") {
        if (method === "GET" && c !== undefined && rest.length === 3) return this.getBlob(c, req.headers["accept"] ?? "");
        if (method === "POST" && rest.length === 2) return this.createBlob(body);
      }
      if (b === "commits") {
        if (method === "POST" && rest.length === 2) return this.createCommitRoute(body);
        if (method === "GET" && c !== undefined && rest.length === 3) {
          const commit = this.commits.get(c);
          return commit === undefined ? notFound() : json(200, this.commitJson(c, commit));
        }
      }
      return notFound();
    }
    if (a === "commits" && rest.length === 1 && method === "GET") return this.listCommits(url.searchParams);
    if (a === "compare" && rest.length > 1 && method === "GET") return this.compare(rest.slice(1).join("/"));
    if (a === "actions" && b === "workflows" && c !== undefined && rest[3] === "dispatches" && rest.length === 4 && method === "POST") {
      if (typeof body.ref !== "string") return json(422, { message: "Invalid request." });
      this.dispatches.push({ workflow: c, ref: body.ref, inputs: isRecord(body.inputs) ? body.inputs : {} });
      return noContent();
    }
    return notFound();
  }

  private getRef(rest: string): FakeResponse {
    const ref = `refs/${rest}`;
    const sha = this.refs.get(ref);
    return sha === undefined ? notFound() : json(200, this.refJson(ref, sha));
  }

  private matchingRefs(prefix: string): FakeResponse {
    const full = `refs/${prefix}`;
    const out = [...this.refs.entries()]
      .filter(([ref]) => ref.startsWith(full))
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
      .map(([ref, sha]) => this.refJson(ref, sha));
    return json(200, out);
  }

  private createRef(body: Record<string, unknown>): FakeResponse {
    const { ref, sha } = body;
    if (typeof ref !== "string" || typeof sha !== "string" || !ref.startsWith("refs/")) {
      return json(422, { message: "Invalid request." });
    }
    if (this.refs.has(ref)) return json(422, { message: "Reference already exists" });
    if (!this.commits.has(sha)) return json(422, { message: "Object does not exist" });
    this.refs.set(ref, sha);
    return json(201, this.refJson(ref, sha));
  }

  private updateRef(ref: string, body: Record<string, unknown>): FakeResponse {
    const current = this.refs.get(ref);
    if (current === undefined) return notFound();
    const sha = body.sha;
    if (typeof sha !== "string" || !this.commits.has(sha)) return json(422, { message: "Object does not exist" });
    if (body.force !== true && !this.reachable(sha).has(current)) {
      return json(422, { message: "Update is not a fast forward" });
    }
    this.refs.set(ref, sha);
    return json(200, this.refJson(ref, sha));
  }

  private deleteRef(ref: string): FakeResponse {
    if (!this.refs.delete(ref)) return json(422, { message: "Reference does not exist" });
    return noContent();
  }

  private getTree(sha: string, recursive: boolean): FakeResponse {
    const treeSha = this.trees.has(sha) ? sha : this.commits.get(sha)?.tree;
    if (treeSha === undefined) return notFound();
    const item = (path: string, e: Entry): Record<string, unknown> => {
      const out: Record<string, unknown> = { path, mode: e.mode, type: e.type, sha: e.sha };
      if (e.type === "blob") out.size = this.blobs.get(e.sha)?.byteLength ?? 0;
      return out;
    };
    const tree: Record<string, unknown>[] = [];
    if (recursive) {
      this.walkTree(treeSha, "", (path, e) => tree.push(item(path, e)));
    } else {
      for (const e of this.trees.get(treeSha) ?? []) tree.push(item(e.name, e));
    }
    // Like GitHub (observed 2026-10-04 on octocat/Hello-World): `sha` echoes the requested sha, so a
    // commit sha comes back as given, not as its tree's sha.
    return json(200, { sha, url: "", truncated: false, tree });
  }

  private createTree(body: Record<string, unknown>): FakeResponse {
    let base: string | null = null;
    if (body.base_tree !== undefined && body.base_tree !== null) {
      if (typeof body.base_tree !== "string" || !this.trees.has(body.base_tree)) {
        return json(422, { message: "Invalid request." });
      }
      base = body.base_tree;
    }
    if (!Array.isArray(body.tree)) return json(422, { message: "Invalid request." });
    const ops: { path: string; op: PathOp }[] = [];
    for (const raw of body.tree as unknown[]) {
      if (!isRecord(raw) || typeof raw.path !== "string") return json(422, { message: "Invalid request." });
      const mode = typeof raw.mode === "string" ? raw.mode : raw.type === "tree" ? TREE_MODE : BLOB_MODE;
      if (typeof raw.content === "string") {
        ops.push({ path: raw.path, op: { kind: "blob", sha: this.putBlob(new TextEncoder().encode(raw.content)), mode } });
      } else if (raw.sha === null) {
        ops.push({ path: raw.path, op: { kind: "delete" } });
      } else if (typeof raw.sha === "string") {
        if (raw.type === "tree") {
          if (!this.trees.has(raw.sha)) return json(422, { message: "GitRPC::BadObjectState" });
          ops.push({ path: raw.path, op: { kind: "tree", sha: raw.sha } });
        } else {
          if (!this.blobs.has(raw.sha)) return json(422, { message: "GitRPC::BadObjectState" });
          ops.push({ path: raw.path, op: { kind: "blob", sha: raw.sha, mode } });
        }
      } else {
        return json(422, { message: "Invalid request." });
      }
    }
    return json(201, { sha: this.applyOps(base, ops), url: "", tree: [] });
  }

  private getBlob(sha: string, accept: string): FakeResponse {
    const bytes = this.blobs.get(sha);
    if (bytes === undefined) return notFound();
    if (accept.includes("raw")) {
      return { status: 200, headers: { ...CORS, "content-type": "application/vnd.github.raw" }, body: bytes.slice() };
    }
    return json(200, { sha, size: bytes.byteLength, encoding: "base64", content: base64Lines(bytes) });
  }

  private createBlob(body: Record<string, unknown>): FakeResponse {
    if (typeof body.content !== "string") return json(422, { message: "Invalid request." });
    const encoding = body.encoding ?? "utf-8";
    let bytes: Uint8Array;
    if (encoding === "base64") bytes = new Uint8Array(Buffer.from(body.content, "base64"));
    else if (encoding === "utf-8") bytes = new TextEncoder().encode(body.content);
    else return json(422, { message: "Invalid request." });
    if (bytes.byteLength > this.maxBlobBytes) {
      return json(422, {
        message: "Sorry, your input was too large to process. Consider creating the blob with a smaller body.",
      });
    }
    return json(201, { sha: this.putBlob(bytes), url: "" });
  }

  private createCommitRoute(body: Record<string, unknown>): FakeResponse {
    const { message, tree, parents } = body;
    if (typeof message !== "string" || typeof tree !== "string" || !this.trees.has(tree)) {
      return json(422, { message: "Invalid request." });
    }
    const parentList: string[] = [];
    if (parents !== undefined) {
      if (!Array.isArray(parents)) return json(422, { message: "Invalid request." });
      for (const p of parents as unknown[]) {
        if (typeof p !== "string" || !this.commits.has(p)) return json(422, { message: "Invalid request." });
        parentList.push(p);
      }
    }
    let author: FakePerson = { ...DEFAULT_AUTHOR, date: secondPrecision(this.now()) };
    if (body.author !== undefined) {
      const a = body.author;
      if (!isRecord(a) || typeof a.name !== "string" || typeof a.email !== "string") {
        return json(422, { message: "Invalid request." });
      }
      author = { name: a.name, email: a.email, date: typeof a.date === "string" ? a.date : secondPrecision(this.now()) };
    }
    const c: FakeCommit = { tree, parents: parentList, message, author, committer: { ...author } };
    const sha = this.createCommit(c);
    return json(201, this.commitJson(sha, c));
  }

  private listCommits(params: URLSearchParams): FakeResponse {
    const start = params.get("sha") ?? "main";
    const headSha = this.resolveCommit(start);
    if (headSha === undefined) return json(404, { message: `No commit found for SHA: ${start}` });
    const path = params.get("path");
    const perPage = Math.max(1, Math.min(100, Number(params.get("per_page") ?? "30") || 30));
    const page = Math.max(1, Number(params.get("page") ?? "1") || 1);

    let shas = [...this.reachable(headSha)];
    shas.sort((x, y) => {
      const cx = this.commits.get(x);
      const cy = this.commits.get(y);
      const dx = cx === undefined ? 0 : Date.parse(cx.author.date);
      const dy = cy === undefined ? 0 : Date.parse(cy.author.date);
      if (dx !== dy) return dy - dx;
      return this.generation(y) - this.generation(x);
    });
    if (path !== null && path !== "") {
      shas = shas.filter((s) => {
        const c = this.commits.get(s);
        if (c === undefined) return false;
        const mine = this.lookupEntry(c.tree, path)?.sha;
        const parent = c.parents[0] === undefined ? undefined : this.commits.get(c.parents[0]);
        const theirs = parent === undefined ? undefined : this.lookupEntry(parent.tree, path)?.sha;
        return mine !== theirs;
      });
    }
    const items = shas.slice((page - 1) * perPage, page * perPage).map((s) => {
      const c = this.commits.get(s);
      if (c === undefined) throw new Error("FakeGithub: dangling commit");
      return {
        sha: s,
        commit: { message: c.message, author: c.author, committer: c.committer, tree: { sha: c.tree } },
        parents: c.parents.map((p) => ({ sha: p })),
      };
    });
    return json(200, items);
  }

  private compare(spec: string): FakeResponse {
    const sep = spec.indexOf("...");
    if (sep < 0) return notFound();
    const base = this.resolveCommit(spec.slice(0, sep));
    const head = this.resolveCommit(spec.slice(sep + 3));
    if (base === undefined || head === undefined) return notFound();
    const fromBase = this.reachable(base);
    const fromHead = this.reachable(head);
    const ahead_by = [...fromHead].filter((s) => !fromBase.has(s)).length;
    const behind_by = [...fromBase].filter((s) => !fromHead.has(s)).length;
    const status =
      base === head ? "identical" : fromHead.has(base) ? "ahead" : fromBase.has(head) ? "behind" : "diverged";
    return json(200, { status, ahead_by, behind_by });
  }
}

export function fakeFetch(fake: FakeGithub): typeof fetch {
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let req: FakeRequest;
    if (input instanceof Request) {
      if (init?.body !== undefined && init.body !== null && typeof init.body !== "string") {
        throw new Error("fakeFetch: only string bodies");
      }
      const r = init === undefined ? input : new Request(input, init);
      const headers: Record<string, string> = {};
      r.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      const method = r.method.toUpperCase();
      const text = method === "GET" || method === "HEAD" ? "" : await r.text();
      req = { method, url: r.url, headers, body: text === "" ? null : text };
    } else {
      const body = init?.body;
      if (body !== undefined && body !== null && typeof body !== "string") {
        throw new Error("fakeFetch: only string bodies");
      }
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      req = {
        method: (init?.method ?? "GET").toUpperCase(),
        url: input instanceof URL ? input.href : input,
        headers,
        body: body ?? null,
      };
    }
    const res = await fake.handle(req);
    const payload =
      res.status === 204 || res.status === 304 || res.body === null
        ? null
        : typeof res.body === "string"
          ? res.body
          : new Uint8Array(res.body);
    return new Response(payload, { status: res.status, headers: res.headers });
  };
  return impl as typeof fetch;
}

export async function routeFakeGithub(
  page: Page,
  fake: FakeGithub,
  opts: { workerOrigin: string; returnUrl: string },
): Promise<void> {
  const handler = async (route: Route): Promise<void> => {
    const r = route.request();
    const req: FakeRequest = { method: r.method(), url: r.url(), headers: r.headers(), body: r.postData() };
    let res: FakeResponse;
    try {
      res = await fake.handle(req);
    } catch {
      await route.abort("failed");
      return;
    }
    await route.fulfill({
      status: res.status,
      headers: res.headers,
      body: res.body === null ? undefined : typeof res.body === "string" ? Buffer.from(res.body, "utf8") : Buffer.from(res.body),
    });
  };
  await page.route("https://api.github.com/**", handler);
  await page.route(`${opts.workerOrigin}/**`, handler);
  await page.route("https://github.com/login/oauth/authorize**", async (route) => {
    const state = new URL(route.request().url()).searchParams.get("state") ?? "";
    await route.fulfill({
      status: 302,
      headers: { location: `${opts.returnUrl}?code=fake-code&state=${encodeURIComponent(state)}` },
    });
  });
  await page.route("https://avatars.githubusercontent.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "image/png" },
      body: Buffer.from(TRANSPARENT_PNG_BASE64, "base64"),
    });
  });
}
