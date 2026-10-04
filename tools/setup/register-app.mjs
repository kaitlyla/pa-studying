// One-time registration of the "PA Studying editor" GitHub App (plan 10 §10.7, setup steps 3–5).
//
//   node tools/setup/register-app.mjs
//
// 3. Serves a one-button page on http://127.0.0.1:8977/ that posts the app manifest to GitHub. After
//    she clicks "Create GitHub App", GitHub redirects to /registered; the code is converted, the key is
//    converted to PKCS#8, and GH_CLIENT_ID, GH_CLIENT_SECRET and GH_APP_KEY go to the Worker through
//    `wrangler secret put` on stdin (never to disk). clientId is written to app/auth-config.json.
// 4. Prints the install URL and polls until she has installed the app on pa-studying, checks the
//    installation, stores GH_INSTALLATION_ID and redeploys the Worker.
// 5. Waits until http://127.0.0.1:8977/probe is requested (by the agent, once she is ready), then runs
//    the revocation probe (revoke-probe.mjs) with the client secret still held only in memory.
import { randomBytes } from "node:crypto";
import {
  API,
  LOOPBACK,
  OWNER,
  REPO,
  SITE_URL,
  apiHeaders,
  appJwt,
  createLoopback,
  escapeHtml,
  page,
  putSecret,
  readAuthConfig,
  toPkcs8,
  wrangler,
  writeAuthConfig,
} from "./common.mjs";
import { revokeProbe } from "./revoke-probe.mjs";

const APP_NAME = "PA Studying editor";
const EXPECTED_PERMISSIONS = { actions: "write", contents: "write", metadata: "read" };
const POLL_MS = 5000;
const INSTALL_WAIT_MS = 2 * 60 * 60 * 1000;

const sortedJson = (value) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));

const { workerOrigin } = readAuthConfig();
if (typeof workerOrigin !== "string" || new URL(workerOrigin).origin !== workerOrigin) {
  throw new Error("app/auth-config.json must hold the deployed Worker's origin (setup steps 1–2) first");
}

const manifest = {
  name: APP_NAME,
  url: SITE_URL,
  hook_attributes: { url: `${workerOrigin}/`, active: false },
  redirect_url: `${LOOPBACK}/registered`,
  callback_urls: [SITE_URL, `${LOOPBACK}/callback`],
  public: false,
  default_permissions: { contents: "write", actions: "write", metadata: "read" },
  default_events: [],
  request_oauth_on_install: false,
};

const loopback = createLoopback();
await loopback.listen();

// Step 3: create the app from the manifest.
const manifestState = randomBytes(32).toString("base64url");
loopback.on("/", () => ({
  html: page(
    "Create the PA Studying editor app",
    `<h1>PA Studying editor</h1>
<p>This creates the private GitHub App the study site uses for your sign-in. Make sure you are signed in to GitHub as <b>${OWNER}</b>, then click the button.</p>
<form method="post" action="https://github.com/settings/apps/new?state=${encodeURIComponent(manifestState)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button type="submit">Create GitHub App</button>
</form>`,
  ),
}));

const app = await new Promise((resolve, reject) => {
  loopback.on("/registered", async (url) => {
    if (url.searchParams.get("state") !== manifestState || !url.searchParams.get("code")) {
      return { status: 400, html: page("Not completed", "<p>This page wasn't reached from GitHub's app creation. Go back and click Create GitHub App.</p>") };
    }
    loopback.off("/registered");
    loopback.off("/");
    try {
      const response = await fetch(`${API}/app-manifests/${encodeURIComponent(url.searchParams.get("code"))}/conversions`, {
        method: "POST",
        headers: apiHeaders(),
      });
      if (response.status !== 201) throw new Error(`manifest conversion answered ${response.status}`);
      const converted = await response.json();
      if (converted.owner?.login !== OWNER) throw new Error(`the app was created under ${converted.owner?.login}, not ${OWNER}`);
      resolve(converted);
      const installUrl = `https://github.com/apps/${converted.slug}/installations/new`;
      return {
        html: page(
          "App created",
          `<h1>App created</h1><p>Next, install it on your study site's repository:</p>
<p><a href="${escapeHtml(installUrl)}">${escapeHtml(installUrl)}</a></p>
<p>Choose <b>Only select repositories</b>, pick <b>${REPO}</b>, and click Install.</p>`,
        ),
      };
    } catch (error) {
      reject(error);
      throw error;
    }
  });
  console.log(`Step 3: open ${LOOPBACK}/ and click "Create GitHub App".`);
});

const keyPem = app.pem;
console.log(`App created: id ${app.id}, slug ${app.slug}, client ID ${app.client_id}.`);
await putSecret("GH_CLIENT_ID", app.client_id);
await putSecret("GH_CLIENT_SECRET", app.client_secret);
await putSecret("GH_APP_KEY", toPkcs8(keyPem));
writeAuthConfig({ clientId: app.client_id });
console.log("Stored GH_CLIENT_ID, GH_CLIENT_SECRET and GH_APP_KEY as Worker secrets; wrote clientId to app/auth-config.json.");

// Step 4: wait for the installation on pa-studying.
console.log(`Step 4: install the app: https://github.com/apps/${app.slug}/installations/new`);
const jwtHeaders = () => apiHeaders(`Bearer ${appJwt(app.client_id, keyPem)}`);
const deadline = Date.now() + INSTALL_WAIT_MS;
let installation;
while (!installation) {
  if (Date.now() > deadline) throw new Error("no installation appeared within 2 hours");
  const response = await fetch(`${API}/repos/${OWNER}/${REPO}/installation`, { headers: jwtHeaders() });
  if (response.status === 200) installation = await response.json();
  else if (response.status !== 404) throw new Error(`GET /repos/${OWNER}/${REPO}/installation answered ${response.status}`);
  else await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}

const listed = await (await fetch(`${API}/app/installations`, { headers: jwtHeaders() })).json();
if (!Array.isArray(listed) || listed.length !== 1 || listed[0].id !== installation.id) {
  throw new Error(`expected exactly one installation (${installation.id}), GET /app/installations gave ${JSON.stringify(listed?.map?.((i) => i.id))}`);
}
if (sortedJson(installation.permissions) !== sortedJson(EXPECTED_PERMISSIONS)) {
  throw new Error(`installation permissions are ${JSON.stringify(installation.permissions)}, expected ${JSON.stringify(EXPECTED_PERMISSIONS)}`);
}
if (installation.repository_selection !== "selected") {
  throw new Error(`installation repository_selection is ${installation.repository_selection}; it must be "Only select repositories"`);
}
const tokenResponse = await fetch(`${API}/app/installations/${installation.id}/access_tokens`, { method: "POST", headers: jwtHeaders() });
const { token: installationToken } = await tokenResponse.json();
const repos = await (await fetch(`${API}/installation/repositories`, { headers: apiHeaders(`Bearer ${installationToken}`) })).json();
await fetch(`${API}/installation/token`, { method: "DELETE", headers: apiHeaders(`Bearer ${installationToken}`) });
const repoNames = repos.repositories?.map((r) => r.full_name) ?? [];
if (repoNames.length !== 1 || repoNames[0] !== `${OWNER}/${REPO}`) {
  throw new Error(`the installation can reach ${JSON.stringify(repoNames)}; it must be ${OWNER}/${REPO} only`);
}
console.log(
  `Installation ${installation.id}: account ${installation.account?.login}, repository_selection ${installation.repository_selection}, ` +
    `repositories ${JSON.stringify(repoNames)}, permissions ${JSON.stringify(installation.permissions)}.`,
);

await putSecret("GH_INSTALLATION_ID", String(installation.id));
await wrangler(["deploy"]);
console.log("Stored GH_INSTALLATION_ID and redeployed the Worker.");

// Step 5: the revocation probe, started on request so she is ready to sign in.
await new Promise((resolve) => {
  loopback.on("/probe", () => {
    loopback.off("/probe");
    resolve();
    return { html: page("Probe started", "<p>The sign-in page is opening.</p>") };
  });
  console.log(`Step 5: waiting for ${LOOPBACK}/probe to start the revocation probe.`);
});
try {
  await revokeProbe({ clientId: app.client_id, clientSecret: app.client_secret, loopback });
} finally {
  await loopback.close();
}
console.log(`Step 6: she removes ${LOOPBACK}/callback at https://github.com/settings/apps/${app.slug} (Callback URL), then Save changes.`);
