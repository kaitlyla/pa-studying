// The repository's files at one commit, read through the Git data API (plan 50 §50.4 edit start,
// §50.6 View): the tree once, then each needed blob (at most 6 at a time), parsed through lib/content.
import { parseFile } from "../../lib/content/index.ts";
import { pool, type Git } from "./github.ts";

export class Snapshot {
  private readonly texts = new Map<string, Promise<string>>();
  readonly git: Git;
  readonly commit: string;
  /** Blob path → sha. */
  readonly files: ReadonlyMap<string, string>;

  private constructor(git: Git, commit: string, files: ReadonlyMap<string, string>) {
    this.git = git;
    this.commit = commit;
    this.files = files;
  }

  /** The tree of `commit` (or of `main`'s head when omitted). */
  static async at(git: Git, commit?: string): Promise<Snapshot> {
    const sha = commit ?? (await git.ref());
    return new Snapshot(git, sha, await git.files(sha));
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  /** Paths under a directory prefix (ending in `/`), sorted. */
  under(prefix: string): string[] {
    return [...this.files.keys()].filter((p) => p.startsWith(prefix)).sort();
  }

  text(path: string): Promise<string> {
    let p = this.texts.get(path);
    if (!p) {
      const sha = this.files.get(path);
      if (sha === undefined) return Promise.reject(new Error(`${path} is not in ${this.commit}`));
      p = this.git.blobText(sha);
      this.texts.set(path, p);
      p.catch(() => this.texts.delete(path));
    }
    return p;
  }

  async json<T>(path: string): Promise<T> {
    return parseFile<T>(path, await this.text(path));
  }

  async jsonIfExists<T>(path: string): Promise<T | null> {
    return this.has(path) ? this.json<T>(path) : null;
  }

  /** Read several files, at most 6 blob requests at once. */
  async many<T>(paths: readonly string[]): Promise<T[]> {
    return pool(paths, 6, (p) => this.json<T>(p));
  }
}
