// Pictures pasted or dropped as files go to her Add picture path; text pastes as before.
import { afterEach, describe, expect, it } from "vitest";
import { EditorView } from "prosemirror-view";
import { TextSelection } from "prosemirror-state";
import type { DocJSON } from "../../../lib/content/index.ts";
import { createEditorState, pastedFiles, pictureFileProps } from "./state.ts";
import { markViews, nodeViews } from "./views.ts";

const doc: DocJSON = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "abcd" }] }] };
const png = (): File => new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });

/** A DataTransfer as a paste or drop brings it (jsdom has none). */
function transfer(text: Record<string, string>, files: File[]): DataTransfer {
  return { getData: (t: string) => text[t] ?? "", files } as unknown as DataTransfer;
}

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

function open(onFiles: (files: File[]) => void): EditorView {
  const host = document.createElement("div");
  document.body.append(host);
  view = new EditorView(host, {
    state: createEditorState(doc),
    nodeViews: nodeViews(11),
    markViews: markViews(11),
    ...pictureFileProps((_v, files) => onFiles(files)),
  });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
  return view;
}

describe("pastedFiles", () => {
  it("is the files of a paste with no text, and none when the paste has text or no data", () => {
    const f = png();
    expect(pastedFiles(transfer({}, [f]))).toEqual([f]);
    expect(pastedFiles(transfer({ "text/html": '<img src="x">' }, [f]))).toEqual([f]);
    expect(pastedFiles(transfer({ "text/plain": "ECG" }, [f]))).toEqual([]);
    expect(pastedFiles(null)).toEqual([]);
  });
});

describe("pictureFileProps", () => {
  it("a pasted picture file goes to the Add picture path and inserts no text", () => {
    const got: File[][] = [];
    const v = open((files) => got.push(files));
    const f = png();
    const event = { clipboardData: transfer({ "text/html": '<img src="blob:x">' }, [f]) } as unknown as ClipboardEvent;
    expect(v.someProp("handlePaste", (h) => h(v, event, null as never))).toBe(true);
    expect(got).toEqual([[f]]);
    expect(v.state.doc.textContent).toBe("abcd");
  });

  it("a paste with text pastes the text and adds no picture", () => {
    const got: File[][] = [];
    const v = open((files) => got.push(files));
    const event = { clipboardData: transfer({ "text/plain": "X" }, [png()]) } as unknown as ClipboardEvent;
    expect(v.someProp("handlePaste", (h) => h(v, event, null as never))).toBe(true);
    expect(got).toEqual([]);
    expect(v.state.doc.textContent).toBe("aXbcd");
  });

  it("a dropped picture file moves the cursor to the drop point and goes to the Add picture path", () => {
    const got: { files: File[]; at: number }[] = [];
    const v = open((files) => got.push({ files, at: v.state.selection.from }));
    // jsdom has no layout: the drop point is the position after "abc".
    v.posAtCoords = () => ({ pos: 4, inside: -1 });
    const f = png();
    const event = { dataTransfer: transfer({}, [f]), clientX: 10, clientY: 10 } as unknown as DragEvent;
    expect(v.someProp("handleDrop", (h) => h(v, event, null as never, false))).toBe(true);
    expect(got).toEqual([{ files: [f], at: 4 }]);
  });

  it("any other drop is still refused", () => {
    const got: File[][] = [];
    const v = open((files) => got.push(files));
    const event = { dataTransfer: transfer({ "text/plain": "x" }, []), clientX: 0, clientY: 0 } as unknown as DragEvent;
    expect(v.someProp("handleDrop", (h) => h(v, event, { content: { childCount: 0 } } as never, false))).toBe(true);
    expect(got).toEqual([]);
    expect(v.state.doc.textContent).toBe("abcd");
  });
});
