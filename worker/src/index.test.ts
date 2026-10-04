import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker, { DISPATCH_RETRY_DELAY_MS, SITE_ORIGIN, SITE_URL, mintAppJwt, type Env } from "./index.ts";

const CLIENT_ID = "Iv23liTESTCLIENT";
const CLIENT_SECRET = "test-client-secret";
const INSTALLATION_ID = "424242";

let env: Env;
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  publicKey = pair.publicKey;
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  env = {
    GH_CLIENT_ID: CLIENT_ID,
    GH_CLIENT_SECRET: CLIENT_SECRET,
    GH_APP_KEY: pem,
    GH_INSTALLATION_ID: INSTALLATION_ID,
    REVOKE_MODE: "token",
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type Call = { url: string; init: RequestInit };

/** Replaces global fetch with a queue of canned answers and records every request. */
function mockFetch(...answers: Array<Response | Error>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const next = answers.shift();
    if (!next) throw new Error(`unexpected fetch to ${String(input)}`);
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function request(path: string, init: RequestInit & { origin?: string | null } = {}) {
  const { origin = SITE_ORIGIN, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (origin !== null) headers.set("Origin", origin);
  return new Request(`https://pa-studying-auth.example.workers.dev${path}`, { method: "POST", ...rest, headers });
}

const postJson = (path: string, body: unknown) =>
  request(path, { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

describe("origin check", () => {
  it.each([
    ["https://evil.example"],
    ["https://kaitlyla.github.io.evil.example"],
    ["http://kaitlyla.github.io"],
    [null],
  ])("answers 403 with an empty body and no CORS header for Origin %s", async (origin) => {
    const calls = mockFetch();
    const response = await worker.fetch(
      request("/token", { origin, body: JSON.stringify({ code: "c", code_verifier: "v" }) }),
      env,
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("preflight", () => {
  it("answers OPTIONS with 204 and the four CORS headers", async () => {
    const response = await worker.fetch(request("/token", { method: "OPTIONS" }), env);
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://kaitlyla.github.io");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST");
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type");
    expect(response.headers.get("Access-Control-Max-Age")).toBe("86400");
  });
});

describe("POST /token", () => {
  it("exchanges the code and returns the token pair with the CORS header", async () => {
    const calls = mockFetch(
      jsonResponse(200, {
        access_token: "ghu_access",
        expires_in: 28800,
        refresh_token: "ghr_refresh",
        refresh_token_expires_in: 15897600,
        token_type: "bearer",
        scope: "",
      }),
    );
    const response = await worker.fetch(postJson("/token", { code: "the-code", code_verifier: "the-verifier" }), env);

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://kaitlyla.github.io");
    expect(await response.json()).toStrictEqual({
      access_token: "ghu_access",
      expires_in: 28800,
      refresh_token: "ghr_refresh",
      refresh_token_expires_in: 15897600,
    });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe("https://github.com/login/oauth/access_token");
    expect(call!.init.method).toBe("POST");
    expect(new Headers(call!.init.headers).get("Accept")).toBe("application/json");
    const sent = new URLSearchParams(String(call!.init.body));
    expect(Object.fromEntries(sent)).toStrictEqual({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: "the-code",
      code_verifier: "the-verifier",
      redirect_uri: SITE_URL,
    });
  });

  it("passes GitHub's error through as 400 with the CORS header", async () => {
    mockFetch(jsonResponse(200, { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." }));
    const response = await worker.fetch(postJson("/token", { code: "stale", code_verifier: "v" }), env);
    expect(response.status).toBe(400);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://kaitlyla.github.io");
    expect(await response.json()).toStrictEqual({ error: "bad_verification_code" });
  });
});

describe("POST /refresh", () => {
  it("sends the refresh grant with the client credentials", async () => {
    const calls = mockFetch(
      jsonResponse(200, { access_token: "ghu_new", expires_in: 28800, refresh_token: "ghr_new", refresh_token_expires_in: 15897600 }),
    );
    const response = await worker.fetch(postJson("/refresh", { refresh_token: "ghr_old" }), env);
    expect(response.status).toBe(200);
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body)))).toStrictEqual({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: "ghr_old",
    });
  });
});

describe("POST /revoke", () => {
  it("with REVOKE_MODE=token sends one DELETE /applications/<id>/token with Basic auth, and maps GitHub's 422 to 204", async () => {
    const calls = mockFetch(jsonResponse(422, { message: "Validation Failed" }));
    const response = await worker.fetch(postJson("/revoke", { access_token: "ghu_access" }), env);

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://kaitlyla.github.io");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe(`https://api.github.com/applications/${CLIENT_ID}/token`);
    expect(call!.init.method).toBe("DELETE");
    const auth = new Headers(call!.init.headers).get("Authorization");
    expect(auth).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
    expect(JSON.parse(String(call!.init.body))).toStrictEqual({ access_token: "ghu_access" });
  });

  it("with REVOKE_MODE=grant deletes the grant", async () => {
    const calls = mockFetch(new Response(null, { status: 204 }));
    const response = await worker.fetch(postJson("/revoke", { access_token: "ghu_access" }), { ...env, REVOKE_MODE: "grant" });
    expect(response.status).toBe(204);
    expect(calls[0]!.url).toBe(`https://api.github.com/applications/${CLIENT_ID}/grant`);
  });

  it("answers 502 with the CORS header when GitHub fails", async () => {
    mockFetch(jsonResponse(500, { message: "Server Error" }));
    const response = await worker.fetch(postJson("/revoke", { access_token: "ghu_access" }), env);
    expect(response.status).toBe(502);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://kaitlyla.github.io");
  });
});

describe("failure paths", () => {
  it("answers a malformed JSON body with 400 invalid_request and calls nothing", async () => {
    const calls = mockFetch();
    const response = await worker.fetch(
      request("/token", { body: "{not json", headers: { "Content-Type": "application/json" } }),
      env,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://kaitlyla.github.io");
    expect(await response.json()).toStrictEqual({ error: "invalid_request" });
    expect(calls).toHaveLength(0);
  });

  it("answers a body missing code_verifier with 400 invalid_request and calls nothing", async () => {
    const calls = mockFetch();
    const response = await worker.fetch(postJson("/token", { code: "c" }), env);
    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({ error: "invalid_request" });
    expect(calls).toHaveLength(0);
  });

  it("answers 502 upstream_unreachable when GitHub cannot be reached", async () => {
    mockFetch(new TypeError("fetch failed"));
    const response = await worker.fetch(postJson("/token", { code: "c", code_verifier: "v" }), env);
    expect(response.status).toBe(502);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://kaitlyla.github.io");
    expect(await response.json()).toStrictEqual({ error: "upstream_unreachable" });
  });

  it("answers 502 upstream_invalid_response when GitHub replies with something other than JSON", async () => {
    mockFetch(new Response("<html>Service unavailable</html>", { status: 503, headers: { "Content-Type": "text/html" } }));
    const response = await worker.fetch(postJson("/refresh", { refresh_token: "ghr_old" }), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toStrictEqual({ error: "upstream_invalid_response" });
  });

  it("answers 502 upstream_invalid_response when GitHub's reply lacks the token fields", async () => {
    mockFetch(jsonResponse(200, { access_token: "ghu_access", expires_in: 28800 }));
    const response = await worker.fetch(postJson("/token", { code: "c", code_verifier: "v" }), env);
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toStrictEqual({ error: "upstream_invalid_response" });
    expect(JSON.stringify(body)).not.toContain("ghu_access");
  });

  it("answers /revoke with 502 and an empty body when GitHub cannot be reached", async () => {
    mockFetch(new TypeError("fetch failed"));
    const response = await worker.fetch(postJson("/revoke", { access_token: "ghu_access" }), env);
    expect(response.status).toBe(502);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://kaitlyla.github.io");
    expect(await response.text()).toBe("");
  });

  it("answers /revoke with 502 and calls nothing while REVOKE_MODE is unset", async () => {
    const calls = mockFetch();
    const withoutMode: Env = { ...env };
    delete withoutMode.REVOKE_MODE;
    const response = await worker.fetch(postJson("/revoke", { access_token: "ghu_access" }), withoutMode);
    expect(response.status).toBe(502);
    expect(calls).toHaveLength(0);
  });

  it("refuses a GH_APP_KEY that is not PKCS#8 PEM", async () => {
    const pkcs1 = env.GH_APP_KEY.replace(/BEGIN PRIVATE KEY/, "BEGIN RSA PRIVATE KEY").replace(/END PRIVATE KEY/, "END RSA PRIVATE KEY");
    await expect(mintAppJwt({ ...env, GH_APP_KEY: pkcs1 })).rejects.toThrow("GH_APP_KEY must be a PKCS#8 PEM private key");
  });
});

describe("unknown routes", () => {
  it.each([
    ["POST /other", postJson("/other", {})],
    ["GET /token", () => request("/token", { method: "GET" })],
  ] as const)("answers 404 with the CORS header for %s", async (_label, make) => {
    const req = typeof make === "function" ? make() : make;
    const response = await worker.fetch(req, env);
    expect(response.status).toBe(404);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://kaitlyla.github.io");
  });
});

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

describe("scheduled()", () => {
  it("mints an RS256 app JWT, gets an installation token and dispatches guideline-check.yml on main", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-01T09:00:00Z"), toFake: ["Date"] });
    const calls = mockFetch(jsonResponse(201, { token: "ghs_install" }), new Response(null, { status: 204 }));

    await worker.scheduled({}, env);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(`https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`);
    const jwt = new Headers(calls[0]!.init.headers).get("Authorization")!.replace(/^Bearer /, "");
    const [header, claims, signature] = jwt.split(".");
    expect(decodeJwtPart(header!)).toStrictEqual({ alg: "RS256", typ: "JWT" });
    const now = Math.floor(new Date("2026-11-01T09:00:00Z").getTime() / 1000);
    expect(decodeJwtPart(claims!)).toStrictEqual({ iat: now - 60, exp: now + 540, iss: CLIENT_ID });
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      Buffer.from(signature!, "base64url"),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(valid).toBe(true);

    expect(calls[1]!.url).toBe("https://api.github.com/repos/kaitlyla/pa-studying/actions/workflows/guideline-check.yml/dispatches");
    expect(new Headers(calls[1]!.init.headers).get("Authorization")).toBe("Bearer ghs_install");
    expect(JSON.parse(String(calls[1]!.init.body))).toStrictEqual({ ref: "main" });
  });

  // JWT signing completes on the crypto thread pool, outside the fake clock, so each step first waits
  // (on real setImmediate turns) until the attempt has failed and its retry timer is pending.
  async function settle(predicate: () => boolean) {
    const deadline = performance.now() + 5000;
    while (!predicate() && performance.now() < deadline) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(predicate()).toBe(true);
  }

  it("retries a failed dispatch twice, 30 s apart, then throws", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-01T09:00:00Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
    const token = () => jsonResponse(201, { token: "ghs_install" });
    const calls = mockFetch(
      token(),
      jsonResponse(500, { message: "Server Error" }),
      token(),
      new Error("network down"),
      token(),
      jsonResponse(422, { message: "Workflow does not have 'workflow_dispatch' trigger" }),
    );
    const dispatches = () => calls.filter((c) => c.url.endsWith("/dispatches")).length;

    const run = worker.scheduled({}, env);
    const outcome = expect(run).rejects.toThrow("guideline-check dispatch failed after 3 attempts");

    await settle(() => dispatches() === 1 && vi.getTimerCount() === 1);
    await vi.advanceTimersByTimeAsync(DISPATCH_RETRY_DELAY_MS - 1);
    expect(dispatches()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle(() => dispatches() === 2 && vi.getTimerCount() === 1);
    await vi.advanceTimersByTimeAsync(DISPATCH_RETRY_DELAY_MS);
    await outcome;

    expect(dispatches()).toBe(3);
    expect(calls).toHaveLength(6);
    expect(vi.getTimerCount()).toBe(0);
    expect(DISPATCH_RETRY_DELAY_MS).toBe(30_000);
  });

  it("stops retrying once a dispatch succeeds", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-01T09:00:00Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
    const calls = mockFetch(
      jsonResponse(201, { token: "ghs_install" }),
      jsonResponse(502, {}),
      jsonResponse(201, { token: "ghs_install" }),
      new Response(null, { status: 204 }),
    );
    const run = worker.scheduled({}, env);
    await settle(() => calls.length === 2 && vi.getTimerCount() === 1);
    await vi.advanceTimersByTimeAsync(DISPATCH_RETRY_DELAY_MS);
    await expect(run).resolves.toBeUndefined();
    expect(calls).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);
  });
});
