// Small line icons. Every use pairs an icon with text or an aria-label.
import type { ReactNode } from "react";

export type IconName =
  | "search" | "chev" | "plus" | "x" | "dl" | "menu" | "hide" | "show" | "pill" | "gap" | "upd" | "ext" | "back";

function paths(n: IconName): ReactNode {
  const line = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  switch (n) {
    case "search":
      return (
        <g {...line}>
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5L14 14" />
        </g>
      );
    case "chev":
      return <path {...line} d="M6 3.5L10.5 8 6 12.5" />;
    case "plus":
      return <path {...line} d="M8 3.5v9M3.5 8h9" />;
    case "x":
      return <path {...line} d="M4.5 4.5l7 7M11.5 4.5l-7 7" />;
    case "dl":
      return <path {...line} d="M8 2.5v8M5 7.5l3 3 3-3M3 13.5h10" />;
    case "menu":
      return <path {...line} d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />;
    case "hide":
      return <path {...line} d="M8 3.5L3.5 8 8 12.5M12.5 3.5L8 8l4.5 4.5" />;
    case "show":
      return <path {...line} d="M3.5 3.5L8 8l-4.5 4.5M8 3.5L12.5 8 8 12.5" />;
    case "pill":
      return (
        <g {...line} strokeWidth={1.5}>
          <rect x="2" y="5.5" width="12" height="5" rx="2.5" transform="rotate(-40 8 8)" />
          <path d="M6.2 5.9l3.6 4.2" />
        </g>
      );
    case "gap":
      return (
        <g {...line}>
          <circle cx="8" cy="8" r="5.5" strokeDasharray="2.2 1.6" />
          <path d="M8 7.2v3.6M8 5.2v.1" />
        </g>
      );
    case "upd":
      return <path {...line} d="M13 8a5 5 0 1 1-1.6-3.7M13 2.8v2.7h-2.7" />;
    case "ext":
      return <path {...line} d="M9.5 3h3.5v3.5M13 3L7.5 8.5M11 9.5V13H3V5h3.5" />;
    case "back":
      return <path {...line} d="M10 3.5L5.5 8l4.5 4.5" />;
  }
}

export function Icon({ n, size = 16 }: { n: IconName; size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false" className="ic">
      {paths(n)}
    </svg>
  );
}
