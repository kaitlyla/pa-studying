// Floating pictures in the editor (anchored.float): the frame they are laid out in, the same layout
// as the reader's (render/floats.ts); moving one by dragging it; and Wrap text / In line with text.
import type { Node as PMNode } from "prosemirror-model";
import { NodeSelection, Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { FLOAT_FRAME, FLOAT_PIC, FX, FX_END, settleFloats, watchFloats } from "../../render/floats.ts";
import { selectedPicture, type Command } from "./commands.ts";
import { N } from "./types.ts";

/** Whether a doc has a floating picture anywhere (and so is drawn as a float frame). */
export function hasFloat(doc: PMNode): boolean {
  let found = false;
  doc.descendants((n) => {
    if (found) return false;
    if (n.type === N.anchored && n.attrs.float != null) found = true;
    return !found;
  });
  return found;
}

function marker(cls: string): () => HTMLElement {
  return () => {
    const d = document.createElement("div");
    d.className = cls;
    d.setAttribute("aria-hidden", "true");
    d.contentEditable = "false";
    return d;
  };
}

/**
 * The frame's region starts (render/floats.ts): one at the doc's start, one after each table and one at
 * the start of every table cell; and its end. None in a doc without floating pictures.
 */
export function frameDecorations(doc: PMNode): DecorationSet {
  if (!hasFloat(doc)) return DecorationSet.empty;
  const at = (pos: number, cls: string, key: string, side: number): Decoration =>
    Decoration.widget(pos, marker(cls), { key, side, ignoreSelection: true });
  const out = [at(0, FX, "fx-0", -1)];
  doc.forEach((child, offset) => {
    if (child.type === N.table) out.push(at(offset + child.nodeSize, FX, `fx-${offset + child.nodeSize}`, -1));
  });
  doc.descendants((n, pos) => {
    if (n.type === N.table_cell) out.push(at(pos + 1, FX, `fxc-${pos}`, -1));
    return true;
  });
  out.push(at(doc.content.size, FX_END, "fx-end", 1));
  return DecorationSet.create(doc, out);
}

/** Where a picture floats: before the block at `anchorPos` (in body text or a table cell), offset by dx/dy. */
export interface FloatPlace {
  anchorPos: number;
  dxPt: number;
  dyPt: number;
}

/**
 * Makes the selected picture float at `place`: an inline picture, a picture in an anchor, or a
 * floating one moved. It goes into a floating anchor before the block at `place.anchorPos`, which must
 * be a block of body text or of a table cell, and stays selected.
 */
export function floatPicture(place: FloatPlace): Command {
  return (state, dispatch) => {
    const sel = selectedPicture(state);
    if (!sel) return false;
    const $pic = sel.$from;
    const inAnchor = sel.node.type === N.image_block && $pic.parent.type === N.anchored;
    if (sel.node.type !== N.image && !inAnchor) return false;
    const from = inAnchor ? $pic.before() : sel.from;
    const to = inAnchor ? $pic.after() : sel.to;
    if (place.anchorPos > from && place.anchorPos < to) return false;
    const $anchor = state.doc.resolve(place.anchorPos);
    if ($anchor.parent !== state.doc && $anchor.parent.type !== N.table_cell) return false;
    const target = $anchor.nodeAfter;
    if (!target || !target.isBlock) return false;
    const node = N.anchored.create({ offsetPt: 0, float: { dxPt: place.dxPt, dyPt: Math.max(0, place.dyPt) } }, N.image_block.create(sel.node.attrs));
    if (!dispatch) return true;
    const tr = state.tr.delete(from, to);
    const at = tr.mapping.map(place.anchorPos);
    tr.insert(at, node);
    tr.setSelection(NodeSelection.create(tr.doc, at + 1));
    dispatch(tr);
    return true;
  };
}

/**
 * In line with text: the selected floating picture goes back into the text, at the start of the
 * paragraph it floated by (in a paragraph of its own where that block is not one), and stays selected.
 */
export const inlinePicture: Command = (state, dispatch) => {
  const sel = selectedPicture(state);
  if (!sel) return false;
  const $pic = sel.$from;
  if ($pic.parent.type !== N.anchored || $pic.parent.attrs.float == null) return false;
  if (!dispatch) return true;
  const from = $pic.before();
  const to = $pic.after();
  const image = N.image.create(sel.node.attrs);
  const next = state.doc.resolve(to).nodeAfter;
  const tr = next?.type === N.paragraph
    ? state.tr.insert(to + 1, image).delete(from, to)
    : state.tr.replaceWith(from, to, N.paragraph.create(null, image));
  // Either way the picture now starts the paragraph where its anchor was.
  dispatch(tr.setSelection(NodeSelection.create(tr.doc, from + 1)));
  return true;
};

/** The CSS scale an element is drawn at (the open sidebar's), so client px divide back to layout px. */
const scaleOf = (el: HTMLElement): number => (el.offsetWidth > 0 ? el.getBoundingClientRect().width / el.offsetWidth : 1) || 1;

/** An element's content box (inside its border and padding) in client px, drawn at scale `s`. */
function contentBox(el: HTMLElement, s: number): { left: number; right: number } {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const px = (v: string): number => (parseFloat(v) || 0) * s;
  return {
    left: r.left + px(cs.borderLeftWidth) + px(cs.paddingLeft),
    right: r.right - px(cs.borderRightWidth) - px(cs.paddingRight),
  };
}

/**
 * Where a picture drawn at `box` (client px) floats if left there: in the column under its top-left
 * corner (the innermost table cell there, else body text), kept within that cell's table or the body
 * column; before the last block of that column whose top is at or above the picture's (its first
 * block when none is), dx from the column's left and dy from that block's top. Null outside the frame.
 */
export function placeFloat(view: EditorView, box: DOMRect, basePt: number): FloatPlace | null {
  const frame = view.dom;
  const doc = view.state.doc;
  const x = box.left + 1;
  const y = box.top + 1;
  let cellPos: number | null = null;
  let cellEl: HTMLElement | null = null;
  doc.descendants((n, pos) => {
    if (n.type !== N.table_cell) return true;
    const td = view.nodeDOM(pos);
    if (td instanceof HTMLElement) {
      const r = td.getBoundingClientRect();
      if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) {
        cellPos = pos;
        cellEl = td;
      }
    }
    return true;
  });
  const column = cellPos === null ? doc : doc.nodeAt(cellPos);
  const start = cellPos === null ? 0 : cellPos + 1;
  const columnEl: HTMLElement = cellEl ?? frame;
  if (!column) return null;
  // The column's content box (where its region start, the .fx, sits once anything floats).
  const s = scaleOf(frame);
  const { left } = contentBox(columnEl, s);
  const table = cellEl ? (cellEl as HTMLElement).closest("table") : null;
  const bounds = table ? table.getBoundingClientRect() : contentBox(frame, s);
  const picLeft = Math.max(bounds.left, Math.min(box.left, bounds.right - box.width));
  const blocks: { pos: number; top: number }[] = [];
  column.forEach((child, offset) => {
    if (child.type === N.anchored && child.attrs.float != null) return;
    const dom = view.nodeDOM(start + offset);
    if (dom instanceof HTMLElement) blocks.push({ pos: start + offset, top: dom.getBoundingClientRect().top });
  });
  const at = blocks.findLast((b) => b.top <= box.top + 0.5) ?? blocks[0];
  if (!at) return null;
  const emPx = parseFloat(getComputedStyle(columnEl).fontSize) || 16;
  const pt = (px: number): number => Math.round((px / s / emPx) * basePt * 10) / 10;
  return { anchorPos: at.pos, dxPt: pt(picLeft - left), dyPt: Math.max(0, pt(box.top - at.top)) };
}

/** How far (px) the pointer moves before a press on a floating picture becomes a move. */
const MOVE_SLOP_PX = 3;

/**
 * A press on a floating picture selects it; dragging it moves it there, the text it no longer covers
 * moving back and the text it now covers moving aside, and nothing else. Escape puts it back.
 */
function startMove(view: EditorView, e: PointerEvent, basePt: number): boolean {
  if (e.button !== 0 || !(e.target instanceof Element)) return false;
  const pic = e.target.closest(`.${FLOAT_PIC}`);
  if (!(pic instanceof HTMLElement) || !view.dom.contains(pic)) return false;
  const inside = view.posAtDOM(pic, 0);
  const $in = view.state.doc.resolve(inside);
  if ($in.parent.type !== N.anchored || view.state.doc.nodeAt(inside)?.type !== N.image_block) return false;
  e.preventDefault();
  view.focus();
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, inside)));
  const s = scaleOf(view.dom);
  const left0 = parseFloat(pic.style.left) || 0;
  const top0 = parseFloat(pic.style.top) || 0;
  let moving = false;
  const move = (ev: PointerEvent): void => {
    const dx = ev.clientX - e.clientX;
    const dy = ev.clientY - e.clientY;
    if (!moving && Math.hypot(dx, dy) < MOVE_SLOP_PX) return;
    moving = true;
    pic.style.left = `${left0 + dx / s}px`;
    pic.style.top = `${top0 + dy / s}px`;
  };
  const end = (drop: boolean): void => {
    pic.removeEventListener("pointermove", move);
    pic.removeEventListener("pointerup", up);
    pic.removeEventListener("pointercancel", cancel);
    pic.ownerDocument.removeEventListener("keydown", key, true);
    if (pic.hasPointerCapture(e.pointerId)) pic.releasePointerCapture(e.pointerId);
    if (!moving) return;
    const place = drop ? placeFloat(view, pic.getBoundingClientRect(), basePt) : null;
    if (place && floatPicture(place)(view.state, view.dispatch)) return;
    // Not moved after all: drawn again where it was.
    settleFloats(view.dom, true);
  };
  const up = (): void => end(true);
  const cancel = (): void => end(false);
  const key = (ev: KeyboardEvent): void => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    end(false);
  };
  pic.setPointerCapture(e.pointerId);
  pic.addEventListener("pointermove", move);
  pic.addEventListener("pointerup", up);
  pic.addEventListener("pointercancel", cancel);
  pic.ownerDocument.addEventListener("keydown", key, true);
  return true;
}

interface FloatsState {
  decorations: DecorationSet;
  floats: boolean;
}

const floatsKey = new PluginKey<FloatsState>("floats");

function floatsState(doc: PMNode): FloatsState {
  const decorations = frameDecorations(doc);
  return { decorations, floats: decorations !== DecorationSet.empty };
}

/**
 * Floating pictures in an editor: the frame and its region starts while the doc has any, laid out
 * (watchFloats) whenever the doc changes or the editor is resized; and, where its text is drawn at a
 * known `basePt` (her page editors), moving them by dragging.
 */
export function floatsPlugin(basePt: number | null): Plugin<FloatsState> {
  return new Plugin<FloatsState>({
    key: floatsKey,
    state: {
      init: (_, state) => floatsState(state.doc),
      apply: (tr, old) => (tr.docChanged ? floatsState(tr.doc) : old),
    },
    props: {
      decorations: (state) => floatsKey.getState(state)?.decorations,
      attributes: (state): Record<string, string> => (floatsKey.getState(state)?.floats ? { class: FLOAT_FRAME } : {}),
      handleDOMEvents: {
        pointerdown: (view, e) => basePt !== null && startMove(view, e, basePt),
        // A floating picture moves by startMove, never by the browser's drag and drop.
        dragstart: (_view, e) => {
          if (!(e.target instanceof Element) || !e.target.closest(`.${FLOAT_PIC}`)) return false;
          e.preventDefault();
          return true;
        },
      },
    },
    view: (view) => {
      let watch: ReturnType<typeof watchFloats> | null = null;
      let doc = view.state.doc;
      const sync = (redraw: boolean): void => {
        if (!floatsKey.getState(view.state)?.floats) {
          watch?.stop();
          watch = null;
        } else if (!watch) watch = watchFloats(view.dom);
        else if (redraw) watch.redraw();
      };
      sync(true);
      return {
        update: (v) => {
          const changed = v.state.doc !== doc;
          doc = v.state.doc;
          sync(changed);
        },
        destroy: () => watch?.stop(),
      };
    },
  });
}
