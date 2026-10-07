// Word's picture handles: a selected picture gets eight, drawn over it. A corner scales it, its
// proportions kept; a side handle squishes or stretches it, changing only its width or its height.
// While dragging the picture itself previews the size; on release it takes it in one change, through
// the same limits as Picture − / +; Escape or a cancelled pointer leaves it as it was.
import { useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { em } from "../render/styles.ts";
import {
  draggedPictureSize, PICTURE_HANDLES, seenPictureSize, shownPictureWidth, unturnedDrag, type PictureHandle, type PictureSize, type PictureTurn,
} from "./editor/commands.ts";

export interface PictureHandlesProps {
  /** The selected picture's img, once the page has drawn it. */
  find: () => Element | null;
  /** Its widths are set in em of this size. */
  basePt: number;
  /**
   * Its size, read when a drag starts: an unsized figure's size is the width it is shown at, which only
   * the page as drawn (with the figure marked picked) can tell. Null when it is gone.
   */
  size: () => PictureSize | null;
  limit: PictureSize;
  turn?: PictureTurn;
  /** The one change a drag makes: `handle` (in the picture's own frame) dragged by (dxPt, dyPt) from `start`. */
  onResize: (start: PictureSize, handle: PictureHandle, dxPt: number, dyPt: number) => void;
}

const CURSOR: Record<PictureHandle, string> = {
  nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
};

/** Shows the picture at `s` while she drags, as imageStyle would draw it. */
function preview(img: HTMLElement, s: PictureSize, basePt: number): void {
  Object.assign(img.style, { width: em(s.widthPt, basePt), maxWidth: "100%", height: "auto", aspectRatio: `${s.widthPt} / ${s.heightPt}` });
}

export function PictureHandles({ find, basePt, size, limit, turn = {}, onResize }: PictureHandlesProps): ReactNode {
  const box = useRef<HTMLDivElement>(null);

  // The handles follow the picture wherever it moves (scrolling, the sidebar, the window, a new size).
  useLayoutEffect(() => {
    let frame = 0;
    const place = (): void => {
      const el = box.current;
      const img = find();
      if (el) {
        const r = img instanceof HTMLElement && img.isConnected ? img.getBoundingClientRect() : null;
        el.hidden = !r || r.width <= 0;
        if (r) Object.assign(el.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      }
      frame = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, [find]);

  const grab = (handle: PictureHandle) => (e: ReactPointerEvent<HTMLSpanElement>): void => {
    if (e.button !== 0) return;
    const img = find();
    if (!(img instanceof HTMLElement) || img.offsetWidth <= 0) return;
    const emPx = parseFloat(getComputedStyle(img).fontSize);
    const now = size();
    if (!(emPx > 0) || !now) return;
    e.preventDefault();
    const knob = e.currentTarget;
    knob.setPointerCapture(e.pointerId);
    // Drawn px per layout px (the page drawn smaller by a CSS scale), measured along the picture's own width.
    const r = img.getBoundingClientRect();
    const quarter = Math.abs((turn.rot ?? 0) % 180) === 90;
    const scale = (quarter ? r.height : r.width) / img.offsetWidth;
    const ptPerPx = basePt / emPx / scale;
    const start = seenPictureSize(now, shownPictureWidth(img, basePt));
    const css = img.style.cssText;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const drag = (ev: PointerEvent) => unturnedDrag(handle, (ev.clientX - x0) * ptPerPx, (ev.clientY - y0) * ptPerPx, turn);

    const move = (ev: PointerEvent): void => {
      const d = drag(ev);
      preview(img, draggedPictureSize(start, d.handle, d.dx, d.dy, limit), basePt);
    };
    const stop = (): void => {
      img.style.cssText = css;
      knob.removeEventListener("pointermove", move);
      knob.removeEventListener("pointerup", up);
      knob.removeEventListener("pointercancel", stop);
      knob.ownerDocument.removeEventListener("keydown", key, true);
      if (knob.hasPointerCapture(e.pointerId)) knob.releasePointerCapture(e.pointerId);
    };
    const up = (ev: PointerEvent): void => {
      const d = drag(ev);
      stop();
      if (d.dx !== 0 || d.dy !== 0) onResize(start, d.handle, d.dx, d.dy);
    };
    const key = (ev: KeyboardEvent): void => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      stop();
    };
    knob.addEventListener("pointermove", move);
    knob.addEventListener("pointerup", up);
    knob.addEventListener("pointercancel", stop);
    knob.ownerDocument.addEventListener("keydown", key, true);
  };

  return createPortal(
    <div className="pic-handles" ref={box} hidden aria-hidden="true" data-ref="pic-handles">
      {PICTURE_HANDLES.map((h) => (
        <span
          key={h}
          className={`pic-handle ${h}`}
          title="Drag to resize"
          style={{ cursor: CURSOR[h] }}
          data-ref={`pic-handle-${h}`}
          onPointerDown={grab(h)}
          onMouseDown={(e) => e.preventDefault()}
        />
      ))}
    </div>,
    document.body,
  );
}
