// The app side of sign-in (plan 10 §10.7) and the owner check (50 §50.1).
import { startOwnerCheck } from "./auth.ts";
import { startEditing } from "../edit/boot.ts";

export { OwnerAvatar, SignInDialog, SignInLink } from "./AuthUI.tsx";
export { checkOwner, completeSignInReturn, openSignIn, waitForSignIn } from "./auth.ts";
export { githubFetch } from "./api.ts";
export { SignedOutError } from "./session.ts";

/** Boot: edit mode's guards and overlay hook first, so the first owner check already reaches them. */
export function startAuth(): void {
  startEditing();
  startOwnerCheck();
}
