// Wires edit mode into the app once at boot (plan 50 §50.3, §50.5): the unsaved-changes guard on
// in-app navigation and Sign out, the draft kept across the sign-in page load, the browser's own
// leave prompt (also while an upload has steps left, §50.9), and the owner's overlay while she is
// signed in.
import { onOwnerChange, setBeforeSignInNavigate, setSignOutGuard } from "../auth/auth.ts";
import { setNavigationGuard } from "../shell/route.ts";
import { startOverlay, stopOverlay } from "./overlay.ts";
import { confirmLeave, keepEditsSignedOut, leavingFor, onBeforeUnload, repo, saveDraft } from "./session.ts";
import { onUploadBeforeUnload } from "./upload.ts";

let started = false;

/** The owner's overlay follows the owner state; an unreachable site.json leaves it off this session. */
async function ownerChanged(owner: boolean): Promise<void> {
  if (!owner) {
    // Before the editors close with the owner state: her unsaved changes must outlive them.
    const kept = keepEditsSignedOut();
    stopOverlay();
    await kept;
    return;
  }
  try {
    await startOverlay((await repo()).git);
  } catch (e) {
    console.warn("The saved-changes overlay didn’t start", e);
  }
}

/** The check on every in-app navigation: a page banner stays on its own route; unsaved edits ask first. */
export function guardNavigation(toHash: string): Promise<boolean> {
  leavingFor(toHash);
  return confirmLeave();
}

export function startEditing(): void {
  if (started) return;
  started = true;
  setNavigationGuard(guardNavigation);
  setSignOutGuard(confirmLeave);
  setBeforeSignInNavigate((saveWaiting) => saveDraft(saveWaiting));
  window.addEventListener("beforeunload", onBeforeUnload);
  window.addEventListener("beforeunload", onUploadBeforeUnload);
  onOwnerChange((owner) => void ownerChanged(owner));
}
