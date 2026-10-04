// Stored ProseMirror JSON → React elements (plan 40 §40.6). No HTML string is ever built or injected
// (10 §10.6 control 2): every node becomes a React element and every text is a React text child.
import { createContext, Fragment, useContext, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { isAllowedHref } from "../../lib/schema.ts";
import { isMark, isNode, type ImageAttrs, type ListMarker, type MarkJSON, type MarkName, type NodeJSON, type PMNode, type TableBorders } from "../../lib/schemaTypes.ts";
import { DATA_BASE } from "../data/load.ts";
import { openImageViewer } from "../files/imageViewer.tsx";
import { navigate } from "../shell/route.ts";
import { Drawing } from "./Drawing.tsx";
import { HitBlock, Txt } from "./Text.tsx";
import {
  anchoredOffset,
  cellStyle,
  em,
  imageStyle,
  markerStyle,
  paragraphStyle,
  ruleStyle,
  runStyle,
  tableColumns,
  textboxStyle,
  underlineStyle,
} from "./styles.ts";
import { layoutTable, selectRows, type DrawRow, type PlacedCell } from "./tableLayout.ts";

export type { PMNode } from "../../lib/schemaTypes.ts";

/** URL of a stored image (`dist/data/assets/<sha>.<ext>`). */
export function assetUrl(asset: string): string {
  return `${DATA_BASE}assets/${asset}`;
}

interface Ctx {
  basePt: number;
  /** The two readability aids of pharm notes cards (pharm/notes-fidelity). */
  pharmNotes: boolean;
}

const RenderCtx = createContext<Ctx>({ basePt: 11, pharmNotes: false });

// ---- inline content --------------------------------------------------------------------------------

/** A divider paragraph: its whole text is 3+ of hyphen, en dash, em dash or underscore, with optional spaces. */
export const DIVIDER_RE = new RegExp(String.raw`^[ \t\xa0]*(?:[-–—_][ \t\xa0]*){3,}$`, "u");
/** A lead label such as `MOA:` or `Clin Use:` at the start of a paragraph. */
export const LEAD_LABEL_RE = /^[A-Z][A-Za-z0-9 /&()-]{0,30}:/;

/** Text of a paragraph's inline content (hard breaks as newlines). */
export function inlineText(nodes: readonly PMNode[] | undefined): string {
  return (nodes ?? []).map((n) => (n.type === "text" ? (n.text ?? "") : n.type === "hard_break" ? "\n" : "")).join("");
}

function onInternalLink(e: MouseEvent<HTMLAnchorElement>, href: string): void {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  void navigate(href);
}

/** Wraps `child` in the elements of a run's marks: a > style span > strong > em > u > s > sup/sub. */
export function withMarks(marks: readonly MarkJSON[] | undefined, child: ReactNode, basePt: number): ReactNode {
  const ms = marks ?? [];
  let out = child;
  const has = <K extends MarkName>(t: K): Extract<MarkJSON, { type: K }> | undefined => ms.find((m): m is Extract<MarkJSON, { type: K }> => isMark(m, t));
  const va = has("vertAlign");
  if (va) out = va.attrs.value === "sub" ? <sub>{out}</sub> : <sup>{out}</sup>;
  const strike = has("strike");
  if (strike) out = <s style={strike.attrs.double ? { textDecorationStyle: "double" } : undefined}>{out}</s>;
  const u = has("underline");
  if (u) out = <u style={{ textDecorationStyle: underlineStyle(u.attrs.style) }}>{out}</u>;
  if (has("italic")) out = <em>{out}</em>;
  if (has("bold")) out = <strong>{out}</strong>;
  const style = runStyle(ms, basePt);
  if (style) out = <span style={style}>{out}</span>;
  const h = has("link")?.attrs.href;
  if (h !== undefined && isAllowedHref(h)) {
    if (h.startsWith("#/")) {
      out = (
        <a href={h} onClick={(e) => onInternalLink(e, h)}>
          {out}
        </a>
      );
    } else if (/^https?:/.test(h)) {
      out = (
        <a href={h} target="_blank" rel="noopener noreferrer">
          {out}
        </a>
      );
    } else {
      out = <a href={h}>{out}</a>;
    }
  }
  return out;
}

function InlineImage({ attrs }: { attrs: ImageAttrs }): ReactNode {
  const { basePt } = useContext(RenderCtx);
  const url = assetUrl(attrs.asset);
  return <img src={url} alt="" loading="lazy" className="pic" style={imageStyle(attrs, basePt)} onClick={() => openImageViewer(url)} />;
}

/** Character offset where each inline node starts (hard breaks count as one character). */
function inlineOffsets(nodes: readonly PMNode[]): number[] {
  const out: number[] = [];
  nodes.reduce((pos, n) => {
    out.push(pos);
    return pos + (n.type === "text" ? (n.text ?? "").length : n.type === "hard_break" ? 1 : 0);
  }, 0);
  return out;
}

/** Renders inline nodes; the first `labelLen` characters are wrapped in the lead-label style. */
function Inline({ nodes, labelLen }: { nodes: readonly PMNode[]; labelLen: number }): ReactNode {
  const { basePt } = useContext(RenderCtx);
  const offsets = inlineOffsets(nodes);
  // Search highlights match the paragraph's joined text, so a word split across runs still matches.
  return (
    <HitBlock text={inlineText(nodes)}>
      {nodes.map((n, i) => {
        switch (n.type) {
          case "text": {
            const text = n.text ?? "";
            const start = offsets[i] ?? 0;
            if (start < labelLen) {
              const cut = Math.min(text.length, labelLen - start);
              return (
                <Fragment key={i}>
                  {withMarks(n.marks, <span className="lead-label"><Txt text={text.slice(0, cut)} offset={start} /></span>, basePt)}
                  {cut < text.length && withMarks(n.marks, <Txt text={text.slice(cut)} offset={start + cut} />, basePt)}
                </Fragment>
              );
            }
            return <Fragment key={i}>{withMarks(n.marks, <Txt text={text} offset={start} />, basePt)}</Fragment>;
          }
          case "hard_break":
            return <br key={i} />;
          case "page_break":
            return null;
          default:
            return isNode(n, "image") ? <InlineImage key={i} attrs={n.attrs} /> : null;
        }
      })}
    </HitBlock>
  );
}

function Marker({ marker }: { marker: ListMarker }): ReactNode {
  const { basePt } = useContext(RenderCtx);
  return (
    <span className="marker" style={markerStyle(marker.tabPt, basePt, marker.font)}>
      {withMarks(marker.marks, marker.text, basePt)}
    </span>
  );
}

function Paragraph({ node }: { node: PMNode & NodeJSON<"paragraph"> }): ReactNode {
  const { basePt, pharmNotes } = useContext(RenderCtx);
  const a = node.attrs;
  const content = node.content ?? [];
  const style = paragraphStyle(a, basePt);
  if (pharmNotes) {
    const text = inlineText(content);
    if (DIVIDER_RE.test(text)) {
      return (
        <div className="pdiv" style={{ marginTop: style.marginTop, marginBottom: style.marginBottom }}>
          <hr aria-hidden="true" />
          <span className="vh">{text}</span>
        </div>
      );
    }
    const label = LEAD_LABEL_RE.exec(text);
    return (
      <p style={style}>
        {a.marker && <Marker marker={a.marker} />}
        <Inline nodes={content} labelLen={label ? label[0].length : 0} />
        {content.length === 0 && <br />}
      </p>
    );
  }
  return (
    <p style={style}>
      {a.marker && <Marker marker={a.marker} />}
      <Inline nodes={content} labelLen={0} />
      {content.length === 0 && <br />}
    </p>
  );
}

// ---- tables ---------------------------------------------------------------------------------------

export interface TableView {
  /** Row ids to show, in order (with heading rows already inserted); null = every row. */
  rows: readonly string[] | null;
  /** Phone stacked mode (guide-reader/phone-tables). */
  stacked: boolean;
}

function Cell({ placed, rowspan, edges, borders }: { placed: PlacedCell; rowspan: number; edges: { top: boolean; right: boolean; bottom: boolean; left: boolean }; borders: TableBorders | null }): ReactNode {
  const { basePt } = useContext(RenderCtx);
  const cell = placed.node;
  return (
    <td
      colSpan={placed.colspan > 1 ? placed.colspan : undefined}
      rowSpan={rowspan > 1 ? rowspan : undefined}
      style={cellStyle(isNode(cell, "table_cell") ? cell.attrs : {}, basePt, borders, edges)}
    >
      <Blocks nodes={placed.node.content ?? []} />
    </td>
  );
}

function GridTable({ node, rows }: { node: PMNode & NodeJSON<"table">; rows: DrawRow[] }): ReactNode {
  const { basePt } = useContext(RenderCtx);
  const a = node.attrs;
  const cols = tableColumns(a.grid);
  const borders = a.borders;
  const columns = Math.max(cols.length, ...rows.flatMap((r) => r.cells.map((c) => c.cell.col + c.cell.colspan)));
  const last = rows.length - 1;
  return (
    <div className="ntw">
      <table className="nt" style={{ marginLeft: em(a.indentPt, basePt) }}>
        <colgroup>
          {cols.map((w, i) => (
            <col key={i} style={{ width: `${Math.round(w * 100) / 100}%` }} />
          ))}
        </colgroup>
        <tbody>
          {rows.map((r, ri) => {
            const rowNode = r.row.node;
            const ra = isNode(rowNode, "table_row") ? rowNode.attrs : null;
            const min = ra?.minHeightPt != null ? { height: em(ra.minHeightPt, basePt) } : undefined;
            return (
              <tr key={r.row.id || ri} data-anchor={r.row.id} className={ra?.kind === "heading" ? "hrow" : undefined} style={min}>
                {r.cells.map((c, ci) => (
                  <Cell
                    key={ci}
                    placed={c.cell}
                    rowspan={c.rowspan}
                    borders={borders}
                    edges={{ top: ri === 0, bottom: ri + c.rowspan - 1 >= last, left: c.cell.col === 0, right: c.cell.col + c.cell.colspan >= columns }}
                  />
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function cellAt(row: DrawRow | null, col: number): PlacedCell | null {
  if (!row) return null;
  return row.cells.find((c) => c.cell.col <= col && col < c.cell.col + c.cell.colspan)?.cell ?? null;
}

function fillOf(cell: PlacedCell | null): CSSProperties | undefined {
  const f = cell?.node.attrs?.fill;
  return typeof f === "string" ? { background: `#${f}` } : undefined;
}

/** Phone: each row as its label, its name, then each column under its column heading, fills kept. */
function StackedTable({ rows }: { rows: DrawRow[] }): ReactNode {
  let heading: DrawRow | null = null;
  const out: ReactNode[] = [];
  rows.forEach((r, i) => {
    if (r.row.node.attrs?.kind === "heading") {
      heading = r;
      const label = cellAt(r, 0);
      if (label && inlineText(label.node.content?.[0]?.content).trim() !== "") {
        out.push(
          <div key={`h${i}`} className="stk-label" style={fillOf(label)} data-anchor={r.row.id}>
            <Blocks nodes={label.node.content ?? []} />
          </div>,
        );
      }
      return;
    }
    const head: DrawRow | null = heading;
    const nameCell = cellAt(r, 0);
    out.push(
      <div key={i} className="stk" data-anchor={r.row.id}>
        {nameCell && (
          <div className="stk-name" style={fillOf(nameCell)}>
            <Blocks nodes={nameCell.node.content ?? []} />
          </div>
        )}
        {r.cells
          .filter((c) => c.cell.col > 0)
          .map((c, ci) => {
            const h = cellAt(head, c.cell.col);
            return (
              <div key={ci} className="stk-col">
                {h && (
                  <div className="stk-ch" style={fillOf(h)}>
                    <Blocks nodes={h.node.content ?? []} />
                  </div>
                )}
                <div className="stk-cb" style={fillOf(c.cell)}>
                  <Blocks nodes={c.cell.node.content ?? []} />
                </div>
              </div>
            );
          })}
      </div>,
    );
  });
  return <div className="stacked">{out}</div>;
}

const TableViewCtx = createContext<TableView>({ rows: null, stacked: false });

function Table({ node }: { node: PMNode & NodeJSON<"table"> }): ReactNode {
  const view = useContext(TableViewCtx);
  const rows = selectRows(layoutTable(node), view.rows);
  // Nested tables (a table inside a cell) always show in full as a grid.
  return (
    <TableViewCtx.Provider value={{ rows: null, stacked: false }}>
      {view.stacked ? <StackedTable rows={rows} /> : <GridTable node={node} rows={rows} />}
    </TableViewCtx.Provider>
  );
}

// ---- other blocks ---------------------------------------------------------------------------------

/** Width of an anchored node's child (a picture, text box or drawing). */
function childWidthPt(node: PMNode | undefined): number {
  if (!node) return 0;
  if (isNode(node, "image_block") || isNode(node, "textbox") || isNode(node, "drawing")) return node.attrs.widthPt;
  return 0;
}

function Textbox({ node }: { node: PMNode & NodeJSON<"textbox"> }): ReactNode {
  const { basePt } = useContext(RenderCtx);
  return (
    <div className="textbox" style={textboxStyle(node.attrs, basePt)}>
      <Blocks nodes={node.content ?? []} />
    </div>
  );
}

function DrawingText({ node }: { node: PMNode }): ReactNode {
  const { basePt } = useContext(RenderCtx);
  if (!isNode(node, "drawing_text")) return null;
  const ta = node.attrs;
  return (
    <foreignObject x={ta.x} y={ta.y} width={ta.w} height={ta.h}>
      <div
        className="drawing-text"
        style={{
          fontSize: `${basePt}px`,
          background: ta.fill ? `#${ta.fill}` : undefined,
          border: ta.border ? `${ta.border.widthPt}px solid #${ta.border.color}` : undefined,
          width: "100%",
          height: "100%",
          boxSizing: "border-box",
        }}
      >
        <Blocks nodes={node.content ?? []} />
      </div>
    </foreignObject>
  );
}

function DrawingNode({ node }: { node: PMNode & NodeJSON<"drawing"> }): ReactNode {
  const { basePt } = useContext(RenderCtx);
  const a = node.attrs;
  return (
    <Drawing widthPt={a.widthPt} heightPt={a.heightPt} shapes={a.shapes} basePt={basePt} assetUrl={assetUrl}>
      {(node.content ?? []).map((t, i) => (
        <DrawingText key={i} node={t} />
      ))}
    </Drawing>
  );
}

function Anchored({ node }: { node: PMNode & NodeJSON<"anchored"> }): ReactNode {
  const { basePt } = useContext(RenderCtx);
  const child = node.content?.[0];
  return (
    <div className="anchored">
      <div style={{ marginLeft: anchoredOffset(node.attrs.offsetPt, childWidthPt(child), basePt), width: "fit-content", maxWidth: "100%" }}>
        {child && <Block node={child} />}
      </div>
    </div>
  );
}

function SlideCard({ node }: { node: PMNode }): ReactNode {
  const [head, ...rest] = node.content ?? [];
  return (
    <section className="sd-card">
      {head && (
        <h4>
          <Inline nodes={head.content ?? []} labelLen={0} />
        </h4>
      )}
      <Blocks nodes={rest} />
    </section>
  );
}

function Block({ node }: { node: PMNode }): ReactNode {
  const { basePt } = useContext(RenderCtx);
  if (isNode(node, "paragraph")) return <Paragraph node={node} />;
  if (isNode(node, "heading_line")) {
    return (
      <h3 className="heading-line">
        <Inline nodes={node.content ?? []} labelLen={0} />
      </h3>
    );
  }
  if (isNode(node, "table")) return <Table node={node} />;
  if (isNode(node, "rule")) return <hr className="rule" style={ruleStyle(node.attrs.color, node.attrs.widthPt, basePt)} />;
  if (isNode(node, "textbox")) return <Textbox node={node} />;
  if (isNode(node, "anchored")) return <Anchored node={node} />;
  if (isNode(node, "image_block")) {
    return (
      <div className="pic-block">
        <InlineImage attrs={node.attrs} />
      </div>
    );
  }
  if (isNode(node, "drawing")) return <DrawingNode node={node} />;
  if (isNode(node, "slide_card")) return <SlideCard node={node} />;
  return null;
}

function Blocks({ nodes }: { nodes: readonly PMNode[] }): ReactNode {
  return nodes.map((n, i) => <Block key={i} node={n} />);
}

export interface RichDocProps {
  doc: PMNode | { type: "doc"; content: unknown[] };
  basePt: number;
  /** For a table block: the rows to show, in order (heading rows included); default all. */
  rows?: readonly string[] | null;
  stacked?: boolean;
  pharmNotes?: boolean;
}

/** Renders one stored doc. The caller sets the reading font size (13px laptop / 14px phone). */
export function RichDoc({ doc, basePt, rows = null, stacked = false, pharmNotes = false }: RichDocProps): ReactNode {
  return (
    <RenderCtx.Provider value={{ basePt, pharmNotes }}>
      <TableViewCtx.Provider value={{ rows, stacked }}>
        <Blocks nodes={((doc as PMNode).content ?? []) as PMNode[]} />
      </TableViewCtx.Provider>
    </RenderCtx.Provider>
  );
}
