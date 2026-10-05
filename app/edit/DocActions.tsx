// The owner's parts of a document's page (plan 50 §50.7): the note of a failed replacement, until the
// next successful replace or Dismiss (Orchestrator ruling 2026-10-04 20:39Z, amending 50 §50.9 step 4).
import { useState, type ReactNode } from "react";
import type { DocJson } from "../../lib/derive/published.ts";
import { SignedOutError } from "../auth/session.ts";
import { waitForSignIn } from "../auth/auth.ts";
import { useOwner } from "../shell/owner.tsx";
import { showToast } from "../shell/toast.tsx";
import { dismissReplaceFailed } from "./docs.ts";
import { shortDate } from "./format.ts";
import { recordSaved } from "./overlay.ts";
import { repo, SAVE_FAILED } from "./session.ts";

/** The failed-replacement note (design editing/docs/rules/replacefail). */
export const REPLACE_FAILED_NOTE = (fileName: string, date: string): string =>
  `Couldn’t replace with ${fileName} (${date}). The old file is still here. Try again.`;
/** Its control (design editing/docs/rules/replacefail). */
export const DISMISS = "Dismiss";

/** Owner only: the document's last replacement failed. */
export function ReplaceFailedNote({ doc }: { doc: DocJson }): ReactNode {
  const { owner } = useOwner();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const failed = doc.replaceFailed;
  if (!owner || !failed || dismissed === failed.at) return null;

  const dismiss = async (): Promise<void> => {
    setBusy(true);
    try {
      const { git, site } = await repo();
      const r = await dismissReplaceFailed({ git, docId: doc.id, author: { name: site.owner.commitName, email: site.owner.commitEmail } });
      if (r.kind === "saved") {
        if (r.files.size > 0) await recordSaved(r.files, r.commit);
        setDismissed(failed.at);
        return;
      }
      showToast(SAVE_FAILED.title);
    } catch (e) {
      if (e instanceof SignedOutError) {
        setBusy(false);
        if (await waitForSignIn()) await dismiss();
        return;
      }
      console.error("Dismiss failed", e);
      showToast(SAVE_FAILED.title);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="banner err" role="status" data-ref="replace-failed">
      <span className="bt">{REPLACE_FAILED_NOTE(failed.fileName, shortDate(failed.at))}</span>
      <span className="ba">
        <button type="button" className="btn" disabled={busy} onClick={() => void dismiss()} data-ref="replace-failed-dismiss">{DISMISS}</button>
      </span>
    </div>
  );
}
