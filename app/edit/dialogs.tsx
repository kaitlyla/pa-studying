// The owner's dialogs: a modal frame, confirms (Delete row, Delete picture, Restore, Remove…) and the
// "You have unsaved changes" dialog (guide-reader/unsaved). OB6 mounts UnsavedDialog once for the app.
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { trapTab } from "../shell/focus.ts";
import { resolveUnsaved, useEdit } from "./session.ts";

export function Dialog({ title, children, actions, onClose, label }: {
  title: ReactNode;
  children?: ReactNode;
  actions: ReactNode;
  onClose: () => void;
  label?: string;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("input, .row .btn.pri, .row .btn");
    first?.focus();
    return () => prev?.focus?.();
  }, []);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={ref}
        className="dlg"
        role="dialog"
        aria-modal="true"
        aria-label={label ?? (typeof title === "string" ? title : undefined)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          trapTab(e);
        }}
      >
        <h2>{title}</h2>
        {children}
        <div className="row">{actions}</div>
      </div>
    </div>
  );
}

// ---- confirms ---------------------------------------------------------------------------------------

interface ConfirmRequest {
  title: string;
  lines: string[];
  action: string;
  danger: boolean;
  resolve: (ok: boolean) => void;
}

let pending: ConfirmRequest | null = null;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());

/** Shows a confirm dialog; resolves true when she confirms. */
export function askConfirm(title: string, lines: string[] = [], opts: { action?: string; danger?: boolean } = {}): Promise<boolean> {
  pending?.resolve(false);
  return new Promise((resolve) => {
    pending = { title, lines, action: opts.action ?? "OK", danger: opts.danger ?? false, resolve };
    emit();
  });
}

function settle(ok: boolean): void {
  const p = pending;
  pending = null;
  emit();
  p?.resolve(ok);
}

/** The editor's Confirm: the first line is the title (her editor's prompts), the rest the body. */
export function editorConfirm(lines: string[]): Promise<boolean> {
  const [title = "", ...rest] = lines;
  return askConfirm(title, rest, { action: "Delete", danger: true });
}

/** The confirm before a column width change that also changes other diagnoses' rows (the lines name them). */
export function widthConfirm(lines: string[]): Promise<boolean> {
  return askConfirm("Change this column for them too?", lines, { action: "Change" });
}

function ConfirmHost(): ReactNode {
  const p = useSyncExternalStore((cb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }, () => pending);
  if (!p) return null;
  return (
    <Dialog
      title={p.title}
      onClose={() => settle(false)}
      actions={<>
        <button className="btn" onClick={() => settle(false)}>Cancel</button>
        <button className={p.danger ? "btn danger" : "btn pri"} onClick={() => settle(true)} data-ref="confirm-ok">{p.action}</button>
      </>}
    >
      {p.lines.map((l, i) => <p key={i}>{l}</p>)}
    </Dialog>
  );
}

/** The unsaved-changes dialog and every confirm. */
export function UnsavedDialog(): ReactNode {
  const { unsaved } = useEdit();
  return (
    <>
      <ConfirmHost />
      {unsaved && (
        <Dialog
          title="You have unsaved changes"
          onClose={() => resolveUnsaved("stay")}
          actions={<>
            <button className="btn" onClick={() => resolveUnsaved("stay")} data-ref="unsaved-stay">Keep editing</button>
            <button className="btn danger" onClick={() => resolveUnsaved("discard")} data-ref="unsaved-discard">Discard changes</button>
            {unsaved.conflict
              ? <button className="btn pri" onClick={() => resolveUnsaved("copy")} data-ref="unsaved-copy">Copy my changes</button>
              : <button className="btn pri" onClick={() => resolveUnsaved("save")} data-ref="unsaved-save">Save and continue</button>}
          </>}
        >
          <p>Your edits to this page haven’t been saved. If you discard them, the page stays as it was last saved.</p>
        </Dialog>
      )}
    </>
  );
}
