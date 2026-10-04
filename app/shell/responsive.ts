// The layout switches at 900px (site-shell/responsive, 40 §40.9).
import { useSyncExternalStore } from "react";

export const PHONE_QUERY = "(max-width: 899.98px)";

function query(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(PHONE_QUERY) : null;
}

function subscribe(cb: () => void): () => void {
  const mq = query();
  if (!mq) return () => {};
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

const getSnapshot = (): boolean => query()?.matches ?? false;

/** True below 900px wide. */
export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
