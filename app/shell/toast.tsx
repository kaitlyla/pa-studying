// One toast at a time, announced politely (guide-reader/a11y).
import { useSyncExternalStore, type ReactNode } from "react";

export interface ToastOptions {
  /** Shows an Undo button that runs this and dismisses the toast. */
  undo?: () => void;
  /** Milliseconds before it hides; default 3800. 0 keeps it until replaced or dismissed. */
  ms?: number;
}

interface ToastState {
  id: number;
  text: string;
  undo?: () => void;
}

let toast: ToastState | null = null;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function hideToast(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  toast = null;
  emit();
}

export function showToast(text: string, opts: ToastOptions = {}): void {
  if (timer) clearTimeout(timer);
  timer = null;
  seq += 1;
  toast = { id: seq, text, undo: opts.undo };
  const ms = opts.ms ?? 3800;
  if (ms > 0) timer = setTimeout(hideToast, ms);
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const getSnapshot = (): ToastState | null => toast;

export function Toast(): ReactNode {
  const t = useSyncExternalStore(subscribe, getSnapshot);
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {t && (
        <div className="toast" key={t.id}>
          <span>{t.text}</span>
          {t.undo && (
            <button
              type="button"
              onClick={() => {
                t.undo?.();
                hideToast();
              }}
            >
              Undo
            </button>
          )}
          <button type="button" aria-label="Dismiss" onClick={hideToast}>
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
