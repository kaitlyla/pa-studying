// pa-studying-auth: the GitHub App token exchange for the site's sign-in, and the monthly
// guideline-check trigger (plan 10 §10.7, 80). Tokens pass through; nothing is logged or stored.

export interface Env {
  GH_CLIENT_ID: string;
  GH_CLIENT_SECRET: string;
  /** The app private key, PKCS#8 PEM. */
  GH_APP_KEY: string;
  GH_INSTALLATION_ID: string;
  /** Which revocation call `/revoke` makes, fixed by the setup revocation probe. */
  REVOKE_MODE?: string;
}

export const SITE_ORIGIN = "https://kaitlyla.github.io";
export const SITE_URL = "https://kaitlyla.github.io/pa-studying/";
const REPO = "kaitlyla/pa-studying";
const GUIDELINE_WORKFLOW = "guideline-check.yml";
const OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token";
const API = "https://api.github.com";
const API_VERSION = "2026-03-10";
const USER_AGENT = "pa-studying-auth";
export const DISPATCH_RETRY_DELAY_MS = 30_000;
const DISPATCH_ATTEMPTS = 3;

const CORS_ALLOW_ORIGIN = { "Access-Control-Allow-Origin": SITE_ORIGIN };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_ALLOW_ORIGIN, "Content-Type": "application/json" },
  });
}

function empty(status: number, cors: boolean): Response {
  return new Response(null, { status, headers: cors ? CORS_ALLOW_ORIGIN : {} });
}

async function readStringFields<K extends string>(request: Request, keys: readonly K[]): Promise<Record<K, string> | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const out = {} as Record<K, string>;
  for (const key of keys) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value !== "string" || value === "") return null;
    out[key] = value;
  }
  return out;
}

/** Posts to GitHub's OAuth token endpoint and maps the answer to the Worker's token response. */
async function oauthToken(env: Env, params: Record<string, string>): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({ client_id: env.GH_CLIENT_ID, client_secret: env.GH_CLIENT_SECRET, ...params }),
    });
  } catch {
    return json(502, { error: "upstream_unreachable" });
  }
  let data: Record<string, unknown>;
  try {
    data = (await upstream.json()) as Record<string, unknown>;
  } catch {
    return json(502, { error: "upstream_invalid_response" });
  }
  if (typeof data.error === "string") {
    return json(400, { error: data.error });
  }
  if (
    !upstream.ok ||
    typeof data.access_token !== "string" ||
    typeof data.refresh_token !== "string" ||
    typeof data.expires_in !== "number" ||
    typeof data.refresh_token_expires_in !== "number"
  ) {
    return json(502, { error: "upstream_invalid_response" });
  }
  return json(200, {
    access_token: data.access_token,
    expires_in: data.expires_in,
    refresh_token: data.refresh_token,
    refresh_token_expires_in: data.refresh_token_expires_in,
  });
}

async function handleToken(request: Request, env: Env): Promise<Response> {
  const body = await readStringFields(request, ["code", "code_verifier"] as const);
  if (!body) return json(400, { error: "invalid_request" });
  return oauthToken(env, { code: body.code, code_verifier: body.code_verifier, redirect_uri: SITE_URL });
}

async function handleRefresh(request: Request, env: Env): Promise<Response> {
  const body = await readStringFields(request, ["refresh_token"] as const);
  if (!body) return json(400, { error: "invalid_request" });
  return oauthToken(env, { grant_type: "refresh_token", refresh_token: body.refresh_token });
}

async function handleRevoke(request: Request, env: Env): Promise<Response> {
  const body = await readStringFields(request, ["access_token"] as const);
  if (!body) return json(400, { error: "invalid_request" });
  const mode = env.REVOKE_MODE;
  if (mode !== "token" && mode !== "grant") return empty(502, true);
  let upstream: Response;
  try {
    upstream = await fetch(`${API}/applications/${encodeURIComponent(env.GH_CLIENT_ID)}/${mode}`, {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Basic ${btoa(`${env.GH_CLIENT_ID}:${env.GH_CLIENT_SECRET}`)}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": API_VERSION,
      },
      body: JSON.stringify({ access_token: body.access_token }),
    });
  } catch {
    return empty(502, true);
  }
  // 422 means the token is already invalid, which counts as revoked.
  return empty(upstream.status === 204 || upstream.status === 422 ? 204 : 502, true);
}

async function handleFetch(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Origin") !== SITE_ORIGIN) return empty(403, false);
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...CORS_ALLOW_ORIGIN,
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  const { pathname } = new URL(request.url);
  if (request.method === "POST") {
    if (pathname === "/token") return handleToken(request, env);
    if (pathname === "/refresh") return handleRefresh(request, env);
    if (pathname === "/revoke") return handleRevoke(request, env);
  }
  return empty(404, true);
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const b64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const binary = atob(b64);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  return der;
}

/** Mints the app JWT: RS256 over {iat: now − 60 s, exp: now + 540 s, iss: client ID}. */
export async function mintAppJwt(env: Env, nowMs: number = Date.now()): Promise<string> {
  if (!env.GH_APP_KEY.includes("-----BEGIN PRIVATE KEY-----")) {
    throw new Error("GH_APP_KEY must be a PKCS#8 PEM private key");
  }
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(env.GH_APP_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const now = Math.floor(nowMs / 1000);
  const encoder = new TextEncoder();
  const header = base64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = base64url(encoder.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.GH_CLIENT_ID })));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(`${header}.${claims}`));
  return `${header}.${claims}.${base64url(new Uint8Array(signature))}`;
}

const apiHeaders = (authorization: string) => ({
  Accept: "application/vnd.github+json",
  Authorization: authorization,
  "User-Agent": USER_AGENT,
  "X-GitHub-Api-Version": API_VERSION,
});

/** One attempt: an installation token, then the workflow dispatch. Throws on a non-2xx or network error. */
async function dispatchOnce(env: Env): Promise<void> {
  const jwt = await mintAppJwt(env);
  const tokenResponse = await fetch(
    `${API}/app/installations/${encodeURIComponent(env.GH_INSTALLATION_ID)}/access_tokens`,
    { method: "POST", headers: apiHeaders(`Bearer ${jwt}`) },
  );
  if (!tokenResponse.ok) throw new Error(`installation token: HTTP ${tokenResponse.status}`);
  const { token } = (await tokenResponse.json()) as { token?: unknown };
  if (typeof token !== "string") throw new Error("installation token: no token in response");
  const dispatch = await fetch(`${API}/repos/${REPO}/actions/workflows/${GUIDELINE_WORKFLOW}/dispatches`, {
    method: "POST",
    headers: { ...apiHeaders(`Bearer ${token}`), "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main" }),
  });
  if (!dispatch.ok) throw new Error(`dispatch ${GUIDELINE_WORKFLOW}: HTTP ${dispatch.status}`);
}

/** Dispatches the guideline check, retrying twice 30 s apart; throws so Cron Events shows the run failed. */
export async function dispatchGuidelineCheck(env: Env): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DISPATCH_ATTEMPTS; attempt++) {
    try {
      await dispatchOnce(env);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < DISPATCH_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, DISPATCH_RETRY_DELAY_MS));
      }
    }
  }
  throw new Error(`guideline-check dispatch failed after ${DISPATCH_ATTEMPTS} attempts`, { cause: lastError });
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleFetch(request, env);
  },
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    await dispatchGuidelineCheck(env);
  },
};
