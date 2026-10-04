// The owner's GitHub App user tokens (plan 10 §10.7, app side): sign-in through the authorize page,
// the return from it, token refresh serialized across tabs, and sign-out.
import {
  AUTH_KEY, AUTHORIZE_URL, CHANNEL_NAME, CLIENT_ID, OAUTH_KEY, POPUP_FEATURES, POPUP_NAME, REFRESH_LOCK,
  REFRESH_MARGIN_MS, RETURN_KEY, SITE_URL, WORKER_ORIGIN,
} from "./config.ts";

/** `localStorage["pa.auth"]`: the token pair with absolute expiry times in ms. */
export interface AuthRecord {
  access: string;
  accessExp: number;
  refresh: string;
  refreshExp: number;
}

/** `localStorage["pa.oauth"]`: one sign-in attempt in flight. */
interface OAuthAttempt {
  state: string;
  verifier: string;
}

export type AuthMessage = { type: "signed-in" } | { type: "signed-out" };

/** The stored sign-in is gone or can no longer be refreshed: she must sign in again. */
export class SignedOutError extends Error {
  constructor(message = "Not signed in") {
    super(message);
    this.name = "SignedOutError";
  }
}

// ---- storage ------------------------------------------------------------------------------------

function readJSON(key: string): unknown {
  const raw = localStorage.getItem(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isAuthRecord(v: unknown): v is AuthRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.access === "string" && typeof r.refresh === "string" &&
    typeof r.accessExp === "number" && typeof r.refreshExp === "number";
}

export function readAuth(): AuthRecord | null {
  const v = readJSON(AUTH_KEY);
  return isAuthRecord(v) ? v : null;
}

function writeAuth(record: AuthRecord): void {
  localStorage.setItem(AUTH_KEY, JSON.stringify(record));
}

export function clearAuth(): void {
  localStorage.removeItem(AUTH_KEY);
}

// ---- cross-tab channel --------------------------------------------------------------------------

let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel {
  channel ??= new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

export function broadcast(message: AuthMessage): void {
  getChannel().postMessage(message);
}

/** Listen for sign-in and sign-out in other tabs (and popups). Returns the unsubscribe function. */
export function onAuthMessage(listener: (m: AuthMessage) => void): () => void {
  const handler = (e: MessageEvent<AuthMessage>): void => listener(e.data);
  const ch = getChannel();
  ch.addEventListener("message", handler);
  return () => ch.removeEventListener("message", handler);
}

// ---- sign-in ------------------------------------------------------------------------------------

export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** A sign-in attempt prepared ahead of the click, so the click handler can open the window synchronously. */
export interface PreparedSignIn {
  state: string;
  verifier: string;
  url: string;
}

/**
 * Generate `state` and the PKCE `verifier` (32 random bytes each, base64url) and the authorize URL.
 * The S256 challenge needs an async digest, so this runs before the click (when the dialog opens).
 */
export async function prepareSignIn(): Promise<PreparedSignIn> {
  const state = randomToken();
  const verifier = randomToken();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: SITE_URL,
    state,
    code_challenge: base64url(digest),
    code_challenge_method: "S256",
  });
  return { state, verifier, url: `${AUTHORIZE_URL}?${params.toString()}` };
}

/**
 * The "Continue with GitHub" click. Must run inside the click handler: it stores the attempt and opens
 * the authorize page in a popup. When the popup is blocked, `beforeNavigate` runs (the editor keeps
 * unsaved work in its draft store) and the current tab navigates instead.
 */
export function startSignIn(
  prepared: PreparedSignIn,
  beforeNavigate: () => Promise<void> | void = () => {},
): Promise<"popup" | "navigated"> {
  const attempt: OAuthAttempt = { state: prepared.state, verifier: prepared.verifier };
  localStorage.setItem(OAUTH_KEY, JSON.stringify(attempt));
  const popup = window.open(prepared.url, POPUP_NAME, POPUP_FEATURES);
  if (popup) return Promise.resolve("popup");
  return (async () => {
    localStorage.setItem(RETURN_KEY, location.hash);
    await beforeNavigate();
    location.assign(prepared.url);
    return "navigated" as const;
  })();
}

export type ReturnOutcome = "none" | "signed-in" | "failed";

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_in: number;
}

function isTokenResponse(v: unknown): v is TokenResponse {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.access_token === "string" && typeof r.refresh_token === "string" &&
    typeof r.expires_in === "number" && typeof r.refresh_token_expires_in === "number";
}

function recordFrom(t: TokenResponse, now: number): AuthRecord {
  return {
    access: t.access_token,
    accessExp: now + t.expires_in * 1000,
    refresh: t.refresh_token,
    refreshExp: now + t.refresh_token_expires_in * 1000,
  };
}

async function postWorker(path: string, body: Record<string, string>): Promise<Response> {
  return fetch(`${WORKER_ORIGIN}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * The return from GitHub (`?code&state` on the site URL, in the popup or the tab), run by the app boot
 * before routing. Removes the query, checks `state` against `pa.oauth` (deleted either way), exchanges
 * the code through the Worker, stores `pa.auth` and broadcasts. A popup closes itself; a tab goes back
 * to the route it left.
 */
export async function exchangeReturnCode(): Promise<ReturnOutcome> {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const state = params.get("state");
  if (code === null && state === null) return "none";
  history.replaceState(history.state, "", `${location.pathname}${location.hash}`);

  const attempt = readJSON(OAUTH_KEY) as Partial<OAuthAttempt> | null;
  localStorage.removeItem(OAUTH_KEY);
  if (!code || !state || !attempt || typeof attempt.verifier !== "string" || attempt.state !== state) return "failed";

  let tokens: unknown;
  try {
    const res = await postWorker("/token", { code, code_verifier: attempt.verifier });
    if (!res.ok) return "failed";
    tokens = await res.json();
  } catch {
    return "failed";
  }
  if (!isTokenResponse(tokens)) return "failed";
  writeAuth(recordFrom(tokens, Date.now()));
  broadcast({ type: "signed-in" });

  if (window.name === POPUP_NAME) {
    window.close();
  } else {
    const back = localStorage.getItem(RETURN_KEY);
    localStorage.removeItem(RETURN_KEY);
    if (back) location.hash = back;
  }
  return "signed-in";
}

// ---- token use ----------------------------------------------------------------------------------

let onSignedOut: () => void = () => {};

/** Called when a refresh fails and the stored sign-in is cleared (the app enters the signed-out state). */
export function setSignedOutHandler(handler: () => void): void {
  onSignedOut = handler;
}

/** The stored sign-in no longer works: clear it, enter the signed-out state, and throw. */
export function lose(): never {
  clearAuth();
  onSignedOut();
  throw new SignedOutError("Sign-in expired");
}

/**
 * Refresh inside the cross-tab lock. `spent` is the access token the caller found stale (or got a 401
 * with): when the stored token differs, another tab already refreshed and its pair is used as-is, so a
 * single-use refresh token is never spent twice.
 */
export async function refreshAuth(spent: string): Promise<AuthRecord> {
  return navigator.locks.request(REFRESH_LOCK, async () => {
    const current = readAuth();
    if (!current) throw new SignedOutError();
    if (current.access !== spent) return current;
    if (current.refreshExp <= Date.now()) lose();
    let res: Response;
    try {
      res = await postWorker("/refresh", { refresh_token: current.refresh });
    } catch (e) {
      // A network failure is not an expired sign-in; the caller reports it as offline.
      throw e instanceof Error ? e : new Error(String(e));
    }
    if (res.status === 400) lose();
    if (!res.ok) throw new Error(`Token refresh failed with status ${res.status}`);
    const body: unknown = await res.json();
    if (!isTokenResponse(body)) lose();
    const next = recordFrom(body, Date.now());
    writeAuth(next);
    return next;
  });
}

/** A usable access token: refreshed first when it has under 5 minutes left. */
export async function accessToken(): Promise<string> {
  const current = readAuth();
  if (!current) throw new SignedOutError();
  if (current.accessExp - Date.now() < REFRESH_MARGIN_MS) return (await refreshAuth(current.access)).access;
  return current.access;
}

// ---- sign-out -----------------------------------------------------------------------------------

/**
 * Sign out on this device: revoke through the Worker, then delete `pa.auth` (whether or not the revoke
 * worked), then tell the other tabs.
 */
export async function signOut(): Promise<void> {
  const current = readAuth();
  if (current) {
    try {
      await postWorker("/revoke", { access_token: current.access });
    } catch {
      // Signed out on this device regardless; the orphaned tokens expire on their own (10 §10.7).
    }
  }
  clearAuth();
  broadcast({ type: "signed-out" });
}
