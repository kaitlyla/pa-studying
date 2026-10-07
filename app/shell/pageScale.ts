// With the laptop sidebar open, the page keeps the layout it has with the sidebar hidden (same line
// breaks, table columns and picture sizes) and is drawn smaller with a transform to fit beside it.
// A transform only changes how the laid-out page is drawn, so every line breaks where it does with the
// sidebar hidden; CSS zoom re-measures text at the smaller size and moves some line breaks.
import { createContext, useLayoutEffect, useRef, type RefObject } from "react";

export interface PageScale {
  /** The page content's layout width in px: what it gets with the sidebar hidden. */
  width: number;
  /** The drawn size relative to the layout size. */
  scale: number;
}

/**
 * The scale for the page beside the open sidebar. `main` is the scrolling area's width, `inset` the
 * page frame's horizontal padding, `side` the open sidebar's width, `rail` the hidden sidebar's rail,
 * `max` the frame's maximum width. Null when hiding the sidebar would not widen the page content.
 */
export function openSidebarScale(main: number, inset: number, side: number, rail: number, max: number): PageScale | null {
  const shown = Math.min(main, max) - inset;
  const width = Math.min(main + side - rail, max) - inset;
  if (!(shown > 0) || !(width > shown)) return null;
  return { width, scale: shown / width };
}

/**
 * Where bars that stick to the top of the page area render (the edit toolbar): inside the page frame
 * but outside the scaled content, since a sticky element inside a transform scrolls away with it.
 */
export const PageBarSlot = createContext<HTMLElement | null>(null);

function px(style: CSSStyleDeclaration, name: string): number {
  return parseFloat(style.getPropertyValue(name));
}

/**
 * A ref for the page content inside the scrolling `main`; while `sidebarOpen`, it keeps the content at
 * its sidebar-hidden layout, drawn smaller to fit.
 */
export function usePageScale(main: RefObject<HTMLElement | null>, sidebarOpen: boolean): RefObject<HTMLDivElement | null> {
  const page = useRef<HTMLDivElement>(null);
  const shownScale = useRef(1);
  useLayoutEffect(() => {
    const m = main.current;
    const el = page.current;
    const frame = el?.parentElement;
    if (!m || !el || !frame || !sidebarOpen || typeof ResizeObserver === "undefined") return;
    // Keeps the line at the top of the view in place when the scale changes. A transform moves nothing
    // in the layout, so the browser's scroll anchoring can't; and it is off while this runs, since the
    // sidebar has already narrowed `main` and anchoring would follow the page's brief reflow at that width.
    const show = (s: PageScale | null): void => {
      const before = shownScale.current;
      const after = s?.scale ?? 1;
      const top = el.getBoundingClientRect().top - m.getBoundingClientRect().top + m.scrollTop;
      const at = (m.scrollTop - top) / before;
      if (s) {
        el.style.width = `${s.width}px`;
        el.style.transform = `scale(${s.scale})`;
        el.style.transformOrigin = "0 0";
        // The transform leaves the layout box at full size; take back the height not drawn, and clip
        // the rest, which some browsers (Firefox) still count as scrollable.
        el.style.marginBottom = `${-el.offsetHeight * (1 - s.scale)}px`;
        frame.style.overflow = "clip";
      } else {
        for (const p of ["width", "transform", "transform-origin", "margin-bottom"]) el.style.removeProperty(p);
        frame.style.removeProperty("overflow");
      }
      shownScale.current = after;
      if (after !== before && at > 0) m.scrollTop = top + at * after;
    };
    const withoutAnchoring = (update: () => void): void => {
      m.style.overflowAnchor = "none";
      update();
      m.style.removeProperty("overflow-anchor");
    };
    const apply = (): void =>
      withoutAnchoring(() => {
        const vars = getComputedStyle(m);
        const box = getComputedStyle(frame);
        const inset = px(box, "padding-left") + px(box, "padding-right");
        show(openSidebarScale(m.clientWidth, inset, px(vars, "--side-w"), px(vars, "--rail-w"), px(vars, "--page-max")));
      });
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(m);
    ro.observe(el);
    return () => {
      ro.disconnect();
      withoutAnchoring(() => show(null));
    };
  }, [main, sidebarOpen]);
  return page;
}
