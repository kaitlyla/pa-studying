import type { ReactNode } from "react";

function Svg({ size, children }: { size: number; children: ReactNode }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export function MagnifierIcon({ size = 16 }: { size?: number }): ReactNode {
  return (
    <Svg size={size}>
      <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M11 11l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

export function CloseIcon({ size = 12 }: { size?: number }): ReactNode {
  return (
    <Svg size={size}>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

export function BackIcon({ size = 16 }: { size?: number }): ReactNode {
  return (
    <Svg size={size}>
      <path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function GapIcon({ size = 13 }: { size?: number }): ReactNode {
  return (
    <Svg size={size}>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeDasharray="2.4 1.6" />
      <path d="M8 7v4M8 5v.01" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </Svg>
  );
}

export function UpdateIcon({ size = 13 }: { size?: number }): ReactNode {
  return (
    <Svg size={size}>
      <path d="M13.5 8A5.5 5.5 0 1 1 11.6 3.8" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M13.5 2.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </Svg>
  );
}
