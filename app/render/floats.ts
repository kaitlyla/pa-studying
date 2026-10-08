// Floating pictures (anchored.float, Word's square wrap): where each is drawn, and the room it takes
// from the text it covers, so that text wraps beside it or continues below it, in body text and in
// table cells alike. Browsers have no CSS exclusions, and a float never reaches out of the block it
// sits in, so each run of flowing text (a "region": a table cell, or the body text from the doc's start
// or a table to the next table) starts with an element of its own (`.fx`) holding floats sized to the
// part of each picture over it. A doc with floating pictures is drawn in one frame (`.float-frame`);
// the reader and the editor both keep it laid out with watchFloats: measure it (measureFloats), lay it
// out (layoutFloats), draw that (applyFloatLayout), and repeat, since each drawing moves text, until
// it settles.

/** A box in a frame's layout px (unscaled by any CSS transform), from the top-left of its padding box. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A block of a region, from `top` to `bottom` in frame px, and where its text goes: its lines start
 * `indent` px right of the region's left, and its first line `hang` px left of that (a hanging indent:
 * a negative text-indent, as her bullets have); they are `lineHeight` px apart from `lineTop`. The
 * room beside a picture is the room for this text, not for the region: an indented block can have
 * none where the region still has some.
 */
export interface TextBlock {
  top: number;
  bottom: number;
  indent: number;
  hang: number;
  lineTop: number;
  lineHeight: number;
}

/** A run of flowing text: its box, and its blocks (top first). */
export interface Region extends Box {
  blocks?: readonly TextBlock[];
}

/**
 * What keeps a picture in: the table it floats over, or the doc's text column. It is moved left or
 * right to stay within `width`, and room is added below `bottom` if it reaches further down.
 */
export interface Frame {
  left: number;
  width: number;
  bottom: number;
}

/**
 * A floating picture: its frame (an index into the frames), where it asks to be drawn (its column's
 * left + dx, the top of the block after it + dy) and its size.
 */
export interface FloatPic {
  frame: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Room a region's text keeps clear of, from the top of the region: `width` from its `side`, so the
 * text runs on the other side, or below when `width` is the whole region.
 */
export interface Exclusion {
  side: "left" | "right";
  top: number;
  width: number;
  height: number;
}

export interface FloatLayout {
  /** Each picture's place (the order of the pictures given). */
  places: { left: number; top: number }[];
  /** Each region's exclusions, top first (the order of the regions given). */
  exclusions: Exclusion[][];
  /** Room added below each frame, so a picture reaching past its end stays inside it (the order of the frames given). */
  below: number[];
}

/**
 * Lays out pictures over regions of text: each picture where it asks to be, moved left or right as
 * needed to stay within its frame's width. In each region a picture covers, the text keeps
 * clear of the part it covers, on the side of the picture with less room, so the text runs on the
 * wider side; when neither side has `minSide` px, the text goes below it. Pictures over the same
 * lines of a region are kept clear together. Any picture covers any region under it: a body picture
 * reaching over a table moves that table's text aside too.
 */
export function layoutFloats(frames: readonly Frame[], regions: readonly Region[], pics: readonly FloatPic[], minSide: number): FloatLayout {
  const places = pics.map((p) => {
    const f = frames[p.frame];
    if (!f) return { left: p.left, top: p.top };
    return { left: Math.max(f.left, Math.min(p.left, f.left + f.width - p.width)), top: p.top };
  });
  const exclusions = regions.map((c) => {
    const spans = pics
      .map((p, i) => {
        const at = places[i] as { left: number; top: number };
        const x0 = Math.max(at.left, c.left);
        const x1 = Math.min(at.left + p.width, c.left + c.width);
        const y0 = Math.max(at.top, c.top);
        const y1 = Math.min(at.top + p.height, c.top + c.height);
        return x1 > x0 && y1 > y0 ? { x0, x1, y0, y1 } : null;
      })
      .filter((s) => s !== null)
      .sort((a, b) => a.y0 - b.y0);
    const merged: typeof spans = [];
    for (const s of spans) {
      const last = merged.at(-1);
      if (last && s.y0 < last.y1) {
        last.x0 = Math.min(last.x0, s.x0);
        last.x1 = Math.max(last.x1, s.x1);
        last.y1 = Math.max(last.y1, s.y1);
      } else merged.push({ ...s });
    }
    return merged.flatMap((s) => besidePicture(c, s, minSide));
  });
  const below = frames.map((f, fi) => {
    const bottom = Math.max(f.bottom, ...pics.map((p, i) => (p.frame === fi ? (places[i]?.top ?? 0) + p.height : f.bottom)));
    return bottom - f.bottom;
  });
  return { places, exclusions, below };
}

/**
 * The room a region keeps clear beside the part `s` of a picture over it (frame px). The text runs on
 * the picture's side with more room in the region; when neither has `minSide` px, it goes below. Each
 * block beside it then needs `minSide` px from where its own text starts: from the first block that
 * has less (an indented block, or a bullet whose text after the bullet would not fit), the text goes
 * below the picture, bullet and all, rather than leaving the bullet beside it alone. A block with a
 * hanging indent whose first line would start under the picture is kept clear by its hang more, so
 * its bullet starts at the picture's edge and its other lines `hang` further in, as in Word.
 *
 * The room starts at the top of the line the picture's top cuts into: a line moves aside only for
 * room that starts at or above it, and would otherwise stay under the picture. A block's lines above
 * the picture are drawn where its line height puts them, since no room is kept beside them.
 */
function besidePicture(c: Region, span: { x0: number; x1: number; y0: number; y1: number }, minSide: number): Exclusion[] {
  const cut = (c.blocks ?? []).find((b) => b.top <= span.y0 && span.y0 < b.bottom);
  const lineTop = cut && cut.lineHeight > 0 ? cut.lineTop + Math.floor((span.y0 - cut.lineTop) / cut.lineHeight + 1e-6) * cut.lineHeight : span.y0;
  const s = { ...span, y0: Math.max(c.top, cut ? cut.top : c.top, Math.min(span.y0, lineTop)) };
  const right = c.left + c.width;
  const leftRoom = s.x0 - c.left;
  const rightRoom = right - s.x1;
  const out: Exclusion[] = [];
  const keep = (side: Exclusion["side"], y0: number, y1: number, width: number): void => {
    if (y1 <= y0) return;
    const last = out.at(-1);
    if (last && last.side === side && Math.abs(last.width - width) < 0.5 && Math.abs(last.top + last.height - (y0 - c.top)) < 0.5) last.height = y1 - c.top - last.top;
    else out.push({ side, top: y0 - c.top, width, height: y1 - y0 });
  };
  if (Math.max(leftRoom, rightRoom) < minSide) {
    keep("left", s.y0, s.y1, c.width);
    return out;
  }
  const textLeft = rightRoom < leftRoom;
  // Text on the left ends at the picture; text on the right starts at it, or further in for a block
  // indented past it, and its bullet must not start under it.
  const side: Exclusion["side"] = textLeft ? "right" : "left";
  const plain = textLeft ? right - s.x0 : s.x1 - c.left;
  const beside = (b: TextBlock): { room: number; width: number } => {
    const start = c.left + b.indent;
    if (textLeft) return { room: s.x0 - start, width: plain };
    const edge = b.hang > 0 && start - b.hang < s.x1 ? s.x1 + b.hang : s.x1;
    return { room: right - Math.max(start, edge), width: Math.min(c.width, edge - c.left) };
  };
  let y = s.y0;
  for (const b of c.blocks ?? []) {
    const y0 = Math.max(b.top, y);
    const y1 = Math.min(b.bottom, s.y1);
    if (y1 <= y0) continue;
    keep(side, y, y0, plain);
    const { room, width } = beside(b);
    if (room < minSide) {
      keep("left", y0, s.y1, c.width);
      return out;
    }
    keep(side, y0, y1, width);
    y = y1;
  }
  keep(side, y, s.y1, plain);
  return out;
}

/** Whether two layouts draw the same, to within half a px. */
export function sameFloatLayout(a: FloatLayout | null, b: FloatLayout): boolean {
  if (!a) return false;
  const near = (x: number, y: number): boolean => Math.abs(x - y) < 0.5;
  return (
    a.below.length === b.below.length &&
    a.below.every((x, i) => near(x, b.below[i] ?? NaN)) &&
    a.places.length === b.places.length &&
    a.places.every((p, i) => near(p.left, b.places[i]?.left ?? NaN) && near(p.top, b.places[i]?.top ?? NaN)) &&
    a.exclusions.length === b.exclusions.length &&
    a.exclusions.every((list, i) => {
      const other = b.exclusions[i] ?? [];
      return list.length === other.length && list.every((e, j) => {
        const o = other[j];
        return !!o && e.side === o.side && near(e.top, o.top) && near(e.width, o.width) && near(e.height, o.height);
      });
    })
  );
}

/** The browser's layout unit (Chrome lays boxes out in 1/64 px). */
const LAYOUT_UNIT = 1 / 64;

/** `y` rounded up to the layout unit: a box laid out there never starts above `y`. */
function unitCeil(y: number): number {
  return Math.ceil(y / LAYOUT_UNIT) * LAYOUT_UNIT;
}

/**
 * The floats a region's `.fx` holds for its exclusions: for each, a zero-width spacer down to its top,
 * then the room itself. Each clears the floats above it, so they stack down the region in order.
 * Every edge is rounded down the page to the layout unit: a room the browser rounded up even a
 * fraction of a pixel would overlap the line just above its top, and move that line aside too.
 */
export function exclusionFloats(list: readonly Exclusion[]): { float: "left" | "right"; width: number; height: number }[] {
  const out: { float: "left" | "right"; width: number; height: number }[] = [];
  let y = 0;
  for (const e of list) {
    const top = Math.max(y, unitCeil(e.top));
    const bottom = Math.max(top, unitCeil(e.top + e.height));
    out.push({ float: "left", width: 0, height: top - y }, { float: e.side, width: e.width, height: bottom - top });
    y = bottom;
  }
  return out;
}

/** The class of the element a doc with floating pictures is drawn in (positioned, so they are placed in it). */
export const FLOAT_FRAME = "float-frame";
/**
 * The class of a floating picture's element, a block among the blocks of its column; `data-dx`/`data-dy`
 * hold its offset in em.
 */
export const FLOAT_PIC = "float-pic";
/** The class of the zero-height element starting each region: every cell of a grid table, and the body text at the doc's start and after each such table. */
export const FX = "fx";
/** The class of the last element of a frame, which takes the room below the doc a picture reaching past its end needs. */
export const FX_END = "fx-end";

/** Whether a stored doc has a floating picture anywhere (and so is drawn in a frame). */
export function docHasFloat(node: { type: string; attrs?: Record<string, unknown> | null; content?: readonly unknown[] }): boolean {
  if (node.type === "anchored" && node.attrs?.float != null) return true;
  return (node.content ?? []).some((c) => docHasFloat(c as Parameters<typeof docHasFloat>[0]));
}

export interface MeasuredFloats {
  frames: Frame[];
  /** Each frame's element: the frame's end (`.fx-end`) for the doc's column, else its table. */
  frameEls: HTMLElement[];
  regions: Region[];
  regionEls: HTMLElement[];
  pics: FloatPic[];
  picEls: HTMLElement[];
  /** Where each picture's containing block (its table, or the frame) starts, in frame px. */
  picParents: { left: number; top: number }[];
  /** The frame's font size, in px: the em of MIN_SIDE_EM. */
  emPx: number;
}

const isA = (el: Element | null, cls: string): boolean => !!el && el.classList.contains(cls);

/** The element after `el` that is a block of its column, skipping floating pictures. */
function blockAfter(el: Element): Element | null {
  let n = el.nextElementSibling;
  while (n && isA(n, FLOAT_PIC)) n = n.nextElementSibling;
  return n && !isA(n, FX) && !isA(n, FX_END) ? n : null;
}

/** The block before `el`, skipping floating pictures, or null at the start of its region. */
function blockBefore(el: Element): Element | null {
  let n = el.previousElementSibling;
  while (n && isA(n, FLOAT_PIC)) n = n.previousElementSibling;
  return n && !isA(n, FX) ? n : null;
}

/**
 * Reads a drawn frame: its regions (each `.fx` of this frame), its pictures (each `.float-pic`), and
 * the frames they keep within: the doc's text column (frame 0, from its first region to its end) and
 * each grid table holding a picture. Sizes are layout px: a CSS scale on the page (the sidebar) is
 * divided out. Null when the frame is not laid out (not shown).
 */
export function measureFloats(frame: HTMLElement): MeasuredFloats | null {
  if (frame.offsetWidth <= 0) return null;
  const fr = frame.getBoundingClientRect();
  const s = fr.width / frame.offsetWidth || 1;
  const ox = fr.left + frame.clientLeft * s;
  const oy = fr.top + frame.clientTop * s;
  const x = (v: number): number => (v - ox) / s;
  const y = (v: number): number => (v - oy) / s;
  const own = (el: Element): boolean => el.closest(`.${FLOAT_FRAME}`) === frame;
  const end = [...frame.children].find((c) => isA(c, FX_END));
  const first = [...frame.children].find((c) => isA(c, FX));
  if (!(end instanceof HTMLElement) || !(first instanceof HTMLElement)) return null;
  const column = first.getBoundingClientRect();
  const frames: Frame[] = [{ left: x(column.left), width: column.width / s, bottom: y(end.getBoundingClientRect().top) }];
  const frameEls: HTMLElement[] = [end];

  const regions: Region[] = [];
  const regionEls: HTMLElement[] = [];
  for (const fx of frame.querySelectorAll<HTMLElement>(`.${FX}`)) {
    if (!own(fx)) continue;
    const f = fx.getBoundingClientRect();
    const top = y(f.top);
    let bottom: number;
    const blocks: Element[] = [];
    const td = fx.parentElement;
    if (td instanceof HTMLTableCellElement) {
      const cs = getComputedStyle(td);
      bottom = y(td.getBoundingClientRect().bottom) - parseFloat(cs.paddingBottom) - parseFloat(cs.borderBottomWidth);
      blocks.push(...[...td.children].filter((c) => c !== fx));
    } else {
      // Body text runs to the next table (the element before the next region's `.fx`), or to the end.
      let n = fx.nextElementSibling;
      while (n && !isA(n, FX) && !isA(n, FX_END)) {
        blocks.push(n);
        n = n.nextElementSibling;
      }
      const stop = n && isA(n, FX) ? n.previousElementSibling : n;
      bottom = stop ? y(stop.getBoundingClientRect().top) : top;
    }
    const left = x(f.left);
    const starts: TextBlock[] = [];
    for (const b of blocks) {
      if (isA(b, FLOAT_PIC)) continue;
      const cs = getComputedStyle(b);
      const r = b.getBoundingClientRect();
      const indent = x(r.left) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft) - left;
      // A line height of "normal" (no number) leaves the room starting at the picture's top.
      const lineHeight = parseFloat(cs.lineHeight) || 0;
      const lineTop = y(r.top) + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop);
      starts.push({ top: y(r.top), bottom: y(r.bottom), indent, hang: Math.max(0, -parseFloat(cs.textIndent) || 0), lineTop, lineHeight });
    }
    starts.sort((a, b) => a.top - b.top);
    regions.push({ left, top, width: f.width / s, height: Math.max(0, bottom - top), blocks: starts });
    regionEls.push(fx);
  }

  const pics: FloatPic[] = [];
  const picEls: HTMLElement[] = [];
  const picParents: { left: number; top: number }[] = [];
  for (const pic of frame.querySelectorAll<HTMLElement>(`.${FLOAT_PIC}`)) {
    if (!own(pic)) continue;
    const td = pic.parentElement;
    let fi = 0;
    let columnLeft = frames[0]?.left ?? 0;
    let regionTop: number | null = null;
    if (td instanceof HTMLTableCellElement) {
      const table = td.closest("table");
      const fx = td.querySelector(`:scope > .${FX}`);
      if (!table || !(fx instanceof HTMLElement)) continue;
      fi = frameEls.indexOf(table);
      if (fi < 0) {
        const t = table.getBoundingClientRect();
        fi = frames.push({ left: x(t.left), width: t.width / s, bottom: y(t.bottom) }) - 1;
        frameEls.push(table);
      }
      const f = fx.getBoundingClientRect();
      columnLeft = x(f.left);
      regionTop = y(f.top);
    } else if (td !== frame) continue;
    // Its anchor: the top of the block after it; with none, the bottom of the block before it.
    const next = blockAfter(pic);
    const prev = next ? null : blockBefore(pic);
    const anchorTop = next ? y(next.getBoundingClientRect().top) : prev ? y(prev.getBoundingClientRect().bottom) : (regionTop ?? frames[0]?.bottom ?? 0);
    const emPx = parseFloat(getComputedStyle(pic).fontSize) || 16;
    const parent = pic.offsetParent instanceof HTMLElement ? pic.offsetParent : frame;
    const pr = parent.getBoundingClientRect();
    picParents.push({ left: x(pr.left + parent.clientLeft * s) - parent.scrollLeft, top: y(pr.top + parent.clientTop * s) - parent.scrollTop });
    pics.push({
      frame: fi,
      left: columnLeft + Number(pic.dataset.dx) * emPx,
      top: anchorTop + Number(pic.dataset.dy) * emPx,
      width: pic.offsetWidth,
      height: pic.offsetHeight,
    });
    picEls.push(pic);
  }
  return { frames, frameEls, regions, regionEls, pics, picEls, picParents, emPx: parseFloat(getComputedStyle(frame).fontSize) || 16 };
}

/** The room (4 em) a side of a picture needs before the text beside it runs there rather than below it. */
export const MIN_SIDE_EM = 4;

/** Lays out a measured frame: layoutFloats over what measureFloats read. */
export function layoutMeasured(m: MeasuredFloats): FloatLayout {
  return layoutFloats(m.frames, m.regions, m.pics, MIN_SIDE_EM * m.emPx);
}

/** How many times a frame is measured and drawn again before its layout is taken as settled. */
export const MAX_FLOAT_PASSES = 10;

/**
 * Draws a layout on the measured frame: each picture at its place, the room below each frame, and each
 * region's `.fx` filled with its exclusions' floats. The elements are the page's own (the reader's or
 * the editor's), and only their position styles, the room below and the `.fx` contents are written.
 */
export function applyFloatLayout(m: MeasuredFloats, layout: FloatLayout): void {
  m.frameEls.forEach((el, i) => {
    const px = (layout.below[i] ?? 0) > 0 ? `${layout.below[i]}px` : "";
    if (isA(el, FX_END)) el.style.height = px;
    else el.style.marginBottom = px;
  });
  m.picEls.forEach((pic, i) => {
    const at = layout.places[i];
    const parent = m.picParents[i];
    if (!at || !parent) return;
    pic.style.left = `${at.left - parent.left}px`;
    pic.style.top = `${at.top - parent.top}px`;
  });
  m.regionEls.forEach((fx, i) => {
    fx.replaceChildren(...exclusionFloats(layout.exclusions[i] ?? []).map((f) => {
      const d = fx.ownerDocument.createElement("div");
      Object.assign(d.style, { float: f.float, clear: "both", width: `${f.width}px`, height: `${f.height}px` });
      return d;
    }));
  });
}

const drawnLayout = new WeakMap<HTMLElement, FloatLayout>();

/**
 * Lays out a drawn frame's floating pictures, drawing and measuring again until the layout stops
 * changing (each drawing moves text, and so what the pictures cover and where they are anchored).
 * `redraw`: the page drew the frame's regions or pictures anew since the last layout, so the first one
 * is drawn even if unchanged. False when it had not settled after MAX_FLOAT_PASSES.
 */
export function settleFloats(frame: HTMLElement, redraw = false): boolean {
  if (redraw) drawnLayout.delete(frame);
  for (let i = 0; i < MAX_FLOAT_PASSES; i++) {
    const m = measureFloats(frame);
    if (!m) return true;
    const next = layoutMeasured(m);
    if (sameFloatLayout(drawnLayout.get(frame) ?? null, next)) return true;
    applyFloatLayout(m, next);
    drawnLayout.set(frame, next);
  }
  return false;
}

/** Removes the room a layout added below the tables of a frame no longer laid out. */
function clearTables(frame: HTMLElement): void {
  for (const t of frame.querySelectorAll("table")) t.style.marginBottom = "";
}

/**
 * Keeps a frame's floating pictures laid out while it is shown: now (as drawn anew), and whenever its
 * size changes from outside (the window, the sidebar, a picture loading). A frame whose layout did not
 * settle is laid out again only when its width changes, so it cannot keep redrawing itself. Returns
 * the stop, which also takes away the room it added below tables.
 */
export function watchFloats(frame: HTMLElement): { stop: () => void; redraw: () => void } {
  let settled = settleFloats(frame, true);
  let width = frame.offsetWidth;
  const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
    if (!settled && frame.offsetWidth === width) return;
    width = frame.offsetWidth;
    settled = settleFloats(frame);
  });
  ro?.observe(frame);
  // A wide table scrolled sideways moves its cells under a body picture.
  const onScroll = (): void => {
    if (settled) settled = settleFloats(frame);
  };
  frame.addEventListener("scroll", onScroll, true);
  return {
    stop: () => {
      ro?.disconnect();
      frame.removeEventListener("scroll", onScroll, true);
      drawnLayout.delete(frame);
      clearTables(frame);
    },
    redraw: () => {
      width = frame.offsetWidth;
      settled = settleFloats(frame, true);
    },
  };
}
