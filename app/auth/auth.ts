// The app's sign-in state (plan 10 §10.7 app side; 50 §50.1 owner check): the sign-in dialog, the
// owner check after sign-in and on every load, and the cross-tab channel.
import { loadData } from "../data/load.ts";
import { getOwner, setOwner, type OwnerState } from "../shell/owner.tsx";
import { showToast } from "../shell/toast.tsx";
import { SITE_PATH, type SiteJson } from "../../lib/derive/published.ts";
import { githubFetch } from "./api.ts";
import {
  clearAuth, exchangeReturnCode, onAuthMessage, prepareSignIn, readAuth, setSignedOutHandler, signOut, SignedOutError,
  startSignIn, type PreparedSignIn,
} from "./session.ts";

/** `normal`: "Sign in to edit"; `expired`: a save is waiting for her to sign in again; `failed`: the return didn't verify. */
export type DialogMode = "normal" | "expired" | "failed";

export interface AuthUiState {
  dialog: DialogMode | null;
  /** The next attempt, ready before the click so the popup opens with user activation. */
  prepared: PreparedSignIn | null;
}

let ownerHook: (owner: boolean) => void = () => {};

/** The editor's reaction when she becomes the owner or stops being it (the overlay starts or stops). */
export function onOwnerChange(fn: (owner: boolean) => void): void {
  ownerHook = fn;
}

/** Every owner-state change of the check goes through here, so the editor hears of it. */
function applyOwner(next: OwnerState): void {
  const was = getOwner().owner;
  setOwner(next);
  if (was !== next.owner) ownerHook(next.owner);
}

let ui: AuthUiState = { dialog: null, prepared: null };
const listeners = new Set<() => void>();
let waiters: ((signedIn: boolean) => void)[] = [];

function set(next: Partial<AuthUiState>): void {
  ui = { ...ui, ...next };
  for (const l of listeners) l();
}

export function getAuthUi(): AuthUiState {
  return ui;
}

export function subscribeAuthUi(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function settle(signedIn: boolean): void {
  const ws = waiters;
  waiters = [];
  for (const w of ws) w(signedIn);
}

/** Opens the sign-in dialog and prepares the attempt. */
export function openSignIn(mode: DialogMode = "normal"): void {
  set({ dialog: mode, prepared: null });
  void prepareSignIn().then((prepared) => {
    if (ui.dialog !== null) set({ prepared });
  });
}

export function cancelSignIn(): void {
  set({ dialog: null, prepared: null });
  settle(false);
}

/**
 * A save found the sign-in expired: show the dialog in its "expired" form. Resolves true once she is
 * signed in again as the owner (the save then runs again), false if she cancels.
 */
export function waitForSignIn(): Promise<boolean> {
  openSignIn("expired");
  return new Promise((resolve) => waiters.push(resolve));
}

/** The toast when she is signed in again and the save that was waiting runs. */
export const SAVING_AGAIN = "Signed in again. Saving your changes…";

let beforeNavigate: (saveWaiting: boolean) => Promise<void> | void = () => {};

/**
 * Runs before a full-page sign-in navigation (the editor keeps unsaved views in its draft store).
 * `saveWaiting`: a save is waiting on this sign-in, so it must run again after the return.
 */
export function setBeforeSignInNavigate(fn: (saveWaiting: boolean) => Promise<void> | void): void {
  beforeNavigate = fn;
}

/** The "Continue with GitHub" click handler. */
export function continueWithGithub(): void {
  const prepared = ui.prepared;
  if (!prepared) return;
  const saveWaiting = ui.dialog === "expired";
  // Each attempt uses its own state and verifier.
  set({ prepared: null });
  void startSignIn(prepared, () => beforeNavigate(saveWaiting));
  void prepareSignIn().then((next) => {
    if (ui.dialog !== null) set({ prepared: next });
  });
}

interface GithubUser {
  login: string;
  id: number;
  avatar_url?: string;
}

/**
 * 50 §50.1: she is the owner when GitHub's user is site.json's owner (login and id) and has push on
 * the repository. A different account is signed out at once (the dialog stays open). A network
 * failure keeps the previous state for the session. Resolves to whether she is the owner.
 */
export async function checkOwner(): Promise<boolean> {
  if (!readAuth()) {
    applyOwner({ owner: false });
    return false;
  }
  let user: GithubUser;
  let push: boolean;
  let site: SiteJson;
  try {
    site = await loadData<SiteJson>(SITE_PATH);
    const [u, r] = await Promise.all([githubFetch("/user"), githubFetch(`/repos/${site.repo}`)]);
    if (!u.ok || !r.ok) return getOwner().owner;
    user = (await u.json()) as GithubUser;
    const repo = (await r.json()) as { permissions?: { push?: boolean } };
    push = repo.permissions?.push === true;
  } catch (e) {
    if (e instanceof SignedOutError) {
      applyOwner({ owner: false });
      return false;
    }
    return getOwner().owner;
  }
  const owner = user.login === site.owner.login && user.id === site.owner.id && push;
  if (!owner) {
    clearAuth();
    applyOwner({ owner: false });
    return false;
  }
  applyOwner({ owner: true, login: user.login, avatarUrl: user.avatar_url });
  return true;
}

async function afterSignedIn(): Promise<void> {
  const owner = await checkOwner();
  if (owner) {
    const wasExpired = ui.dialog === "expired";
    set({ dialog: null, prepared: null });
    showToast(wasExpired ? SAVING_AGAIN : "Signed in. Edit and Versions buttons now appear on your notes.");
    settle(true);
  }
}

let started = false;

/** Starts the owner check and listens for sign-in and sign-out in other tabs. */
export function startOwnerCheck(): void {
  if (started) return;
  started = true;
  setSignedOutHandler(() => applyOwner({ owner: false }));
  onAuthMessage((m) => {
    if (m.type === "signed-in") void afterSignedIn();
    else applyOwner({ owner: false });
  });
  void checkOwner();
}

/** The app boot's return handling: a failed return opens the dialog in its failure state. */
export async function completeSignInReturn(): Promise<void> {
  const outcome = await exchangeReturnCode();
  if (outcome === "failed") openSignIn("failed");
}

let signOutGuard: () => Promise<boolean> = async () => true;

/** The editor's unsaved-changes check before Sign out (50 §50.3). */
export function setSignOutGuard(fn: () => Promise<boolean>): void {
  signOutGuard = fn;
}

/** The Sign out control. */
export async function signOutNow(): Promise<void> {
  if (!(await signOutGuard())) return;
  await signOut();
  applyOwner({ owner: false });
  showToast("Signed out.");
}
