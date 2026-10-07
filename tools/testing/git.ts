// Throwaway git repositories for tests.
import { execFileSync } from "node:child_process";

/**
 * Creates a git repository at `dir` (an existing directory), with `main` as its initial branch
 * and auto-maintenance turned off.
 *
 * Git starts `git maintenance run --auto` after a commit and, in a bare repository, after
 * receiving a push. On POSIX systems that run detaches into the background, and when its
 * loose-object estimate is high enough it repacks, writing into `.git` (`info/refs`, packs)
 * after the git command has returned. A test that then deletes the repository races that
 * write, and the delete fails with ENOTEMPTY. With `maintenance.auto` off no maintenance
 * process is started.
 */
export function initTestRepo(dir: string, options: { bare?: boolean } = {}): void {
  execFileSync("git", ["init", "-q", ...(options.bare ? ["--bare"] : []), "-b", "main", dir], { stdio: "pipe" });
  execFileSync("git", ["config", "maintenance.auto", "false"], { cwd: dir, stdio: "pipe" });
}

/** Clones `remote` into `dir` (which must not exist yet), with auto-maintenance off as in initTestRepo. */
export function cloneTestRepo(remote: string, dir: string): void {
  execFileSync("git", ["clone", "-q", "-c", "maintenance.auto=false", remote, dir], { stdio: "pipe" });
}
