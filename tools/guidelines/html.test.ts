import { describe, expect, it } from "vitest";
import { attr, cellsOf, elements, hrefs, norm, parseHtml, rowsOf, textOf } from "./html.ts";

describe("norm (80 §80.3)", () => {
  it("collapses whitespace inside paragraphs, splits on two or more newlines, drops empty paragraphs", () => {
    expect(norm("  The USPSTF\t recommends\nscreening.  ")).toBe("The USPSTF recommends screening.");
    expect(norm("First line.\n\nSecond   line.\n\n\n\nThird.")).toBe("First line.\n\nSecond line.\n\nThird.");
    expect(norm("A.\r\n  \r\nB.")).toBe("A.\n\nB.");
    expect(norm("\n\n  \n\n")).toBe("");
  });
});

describe("textOf", () => {
  it("keeps block elements apart as paragraphs, joins inline text, and turns br into a space", () => {
    const doc = parseHtml("<div><p>One <b>bold</b> word.</p><p>Two<br>lines.</p><ul><li>Item</li></ul></div>");
    expect(norm(textOf(doc))).toBe("One bold word.\n\nTwo lines.\n\nItem");
  });

  it("leaves out scripts, styles, templates, noscript and the elements asked for", () => {
    const doc = parseHtml("<head><style>p{}</style><script>var a = 'March 1, 2020';</script></head><body><template><p>T</p></template><noscript>Enable JS</noscript><p>Statement<sup>†</sup>.</p></body>");
    expect(norm(textOf(doc))).toBe("Statement†.");
    expect(norm(textOf(doc, new Set(["sup"])))).toBe("Statement.");
  });
});

describe("tree access", () => {
  const doc = parseHtml(`<table id="t"><caption>c</caption><thead><tr><th>H</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody>
    <tfoot><tr><td>f</td></tr></tfoot></table><template><a href="/in-template">x</a></template><a href="https://a.example/">a</a><link href="/style.css">`);

  it("rowsOf collects the rows of thead, tbody and tfoot in order; cellsOf picks a row's cells by tag", () => {
    const table = elements(doc, "table").next().value!;
    const rows = rowsOf(table);
    expect(rows.map((r) => norm(textOf(r)))).toEqual(["H", "12", "f"]);
    expect(cellsOf(rows[0]!, "th").map((c) => norm(textOf(c)))).toEqual(["H"]);
    expect(cellsOf(rows[0]!, "td")).toEqual([]);
    expect(cellsOf(rows[1]!, "td")).toHaveLength(2);
    expect(attr(table, "id")).toBe("t");
    expect(attr(table, "class")).toBeNull();
  });

  it("hrefs lists every href in document order, template content included", () => {
    expect(hrefs(doc)).toEqual(["/in-template", "https://a.example/", "/style.css"]);
  });

  it("parse5 builds browser trees from malformed markup: an unclosed p ends at its cell", () => {
    const table = elements(parseHtml("<table><tr><td><p>One<p>Two</td><td>Next</td></tr></table>"), "table").next().value!;
    const cells = cellsOf(rowsOf(table)[0]!, "td");
    expect(cells).toHaveLength(2);
    expect(norm(textOf(cells[0]!))).toBe("One\n\nTwo");
  });
});
