// Wires edit mode into the app once at boot (plan 50 §50.3, §50.5): the unsaved-changes guard on
// in-app navigation and Sign out, the draft kept across the sign-in page load, the browser's own
// leave prompt, and the owner's overlay while she is signed in.
import { onOwnerChange, setBeforeSignInNavigate, setSignOutGuard } from "../auth/auth.ts";
import { setNavigationGuard } from "../shell/route.ts";
import { startOverlay, stopOverlay } from "./overlay.ts";
import { confirmLeave, onBeforeUnload, repo, saveDraft } from "./session.ts";

let started = false;

/** The owner's overlay follows the owner state; an unreachable site.json leaves it off this session. */
async function ownerChanged(owner: boolean): Promise<void> {
  if (!owner) {
    stopOverlay();
    return;
  }
  try {
    await startOverlay((await repo()).git);
  } catch (e) {
    console.warn("The saved-changes overlay didn’t start", e);
  }
}

export function startEditing(): void {
  if (started) return;
  started = true;
  setNavigationGuard(() => confirmLeave());
  setSignOutGuard(confirmLeave);
  setBeforeSignInNavigate((saveWaiting) => saveDraft(saveWaiting));
  window.addEventListener("beforeunload", onBeforeUnload);
  onOwnerChange((owner) => void ownerChanged(owner));
}
