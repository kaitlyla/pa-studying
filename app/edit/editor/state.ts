// Editor state and props for one editable block (plan 50 §50.3): history, her keyboard shortcuts, the
// picture guard, plain-text paste, and pictures pasted or dropped as files (no other drag-and-drop).
import { baseKeymap, chainCommands } from "prosemirror-commands";
import { history, isHistoryTransaction, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { Slice } from "prosemirror-model";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState, Plugin, TextSelection } from "prosemirror-state";
import type { EditorProps, EditorView } from "prosemirror-view";
import { schema } from "../../../lib/schema.ts";
import type { DocJSON } from "../../../lib/content/index.ts";
import { columnDrag } from "./columnDrag.ts";
import { CONFIRMED_DELETE, guardedCount, isPictureMove, plainTextSlice, splitParagraph, toggleBold, toggleItalic, toggleUnderline } from "./commands.ts";

/** Her editor's status text when an edit would remove a picture (`_editor/editor.js` refusePictureRemoval). */
export const PICTURE_REFUSED = "That would remove a picture. To remove a picture, click it and press \"Delete picture\".";

export interface EditorOptions {
  /** Called when the picture guard refuses an edit; the editor shows PICTURE_REFUSED. */
  onPictureRefused?: () => void;
}

/**
 * Rejects any transaction that lowers the count of pictures, text boxes, drawings or anchors, unless
 * a confirmed delete set the meta. Undo and redo are exempt: they replay changes already allowed.
 */
export function pictureGuard(onRefused?: () => void): Plugin {
  return new Plugin({
    filterTransaction(tr, state) {
      if (!tr.docChanged || tr.getMeta(CONFIRMED_DELETE) === true || isHistoryTransaction(tr)) return true;
      if (guardedCount(tr.doc) >= guardedCount(state.doc)) return true;
      onRefused?.();
      return false;
    },
  });
}

export function editorPlugins(opts: EditorOptions = {}): Plugin[] {
  return [
    history(),
    keymap({
      "Mod-z": undo,
      "Mod-y": redo,
      "Shift-Mod-z": redo,
      "Mod-b": toggleBold,
      "Mod-i": toggleItalic,
      "Mod-u": toggleUnderline,
      Enter: chainCommands(splitParagraph, baseKeymap.Enter as NonNullable<typeof baseKeymap.Enter>),
    }),
    keymap(baseKeymap),
    pictureGuard(opts.onPictureRefused),
    columnDrag(),
  ];
}

export function createEditorState(doc: DocJSON | PMNode, opts: EditorOptions = {}): EditorState {
  const node = "type" in doc && typeof doc.type !== "string" ? (doc as PMNode) : schema.nodeFromJSON(doc);
  return EditorState.create({ schema, doc: node, plugins: editorPlugins(opts) });
}

/** Turn pasted HTML into its text (no formatting from the source survives). */
export function htmlToText(html: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const blocks = parsed.body.querySelectorAll("p, div, li, tr, h1, h2, h3, h4, h5, h6, br");
  for (const el of blocks) el.append("\n");
  return (parsed.body.textContent ?? "").replace(/\n+$/, "");
}

/**
 * Paste inserts plain text only (each line a paragraph with the caret paragraph's attributes), so no
 * formatting from the source survives. The one drop allowed is a picture dragged to a new place in the
 * same editor; every other drop is refused. (Picture files pasted or dropped: `pictureFileProps`.)
 */
export const editorProps: EditorProps = {
  handlePaste: (view, event) => {
    const data = event.clipboardData;
    if (!data) return true;
    const plain = data.getData("text/plain");
    const html = data.getData("text/html");
    const text = plain !== "" ? plain : html !== "" ? htmlToText(html) : "";
    const content = plainTextSlice(text, view.state.selection.$from);
    const open = content.childCount > 0 && content.firstChild?.isBlock ? 1 : 0;
    view.dispatch(view.state.tr.replaceSelection(new Slice(content, open, open)).scrollIntoView());
    return true;
  },
  // `moved` is true only for a move-drag that started in this same editor (ProseMirror's own drag).
  handleDrop: (_view, _event, slice, moved) => !isPictureMove(slice, moved),
};

/**
 * The files a paste brings: a copied picture comes as a file with no text (a browser's "Copy image"
 * adds only an <img> as HTML). A paste with text pastes the text, as before.
 */
export function pastedFiles(data: DataTransfer | null): File[] {
  if (!data || data.getData("text/plain") !== "") return [];
  return [...data.files];
}

/**
 * `editorProps` plus pictures: files pasted or dropped go to `onFiles` (her Add picture path) at the
 * cursor, a drop first moving the cursor to where they were dropped. Everything else is as `editorProps`.
 */
export function pictureFileProps(onFiles: (view: EditorView, files: File[]) => void): EditorProps {
  return {
    ...editorProps,
    handlePaste(view, event, slice) {
      const files = pastedFiles(event.clipboardData);
      if (files.length === 0) return editorProps.handlePaste?.call(this, view, event, slice) ?? false;
      onFiles(view, files);
      return true;
    },
    handleDrop(view, event, slice, moved) {
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length === 0) return editorProps.handleDrop?.call(this, view, event, slice, moved) ?? false;
      const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
      if (at) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at.pos))));
      onFiles(view, files);
      return true;
    },
  };
}
