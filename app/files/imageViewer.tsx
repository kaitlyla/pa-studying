// The full-size image viewer (image-viewer): a dark full-screen overlay with −, Fit, + and Close.
// Large charts scroll inside it. Esc closes it; focus starts on its first button and Tab stays inside.
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { keptFraction } from "../../lib/crop.ts";
import type { Crop } from "../../lib/schemaTypes.ts";
import { croppedImageStyle } from "../render/styles.ts";
import { trapTab } from "../shell/focus.ts";

/** What the viewer shows: an image, and the part of it a cropped picture keeps (null: all of it). */
interface Shown {
  url: string;
  crop: Crop | null;
}

let shown: Shown | null = null;
let opener: HTMLElement | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Opens the viewer on an image URL (only `crop`'s part of it, when given); focus returns to the opener when it closes. */
export function openImageViewer(url: string, crop: Crop | null = null): void {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  shown = { url, crop };
  emit();
}

export function closeImageViewer(): void {
  shown = null;
  emit();
  opener?.focus();
  opener = null;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const getSnapshot = (): Shown | null => shown;

const STEP = 0.5;

/** The kept part of a cropped image, at its own pixel size (Fit: no wider than the viewer) or zoomed. */
function CroppedImage({ url, crop, zoom }: { url: string; crop: Crop; zoom: number }): ReactNode {
  const [px, setPx] = useState<{ w: number; h: number } | null>(null);
  const k = keptFraction(crop);
  const box: CSSProperties = { display: "inline-block", position: "relative", overflow: "hidden" };
  if (px) box.aspectRatio = `${px.w * k.w} / ${px.h * k.h}`;
  Object.assign(box, zoom === 1 ? { width: px ? `${px.w * k.w}px` : 0, maxWidth: "100%" } : { width: `${zoom * 100}%`, maxWidth: "none" });
  return (
    <span className="lb-crop" style={box}>
      <img
        src={url}
        alt=""
        data-zoom={zoom}
        style={croppedImageStyle(crop)}
        onLoad={(e) => setPx({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
      />
    </span>
  );
}

function Viewer({ url, crop }: Shown): ReactNode {
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
        {crop ? (
          <CroppedImage url={url} crop={crop} zoom={zoom} />
        ) : (
          <img
            src={url}
            alt=""
            data-zoom={zoom}
            style={fit ? { maxWidth: "100%", width: "auto" } : { maxWidth: "none", width: `${zoom * 100}%` }}
          />
        )}
      </div>
    </div>
  );
}

export function ImageViewer(): ReactNode {
  const s = useSyncExternalStore(subscribe, getSnapshot);
  return s ? <Viewer key={`${s.url}|${JSON.stringify(s.crop)}`} url={s.url} crop={s.crop} /> : null;
}
