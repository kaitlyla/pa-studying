// How the editor draws each node and mark (plan 50 §50.3: node views reuse the renderer, 40 §40.6).
// The schema has no toDOM, so every node and mark gets a view here, built from the renderer's own
// style helpers; atoms that hold no editable text are drawn by the renderer's React components.
import { createElement, type CSSProperties } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DOMSerializer } from "prosemirror-model";
import type { DOMOutputSpec, Mark, Node as PMNode } from "prosemirror-model";
import type { MarkViewConstructor, NodeView, NodeViewConstructor, ViewMutationRecord } from "prosemirror-view";
import { TableMap } from "prosemirror-tables";
import { schema } from "../../../lib/schema.ts";
import {
  anchoredOffset, assetUrl, cellStyle, croppedImageStyle, Drawing, em, imageStyle, markerStyle, paragraphStyle, ruleStyle, runStyle,
  tableColumns, tableIndent, textboxStyle, underlineStyle,
} from "../../render/index.ts";
import { cropOrNull } from "../../../lib/crop.ts";
import { FLOAT_PIC } from "../../render/floats.ts";
import { drawnGrid, placeCells } from "../../../lib/wordFormat.ts";
import type { ImageAttrs, ListMarker, MarkJSON, NodeAttrs } from "../../../lib/schemaTypes.ts";
import { N } from "./types.ts";

/** Copies a React style object onto a DOM element. */
export function applyStyle(el: HTMLElement, style: CSSProperties | null | undefined): void {
  if (!style) return;
  for (const [k, v] of Object.entries(style)) {
    if (v === undefined || v === null) continue;
    (el.style as unknown as Record<string, string>)[k] = String(v);
  }
}

function el(tag: string, style?: CSSProperties | null, className?: string): HTMLElement {
  const e = document.createElement(tag);
  applyStyle(e, style);
  if (className) e.className = className;
  return e;
}

/** Whether a DOM change is to `dom`'s own style attribute (one the page's layout writes, not her edit). */
function isOwnStyle(m: ViewMutationRecord, dom: HTMLElement): boolean {
  return m.type === "attributes" && m.target === dom && m.attributeName === "style";
}

/** A view whose DOM is rebuilt whenever the node's attributes change. */
function plain(dom: HTMLElement, contentDOM: HTMLElement | null, node: PMNode): NodeView {
  return {
    dom,
    contentDOM: contentDOM ?? undefined,
    update: (next) => next.type === node.type && next.sameMarkup(node),
  };
}

/**
 * A node's attributes with their stored types. The schema declares each node's attribute specs
 * against lib/schemaTypes.ts (`satisfies`), so a node of type `name` carries `NodeAttrs[name]`.
 */
function attrsOf<K extends keyof NodeAttrs>(node: PMNode, name: K): NodeAttrs[K] {
  if (node.type.name !== name) throw new Error(`Expected a ${name} node, got ${node.type.name}`);
  return node.attrs as NodeAttrs[K];
}

function markerSpan(marker: ListMarker, basePt: number): HTMLElement {
  const span = el("span", markerStyle(marker.tabPt, basePt, marker.font), "marker");
  span.contentEditable = "false";
  let inner: HTMLElement = span;
  const marks = marker.marks;
  const style = runStyle(marks, basePt);
  if (style) {
    const s = el("span", style);
    inner.append(s);
    inner = s;
  }
  for (const m of marks) {
    const tag = m.type === "bold" ? "strong" : m.type === "italic" ? "em" : m.type === "underline" ? "u" : null;
    if (!tag) continue;
    const e = el(tag);
    inner.append(e);
    inner = e;
  }
  inner.textContent = marker.text;
  return span;
}

/** A React-drawn atom (drawing shapes) mounted into a node view, unmounted when the view goes. */
function reactLayer(host: HTMLElement, render: (root: Root) => void): () => void {
  const root = createRoot(host);
  render(root);
  return () => queueMicrotask(() => root.unmount());
}

/**
 * A cell's style in its table: its own fill and borders, the table's default borders for its place
 * (outer edges or inside, from the cell at `offset` within the table) and the table's cell margins.
 */
function tableCellStyle(cell: PMNode, table: PMNode | null, offset: number, basePt: number): CSSProperties {
  const a = attrsOf(cell, "table_cell");
  if (table?.type !== N.table) return cellStyle(a, basePt, null, { top: false, right: false, bottom: false, left: false });
  const t = attrsOf(table, "table");
  const map = TableMap.get(table);
  const rect = map.findCell(offset);
  const edges = { top: rect.top === 0, left: rect.left === 0, bottom: rect.bottom === map.height, right: rect.right === map.width };
  return cellStyle(a, basePt, t.borders, edges, t.cellMarginPt);
}

/**
 * The grid layout of a table (which cell, by document order, covers each grid slot) as a comparable
 * string. Cell offsets are replaced by ordinals so typing inside a cell leaves the shape unchanged.
 */
function gridShape(table: PMNode): string {
  const map = TableMap.get(table);
  const ordinal = new Map([...new Set(map.map)].sort((a, b) => a - b).map((offset, i) => [offset, i]));
  return `${map.width}x${map.height}:${map.map.map((o) => ordinal.get(o)).join(",")}`;
}

/** How a table is drawn (drawnGrid): its columns in % and each cell's drawn column span, by the cell's offset in the table. */
interface DrawnTable {
  pct: number[];
  colspan: Map<number, number>;
  /** Compares equal while the drawing's columns stay the same; with row widths, while the widths do too. */
  key: string;
}

const drawnTables = new WeakMap<PMNode, DrawnTable>();

/** A table's drawing: rows with their own widths (one dx's) put their cells' edges where those widths do. */
function drawnTable(table: PMNode): DrawnTable {
  const cached = drawnTables.get(table);
  if (cached) return cached;
  const rows: PMNode[] = [];
  const offsets: number[][] = [];
  table.forEach((row, rowOffset) => {
    rows.push(row);
    const list: number[] = [];
    row.forEach((_cell, cellOffset) => list.push(rowOffset + 1 + cellOffset));
    offsets.push(list);
  });
  const byRow: { col: number; colspan: number }[][] = rows.map(() => []);
  for (const c of placeCells(rows.map((r) => ({ content: r.children }))).cells) byRow[c.row]?.push(c);
  const drawn = drawnGrid(rows.map((r, i) => ({ widths: r.attrs.widths, cells: byRow[i] ?? [] })), tableColumns(attrsOf(table, "table")));
  const colspan = new Map<number, number>();
  drawn.spans.forEach((spans, r) => spans.forEach((s, c) => {
    const offset = offsets[r]?.[c];
    if (offset !== undefined) colspan.set(offset, s.colspan);
  }));
  const own = rows.some((r) => r.attrs.widths != null);
  const key = `${drawn.widths.length}:${drawn.spans.map((s) => s.map((x) => x.colspan).join(",")).join(";")}${own ? `:${drawn.widths.map((w) => w.toFixed(4)).join(",")}` : ""}`;
  const out = { pct: drawn.widths, colspan, key };
  drawnTables.set(table, out);
  return out;
}

/**
 * A picture's box as the reader draws it: its img, or for a cropped picture an element clipping its
 * img. The box is what selection, the handles and the size reads measure.
 */
function pictureDom(a: ImageAttrs, basePt: number, extra: CSSProperties | null): HTMLElement {
  const crop = cropOrNull(a.crop);
  const img = el("img", crop ? croppedImageStyle(crop) : { ...imageStyle(a, basePt), ...extra }) as HTMLImageElement;
  img.src = assetUrl(a.asset);
  img.alt = "";
  if (!crop) return img;
  const box = el("span", { ...imageStyle(a, basePt), ...extra }, "pic-crop");
  box.append(img);
  return box;
}

export function nodeViews(basePt: number): Record<string, NodeViewConstructor> {
  return {
    paragraph: (node) => {
      const a = attrsOf(node, "paragraph");
      const p = el("p", paragraphStyle(a, basePt));
      if (a.marker) p.append(markerSpan(a.marker, basePt));
      const content = el("span", null, "pm-inline");
      p.append(content);
      return plain(p, content, node);
    },
    heading_line: (node) => {
      const d = el("div", null, "slide-title");
      return plain(d, d, node);
    },
    hard_break: (node) => plain(el("br"), null, node),
    page_break: (node) => plain(el("span", null, "page-break"), null, node),
    image: (node) => plain(pictureDom(attrsOf(node, "image"), basePt, null), null, node),
    image_block: (node) => plain(pictureDom(attrsOf(node, "image_block"), basePt, { display: "block" }), null, node),
    anchored: (node) => {
      const a = attrsOf(node, "anchored");
      const child = node.firstChild;
      if (a.float && child?.type === N.image_block) {
        // Placed by the floats plugin (render/floats.ts), which writes only its position style.
        const d = el("div", null, FLOAT_PIC);
        d.dataset.dx = String(a.float.dxPt / basePt);
        d.dataset.dy = String(a.float.dyPt / basePt);
        return { ...plain(d, d, node), ignoreMutation: (m) => isOwnStyle(m, d) };
      }
      const childWidth = Number(child?.attrs.widthPt ?? 0);
      const d = el("div", { marginLeft: anchoredOffset(a.offsetPt, childWidth, basePt) }, "anchored");
      return plain(d, d, node);
    },
    rule: (node) => {
      const a = attrsOf(node, "rule");
      return plain(el("hr", ruleStyle(a.color, a.widthPt, basePt)), null, node);
    },
    textbox: (node) => {
      const d = el("div", textboxStyle(attrsOf(node, "textbox"), basePt), "textbox");
      return plain(d, d, node);
    },
    drawing: (node) => {
      const { widthPt, heightPt, shapes } = attrsOf(node, "drawing");
      const dom = el("div", { position: "relative", width: em(widthPt, basePt), maxWidth: "100%" }, "drawing-edit");
      const shapesHost = el("div");
      shapesHost.contentEditable = "false";
      const content = el("div", { position: "absolute", inset: "0" });
      dom.append(shapesHost, content);
      const destroy = reactLayer(shapesHost, (root) => root.render(createElement(Drawing, {
        widthPt, heightPt, shapes, basePt, assetUrl,
      })));
      return { ...plain(dom, content, node), destroy };
    },
    drawing_text: (node) => {
      const a = attrsOf(node, "drawing_text");
      const d = el("div", {
        position: "absolute", left: em(a.x, basePt), top: em(a.y, basePt), width: em(a.w, basePt), minHeight: em(a.h, basePt),
        background: a.fill ? `#${a.fill}` : undefined,
      }, "drawing-text");
      return plain(d, d, node);
    },
    table: (node) => {
      const table = el("table", null, "nt");
      const colgroup = el("colgroup");
      const body = el("tbody");
      table.append(colgroup, body);
      const draw = (n: PMNode): void => {
        const a = attrsOf(n, "table");
        table.removeAttribute("style");
        applyStyle(table, { tableLayout: "fixed", marginLeft: tableIndent(a.indentPt, basePt) });
        colgroup.replaceChildren(...drawnTable(n).pct.map((pct) => el("col", { width: `${pct}%` })));
      };
      draw(node);
      // A cell's outer/inside borders depend on its place in the grid, and ProseMirror keeps the views of
      // unchanged cells; when the grid's shape changes (a row added or deleted), or how its rows are drawn
      // (a dx's row widths, a deleted cell), the whole table is drawn again so every cell takes the edges
      // and drawn columns of its new place.
      const shape = `${gridShape(node)}|${drawnTable(node).key}`;
      let current = node;
      return {
        dom: table,
        contentDOM: body,
        // The room below it for a picture floating past its end (render/floats.ts).
        ignoreMutation: (m) => isOwnStyle(m, table),
        update: (next) => {
          if (next.type !== current.type || `${gridShape(next)}|${drawnTable(next).key}` !== shape) return false;
          if (!next.sameMarkup(current)) {
            // The table's own attributes changed (column widths, cell margins). ProseMirror would move the
            // unchanged cells' views into a new table view as they are, keeping the margins and borders
            // they were drawn with, so the table redraws itself and its cells here.
            draw(next);
            const rows = body.children;
            next.forEach((row, rowOffset, r) => {
              const tds = rows[r]?.children;
              row.forEach((cell, cellOffset, c) => {
                const td = tds?.[c];
                if (!(td instanceof HTMLTableCellElement)) return;
                td.removeAttribute("style");
                applyStyle(td, tableCellStyle(cell, next, rowOffset + 1 + cellOffset, basePt));
              });
            });
          }
          current = next;
          return true;
        },
      };
    },
    table_row: (node) => {
      const tr = el("tr", null, attrsOf(node, "table_row").kind === "heading" ? "hrow" : undefined);
      return plain(tr, tr, node);
    },
    table_cell: (node, view, getPos) => {
      const a = attrsOf(node, "table_cell");
      const pos = getPos();
      const $pos = pos === undefined ? null : view.state.doc.resolve(pos);
      const tableNode = $pos ? $pos.node($pos.depth - 1) : null;
      const offset = $pos && pos !== undefined ? pos - $pos.start($pos.depth - 1) : 0;
      const td = el("td", tableCellStyle(node, tableNode, offset, basePt)) as HTMLTableCellElement;
      // The drawn columns it spans: in a row with its own widths, those between its edges (drawnTable).
      td.colSpan = tableNode?.type === N.table ? (drawnTable(tableNode).colspan.get(offset) ?? a.colspan) : a.colspan;
      td.rowSpan = a.rowspan;
      return plain(td, td, node);
    },
    slide_card: (node) => {
      const d = el("div", null, "slide-card");
      return plain(d, d, node);
    },
  };
}

function markElement(mark: Mark, basePt: number): HTMLElement {
  // Mark.toJSON gives the stored shape: `attrs` exactly when the mark type has attributes.
  const json: MarkJSON = mark.toJSON();
  switch (json.type) {
    case "link": {
      const link = el("a") as HTMLAnchorElement;
      link.href = json.attrs.href;
      link.rel = "noopener noreferrer";
      return link;
    }
    case "bold":
      return el("strong");
    case "italic":
      return el("em");
    case "underline":
      return el("u", { textDecorationStyle: underlineStyle(json.attrs.style) });
    case "strike":
      return el("s", json.attrs.double ? { textDecorationStyle: "double" } : null);
    case "vertAlign":
      return el(json.attrs.value === "sub" ? "sub" : "sup");
    default:
      return el("span", runStyle([json], basePt));
  }
}

export function markViews(basePt: number): Record<string, MarkViewConstructor> {
  const out: Record<string, MarkViewConstructor> = {};
  for (const name of Object.keys(schema.marks)) out[name] = (mark) => ({ dom: markElement(mark, basePt) });
  return out;
}

/** Serializer for copy and drag within the editor: the same elements, without node-view behavior. */
export function clipboardSerializer(basePt: number): DOMSerializer {
  const nodeSpecs: Record<string, (node: PMNode) => DOMOutputSpec> = {};
  for (const name of Object.keys(schema.nodes)) {
    if (name === "text") continue;
    nodeSpecs[name] = (node) => {
      if (node.isLeaf) return node.isInline ? ["span", node.textContent] : ["div"];
      if (node.type === N.table) return ["table", ["tbody", 0]];
      if (node.type === N.table_row) return ["tr", 0];
      if (node.type === N.table_cell) return ["td", 0];
      if (node.type === N.paragraph) return ["p", 0];
      return ["div", 0];
    };
  }
  const markSpecs: Record<string, (mark: Mark) => DOMOutputSpec> = {};
  for (const name of Object.keys(schema.marks)) markSpecs[name] = (mark) => markElement(mark, basePt);
  return new DOMSerializer(nodeSpecs, markSpecs);
}
