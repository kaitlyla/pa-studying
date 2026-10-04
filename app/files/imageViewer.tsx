// The full-size image viewer (image-viewer): a dark full-screen overlay with −, Fit, + and Close.
// Large charts scroll inside it. Esc closes it; focus starts on its first button and Tab stays inside.
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { trapTab } from "../shell/focus.ts";

let src: string | null = null;
let opener: HTMLElement | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Opens the viewer on an image URL; focus returns to the opener when it closes. */
export function openImageViewer(url: string): void {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  src = url;
  emit();
}

export function closeImageViewer(): void {
  src = null;
  emit();
  opener?.focus();
  opener = null;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const getSnapshot = (): string | null => src;

const STEP = 0.5;

function Viewer({ url }: { url: string }): ReactNode {
  const [zoom, setZoom] = useState(1);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
  }, []);
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeImageViewer();
      return;
    }
    trapTab(e);
  };
  const fit = zoom === 1;
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Image, full size" onKeyDown={onKey}>
      <div className="lb-bar">
        <button type="button" ref={first} aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(STEP, z - STEP))}>
          −
        </button>
        <button type="button" onClick={() => setZoom(1)}>
          Fit
        </button>
        <button type="button" aria-label="Zoom in" onClick={() => setZoom((z) => z + STEP)}>
          +
        </button>
        <button type="button" onClick={closeImageViewer}>
          Close ✕
        </button>
      </div>
      <div className="lb-in">
        <img
          src={url}
          alt=""
          data-zoom={zoom}
          style={fit ? { maxWidth: "100%", width: "auto" } : { maxWidth: "none", width: `${zoom * 100}%` }}
        />
      </div>
    </div>
  );
}

export function ImageViewer(): ReactNode {
  const url = useSyncExternalStore(subscribe, getSnapshot);
  return url ? <Viewer key={url} url={url} /> : null;
}
