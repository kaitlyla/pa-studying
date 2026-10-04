// The review-slide viewer's controls (guide-reader/review-slides): Previous, "Slide i of n" in a live
// region, Next, and "Jump to slide". The arrow keys move between slides anywhere on the viewer.
import type { KeyboardEvent, ReactNode } from "react";
import { Icon } from "../shell/Icon.tsx";

export interface SlideNavProps {
  /** 1-based current slide. */
  n: number;
  total: number;
  /** Option labels for "Jump to slide", one per slide. */
  labels: readonly string[];
  go: (n: number) => void;
  /** How the position reads: "Slide 3 of 12" or "3 / 12". */
  format?: "words" | "fraction";
}

export function SlideNav({ n, total, labels, go, format = "words" }: SlideNavProps): ReactNode {
  return (
    <div className="fv-bar">
      <button type="button" className="btn" disabled={n <= 1} onClick={() => go(n - 1)}>
        <Icon n="back" size={14} />
        Previous
      </button>
      <span aria-live="polite">{format === "words" ? `Slide ${n} of ${total}` : `${n} / ${total}`}</span>
      <button type="button" className="btn" disabled={n >= total} onClick={() => go(n + 1)}>
        Next
        <Icon n="chev" size={12} />
      </button>
      <select className="sd-jump" aria-label="Jump to slide" value={n} onChange={(e) => go(Number(e.target.value))}>
        {labels.map((l, k) => (
          <option key={k} value={k + 1}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

const isField = (t: EventTarget): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName));

/** ArrowLeft/ArrowRight move one slide, except while typing in a field. */
export function slideKeys(n: number, total: number, go: (n: number) => void): (e: KeyboardEvent<HTMLElement>) => void {
  return (e) => {
    if (e.defaultPrevented || isField(e.target)) return;
    if (e.key === "ArrowRight" && n < total) {
      e.preventDefault();
      go(n + 1);
    } else if (e.key === "ArrowLeft" && n > 1) {
      e.preventDefault();
      go(n - 1);
    }
  };
}
