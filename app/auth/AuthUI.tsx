// The owner's sign-in surfaces (UI sign-in, site-shell/signin-link): the header avatar, the footer
// link, and the sign-in dialog.
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { trapTab } from "../shell/focus.ts";
import { useOwner } from "../shell/owner.tsx";
import { useIsPhone } from "../shell/responsive.ts";
import { cancelSignIn, continueWithGithub, getAuthUi, openSignIn, signOutNow, subscribeAuthUi } from "./auth.ts";

function useAuthUi(): ReturnType<typeof getAuthUi> {
  return useSyncExternalStore(subscribeAuthUi, getAuthUi);
}

/** The header avatar, shown only to the signed-in owner. */
export function OwnerAvatar(): ReactNode {
  const owner = useOwner();
  const phone = useIsPhone();
  if (!owner.owner) return null;
  return (
    <span className="me" data-ref="signed-in-indicator" title={`Signed in with GitHub as ${owner.login ?? ""}`}>
      {owner.avatarUrl ? <img className="avatar" src={owner.avatarUrl} alt="" width={22} height={22} /> : <span className="avatar" aria-hidden="true" />}
      {!phone && "Signed in"}
    </span>
  );
}

/** "Owner sign-in" for visitors; "Sign out" for her. */
export function SignInLink(): ReactNode {
  const owner = useOwner();
  return owner.owner ? (
    <button type="button" className="linkbtn" onClick={() => void signOutNow()} data-ref="sign-out">Sign out</button>
  ) : (
    <button type="button" className="linkbtn" onClick={() => openSignIn("normal")} data-ref="owner-sign-in">Owner sign-in</button>
  );
}

const TEXT = {
  normal: { title: "Sign in to edit", body: "Only the site owner can edit. Viewing never needs a sign-in." },
  expired: {
    title: "Sign in again to finish saving",
    body: "Your sign-in expired. Your changes are still here and will be saved as soon as you’re signed in.",
  },
  failed: { title: "Sign in to edit", body: "Signing in didn’t finish. Only the site owner can edit. Please try again." },
} as const;

export function SignInDialog(): ReactNode {
  const { dialog, prepared } = useAuthUi();
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // The button is enabled once the attempt is prepared; focus it then.
    if (dialog && prepared) first.current?.focus();
  }, [dialog, prepared]);
  if (!dialog) return null;
  const t = TEXT[dialog];
  return (
    <div className="scrim" data-surface="sign-in">
      <div className="dlg" role="dialog" aria-modal="true" aria-labelledby="sign-in-title" data-ref="sign-in-dialog" onKeyDown={trapTab}>
        <h2 id="sign-in-title">{t.title}</h2>
        <p>{t.body}</p>
        <div className="row">
          <button
            ref={first}
            type="button"
            className="btn pri"
            onClick={continueWithGithub}
            disabled={!prepared}
            data-ref="github-continue"
          >
            Continue with GitHub
          </button>
          <button type="button" className="btn" onClick={cancelSignIn} data-ref="sign-in-cancel">Cancel</button>
        </div>
      </div>
    </div>
  );
}
