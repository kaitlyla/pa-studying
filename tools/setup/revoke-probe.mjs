// Setup step 5 (plan 10 §10.7): measures whether deleting a user access token also kills the refresh
// token issued with it, which fixes the Worker's REVOKE_MODE. She signs in once through the loopback
// callback; the request/response pairs are recorded with every token and secret redacted.
//
// Normally run by register-app.mjs, which holds the client secret in memory. Run on its own, it reads
// `{"clientId": "...", "clientSecret": "..."}` from stdin, so the secret never touches disk.
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { API, LOOPBACK, apiHeaders, createLoopback, openInBrowser, page } from "./common.mjs";

const OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token";
const recordPath = fileURLToPath(new URL("./revoke-probe.json", import.meta.url));
const SECRET_FIELDS = new Set(["access_token", "refresh_token", "client_secret", "code", "code_verifier"]);

/** Copies a JSON-like value with every token, secret and one-time code replaced by "[redacted]". */
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, SECRET_FIELDS.has(key) && v != null ? "[redacted]" : redact(v)]),
    );
  }
  return value;
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { nonJsonBody: text.slice(0, 200) };
  }
}

async function oauth(record, step, params) {
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "pa-studying-setup" },
    body: new URLSearchParams(params),
  });
  const body = await readJson(response);
  record.steps.push({
    step,
    request: { method: "POST", url: OAUTH_TOKEN_URL, body: redact(params) },
    response: { status: response.status, body: redact(body) },
  });
  return body ?? {};
}

async function deleteApplication(record, step, clientId, clientSecret, kind, accessToken) {
  const url = `${API}/applications/${encodeURIComponent(clientId)}/${kind}`;
  const response = await fetch(url, {
    method: "DELETE",
    headers: {
      ...apiHeaders(`Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ access_token: accessToken }),
  });
  const body = await readJson(response);
  record.steps.push({
    step,
    request: { method: "DELETE", url, headers: { Authorization: "Basic [redacted]" }, body: { access_token: "[redacted]" } },
    response: { status: response.status, body: redact(body) },
  });
  return response.status;
}

/**
 * Runs the probe and writes revoke-probe.json. Resolves to the measured mode: "token" when the refresh
 * fails with bad_refresh_token after the access token was deleted, "grant" when the refresh still works.
 */
export async function revokeProbe({ clientId, clientSecret, loopback }) {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const redirectUri = `${LOOPBACK}/callback`;
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  const code = await new Promise((resolve, reject) => {
    loopback.on("/callback", (url) => {
      loopback.off("/callback");
      const error = url.searchParams.get("error");
      const returned = url.searchParams.get("code");
      if (url.searchParams.get("state") !== state || error || !returned) {
        reject(new Error(`sign-in callback rejected: ${error ?? "state mismatch or missing code"}`));
        return { status: 400, html: page("Sign-in failed", "<p>The sign-in didn't complete. The agent will set it up again.</p>") };
      }
      resolve(returned);
      return { html: page("Signed in", "<p>Signed in. You can close this tab.</p>") };
    });
    console.log(`Revocation probe: sign-in page opened in the browser:\n  ${authorize}`);
    openInBrowser(authorize.toString());
  });

  const record = { probedAt: new Date().toISOString(), clientId, steps: [] };
  const exchanged = await oauth(record, "exchange", {
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  if (typeof exchanged.access_token !== "string" || typeof exchanged.refresh_token !== "string") {
    throw new Error(`code exchange failed: ${JSON.stringify(redact(exchanged))}`);
  }

  const deleted = await deleteApplication(record, "delete-token", clientId, clientSecret, "token", exchanged.access_token);
  if (deleted !== 204) throw new Error(`DELETE /applications/{client_id}/token answered ${deleted}, expected 204`);

  const refreshed = await oauth(record, "refresh-after-delete", {
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: exchanged.refresh_token,
  });

  let mode;
  if (refreshed.error === "bad_refresh_token") {
    mode = "token";
  } else if (typeof refreshed.access_token === "string") {
    mode = "grant";
    const cleaned = await deleteApplication(record, "delete-grant-cleanup", clientId, clientSecret, "grant", refreshed.access_token);
    if (cleaned !== 204) throw new Error(`grant cleanup answered ${cleaned}, expected 204`);
  } else {
    throw new Error(`refresh gave neither a token nor bad_refresh_token: ${JSON.stringify(redact(refreshed))}`);
  }

  record.result = { REVOKE_MODE: mode };
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Revocation probe result: REVOKE_MODE=${mode} (recorded in tools/setup/revoke-probe.json)`);
  return mode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const { clientId, clientSecret } = JSON.parse(input);
  const loopback = createLoopback();
  await loopback.listen();
  try {
    await revokeProbe({ clientId, clientSecret, loopback });
  } finally {
    await loopback.close();
  }
}
