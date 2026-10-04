// Authorized calls to api.github.com (plan 50 intro; 10 §10.7 token use): the owner's access token,
// refreshed when it has under 5 minutes left; a 401 refreshes once and retries the call once.
import { API_ORIGIN } from "./config.ts";
import { accessToken, lose, refreshAuth } from "./session.ts";

export interface ApiInit {
  method?: string;
  /** JSON body; sent with `Content-Type: application/json`. */
  json?: unknown;
  /** Accept header; default `application/vnd.github+json`. */
  accept?: string;
}

async function send(path: string, init: ApiInit, token: string): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: init.accept ?? "application/vnd.github+json",
    "X-GitHub-Api-Version": "2026-03-10",
  };
  let body: string | undefined;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  // GitHub sends `Cache-Control: private, max-age=60` on reads such as the branch ref; a cached head
  // would make edit start and the commit protocol work from a stale commit.
  return fetch(`${API_ORIGIN}${path}`, { method: init.method ?? "GET", headers, body, cache: "no-store" });
}

/**
 * One GitHub API call with the owner's token. Network failures reject as from `fetch`; a sign-in that
 * cannot be refreshed throws SignedOutError (and the app is put in the signed-out state).
 */
export async function githubFetch(path: string, init: ApiInit = {}): Promise<Response> {
  const token = await accessToken();
  const res = await send(path, init, token);
  if (res.status !== 401) return res;
  const fresh = await refreshAuth(token);
  const again = await send(path, init, fresh.access);
  if (again.status === 401) lose();
  return again;
}
