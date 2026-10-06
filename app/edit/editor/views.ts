// How the editor draws each node and mark (plan 50 §50.3: node views reuse the renderer, 40 §40.6).
// The schema has no toDOM, so every node and mark gets a view here, built from the renderer's own
// style helpers; atoms that hold no editable text are drawn by the renderer's React components.
import { createElement, type CSSProperties } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DOMSerializer } from "prosemirror-model";
import type { DOMOutputSpec, Mark, Node as PMNode } from "prosemirror-model";
import type { MarkViewConstructor, NodeView, NodeViewConstructor } from "prosemirror-view";
import { TableMap } from "prosemirror-tables";
import { schema } from "../../../lib/schema.ts";
import {
  anchoredOffset, assetUrl, cellStyle, Drawing, em, imageStyle, markerStyle, paragraphStyle, ruleStyle, runStyle,
  tableColumns, tableIndent, textboxStyle, underlineStyle,
} from "../../render/index.ts";
import type { ListMarker, MarkJSON, NodeAttrs } from "../../../lib/schemaTypes.ts";
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
    image: (node) => {
      const a = attrsOf(node, "image");
      const img = el("img", imageStyle(a, basePt)) as HTMLImageElement;
      img.src = assetUrl(a.asset);
      img.alt = "";
      return plain(img, null, node);
    },
    image_block: (node) => {
      const a = attrsOf(node, "image_block");
      const img = el("img", { ...imageStyle(a, basePt), display: "block" }) as HTMLImageElement;
      img.src = assetUrl(a.asset);
      img.alt = "";
      return plain(img, null, node);
    },
    anchored: (node) => {
      const child = node.firstChild;
      const childWidth = Number(child?.attrs.widthPt ?? 0);
      const d = el("div", { marginLeft: anchoredOffset(attrsOf(node, "anchored").offsetPt, childWidth, basePt) }, "anchored");
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
        colgroup.replaceChildren(...tableColumns(a).map((pct) => el("col", { width: `${pct}%` })));
      };
      draw(node);
      // A cell's outer/inside borders depend on its place in the grid, and ProseMirror keeps the views of
      // unchanged cells; when the grid's shape changes (a row added or deleted) the whole table is drawn
      // again so every cell takes the edges of its new place.
      const shape = gridShape(node);
      let current = node;
      return {
        dom: table,
        contentDOM: body,
        update: (next) => {
          if (next.type !== current.type || gridShape(next) !== shape) return false;
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
      td.colSpan = a.colspan;
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
