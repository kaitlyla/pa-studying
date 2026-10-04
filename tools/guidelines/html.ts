// Fetched pages are untrusted input (10 §10.6 control 8): they are parsed as data with parse5, and
// only text nodes and `href` attribute values are read from the tree.
import { parse } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";

type ParentNode = DefaultTreeAdapterTypes.ParentNode;
export type Element = DefaultTreeAdapterTypes.Element;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;

export function parseHtml(html: string): ParentNode {
  return parse(html);
}

function children(node: ParentNode): ChildNode[] {
  return node.nodeName === "template" ? (node as DefaultTreeAdapterTypes.Template).content.childNodes : node.childNodes;
}

const isElement = (n: ChildNode): n is Element => "tagName" in n;
const isParent = (n: ChildNode): n is ChildNode & ParentNode => "childNodes" in n;

/** Every element under `node` in document order, optionally only those with tag `tag`. */
export function* elements(node: ParentNode, tag?: string): Generator<Element> {
  for (const child of children(node)) {
    if (isElement(child)) {
      if (tag === undefined || child.tagName === tag) yield child;
      yield* elements(child, tag);
    }
  }
}

/** The `tr` rows of `table`: its direct rows and those of its thead, tbody and tfoot, in order. */
export function rowsOf(table: Element): Element[] {
  const rows: Element[] = [];
  for (const child of children(table)) {
    if (!isElement(child)) continue;
    if (child.tagName === "tr") rows.push(child);
    else if (child.tagName === "tbody" || child.tagName === "thead" || child.tagName === "tfoot") {
      for (const row of children(child)) if (isElement(row) && row.tagName === "tr") rows.push(row);
    }
  }
  return rows;
}

export function cellsOf(row: Element, tag: "td" | "th"): Element[] {
  return children(row).filter((c): c is Element => isElement(c) && c.tagName === tag);
}

export function attr(el: Element, name: string): string | null {
  return el.attrs.find((a) => a.name === name)?.value ?? null;
}

const BLOCK_TAGS = new Set(["p", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "table", "tr", "blockquote"]);
const NEVER_TEXT = new Set(["script", "style", "template", "noscript"]);

/**
 * The text of `node`'s subtree. Block elements are separated by a paragraph break so that `norm`
 * keeps their paragraphs apart; elements whose tag is in `skip` (and scripts and styles) are left out.
 */
export function textOf(node: ParentNode, skip: ReadonlySet<string> = new Set()): string {
  let out = "";
  const walk = (n: ParentNode): void => {
    for (const child of children(n)) {
      if (child.nodeName === "#text") out += (child as DefaultTreeAdapterTypes.TextNode).value;
      else if (isElement(child)) {
        if (NEVER_TEXT.has(child.tagName) || skip.has(child.tagName)) continue;
        if (child.tagName === "br") {
          out += "\n";
          continue;
        }
        const block = BLOCK_TAGS.has(child.tagName);
        if (block) out += "\n\n";
        walk(child);
        if (block) out += "\n\n";
      } else if (isParent(child)) walk(child);
    }
  };
  walk(node);
  return out;
}

/**
 * Text normalization (80 §80.3): paragraphs are separated by runs of two or more newlines; whitespace
 * inside each is collapsed, each is trimmed, empty ones dropped, and they are joined with a blank line.
 */
export function norm(text: string): string {
  return text
    .split(/\n[^\S\n]*\n\s*/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p !== "")
    .join("\n\n");
}

/** Every `href` value in the page, in document order. */
export function hrefs(node: ParentNode): string[] {
  const out: string[] = [];
  for (const el of elements(node)) {
    const href = attr(el, "href");
    if (href !== null) out.push(href);
  }
  return out;
}
