// Word's picture handles: a selected picture gets eight, drawn over it. A corner scales it, its
// proportions kept; a side handle squishes or stretches it, changing only its width or its height.
// While dragging the picture itself previews the size; on release it takes it in one change, through
// the same limits as Picture − / +; Escape or a cancelled pointer leaves it as it was.
// In crop mode the same eight handles trim its edges instead: the whole file is shown faded around
// the part it keeps, and a drag moves that part's edges.
import { useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Crop } from "../../lib/schemaTypes.ts";
import { croppedImageStyle, em, imageTransform } from "../render/styles.ts";
import {
  cropWindow, draggedPictureCrop, draggedPictureSize, PICTURE_HANDLES, seenPictureSize, shownPictureWidth, unturnedDrag,
  type PictureCrop, type PictureHandle, type PictureSize, type PictureTurn,
} from "./editor/commands.ts";

/** Crop mode: the picture's crop now, and the one change a crop drag makes. */
export interface PictureCropping {
  crop: Crop | null;
  onCrop: (start: PictureCrop, handle: PictureHandle, dxPt: number, dyPt: number) => void;
}

export interface PictureHandlesProps {
  /** The selected picture's box (its img, or the element clipping a cropped one), once the page has drawn it. */
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
  /** Set: the handles crop the picture instead of resizing it. */
  cropping?: PictureCropping | null;
}

const CURSOR: Record<PictureHandle, string> = {
  nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
};

/** The img a picture's box shows: the box itself, or the img a cropped picture's box clips. */
export function pictureFile(box: Element | null): HTMLImageElement | null {
  if (box instanceof HTMLImageElement) return box;
  const img = box?.querySelector("img");
  return img instanceof HTMLImageElement ? img : null;
}

/** Shows the picture at `s` while she drags, as imageStyle would draw it. */
function preview(img: HTMLElement, s: PictureSize, basePt: number): void {
  Object.assign(img.style, { width: em(s.widthPt, basePt), maxWidth: "100%", height: "auto", aspectRatio: `${s.widthPt} / ${s.heightPt}` });
}

const pct = (f: number): string => `${f * 100}%`;
const NO_CROP: Crop = { l: 0, t: 0, r: 0, b: 0 };

export function PictureHandles({ find, basePt, size, limit, turn = {}, onResize, cropping = null }: PictureHandlesProps): ReactNode {
  const box = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const win = useRef<HTMLDivElement>(null);
  const kept = useRef<HTMLImageElement>(null);
  const cropOn = cropping !== null;
  const crop = cropping?.crop ?? null;
  // Crop mode: the crop a drag would make (null: the picture's own), drawn by the place loop below.
  const dragged = useRef<{ crop: Crop | null } | null>(null);
  const { rot = 0, flipH = false, flipV = false } = turn;

  // The handles follow the picture wherever it moves (scrolling, the sidebar, the window, a new size).
  // In crop mode the picture is hidden behind the faded whole file and the kept part drawn over it, and
  // the handles sit on that kept part.
  useLayoutEffect(() => {
    let frame = 0;
    let hidden: HTMLElement | null = null;
    const show = (el: HTMLElement | null): void => {
      if (hidden && hidden !== el) hidden.style.visibility = "";
      hidden = el;
      if (el) el.style.visibility = "hidden";
    };
    const place = (): void => {
      const el = box.current;
      const pic = find();
      const r = pic instanceof HTMLElement && pic.isConnected ? pic.getBoundingClientRect() : null;
      const g = ghost.current;
      const w = win.current;
      const k = kept.current;
      if (cropOn && g && w && k && pic instanceof HTMLElement && r && r.width > 0) {
        show(pic);
        const quarter = Math.abs(rot % 180) === 90;
        Object.assign(g.style, {
          left: `${r.left + r.width / 2}px`,
          top: `${r.top + r.height / 2}px`,
          width: `${quarter ? r.height : r.width}px`,
          height: `${quarter ? r.width : r.height}px`,
          transform: `translate(-50%, -50%) ${imageTransform({ rot, flipH, flipV }) ?? ""}`,
        });
        const src = pictureFile(pic)?.currentSrc ?? "";
        for (const img of g.querySelectorAll("img")) if (img.getAttribute("src") !== src) img.setAttribute("src", src);
        const next = dragged.current ? dragged.current.crop : crop;
        const at = cropWindow(crop, next);
        Object.assign(w.style, { left: pct(at.left), top: pct(at.top), width: pct(at.width), height: pct(at.height) });
        Object.assign(k.style, croppedImageStyle(next ?? NO_CROP));
        g.hidden = false;
      } else {
        show(null);
        if (g) g.hidden = true;
      }
      if (el) {
        const shown = cropOn && w && g && !g.hidden ? w.getBoundingClientRect() : r;
        el.hidden = !shown || shown.width <= 0;
        if (shown) Object.assign(el.style, { left: `${shown.left}px`, top: `${shown.top}px`, width: `${shown.width}px`, height: `${shown.height}px` });
      }
      frame = requestAnimationFrame(place);
    };
    place();
    return () => {
      cancelAnimationFrame(frame);
      show(null);
    };
  }, [find, cropOn, crop, rot, flipH, flipV]);

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
    // Escape mid-drag is caught on the window, ahead of the document, so it only cancels the drag
    // (crop mode, which Escape also ends, stays on).
    const view = knob.ownerDocument.defaultView ?? window;
    const drag = (ev: PointerEvent) => unturnedDrag(handle, (ev.clientX - x0) * ptPerPx, (ev.clientY - y0) * ptPerPx, turn);

    const move = (ev: PointerEvent): void => {
      const d = drag(ev);
      if (cropping) dragged.current = { crop: draggedPictureCrop({ size: start, crop }, d.handle, d.dx, d.dy, limit).crop };
      else preview(img, draggedPictureSize(start, d.handle, d.dx, d.dy, limit), basePt);
    };
    const stop = (): void => {
      dragged.current = null;
      if (!cropping) img.style.cssText = css;
      knob.removeEventListener("pointermove", move);
      knob.removeEventListener("pointerup", up);
      knob.removeEventListener("pointercancel", stop);
      view.removeEventListener("keydown", key, true);
      if (knob.hasPointerCapture(e.pointerId)) knob.releasePointerCapture(e.pointerId);
    };
    const up = (ev: PointerEvent): void => {
      const d = drag(ev);
      stop();
      if (d.dx === 0 && d.dy === 0) return;
      if (cropping) cropping.onCrop({ size: start, crop }, d.handle, d.dx, d.dy);
      else onResize(start, d.handle, d.dx, d.dy);
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
    view.addEventListener("keydown", key, true);
  };

  return createPortal(
    <>
      {cropOn && (
        <div className="pic-crop-ghost" ref={ghost} hidden aria-hidden="true" data-ref="pic-crop-ghost">
          <img alt="" className="faded" style={croppedImageStyle(crop ?? NO_CROP)} />
          <div className="pic-crop-win" ref={win} data-ref="pic-crop-window">
            <img alt="" ref={kept} />
          </div>
        </div>
      )}
      <div className={cropping ? "pic-handles crop" : "pic-handles"} ref={box} hidden aria-hidden="true" data-ref="pic-handles">
        {PICTURE_HANDLES.map((h) => (
          <span
            key={h}
            className={`pic-handle ${h}`}
            title={cropping ? "Drag to crop" : "Drag to resize"}
            style={{ cursor: CURSOR[h] }}
            data-ref={`pic-handle-${h}`}
            onPointerDown={grab(h)}
            onMouseDown={(e) => e.preventDefault()}
          />
        ))}
      </div>
    </>,
    document.body,
  );
}
