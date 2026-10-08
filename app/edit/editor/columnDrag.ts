// Drag a table's column border to resize the two columns beside it, as in Word: while dragging a
// guide line follows the pointer; on release the new widths go where Column narrower / wider puts them
// (widthTarget: the table's grid, or a dx's rows) by the same move (moveBorder), so the widths
// save and show on the site and in the PDFs. A change reaching other dxs is applied after her confirm.
import { Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { cellBorder, moveBorder, setWidths } from "./commands.ts";
import type { ColumnBorder, Confirm } from "./commands.ts";

/** How close to a cell's edge, in px, the pointer grabs the border. */
export const BORDER_GRAB_PX = 4;

/** The column border under the pointer, if any: the left or right edge of the cell it is over. */
export function borderAt(view: EditorView, event: MouseEvent): ColumnBorder | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const td = target.closest("td");
  if (!td || !view.dom.contains(td)) return null;
  const box = td.getBoundingClientRect();
  const side = box.right - event.clientX <= BORDER_GRAB_PX ? "right" : event.clientX - box.left <= BORDER_GRAB_PX ? "left" : null;
  if (!side) return null;
  let pos: number;
  try {
    pos = view.posAtDOM(td, 0);
  } catch {
    return null;
  }
  return cellBorder(view.state.doc.resolve(pos), side, view.state);
}

/** The x (viewport px) of `border` in a table drawn `box` wide with these widths. */
function borderX(widths: readonly number[], border: number, box: DOMRect): number {
  const sum = widths.reduce((a, b) => a + b, 0);
  const upTo = widths.slice(0, border + 1).reduce((a, b) => a + b, 0);
  return box.left + (sum > 0 ? (upTo * box.width) / sum : 0);
}

function startDrag(view: EditorView, grab: ColumnBorder, event: MouseEvent, confirm: Confirm): void {
  const { target } = grab;
  const tableDom = view.nodeDOM(target.pos);
  if (!(tableDom instanceof HTMLElement)) return;
  const doc = view.dom.ownerDocument;
  const sum = target.widths.reduce((a, b) => a + b, 0);
  const startX = event.clientX;
  let next: number[] | null = null;

  const guide = doc.createElement("div");
  guide.className = "col-drag-guide";
  const place = (): void => {
    const box = tableDom.getBoundingClientRect();
    Object.assign(guide.style, { left: `${borderX(next ?? target.widths, grab.border, box)}px`, top: `${box.top}px`, height: `${box.height}px` });
  };
  place();
  doc.body.append(guide);

  const move = (e: MouseEvent): void => {
    const width = tableDom.getBoundingClientRect().width;
    if (width <= 0) return;
    next = moveBorder(target.widths, grab.border, ((e.clientX - startX) * sum) / width);
    place();
  };
  const stop = (): void => {
    guide.remove();
    doc.removeEventListener("mousemove", move);
    doc.removeEventListener("mouseup", up);
    doc.removeEventListener("keydown", key, true);
    view.dom.style.cursor = "";
  };
  // Applied only to the table as it was grabbed: an edit during the drag or the confirm leaves it alone.
  const apply = (widths: number[]): void => {
    if (view.state.doc.nodeAt(target.pos) === target.table) view.dispatch(setWidths(view.state, target, widths));
  };
  const up = (e: MouseEvent): void => {
    move(e);
    stop();
    const widths = next;
    if (!widths) return;
    if (target.reach.length === 0) apply(widths);
    else void confirm(target.reach).then((ok) => { if (ok) apply(widths); });
  };
  const key = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    stop();
  };
  doc.addEventListener("mousemove", move);
  doc.addEventListener("mouseup", up);
  doc.addEventListener("keydown", key, true);
}

/** `confirm` asks her before a drag that changes other dxs' rows takes effect. */
export function columnDrag(confirm: Confirm): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        mousemove(view, event) {
          if (event.buttons !== 0) return false;
          view.dom.style.cursor = view.editable && borderAt(view, event) ? "col-resize" : "";
          return false;
        },
        mouseleave(view) {
          view.dom.style.cursor = "";
          return false;
        },
        mousedown(view, event) {
          if (event.button !== 0 || !view.editable) return false;
          const grab = borderAt(view, event);
          if (!grab) return false;
          event.preventDefault();
          startDrag(view, grab, event, confirm);
          return true;
        },
      },
    },
  });
}
