// The stored-doc renderer and the content labels (40 §40.6–§40.7; 99 §99.1 render.test.tsx).
import { act, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FlagNote, PubFigure, PubGap } from "../../lib/derive/published.ts";
import { DATA_BASE } from "../data/load.ts";
import type { DrawingShape, MarkJSON, PMNode } from "../../lib/schemaTypes.ts";
import { SearchClient, setSearchClient } from "../search/client.ts";
import { SearchHighlightProvider, SearchLanding } from "../search/SearchLanding.tsx";
import { resetSearchState } from "../search/store.ts";
import { BASE, fakeSite, inProcessWorker } from "../search/testing.ts";
import { navigate } from "../shell/route.ts";
import { asOwner, installOwnerCss, mount, until, visibleText, type Mounted } from "../testing.tsx";
import { closeImageViewer, ImageViewer } from "../files/imageViewer.tsx";
import { GapBlock, ReviewSlidesBadge, UpdateNote } from "./labels.tsx";
import { RichDoc } from "./RichDoc.tsx";
import { anchoredOffset, borderCss, cellPadding, croppedImageStyle, em, imageTransform, WORD_CELL_MARGINS, paragraphStyle, runStyle, tableColumns, underlineStyle } from "./styles.ts";
import { layoutTable, selectRows } from "./tableLayout.ts";

let ui: Mounted | null = null;

beforeAll(() => installOwnerCss());

afterEach(() => {
  ui?.unmount();
  ui = null;
  asOwner(false);
});

async function render(node: ReactNode): Promise<HTMLDivElement> {
  ui = await mount(node);
  return ui.container;
}

function need<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`missing: ${what}`);
  return v;
}

const NONE4 = { top: null, right: null, bottom: null, left: null };
const PARA = { indLeft: 0, indRight: 0, indFirst: 0, spaceBefore: 0, spaceAfter: 0, line: null, align: "left", shade: null, borders: null, marker: null };

const text = (t: string, marks?: MarkJSON[]): PMNode => (marks ? { type: "text", text: t, marks } : { type: "text", text: t });
const para = (content: PMNode[] | string, attrs: Record<string, unknown> = {}): PMNode => ({
  type: "paragraph",
  attrs: { ...PARA, ...attrs },
  content: typeof content === "string" ? [text(content)] : content,
});
const docOf = (...content: PMNode[]): PMNode => ({ type: "doc", content });

const cell = (t: string, attrs: Record<string, unknown> = {}): PMNode => ({
  type: "table_cell",
  attrs: { colspan: 1, rowspan: 1, colwidth: null, fill: null, vAlign: "top", borders: null, ...attrs },
  content: [para(t)],
});
const row = (id: string, cells: PMNode[], kind: "heading" | "content" = "content", minHeightPt: number | null = null): PMNode => ({
  type: "table_row",
  attrs: { id, kind, minHeightPt, repeatHeader: false, cantSplit: false },
  content: cells,
});
const tableNode = (grid: number[], rows: PMNode[], extra: Record<string, unknown> = {}): PMNode => ({
  type: "table",
  attrs: { grid, indentPt: 0, borders: { ...NONE4, insideH: null, insideV: null }, cellMarginPt: { top: 0, right: 5.4, bottom: 0, left: 5.4 }, ...extra },
  content: rows,
});

const styleOf = (el: Element | null | undefined): CSSStyleDeclaration => (el as HTMLElement).style;

describe("lengths and paragraphs", () => {
  it("renders every pt length as pt / basePt em", () => {
    expect(em(22, 11)).toBe("2em");
    expect(em(5.5, 11)).toBe("0.5em");
    expect(em(1, 3)).toBe("0.3333em");
  });

  it("applies indents, spacing, the three line rules, alignment, shade and borders", async () => {
    const border = { style: "single", widthPt: 1.1, color: "FF0000" };
    const c = await render(
      <RichDoc
        basePt={11}
        doc={docOf(
          para("auto", { indLeft: 22, indRight: 11, indFirst: -5.5, spaceBefore: 6.6, spaceAfter: 11, line: { rule: "auto", value: 1.15 }, align: "justify", shade: "FFFF00" }),
          para("exact", { line: { rule: "exact", value: 13.2 }, borders: { top: border, right: null, bottom: null, left: null } }),
          para("atLeast", { line: { rule: "atLeast", value: 22 }, align: "center" }),
        )}
      />,
    );
    const [p1, p2, p3] = [...c.querySelectorAll("p")];
    expect(styleOf(p1).marginLeft).toBe("2em");
    expect(styleOf(p1).marginRight).toBe("1em");
    expect(styleOf(p1).textIndent).toBe("-0.5em");
    expect(styleOf(p1).marginTop).toBe("0.6em");
    expect(styleOf(p1).marginBottom).toBe("1em");
    expect(styleOf(p1).lineHeight).toBe("1.15");
    expect(styleOf(p1).textAlign).toBe("justify");
    expect(styleOf(p1).background).toContain("rgb(255, 255, 0)");
    expect(styleOf(p2).lineHeight).toBe("1.2em");
    expect(styleOf(p2).borderTop).toBe("0.1em solid rgb(255, 0, 0)");
    expect(styleOf(p3).lineHeight).toBe("2em");
    expect(styleOf(p3).textAlign).toBe("center");
  });

  it("draws a list marker as a tab-wide inline block in its own font", async () => {
    const marker = { text: "•", font: "Symbol", marks: [{ type: "bold" }], tabPt: 18 };
    const c = await render(<RichDoc basePt={9} doc={docOf(para("item", { marker }))} />);
    const m = c.querySelector<HTMLElement>("span.marker");
    expect(m?.textContent).toBe("•");
    expect(m?.style.width).toBe("2em");
    expect(m?.style.display).toBe("inline-block");
    expect(m?.style.fontFamily).toContain('"Symbol"');
    expect(m?.querySelector("strong")?.textContent).toBe("•");
    expect(c.querySelector("p")?.textContent).toBe("•item");
  });

  it("keeps an empty paragraph's height with a line break", async () => {
    const c = await render(<RichDoc basePt={11} doc={docOf(para([]))} />);
    expect(c.querySelector("p")?.innerHTML).toContain("<br>");
  });

  it("renders hard breaks and drops page breaks", async () => {
    const c = await render(<RichDoc basePt={11} doc={docOf(para([text("a"), { type: "hard_break" }, text("b"), { type: "page_break" }, text("c")]))} />);
    expect(c.querySelector("p")?.innerHTML).toBe("a<br>bc");
  });
});

describe("marks", () => {
  it("renders each mark as its element or style", async () => {
    const run = (t: string, ...marks: MarkJSON[]): PMNode => text(t, marks);
    const c = await render(
      <RichDoc
        basePt={10}
        doc={docOf(
          para([
            run("B", { type: "bold" }),
            run("I", { type: "italic" }),
            run("U", { type: "underline", attrs: { style: "dotted" } }),
            run("S", { type: "strike", attrs: { double: false } }),
            run("D", { type: "strike", attrs: { double: true } }),
            run("^", { type: "vertAlign", attrs: { value: "sup" } }),
            run("_", { type: "vertAlign", attrs: { value: "sub" } }),
            run("caps", { type: "caps" }),
            run("sc", { type: "smallCaps" }),
            run("big", { type: "size", attrs: { pt: 15 } }),
            run("red", { type: "color", attrs: { hex: "C00000" } }),
            run("hl", { type: "shade", attrs: { hex: "00FF00" } }, { type: "highlight", attrs: { hex: "FFFF00" } }),
            run("sh", { type: "shade", attrs: { hex: "D9D9D9" } }),
            run("f", { type: "font", attrs: { family: "Wingdings" } }),
          ]),
        )}
      />,
    );
    expect(c.querySelector("strong")?.textContent).toBe("B");
    expect(c.querySelector("em")?.textContent).toBe("I");
    expect(c.querySelector<HTMLElement>("u")?.style.textDecorationStyle).toBe("dotted");
    const strikes = [...c.querySelectorAll<HTMLElement>("s")];
    expect(strikes.map((s) => [s.textContent, s.style.textDecorationStyle])).toEqual([["S", ""], ["D", "double"]]);
    expect(c.querySelector("sup")?.textContent).toBe("^");
    expect(c.querySelector("sub")?.textContent).toBe("_");
    const span = (t: string): HTMLElement | undefined => [...c.querySelectorAll<HTMLElement>("span[style]")].find((s) => s.textContent === t);
    expect(span("caps")?.style.textTransform).toBe("uppercase");
    expect(span("sc")?.style.fontVariant).toBe("small-caps");
    expect(span("big")?.style.fontSize).toBe("1.5em");
    expect(span("red")?.style.color).toBe("rgb(192, 0, 0)");
    // Highlight sits on top of shade.
    expect(span("hl")?.style.backgroundColor).toBe("rgb(255, 255, 0)");
    expect(span("sh")?.style.backgroundColor).toBe("rgb(217, 217, 217)");
    expect(span("f")?.style.fontFamily).toContain('"Wingdings"');
  });

  it("maps Word underline styles through the shared reading (dotDash is dashed)", () => {
    expect(underlineStyle("single")).toBe("solid");
    expect(underlineStyle("double")).toBe("double");
    expect(underlineStyle("dotDash")).toBe("dashed");
    expect(underlineStyle("dotted")).toBe("dotted");
    expect(underlineStyle("wave")).toBe("wavy");
  });

  it("returns no run style for runs with only element marks", () => {
    expect(runStyle([{ type: "bold" }, { type: "italic" }], 11)).toBeNull();
  });

  it("opens external links in a new tab with rel noopener noreferrer, keeps internal #/ links in-app, and drops unsafe hrefs", async () => {
    const link = (t: string, href: string): PMNode => text(t, [{ type: "link", attrs: { href } }]);
    const c = await render(
      <RichDoc
        basePt={11}
        doc={docOf(para([link("ext", "https://www.uspstf.org/x"), link("int", "#/eor/fm/s/cardiovascular"), link("mail", "mailto:a@b.c"), link("bad", "javascript:alert(1)")]))}
      />,
    );
    const a = (t: string): HTMLAnchorElement | undefined => [...c.querySelectorAll("a")].find((x) => x.textContent === t);
    expect(a("ext")?.getAttribute("target")).toBe("_blank");
    expect(a("ext")?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a("int")?.hasAttribute("target")).toBe(false);
    expect(a("int")?.hasAttribute("rel")).toBe(false);
    expect(a("mail")?.getAttribute("href")).toBe("mailto:a@b.c");
    expect(a("bad")).toBeUndefined();
    expect(c.textContent).toContain("bad");
    await navigate("#/start");
    await act(async () => {
      a("int")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    });
    expect(location.hash).toBe("#/eor/fm/s/cardiovascular");
    // A modified click is left to the browser (new tab), so the router does not move.
    await navigate("#/start");
    const ctrl = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
    a("int")?.dispatchEvent(ctrl);
    expect(location.hash).toBe("#/start");
  });
});

describe("tables", () => {
  it("raises a first column under 11% to 11% and scales the others proportionally, unless she set the widths", () => {
    const cols = tableColumns({ grid: [5, 45, 50] });
    expect(cols[0]).toBe(11);
    expect(cols[1]).toBeCloseTo((45 * 89) / 95, 10);
    expect(cols[2]).toBeCloseTo((50 * 89) / 95, 10);
    expect(cols.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 10);
    expect(tableColumns({ grid: [5, 45, 50], ownWidths: false })[0]).toBe(11);
    expect(tableColumns({ grid: [5, 45, 50], ownWidths: true })).toEqual([5, 45, 50]);
    expect(tableColumns({ grid: [20, 80] })).toEqual([20, 80]);
    expect(tableColumns({ grid: [0, 0] })).toEqual([50, 50]);
    expect(tableColumns({ grid: [] })).toEqual([]);
    expect(tableColumns({ grid: [7] })).toEqual([100]);
  });

  it("draws the widths she set as stored, with no first-column floor", async () => {
    const c = await render(
      <RichDoc basePt={11} doc={docOf(tableNode([5, 45, 50], [row("r1", [cell("A"), cell("B"), cell("C")])], { ownWidths: true }))} />,
    );
    expect([...c.querySelectorAll<HTMLElement>("col")].map((col) => col.style.width)).toEqual(["5%", "45%", "50%"]);
  });

  it("starts a table that reaches into Word's page margin at the column's edge, and keeps a positive indent", async () => {
    const c = await render(
      <RichDoc
        basePt={11}
        doc={docOf(
          tableNode([50, 50], [row("r1", [cell("A"), cell("B")])], { indentPt: -27.25 }),
          tableNode([50, 50], [row("r2", [cell("C"), cell("D")])], { indentPt: 22 }),
        )}
      />,
    );
    const tables = [...c.querySelectorAll<HTMLTableElement>("table.nt")];
    expect(tables.map((t) => t.style.marginLeft)).toEqual(["0em", "2em"]);
  });

  it("draws spans, fills and vertical alignment, with the 11% floor on the colgroup", async () => {
    const c = await render(
      <RichDoc
        basePt={11}
        doc={docOf(
          tableNode([10, 45, 45], [
            row("r1", [cell("A", { rowspan: 2, fill: "DDEBF7", vAlign: "center" }), cell("B", { colspan: 2 })], "heading"),
            row("r2", [cell("C", { vAlign: "bottom" }), cell("D")], "content", 22),
          ]),
        )}
      />,
    );
    const widths = [...c.querySelectorAll<HTMLElement>("col")].map((col) => col.style.width);
    expect(widths).toEqual(["11%", "44.5%", "44.5%"]);
    const tds = [...c.querySelectorAll<HTMLTableCellElement>("td")];
    expect(tds.map((td) => td.textContent)).toEqual(["A", "B", "C", "D"]);
    expect(tds[0]?.rowSpan).toBe(2);
    expect(tds[1]?.colSpan).toBe(2);
    expect(tds[0]?.style.background).toContain("rgb(221, 235, 247)");
    expect(tds[0]?.style.verticalAlign).toBe("middle");
    expect(tds[2]?.style.verticalAlign).toBe("bottom");
    const trs = [...c.querySelectorAll("tr")];
    expect(trs.map((tr) => tr.getAttribute("data-anchor"))).toEqual(["r1", "r2"]);
    expect(trs[0]?.className).toBe("hrow");
    expect(styleOf(trs[1]).height).toBe("2em");
  });

  it("uses outer borders on the table's edges and inside borders between cells, and a cell's own side over both", async () => {
    const outer = { style: "single", widthPt: 2.2, color: "000000" };
    const inside = { style: "dashed", widthPt: 1.1, color: "999999" };
    const c = await render(
      <RichDoc
        basePt={11}
        doc={docOf(
          tableNode([50, 50], [row("r1", [cell("A"), cell("B", { borders: { left: { style: "nil", widthPt: 1, color: "000000" } } })])], {
            borders: { top: outer, right: outer, bottom: outer, left: outer, insideH: inside, insideV: inside },
          }),
        )}
      />,
    );
    const [a, b] = [...c.querySelectorAll<HTMLTableCellElement>("td")];
    // jsdom reports colours in rgb() form.
    expect(a?.style.borderLeft).toBe("0.2em solid rgb(0, 0, 0)");
    expect(a?.style.borderRight).toBe("0.1em dashed rgb(153, 153, 153)");
    // jsdom serializes the `none` shorthand as "medium"; the side's style is what shows no line.
    expect(b?.style.borderLeftStyle).toBe("none");
    expect(b?.style.borderRight).toBe("0.2em solid rgb(0, 0, 0)");
    expect(borderCss({ style: "NIL", widthPt: 1, color: "000000" }, 11)).toBe("none");
  });

  it("shows only the requested rows, giving a span cut by hidden rows the shown rows it covers", async () => {
    const t = tableNode([50, 50], [
      row("h", [cell("Head"), cell("H2")], "heading"),
      row("a", [cell("Span", { rowspan: 3 }), cell("a2")]),
      row("b", [cell("b2")]),
      row("c", [cell("c2")]),
    ]);
    const drawn = selectRows(layoutTable(t), ["h", "b", "c"]);
    expect(drawn.map((r) => r.row.id)).toEqual(["h", "b", "c"]);
    // The span starting in hidden row "a" is drawn in "b", covering b and c.
    expect(drawn[1]?.cells.map((x) => [x.cell.col, x.rowspan])).toEqual([[0, 2], [1, 1]]);
    const c = await render(<RichDoc basePt={11} doc={docOf(t)} rows={["h", "c"]} />);
    expect([...c.querySelectorAll("tr")].map((tr) => tr.getAttribute("data-anchor"))).toEqual(["h", "c"]);
    expect(c.textContent).not.toContain("a2");
  });

  it("stacks rows on the phone: label, name, then each column under its heading, fills kept", async () => {
    const t = tableNode([30, 35, 35], [
      row("h", [cell("ARRHYTHMIAS", { fill: "FFC000" }), cell("Presentation"), cell("Treatment")], "heading"),
      row("r", [cell("AF"), cell("irregular"), cell("diltiazem")]),
    ]);
    const c = await render(<RichDoc basePt={11} doc={docOf(t)} stacked />);
    expect(c.querySelector("table")).toBeNull();
    const label = c.querySelector<HTMLElement>(".stk-label");
    expect(label?.textContent).toBe("ARRHYTHMIAS");
    expect(label?.style.background).toContain("rgb(255, 192, 0)");
    expect(label?.getAttribute("data-anchor")).toBe("h");
    const stk = c.querySelector(".stk");
    expect(stk?.getAttribute("data-anchor")).toBe("r");
    expect(stk?.querySelector(".stk-name")?.textContent).toBe("AF");
    expect([...(stk?.querySelectorAll(".stk-col") ?? [])].map((col) => [col.querySelector(".stk-ch")?.textContent, col.querySelector(".stk-cb")?.textContent])).toEqual([
      ["Presentation", "irregular"],
      ["Treatment", "diltiazem"],
    ]);
  });

  it("shows a nested table in full as a grid even in stacked mode", async () => {
    const inner = tableNode([50, 50], [row("i1", [cell("x"), cell("y")])]);
    const outerCell: PMNode = { type: "table_cell", attrs: { colspan: 1, rowspan: 1, colwidth: null, fill: null, vAlign: "top", borders: null }, content: [inner] };
    const c = await render(<RichDoc basePt={11} doc={docOf(tableNode([100], [row("o1", [outerCell])]))} rows={["o1"]} />);
    expect(c.querySelectorAll("table").length).toBe(2);
    expect(c.querySelector("table table td")?.textContent).toBe("x");
  });
});

describe("pictures, text boxes, anchored content, drawings and rules", () => {
  const image = { asset: "0123456789abcdef0123456789abcdef.png", widthPt: 110, heightPt: 55, rot: 90, flipH: true, flipV: false };

  it("rotates and flips a picture with a CSS transform and sizes it in em", async () => {
    expect(imageTransform({ rot: 90, flipH: true, flipV: false })).toBe("rotate(90deg) scaleX(-1)");
    expect(imageTransform({ rot: 0, flipH: false, flipV: true })).toBe("scaleY(-1)");
    expect(imageTransform({ rot: 0, flipH: false, flipV: false })).toBeUndefined();
    const c = await render(<RichDoc basePt={11} doc={docOf({ type: "image_block", attrs: image })} />);
    const img = c.querySelector<HTMLImageElement>(".pic-block img");
    expect(img?.getAttribute("src")).toMatch(/data\/assets\/0123456789abcdef0123456789abcdef\.png$/);
    expect(img?.style.width).toBe("10em");
    expect(img?.style.transform).toBe("rotate(90deg) scaleX(-1)");
  });

  it("an uncropped picture is still the img itself, with no clipping box", async () => {
    const c = await render(<RichDoc basePt={11} doc={docOf({ type: "image_block", attrs: { ...image, crop: null } })} />);
    const img = need(c.querySelector<HTMLImageElement>(".pic-block > img.pic"), "picture");
    expect(img.style.overflow).toBe("");
    expect(img.style.position).toBe("");
    expect(img.style.aspectRatio).toBe("110 / 55");
  });

  it("a cropped picture is a box the size of the part it keeps, clipping its file placed by percentages", async () => {
    const crop = { l: 0.25, t: 0, r: 0.25, b: 0.5 };
    expect(croppedImageStyle(crop)).toEqual({ position: "absolute", left: "-50%", top: "0%", width: "200%", height: "200%", maxWidth: "none" });
    expect(croppedImageStyle({ l: 0.1, t: 0.2, r: 0, b: 0 })).toMatchObject({ left: "-11.1111%", top: "-25%", width: "111.1111%", height: "125%" });
    const c = await render(
      <>
        <RichDoc basePt={11} doc={docOf({ type: "image_block", attrs: { ...image, crop } })} />
        <ImageViewer />
      </>,
    );
    try {
      const box = need(c.querySelector<HTMLElement>(".pic-block > span.pic"), "picture box");
      expect(box.style.width).toBe("10em");
      expect(box.style.aspectRatio).toBe("110 / 55");
      expect(box.style.overflow).toBe("hidden");
      expect(box.style.position).toBe("relative");
      expect(box.style.transform).toBe("rotate(90deg) scaleX(-1)");
      const img = need(box.querySelector<HTMLImageElement>("img"), "picture file");
      expect(img.getAttribute("src")).toMatch(/data\/assets\/0123456789abcdef0123456789abcdef\.png$/);
      expect([img.style.position, img.style.left, img.style.top, img.style.width, img.style.height]).toEqual(["absolute", "-50%", "0%", "200%", "200%"]);
      // Click to enlarge shows the same part.
      act(() => box.click());
      const shown = need(c.querySelector<HTMLElement>('[role="dialog"] .lb-crop'), "viewer crop box");
      expect(shown.style.overflow).toBe("hidden");
      expect(shown.querySelector("img")?.style.left).toBe("-50%");
    } finally {
      act(() => closeImageViewer());
    }
  });

  it("clamps an anchored child's offset to the container: min(offset, 100% − child width)", async () => {
    expect(anchoredOffset(220, 110, 11)).toBe("min(20em, calc(100% - 10em))");
    const c = await render(<RichDoc basePt={11} doc={docOf({ type: "anchored", attrs: { offsetPt: 220 }, content: [{ type: "image_block", attrs: image }] })} />);
    const holder = c.querySelector<HTMLElement>(".anchored > div");
    // jsdom serializes the calc() inside min() without the calc keyword; the exact string is asserted above.
    expect(holder?.style.marginLeft).toBe("min(20em, 100% - 10em)");
    expect(holder?.querySelector("img")).not.toBeNull();
  });

  it("draws a text box with its width, border, fill and Word's default insets", async () => {
    const c = await render(
      <RichDoc
        basePt={12}
        doc={docOf({ type: "textbox", attrs: { widthPt: 120, fill: "F2F2F2", border: { style: "single", widthPt: 1.2, color: "000000" }, inline: true }, content: [para("boxed")] })}
      />,
    );
    const box = c.querySelector<HTMLElement>(".textbox");
    expect(box?.textContent).toBe("boxed");
    expect(box?.style.width).toBe("10em");
    expect(box?.style.border).toBe("0.1em solid rgb(0, 0, 0)");
    expect(box?.style.padding).toBe("0.3em 0.6em");
    expect(box?.style.display).toBe("inline-block");
    expect(box?.style.background).toContain("rgb(242, 242, 242)");
  });

  it("pads cells with the reading padding at Word's default margins, grown or shrunk by her margin changes", async () => {
    expect(cellPadding(WORD_CELL_MARGINS, 12)).toBe("7px 10px 7px 10px");
    expect(cellPadding({ top: 2.4, right: 0, bottom: 1.2, left: 10.8 }, 12)).toBe(
      "max(0px, calc(7px + 0.2em)) max(0px, calc(10px + -0.45em)) max(0px, calc(7px + 0.1em)) max(0px, calc(10px + 0.45em))",
    );

    const plain = await render(<RichDoc basePt={12} doc={docOf(tableNode([100], [row("r_PLAIN00001", [cell("a")])]))} />);
    expect(styleOf(plain.querySelector("td")).padding).toBe("7px 10px");
    const changed = await render(
      <RichDoc basePt={12} doc={docOf(tableNode([100], [row("r_WIDER00001", [cell("a")])], { cellMarginPt: { top: 2.4, right: 5.4, bottom: 2.4, left: 5.4 } }))} />,
    );
    const td = styleOf(changed.querySelector("td"));
    expect(td.paddingTop).toContain("0.2em");
    expect(td.paddingLeft).toBe("10px");
  });

  it("draws each shape kind through the shared drawing module, with its text frames", async () => {
    const shape = (geom: string, over: Partial<DrawingShape> = {}): DrawingShape => ({
      geom, x: 0, y: 0, w: 40, h: 20, rot: 0, flipH: false, flipV: false, stroke: { color: "000000", widthPt: 1, dash: null }, fill: null, head: null, tail: null, asset: null, ...over,
    });
    const shapes = [
      shape("line", { stroke: null }),
      shape("straightConnector1", { tail: "triangle" }),
      shape("arc"),
      shape("mathPlus", { fill: "FF0000" }),
      shape("rightBrace"),
      shape("rect", { stroke: { color: "0000FF", widthPt: 2, dash: "sysDash" } }),
      shape("roundRect"),
      shape("ellipse", { rot: 45 }),
      shape("picture", { asset: "fedcba9876543210fedcba9876543210.png" }),
      shape("cloud"),
    ];
    const c = await render(
      <RichDoc
        basePt={10}
        doc={docOf({
          type: "drawing",
          attrs: { widthPt: 200, heightPt: 100, shapes },
          content: [{ type: "drawing_text", attrs: { x: 5, y: 6, w: 50, h: 20, fill: "FFFFFF", border: { style: "single", widthPt: 1, color: "000000" } }, content: [para("label")] }],
        })}
      />,
    );
    const svg = c.querySelector("svg.drawing");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 200 100");
    expect(styleOf(svg).width).toBe("20em");
    const top = [...(svg?.children ?? [])].filter((el) => el.tagName !== "foreignObject");
    expect(top.map((el) => el.tagName)).toEqual(["g", "g", "path", "path", "path", "rect", "rect", "ellipse", "image", "rect"]);
    // A line with no stroke has no outline (not a 0.75pt black fallback).
    expect(top[0]?.querySelector("line")?.getAttribute("stroke")).toBe("none");
    // The connector's tail arrowhead is a polygon in the stroke colour.
    expect(top[1]?.querySelector("polygon")?.getAttribute("fill")).toBe("#000000");
    expect(top[3]?.getAttribute("fill")).toBe("#FF0000");
    expect(top[5]?.getAttribute("stroke-dasharray")).toBe("6 2");
    expect(top[6]?.getAttribute("rx")).not.toBeNull();
    expect(top[7]?.getAttribute("transform")).toContain("rotate(45)");
    expect(top[8]?.getAttribute("href")).toMatch(/assets\/fedcba9876543210fedcba9876543210\.png$/);
    const fo = svg?.querySelector("foreignObject");
    expect([fo?.getAttribute("x"), fo?.getAttribute("y"), fo?.getAttribute("width"), fo?.getAttribute("height")]).toEqual(["5", "6", "50", "20"]);
    expect(fo?.textContent).toBe("label");
  });

  it("renders a rule as <hr> in its colour and width", async () => {
    const c = await render(<RichDoc basePt={10} doc={docOf({ type: "rule", attrs: { color: "7F7F7F", widthPt: 1.5 } })} />);
    const hr = c.querySelector<HTMLElement>("hr.rule");
    expect(hr?.style.borderTop).toBe("0.15em solid rgb(127, 127, 127)");
  });

  it("renders a slide card with its heading and items, and a heading line as h3", async () => {
    const c = await render(
      <RichDoc basePt={11} doc={docOf({ type: "heading_line", content: [text("Title")] }, { type: "slide_card", content: [para("Presentation"), para("Irregularly irregular")] })} />,
    );
    expect(c.querySelector("h3.heading-line")?.textContent).toBe("Title");
    expect(c.querySelector(".sd-card h4")?.textContent).toBe("Presentation");
    expect(c.querySelector(".sd-card p")?.textContent).toBe("Irregularly irregular");
  });

  it("ignores node types it does not know", async () => {
    const c = await render(<RichDoc basePt={11} doc={docOf({ type: "mystery", content: [para("hidden")] }, para("shown"))} />);
    expect(c.textContent).toBe("shown");
  });
});

describe("pharm notes aids", () => {
  it("draws a divider paragraph as a rule with its text still in the DOM, and bolds a lead label", async () => {
    const doc = docOf(para("- - - - - -"), para([text("Clin "), text("Use: angina", [{ type: "italic" }])]), para("no label here"));
    const c = await render(<RichDoc basePt={11} doc={doc} pharmNotes />);
    const div = c.querySelector(".pdiv");
    expect(div?.querySelector("hr")).not.toBeNull();
    expect(div?.querySelector(".vh")?.textContent).toBe("- - - - - -");
    const labels = [...c.querySelectorAll(".lead-label")].map((l) => l.textContent);
    // The label "Clin Use:" spans two runs; each run's share is wrapped, the rest is not.
    expect(labels).toEqual(["Clin ", "Use:"]);
    expect(c.querySelectorAll("p")[0]?.textContent).toBe("Clin Use: angina");
    expect(c.querySelectorAll("p")[1]?.querySelector(".lead-label")).toBeNull();
  });

  it("applies neither aid outside pharm notes", async () => {
    const c = await render(<RichDoc basePt={11} doc={docOf(para("------"), para("MOA: x"))} />);
    expect(c.querySelector(".pdiv")).toBeNull();
    expect(c.querySelector(".lead-label")).toBeNull();
    expect(c.querySelectorAll("p")[0]?.textContent).toBe("------");
  });
});

describe("labels for content not from her notes", () => {
  const note: FlagNote = {
    id: "u_0000000001", guideline: "GOLD 2025 report", org: "GOLD", published: "2025-01", quote: "Use LAMA/LABA.", grade: "A", url: "https://goldcopd.org/x", flagged: "2026-10-01",
  };
  const gap = (over: Partial<PubGap> = {}): PubGap => ({
    id: "g_0000000001",
    title: "TSH in AF",
    relevantTo: "Atrial fibrillation",
    written: "2026-10",
    doc: { type: "doc", content: [para("Check TSH.")] },
    differs: null,
    sources: [
      { name: "AHA/ACC AF guideline", org: "American Heart Association", year: "2023", url: "https://www.ahajournals.org/x" },
      { name: "Local note", org: "Clinic", year: "2020", url: null },
    ],
    ownerEdits: [],
    figures: [],
    asNotes: false,
    notes: [],
    ...over,
  });
  const strip: PubFigure = {
    asset: `${"ab".repeat(16)}.png`, width: 800, height: 300, caption: "Atrial fibrillation, lead II",
    credit: { author: "Jane Roe", license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/", page: "https://commons.wikimedia.org/wiki/File:AF.png", changes: "Cropped to lead II" },
  };

  it("gap block: no figure area when the block has no images", async () => {
    const c = await render(<GapBlock gap={gap()} />);
    expect(c.querySelector(".gap-figs")).toBeNull();
  });

  it("gap block: each image before the text, opening full size, with its caption as alt text and its credit line", async () => {
    const pd: PubFigure = { ...strip, asset: `${"cd".repeat(16)}.jpg`, caption: "Hyperkalemia", credit: { ...strip.credit, author: "US Gov", license: "Public domain", licenseUrl: null, changes: null } };
    const c = await render(<GapBlock gap={gap({ figures: [strip, pd] })} />);
    const figs = [...c.querySelectorAll("section.gap .gap-figs figure")];
    expect(figs).toHaveLength(2);
    expect(c.querySelector(".gap-figs")?.nextElementSibling?.matches(".gap-body")).toBe(true);
    const img = figs[0]?.querySelector("img");
    expect(img?.getAttribute("src")).toBe(`${DATA_BASE}assets/${strip.asset}`);
    expect(img?.getAttribute("alt")).toBe("Atrial fibrillation, lead II");
    expect([img?.getAttribute("width"), img?.getAttribute("height")]).toEqual(["800", "300"]);
    expect(img?.parentElement?.getAttribute("href")).toBe(`${DATA_BASE}assets/${strip.asset}`);
    expect(figs[0]?.querySelector(".fig-credit")?.textContent).toBe("Image: Jane Roe · CC BY-SA 4.0 · Source  · Changes: Cropped to lead II");
    const links = [...(figs[0]?.querySelectorAll(".fig-credit a") ?? [])].map((a) => [a.textContent?.trim(), a.getAttribute("href"), a.getAttribute("target")]);
    expect(links).toEqual([
      ["CC BY-SA 4.0", "https://creativecommons.org/licenses/by-sa/4.0/", "_blank"],
      ["Source", "https://commons.wikimedia.org/wiki/File:AF.png", "_blank"],
    ]);
    // Public domain: the license is plain text and an unchanged file states no change.
    expect(figs[1]?.querySelector(".fig-credit")?.textContent).toBe("Image: US Gov · Public domain · Source ");
    expect([...(figs[1]?.querySelectorAll(".fig-credit a") ?? [])].map((a) => a.textContent?.trim())).toEqual(["Source"]);
  });

  it("gap block: by default each image is a link to the full-size file, not a viewer button", async () => {
    const c = await render(<GapBlock gap={gap({ figures: [strip] })} />);
    expect(c.querySelector(".gap-figs")?.classList.contains("thumbs")).toBe(false);
    expect(c.querySelector(".gap-figs button")).toBeNull();
    expect(c.querySelector(".gap-figs img")?.parentElement?.tagName).toBe("A");
  });

  it("gap block: an image with a set width shows at that width in em of the box's 11 pt text; one without has no width style", async () => {
    const c = await render(<GapBlock gap={gap({ figures: [{ ...strip, widthPt: 300 }, { ...strip, asset: `${"cd".repeat(16)}.png` }] })} />);
    const imgs = [...c.querySelectorAll<HTMLImageElement>(".gap-figs img")];
    expect(imgs[0]?.style.width).toBe("27.2727em");
    expect(imgs[1]?.style.width).toBe("");
  });

  it("gap block: a squished or stretched image keeps its set proportions; one without a set height keeps the file's", async () => {
    const c = await render(<GapBlock gap={gap({ figures: [{ ...strip, widthPt: 300, heightPt: 250 }, { ...strip, asset: `${"cd".repeat(16)}.png`, widthPt: 300 }] })} />);
    const imgs = [...c.querySelectorAll<HTMLImageElement>(".gap-figs img")];
    expect(imgs[0]?.style.width).toBe("27.2727em");
    expect(imgs[0]?.style.aspectRatio).toBe("300 / 250");
    expect(imgs[1]?.style.aspectRatio).toBe("");
  });

  it("gap block thumbnails: a set width does not change the thumbnail size", async () => {
    const c = await render(<GapBlock gap={gap({ figures: [{ ...strip, widthPt: 300 }] })} thumbnails />);
    expect(c.querySelector<HTMLImageElement>(".gap-figs img")?.style.width).toBe("");
  });

  it("gap block shown as her notes: no box class, badge or Relevant-to line, for anyone; sources and image credit kept", async () => {
    const c = await render(<GapBlock gap={gap({ asNotes: true, figures: [strip] })} />);
    asOwner(true);
    const sec = need(c.querySelector("section"), "section");
    expect(sec.className).toBe("gap as-notes");
    expect(visibleText(c)).not.toContain("Not from your notes");
    expect(sec.querySelector(".gap-meta")).toBeNull();
    expect(sec.querySelectorAll(".gap-src ol li")).toHaveLength(2);
    expect(sec.querySelector(".fig-credit")?.textContent).toContain("Image: Jane Roe");
    expect(sec.querySelector("h3")?.textContent).toBe("TSH in AF");
  });

  it("gap block thumbnails: each image is a button that opens the full-size viewer and returns focus on Escape", async () => {
    const c = await render(
      <>
        <GapBlock gap={gap({ figures: [strip] })} thumbnails />
        <ImageViewer />
      </>,
    );
    try {
      expect(c.querySelector(".gap-figs")?.classList.contains("thumbs")).toBe(true);
      expect(c.querySelector(".gap-figs a img")).toBeNull();
      const btn = need(c.querySelector<HTMLButtonElement>(".gap-figs button.imgbtn"), "thumbnail button");
      expect(btn.getAttribute("type")).toBe("button");
      expect(btn.getAttribute("aria-label")).toBe("Open full size: Atrial fibrillation, lead II");
      expect(btn.querySelector("img")?.getAttribute("src")).toBe(`${DATA_BASE}assets/${strip.asset}`);
      // The credit line stays under the thumbnail.
      expect(btn.closest("figure")?.querySelector(".fig-credit")?.textContent).toContain("Image: Jane Roe");
      expect(c.querySelector('[role="dialog"]')).toBeNull();

      act(() => btn.focus());
      act(() => btn.click());
      const dialog = need(c.querySelector<HTMLElement>('[role="dialog"]'), "viewer");
      expect(dialog.querySelector(".lb-in img")?.getAttribute("src")).toBe(`${DATA_BASE}assets/${strip.asset}`);
      act(() => {
        dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      });
      expect(c.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(btn);
    } finally {
      act(() => closeImageViewer());
    }
  });

  it("gap block: the credit line reads the same for visitors and the owner", async () => {
    const c = await render(<GapBlock gap={gap({ figures: [strip] })} />);
    const credit = (): string => visibleText(c.querySelector(".gap-figs") as HTMLElement);
    const visitor = credit();
    expect(visitor).toContain("Image: Jane Roe");
    asOwner(true);
    expect(credit()).toBe(visitor);
  });

  it("gap block: dashed container for everyone, with title, Relevant to, Written, content and numbered sources", async () => {
    const c = await render(<GapBlock gap={gap()} />);
    const sec = c.querySelector("section.gap");
    expect(sec?.getAttribute("data-anchor")).toBe("g_0000000001");
    expect(sec?.querySelector("h3")?.textContent).toBe("TSH in AF");
    expect(sec?.querySelector(".gap-meta")?.textContent).toMatch(/^Relevant to: Atrial fibrillation · Written /);
    expect(sec?.querySelector(".gap-body")?.textContent).toBe("Check TSH.");
    const items = [...(sec?.querySelectorAll(".gap-src ol li") ?? [])];
    expect(items.map((li) => li.textContent?.trim())).toEqual([
      "AHA/ACC AF guideline. American Heart Association. 2023. Open source",
      "Local note. Clinic. 2020.",
    ]);
    const open = items[0]?.querySelector("a");
    expect(open?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(open?.getAttribute("target")).toBe("_blank");
  });

  it("gap block: badge, 'Edited by you · date' and the Differs callout only for the owner", async () => {
    const g = gap({ ownerEdits: ["2026-10-02T10:00:00Z", "2026-10-03T09:00:00Z"], differs: { type: "doc", content: [para("Your notes say 12 weeks.")] } });
    const c = await render(<GapBlock gap={g} />);
    const visitor = visibleText(c);
    expect(visitor).not.toContain("Not from your notes");
    expect(visitor).not.toContain("Edited by you");
    expect(visitor).not.toContain("Differs from your notes");
    expect(visitor).toContain("TSH in AF");
    asOwner(true);
    const owner = visibleText(c);
    expect(owner).toContain("Not from your notes");
    expect(owner).toMatch(/Edited by you · Oct 3, 2026/);
    expect(owner).toContain("Differs from your notes. Your notes say 12 weeks.");
  });

  it("gap block: a note placed at the gap shows at its top", async () => {
    const c = await render(<GapBlock gap={gap({ notes: [note] })} />);
    const sec = c.querySelector("section.gap");
    expect(sec?.firstElementChild?.matches("aside.upd")).toBe(true);
    expect(sec?.firstElementChild?.getAttribute("data-anchor")).toBe(note.id);
  });

  it("update note: badge and details for everyone, '— not from your notes' only for the owner", async () => {
    const c = await render(<UpdateNote note={note} />);
    const aside = c.querySelector("aside.upd");
    expect(aside?.querySelector(".ut")?.textContent).toBe("GOLD 2025 report");
    expect(visibleText(c)).toContain("Updated guideline");
    expect(visibleText(c)).not.toContain("not from your notes");
    expect(aside?.textContent).toContain("GOLD · Published");
    expect(aside?.textContent).toContain("Grade A");
    expect(aside?.querySelector("blockquote")?.textContent).toBe("“Use LAMA/LABA.”");
    const a = aside?.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://goldcopd.org/x");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
    asOwner(true);
    expect(visibleText(c)).toContain("— not from your notes");
  });

  it("update note: no quote, grade or link when absent or not a web URL", async () => {
    const c = await render(<UpdateNote note={{ ...note, quote: null, grade: null, url: "javascript:alert(1)" }} />);
    expect(c.querySelector("blockquote")).toBeNull();
    expect(c.textContent).not.toContain("Grade");
    expect(c.querySelector("a")).toBeNull();
  });

  it("Review slides badge: '— made from your notes' only on generated decks, and only for the owner", async () => {
    asOwner(true);
    const gen = await render(<ReviewSlidesBadge generated />);
    expect(visibleText(gen)).toBe("Review slides — made from your notes · Not included in PDF downloads");
    ui?.unmount();
    const own = await render(<ReviewSlidesBadge generated={false} />);
    expect(visibleText(own)).toBe("Review slides · Not included in PDF downloads");
    asOwner(false);
    ui?.unmount();
    const visitor = await render(<ReviewSlidesBadge generated />);
    expect(visibleText(visitor)).toBe("Review slides · Not included in PDF downloads");
  });
});

describe("search landing on rendered notes", () => {
  it("opening a result for a later match lands on that match's row, not the first match on the page", async () => {
    const site = fakeSite();
    setSearchClient(new SearchClient(() => inProcessWorker(site.fetch), BASE, site.fetch));
    resetSearchState();
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      const t = tableNode([50, 50], [
        row("r_first", [cell("Lithium"), cell("levels")]),
        row("r_other", [cell("Valproate"), cell("LFTs")]),
        row("r_later", [cell("Toxicity"), cell("lithium tremor")]),
      ]);
      await navigate(`#/eor/psy/s/x?q=lithium&at=r_later`);
      const c = await render(
        <SearchHighlightProvider>
          <main>
            <SearchLanding />
            <div className="notes">
              <RichDoc basePt={11} doc={docOf(t)} />
            </div>
          </main>
        </SearchHighlightProvider>,
      );
      await until(() => scrolled.length > 0, "scroll to the match");
      expect(scrolled).toHaveLength(1);
      expect(scrolled[0]?.closest("tr")?.getAttribute("data-anchor")).toBe("r_later");
      expect(scrolled[0]?.textContent?.toLowerCase()).toBe("lithium");
      // Both matches are highlighted.
      expect([...c.querySelectorAll("mark.hit")].map((m) => m.closest("tr")?.getAttribute("data-anchor"))).toEqual(["r_first", "r_later"]);
    } finally {
      Element.prototype.scrollIntoView = original;
      setSearchClient(null);
      await navigate("#/");
    }
  });
});

describe("paragraphStyle", () => {
  it("defaults missing attributes to zero, left and pre-wrap with a 36pt tab", () => {
    const s = paragraphStyle({}, 12);
    expect(s).toMatchObject({ marginLeft: "0em", textIndent: "0em", textAlign: "left", whiteSpace: "pre-wrap", tabSize: "3em" });
    expect(s.lineHeight).toBeUndefined();
    expect(vi.isMockFunction(paragraphStyle)).toBe(false);
  });
});
