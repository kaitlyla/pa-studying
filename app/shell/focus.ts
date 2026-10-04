// Keeps Tab inside a dialog (guide-reader/a11y).
import type { KeyboardEvent } from "react";

const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function trapTab(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== "Tab") return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (x) => !(x as HTMLButtonElement).disabled,
  );
  const firstEl = items[0];
  const lastEl = items[items.length - 1];
  if (!firstEl || !lastEl) return;
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (e.shiftKey && i <= 0) {
    e.preventDefault();
    lastEl.focus();
  } else if (!e.shiftKey && i === items.length - 1) {
    e.preventDefault();
    firstEl.focus();
  }
}
