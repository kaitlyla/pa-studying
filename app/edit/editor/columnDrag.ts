// Drag a table's column border to resize the two columns beside it, as in Word: while dragging a
// guide line follows the pointer; on release the table's grid takes the new widths (moveColumnBorder,
// the same move as Column narrower / wider), so the widths save and show on the site and in the PDFs.
import { Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { TableAttrs } from "../../../lib/schemaTypes.ts";
import { tableColumns } from "../../render/styles.ts";
import { cellBorder, moveColumnBorder, setTableGrid } from "./commands.ts";
import type { ColumnBorder } from "./commands.ts";

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
  return cellBorder(view.state.doc.resolve(pos), side);
}

/** The x (viewport px) of `border` in a table drawn `box` wide with these widths. */
function borderX(table: Pick<TableAttrs, "grid" | "ownWidths">, border: number, box: DOMRect): number {
  const pct = tableColumns(table).slice(0, border + 1).reduce((a, b) => a + b, 0);
  return box.left + (pct * box.width) / 100;
}

function startDrag(view: EditorView, grab: ColumnBorder, event: MouseEvent): void {
  const tableDom = view.nodeDOM(grab.pos);
  if (!(tableDom instanceof HTMLElement)) return;
  const doc = view.dom.ownerDocument;
  const table = grab.table.attrs as TableAttrs;
  const sum = table.grid.reduce((a, b) => a + b, 0);
  const startX = event.clientX;
  let next: number[] | null = null;

  const guide = doc.createElement("div");
  guide.className = "col-drag-guide";
  const place = (): void => {
    const box = tableDom.getBoundingClientRect();
    Object.assign(guide.style, {
      left: `${borderX(next ? { grid: next, ownWidths: true } : table, grab.border, box)}px`, top: `${box.top}px`, height: `${box.height}px`,
    });
  };
  place();
  doc.body.append(guide);

  const move = (e: MouseEvent): void => {
    const width = tableDom.getBoundingClientRect().width;
    if (width <= 0) return;
    next = moveColumnBorder(table, grab.border, ((e.clientX - startX) * sum) / width);
    place();
  };
  const stop = (): void => {
    guide.remove();
    doc.removeEventListener("mousemove", move);
    doc.removeEventListener("mouseup", up);
    doc.removeEventListener("keydown", key, true);
    view.dom.style.cursor = "";
  };
  const up = (e: MouseEvent): void => {
    move(e);
    stop();
    // Applied only to the table as it was grabbed: an edit during the drag leaves it alone.
    if (next && view.state.doc.nodeAt(grab.pos) === grab.table) view.dispatch(setTableGrid(view.state, grab.pos, next));
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

export function columnDrag(): Plugin {
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
          startDrag(view, grab, event);
          return true;
        },
      },
    },
  });
}
