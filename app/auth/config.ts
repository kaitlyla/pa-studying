// Sign-in constants (plan 10 §10.7). `app/auth-config.json` is the single source of the Worker origin
// and the GitHub App's client id; vite.config.ts puts the same origin into the CSP connect-src.
import authConfig from "../auth-config.json";

export const WORKER_ORIGIN: string = authConfig.workerOrigin;
export const CLIENT_ID: string = authConfig.clientId;

/** The registered callback URL is the site URL; GitHub requires `redirect_uri` to match it exactly. */
export { SITE_URL } from "../../lib/site.ts";
export const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const API_ORIGIN = "https://api.github.com";

/** localStorage keys. */
export const AUTH_KEY = "pa.auth";
export const OAUTH_KEY = "pa.oauth";
export const DEVICE_KEY = "pa.device";
/** The route to continue at after a same-tab sign-in round trip. */
export const RETURN_KEY = "pa.return";

export const CHANNEL_NAME = "pa-auth";
export const POPUP_NAME = "pa-signin";
export const POPUP_FEATURES = "popup,width=520,height=720";
export const REFRESH_LOCK = "pa-auth-refresh";

/** Refresh when the access token has less than this left. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
