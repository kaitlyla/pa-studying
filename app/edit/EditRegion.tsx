// Edit mode on a page (plan 50 §50.2–§50.4; UI guide-reader/edit-mode, save-problems): the Edit and
// Versions buttons, the region that swaps the page body for ProseMirror editors seeded from Git, the
// toolbar, and the save banners.
import { Fragment, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { NodeSelection, type Selection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { GAP_FIGURE_HEIGHT_PT, GAP_FIGURE_WIDTH_PT, type DocJSON, type GapFigure, type GapFile } from "../../lib/content/index.ts";
import { pubFigures } from "../../lib/derive/published.ts";
import { BELOW_HEADING } from "../../lib/derive/topics.ts";
import { GAP_BASE_PT, GapChip, GapFigures, gapClass, type FigurePicking } from "../render/index.ts";
import { currentHash, navigate, versionsHash } from "../shell/route.ts";
import { useOwner } from "../shell/owner.tsx";
import { showToast } from "../shell/toast.tsx";
import { useIsPhone } from "../shell/responsive.ts";
import { PageBarSlot } from "../shell/pageScale.ts";
import {
  changeCellMargins, changeColumnWidth, changeLineSpacing, changeSize, changeSpace, deletePicture, deleteRow, HIGHLIGHT_COLORS, insertPicture, insertRow,
  dragPicture, dragPictureCrop, draggedPictureSize, moveParagraph, naturalPictureWidth, removeHighlight, resetPictureCrop, resetPictureShape, resizePicture,
  scaledPictureSize, selectedPictureSize, selectionSize, setHighlight, setSize, shownPictureWidth, sizeOptions, steppedPictureSize, toggleBold, toggleItalic,
  toggleUnderline, type Command, type DocContext, type PictureCrop, type PictureHandle, type PictureSize, type PictureTurn,
} from "./editor/commands.ts";
import { PictureHandles, pictureFile } from "./PictureHandles.tsx";
import { addPictureFile, PICTURE_ACCEPT } from "./pictures.ts";
import { createEditorState, PICTURE_REFUSED, pictureFileProps } from "./editor/state.ts";
import { clipboardSerializer, markViews, nodeViews } from "./editor/views.ts";
import { editorConfirm } from "./dialogs.tsx";
import {
  copyWithToast, currentLook, dismissBanner, done, getEditStore, LOAD_NEWER, loadNewer, registerView, restoreDraft, save, SAVE_CONFLICT, SAVE_FAILED, SAVE_OFFLINE,
  setGapLook, startEdit, useEdit, viewChanged, type Banner,
} from "./session.ts";
import { figuresWithLook, gapLook, type Part, type Slot } from "./units.ts";
import { rememberVersionsOrigin } from "./versions.ts";
import "./edit.css";

export { useIsEditing } from "./session.ts";

// ---- the focused editor -------------------------------------------------------------------------

interface Active {
  view: EditorView;
  ctx: DocContext;
}

let active: Active | null = null;
/**
 * A gap block's figure she picked (edit mode): Picture − / + size it instead of a picture in an editor.
 * Cleared when its box unmounts (the edit ends or its editors are replaced), so it never outlives the edit.
 */
interface PickedFigure {
  gapId: string;
  index: number;
}
let picked: PickedFigure | null = null;
const activeListeners = new Set<() => void>();
const touch = (): void => activeListeners.forEach((l) => l());

/** She picked a figure (null: she went back to an editor). */
function pickFigure(p: PickedFigure | null): void {
  picked = p;
  touch();
}

/** The open edit's gap block with this id. */
function openGap(id: string): GapFile | null {
  const part = getEditStore().edit?.unit?.parts.find((p): p is Extract<Part, { kind: "gap" }> => p.kind === "gap" && p.gap.id === id);
  return part?.gap ?? null;
}

/** The sizes a gap block's figure can be set to. */
const FIGURE_LIMIT: PictureSize = { widthPt: GAP_FIGURE_WIDTH_PT, heightPt: GAP_FIGURE_HEIGHT_PT };

/** The picked figure's img on the page. */
const pickedFigureImg = (): Element | null => document.querySelector(".gap-fig.picked img");

/**
 * The picked figure in the open edit, and its size: as she set it; else as it is shown (an unsized
 * figure is drawn at its file's own pixel size, within the column), in its file's proportions; else,
 * before the page has drawn it, its natural size. An unsized one is held within FIGURE_LIMIT (keeping
 * its proportions), so a size taken from it always saves.
 */
function openFigure(p: PickedFigure): { gap: GapFile; f: GapFigure; size: PictureSize } | null {
  const gap = openGap(p.gapId);
  const f = gap?.meta.figures?.[p.index];
  if (!gap || !f) return null;
  const look = currentLook(gap);
  const set = look.widths[f.asset];
  if (set !== undefined) return { gap, f, size: { widthPt: set, heightPt: look.heights?.[f.asset] ?? (set * f.height) / f.width } };
  const widthPt = shownPictureWidth(pickedFigureImg(), GAP_BASE_PT) ?? naturalPictureWidth(f.width, FIGURE_LIMIT.widthPt);
  return { gap, f, size: scaledPictureSize({ widthPt, heightPt: (widthPt * f.height) / f.width }, 1, FIGURE_LIMIT) };
}

/**
 * The picked figure resized to `size(its size)`, within FIGURE_LIMIT. Its height is kept only when it
 * is squished or stretched; one in its file's proportions keeps none, so it shows as the file is.
 */
function sizeFigure(p: PickedFigure, size: (s: PictureSize) => PictureSize): void {
  const o = openFigure(p);
  if (!o) return;
  const { gap, f } = o;
  const next = size(o.size);
  const look = currentLook(gap);
  const heights = { ...look.heights };
  if (Math.abs(next.heightPt - (next.widthPt * f.height) / f.width) < 0.01) delete heights[f.asset];
  else heights[f.asset] = next.heightPt;
  setGapLook(gap, { ...look, widths: { ...look.widths, [f.asset]: next.widthPt }, heights });
}

/** Picture − / + on the picked figure: one steppedPictureSize step, as for a picture in her notes. */
const resizeFigure = (p: PickedFigure, dir: 1 | -1): void =>
  sizeFigure(p, (s) => steppedPictureSize(s, dir, FIGURE_LIMIT, shownPictureWidth(pickedFigureImg(), GAP_BASE_PT)));

/** The toolbar's button that gives a squished or stretched picture its file's proportions again, keeping its width. */
export const RESET_SHAPE = "Reset shape";
/** The toolbar's toggle that turns the selected picture's handles into crop handles, as in Word. */
export const CROP = "Crop";
/** The toolbar's button that brings back the whole of a cropped picture's file. */
export const RESET_CROP = "Reset crop";

/** Reset shape on the picked figure (its file's proportions are its stored pixel size's). */
function resetFigureShape(p: PickedFigure): void {
  const o = openFigure(p);
  if (!o) return;
  const { f } = o;
  sizeFigure(p, (s) => scaledPictureSize({ widthPt: s.widthPt, heightPt: (s.widthPt * f.height) / f.width }, 1, FIGURE_LIMIT));
}

function useActive(): { a: Active | null; figure: PickedFigure | null } {
  const [, setTick] = useState(0);
  useEffect(() => {
    const l = (): void => setTick((n) => n + 1);
    activeListeners.add(l);
    return () => {
      activeListeners.delete(l);
    };
  }, []);
  return { a: active, figure: picked };
}

function SlotEditor({ slot }: { slot: Slot }): ReactNode {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return undefined;
    const ctx: DocContext = { basePt: slot.basePt, pageContentPt: slot.pageContentPt, pageContentHeightPt: slot.pageContentHeightPt };
    const view: EditorView = new EditorView(el, {
      state: createEditorState(slot.doc, { onPictureRefused: () => showToast(PICTURE_REFUSED) }),
      nodeViews: nodeViews(slot.basePt),
      markViews: markViews(slot.basePt),
      clipboardSerializer: clipboardSerializer(slot.basePt),
      ...pictureFileProps((v, files) => void addPictures(files, { view: v, ctx })),
      attributes: { "aria-label": "Editable notes", "data-slot": slot.id },
      dispatchTransaction(tr) {
        view.updateState(view.state.apply(tr));
        if (tr.docChanged) viewChanged();
        active = { view, ctx };
        picked = null;
        touch();
      },
      handleDOMEvents: {
        focus: () => {
          active = { view, ctx };
          picked = null;
          touch();
          return false;
        },
      },
    });
    const unregister = registerView(slot.id, view, slot.doc as DocJSON);
    return () => {
      unregister();
      if (active?.view === view) active = null;
      view.destroy();
    };
  }, [slot]);
  return <div className="notes edit-slot" ref={host} />;
}

type SlotView = (slot: Slot) => ReactNode;

const editorView: SlotView = (slot) => <SlotEditor slot={slot} />;

/** The switch on a gap block in edit mode: shown as her own notes (no gap box or labels) or as a gap block. */
export const SHOW_AS_MY_NOTES = "Show as my notes";

/**
 * A gap block's editors in its box. `editing`: the open edit's (its look as she changed it, with the
 * Show as my notes switch, and figures she can pick to resize); else as stored (Versions' View).
 */
function GapFrame({ part, slotView, editing }: { part: Extract<Part, { kind: "gap" }>; slotView: SlotView; editing: boolean }): ReactNode {
  const { edit } = useEdit();
  const { figure } = useActive();
  const { gap } = part;
  const m = gap.meta;
  const look = (editing ? edit?.looks[gap.id] : undefined) ?? gapLook(gap);
  const figures = figuresWithLook(pubFigures(m), look);
  useEffect(() => () => {
    if (picked?.gapId === gap.id) pickFigure(null);
  }, [gap.id]);
  const picking: FigurePicking | undefined = editing
    ? { picked: figure?.gapId === gap.id ? figure.index : null, onPick: (index) => pickFigure({ gapId: gap.id, index }) }
    : undefined;
  return (
    <section className={gapClass(look.asNotes)} aria-label={m.title}>
      <div className="gap-h">
        {!look.asNotes && <GapChip />}
        <h3>{m.title}</h3>
        {editing && (
          <label className="gap-asnotes">
            <input type="checkbox" checked={look.asNotes} onChange={(e) => setGapLook(gap, { ...look, asNotes: e.currentTarget.checked })} data-ref="gap-asnotes" />
            {SHOW_AS_MY_NOTES}
          </label>
        )}
      </div>
      {!look.asNotes && <div className="gap-meta">Relevant to: <b>{m.relevantTo}</b> · Written {m.written}</div>}
      <GapFigures figures={figures} picking={picking} />
      {slotView(part.doc)}
      {part.differs && (
        <div className="gap-diff">
          <b>Differs from your notes.</b>
          {slotView(part.differs)}
        </div>
      )}
      <div className="gap-src"><b>Sources</b><ol>{m.sources.map((s, i) => <li key={i}>{s.name}. {s.org}. {s.year}.</li>)}</ol></div>
    </section>
  );
}

/** One part of an edit unit: its slots shown by `slotView` (editors here; read-only in Versions' View). */
export function PartView({ part, slotView = editorView }: { part: Part; slotView?: SlotView }): ReactNode {
  switch (part.kind) {
    case "stub":
      return <div className="stub"><span className="stub-t">{part.label}</span> drug table — edited on its pharm section</div>;
    case "gap":
      // The editors' own view is the open edit; any other (Versions' View) shows a version as stored.
      return <GapFrame part={part} slotView={slotView} editing={slotView === editorView} />;
    case "below":
      return (
        <section className="below-edit" aria-label={BELOW_HEADING}>
          <div className="below-h">{BELOW_HEADING}</div>
          {slotView(part.slot)}
        </section>
      );
    default:
      return slotView(part.slot);
  }
}

// ---- toolbar ------------------------------------------------------------------------------------

function Tool({ label, run, children, refk, disabled, pressed }: { label: string; run: () => void; children: ReactNode; refk?: string; disabled?: boolean; pressed?: boolean }): ReactNode {
  return (
    <button
      type="button"
      className="tb"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      data-ref={refk}
      disabled={disabled}
      onMouseDown={(e) => {
        e.preventDefault();
        run();
      }}
    >
      {children}
    </button>
  );
}

/** "Highlight" opens these swatches; picking one highlights the selection in it. */
function HighlightPicker({ run }: { run: (c: Command) => void }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <span className="tb-pop">
      <Tool label="Highlight" run={() => setOpen((o) => !o)} refk="tb-highlight"><span className="tb-hl">H</span> ▾</Tool>
      {open && (
        <span className="tb-swatches" role="group" aria-label="Highlight colors" data-ref="tb-highlight-colors">
          {HIGHLIGHT_COLORS.map((c) => (
            <Tool key={c.hex} label={`Highlight ${c.name}`} run={() => { setOpen(false); run(setHighlight(c.hex)); }} refk={`tb-hl-${c.hex}`}>
              <span className="swatch" style={{ background: `#${c.hex}` }} />
            </Tool>
          ))}
          <Tool label="Remove highlight" run={() => { setOpen(false); run(removeHighlight); }} refk="tb-unhighlight"><s>H</s></Tool>
        </span>
      )}
    </span>
  );
}

/**
 * Puts picture files in at the cursor of `at`, in order: the one path for Add picture and for pictures
 * pasted or dropped. A file that can't be added stops there with her message.
 */
async function addPictures(files: readonly File[], at: Active): Promise<void> {
  for (const file of files) {
    const pic = await addPictureFile(file);
    if (typeof pic === "string") {
      showToast(pic);
      return;
    }
    insertPicture(pic, at.ctx)(at.view.state, at.view.dispatch);
  }
  at.view.focus();
}

/** "Add picture": a file picker; the chosen picture goes in at the cursor of the editor she was in. */
function AddPicture({ a }: { a: Active | null }): ReactNode {
  const input = useRef<HTMLInputElement>(null);
  const target = useRef<Active | null>(null);
  const picked = async (file: File | undefined): Promise<void> => {
    const at = target.current;
    if (!file || !at) return;
    await addPictures([file], at);
  };
  return (
    <>
      <Tool label="Add picture" run={() => { target.current = a; input.current?.click(); }} refk="tb-pic-add">Add picture</Tool>
      <input
        ref={input}
        type="file"
        accept={PICTURE_ACCEPT}
        hidden
        data-ref="tb-pic-file"
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          void picked(file);
        }}
      />
    </>
  );
}

function Toolbar(): ReactNode {
  const { edit } = useEdit();
  const { a, figure } = useActive();
  const phone = useIsPhone();
  const [cropSel, setCropSel] = useState<Selection | null>(null);
  const cmd = (c: (ctx: DocContext) => Command) => (): void => {
    if (!a) return;
    c(a.ctx)(a.view.state, a.view.dispatch);
    a.view.focus();
  };
  const plainCmd = (c: Command) => cmd(() => c);
  const sel = a?.view.state.selection;
  const picSel = sel instanceof NodeSelection && (sel.node.type.name === "image" || sel.node.type.name === "image_block") ? sel : null;
  const picture = picSel !== null;
  const pictureImg = (): Element | null => {
    const n = a && picSel ? a.view.nodeDOM(picSel.from) : null;
    return n instanceof Element ? n : null;
  };
  const shownPicture = (c: DocContext): number | null => shownPictureWidth(pictureImg(), c.basePt);
  const pictureNow = a && picSel ? selectedPictureSize(a.view.state, a.ctx) : null;
  // Crop mode belongs to the selection it was turned on for (or the one its own last crop left), so
  // selecting anything else, or changing the picture any other way, ends it.
  const cropping = picSel !== null && cropSel === picSel;
  useEffect(() => {
    if (!cropping) return;
    const key = (ev: KeyboardEvent): void => {
      if (ev.key !== "Escape" && ev.key !== "Enter") return;
      ev.preventDefault();
      ev.stopPropagation();
      setCropSel(null);
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [cropping]);
  const figureOpen = figure !== null && openGap(figure.gapId)?.meta.figures?.[figure.index] !== undefined;
  // Reset shape: the picture's file proportions, read from the img the editor drew (not yet loaded: none).
  const resetPicture = (c: DocContext): Command => (state, dispatch) => {
    const img = pictureFile(pictureImg());
    if (!img || img.naturalWidth <= 0) return false;
    return resetPictureShape(img.naturalHeight / img.naturalWidth, c)(state, dispatch);
  };
  /** Runs a handle drag's change; false when the picture grabbed is no longer the one selected. */
  const onGrabbed = (change: (c: DocContext) => Command): boolean => {
    if (!a || !picSel) return false;
    // Applied only to the picture as it was grabbed: one changed or unselected during the drag is left alone.
    const now = a.view.state.selection;
    if (!(now instanceof NodeSelection) || now.node !== picSel.node) return false;
    change(a.ctx)(a.view.state, a.view.dispatch);
    a.view.focus();
    return true;
  };
  const dragSelected = (start: PictureSize, h: PictureHandle, dxPt: number, dyPt: number): void => {
    onGrabbed((c) => dragPicture(start, h, dxPt, dyPt, c));
  };
  const cropSelected = (start: PictureCrop, h: PictureHandle, dxPt: number, dyPt: number): void => {
    if (a && onGrabbed((c) => dragPictureCrop(start, h, dxPt, dyPt, c))) setCropSel(a.view.state.selection);
  };
  const inTable = a ? changeCellMargins("sides", 1)(a.view.state) : false;
  const canNarrow = a ? changeColumnWidth(-1)(a.view.state) : false;
  const canWiden = a ? changeColumnWidth(1)(a.view.state) : false;
  const sizeNow = a ? selectionSize(a.view.state, a.ctx) : null;
  const slot = useContext(PageBarSlot);
  const bar = (
    <div className={phone ? "etb phone" : "etb"} data-ref="edit-toolbar">
      <div className="etb-tools" role="toolbar" aria-label="Formatting tools">
        <Tool label="Bold" run={plainCmd(toggleBold)} refk="tb-bold"><b>B</b></Tool>
        <Tool label="Italic" run={plainCmd(toggleItalic)} refk="tb-italic"><i>I</i></Tool>
        <Tool label="Underline" run={plainCmd(toggleUnderline)} refk="tb-underline"><u>U</u></Tool>
        <HighlightPicker run={(c) => plainCmd(c)()} />
        <span className="sep" />
        <Tool label="Smaller text" run={cmd((c) => changeSize(-1, c))} refk="tb-smaller">A−</Tool>
        <select
          className="tb-size"
          aria-label="Text size"
          title="Text size"
          data-ref="tb-size"
          value={sizeNow === null ? "" : String(sizeNow)}
          disabled={!a}
          onChange={(e) => cmd((c) => setSize(Number(e.currentTarget.value), c))()}
        >
          {sizeOptions(sizeNow).map((pt) => <option key={pt} value={String(pt)}>{pt}</option>)}
        </select>
        <Tool label="Bigger text" run={cmd((c) => changeSize(1, c))} refk="tb-bigger">A+</Tool>
        <Tool label="Move paragraph left" run={plainCmd(moveParagraph(-1))} refk="tb-left">⇤</Tool>
        <Tool label="Move paragraph right" run={plainCmd(moveParagraph(1))} refk="tb-right">⇥</Tool>
        <span className="tb-group" role="group" aria-label="Line spacing">
          <span className="tb-gl">Line spacing</span>
          <Tool label="Tighter line spacing" run={cmd((c) => changeLineSpacing(-1, c))} refk="tb-tighter">Tighter</Tool>
          <Tool label="Looser line spacing" run={cmd((c) => changeLineSpacing(1, c))} refk="tb-looser">Looser</Tool>
        </span>
        <span className="tb-group" role="group" aria-label="Paragraph spacing">
          <span className="tb-gl">¶ spacing</span>
          <Tool label="Less space above" run={plainCmd(changeSpace("spaceBefore", -1))} refk="tb-above-less">Above −</Tool>
          <Tool label="More space above" run={plainCmd(changeSpace("spaceBefore", 1))} refk="tb-above-more">Above +</Tool>
          <Tool label="Less space below" run={plainCmd(changeSpace("spaceAfter", -1))} refk="tb-below-less">Below −</Tool>
          <Tool label="More space below" run={plainCmd(changeSpace("spaceAfter", 1))} refk="tb-below-more">Below +</Tool>
        </span>
        <span className="sep" />
        <Tool label="Insert row above" run={plainCmd(insertRow("above"))} refk="tb-row-above">Row ↑</Tool>
        <Tool label="Insert row below" run={plainCmd(insertRow("below"))} refk="tb-row-below">Row ↓</Tool>
        <Tool label="Delete row" run={() => { if (a) void deleteRow(editorConfirm)(a.view); }} refk="tb-row-delete">Delete row</Tool>
        {inTable && (
          <span className="tb-group" role="group" aria-label="Cell text margins">
            <span className="tb-gl">Cell margins</span>
            <Tool label="Less space at cell sides" run={plainCmd(changeCellMargins("sides", -1))} refk="tb-cell-sides-less">Sides −</Tool>
            <Tool label="More space at cell sides" run={plainCmd(changeCellMargins("sides", 1))} refk="tb-cell-sides-more">Sides +</Tool>
            <Tool label="Less space at cell top and bottom" run={plainCmd(changeCellMargins("topBottom", -1))} refk="tb-cell-tb-less">Top/bottom −</Tool>
            <Tool label="More space at cell top and bottom" run={plainCmd(changeCellMargins("topBottom", 1))} refk="tb-cell-tb-more">Top/bottom +</Tool>
          </span>
        )}
        {inTable && (
          <span className="tb-group" role="group" aria-label="Column width">
            <span className="tb-gl">Column</span>
            <Tool label="Make this column narrower" run={plainCmd(changeColumnWidth(-1))} refk="tb-col-narrower" disabled={!canNarrow}>Narrower</Tool>
            <Tool label="Make this column wider" run={plainCmd(changeColumnWidth(1))} refk="tb-col-wider" disabled={!canWiden}>Wider</Tool>
          </span>
        )}
        <span className="sep" />
        <AddPicture a={a} />
        {figure ? (
          <>
            <span className="sep" />
            <span className="tb-gl">Picture:</span>
            <Tool label="Make picture smaller" run={() => resizeFigure(figure, -1)} refk="tb-pic-smaller">−</Tool>
            <Tool label="Make picture bigger" run={() => resizeFigure(figure, 1)} refk="tb-pic-bigger">+</Tool>
            <Tool label={RESET_SHAPE} run={() => resetFigureShape(figure)} refk="tb-pic-reset">{RESET_SHAPE}</Tool>
          </>
        ) : picture && (
          <>
            <span className="sep" />
            <span className="tb-gl">Picture:</span>
            <Tool label="Make picture smaller" run={cmd((c) => resizePicture(-1, c, shownPicture(c)))} refk="tb-pic-smaller">−</Tool>
            <Tool label="Make picture bigger" run={cmd((c) => resizePicture(1, c, shownPicture(c)))} refk="tb-pic-bigger">+</Tool>
            <Tool label={RESET_SHAPE} run={cmd(resetPicture)} refk="tb-pic-reset">{RESET_SHAPE}</Tool>
            <Tool label={CROP} pressed={cropping} run={() => setCropSel(cropping ? null : picSel)} refk="tb-pic-crop">{CROP}</Tool>
            {pictureNow?.crop && <Tool label={RESET_CROP} run={cmd(resetPictureCrop)} refk="tb-pic-uncrop">{RESET_CROP}</Tool>}
            <Tool label="Delete picture" run={() => { if (a) void deletePicture(editorConfirm)(a.view); }} refk="tb-pic-delete">Delete picture</Tool>
          </>
        )}
        {figure && figureOpen ? (
          <PictureHandles
            find={pickedFigureImg}
            basePt={GAP_BASE_PT}
            size={() => openFigure(figure)?.size ?? null}
            limit={FIGURE_LIMIT}
            onResize={(start, h, dxPt, dyPt) => sizeFigure(figure, () => draggedPictureSize(start, h, dxPt, dyPt, FIGURE_LIMIT))}
          />
        ) : a && picSel && pictureNow && (
          <PictureHandles
            find={pictureImg}
            basePt={a.ctx.basePt}
            size={() => pictureNow.size}
            limit={pictureNow.limit}
            turn={picSel.node.attrs as PictureTurn}
            onResize={dragSelected}
            cropping={cropping ? { crop: pictureNow.crop, onCrop: cropSelected } : null}
          />
        )}
      </div>
      <span className="estat" data-ref="edit-status-row">
        <span data-ref="edit-dirty-state">{edit?.saving ? "Saving…" : edit?.dirty ? "Unsaved changes" : "No changes yet"}</span>
        <button type="button" className="btn" onClick={() => void done()} data-ref="edit-done">Done</button>
        <button type="button" className="btn pri" disabled={!edit?.dirty || edit.saving} onClick={() => void save()} data-ref="edit-save">Save</button>
      </span>
    </div>
  );
  return slot ? createPortal(bar, slot) : bar;
}

// ---- banners ------------------------------------------------------------------------------------

export function SaveBanner({ banner }: { banner: Banner }): ReactNode {
  const dismiss = <button type="button" className="linkbtn" onClick={dismissBanner}>Dismiss</button>;
  switch (banner.kind) {
    case "saved":
      return <div className="banner ok" role="status" data-ref="save-success"><span className="bt"><b>Saved.</b> Everyone will see the change on the site within a few minutes. Search and the sidebar update too.</span><span className="ba">{dismiss}</span></div>;
    case "offline":
      return <div className="banner err" role="alert" data-ref="save-failed"><span className="bt"><b>{SAVE_OFFLINE}</b> Your changes are still here, and the last saved version is unchanged.</span><span className="ba"><button type="button" className="btn pri" onClick={() => void save()} data-ref="save-retry">Try again</button></span></div>;
    case "failed":
      // Not a connection problem, so no Try again.
      return (
        <div className="banner err" role="alert" data-ref="save-error">
          <span className="bt"><b>{SAVE_FAILED.title}</b> {SAVE_FAILED.body}</span>
          <span className="ba"><button type="button" className="btn" onClick={() => void copyWithToast()} data-ref="save-error-copy">Copy my changes</button></span>
        </div>
      );
    case "conflict":
      return (
        <div className="banner err" role="alert" data-ref="save-conflict">
          <span className="bt"><b>{SAVE_CONFLICT(banner.at)}</b> Nothing was overwritten. Copy your changes, then load the newer version and add them back.</span>
          <span className="ba">
            <button type="button" className="btn" onClick={() => void copyWithToast()} data-ref="conflict-copy">Copy my changes</button>
            <button type="button" className="btn pri" onClick={() => void loadNewer()} data-ref="conflict-load-newer">{LOAD_NEWER}</button>
          </span>
        </div>
      );
    case "restored":
      return <div className="banner ok" role="status" data-ref="restored"><span className="bt"><b>Restored</b> the version from {banner.from}. The version it replaced is kept in Versions.</span><span className="ba">{dismiss}</span></div>;
    case "loaded":
      return <div className="banner info" role="status" data-ref="loaded"><span className="bt">Showing the newer version saved at {banner.at}.{banner.copied && " Your copied changes are on the clipboard."}</span><span className="ba">{dismiss}</span></div>;
  }
}

/** The page-level banner after an edit closed ("Saved.", "Restored"), on the page it belongs to. */
export function PageBanner({ pageKey }: { pageKey?: string }): ReactNode {
  const { pageBanner, edit } = useEdit();
  if (!pageBanner || edit || (pageKey !== undefined && pageBanner.key !== pageKey)) return null;
  return <SaveBanner banner={pageBanner.banner} />;
}

// ---- the region and its buttons -------------------------------------------------------------------

/**
 * Content that is not edited here but stays in view while editing (a topic's meds panel): shown after
 * the region's `children` when read, and among the editors before the first part of kind `before`
 * (after the last part when the unit has none), so it keeps its place in the page in both modes.
 */
export interface Kept {
  before: Part["kind"];
  node: ReactNode;
}

/** Wraps one editable page body. Not editing: the page as published. Editing: toolbar, banners, editors. */
export function EditRegion({ pageKey, children, kept }: { pageKey: string; title?: string; children?: ReactNode; kept?: Kept }): ReactNode {
  const { edit } = useEdit();
  const { owner } = useOwner();
  const editing = owner && edit !== null && edit.key === pageKey;
  const open = edit !== null;
  const keptAt = editing && edit.unit && kept ? edit.unit.parts.findIndex((p) => p.kind === kept.before) : -1;
  useEffect(() => {
    // A draft kept before the sign-in round trip reopens edit mode on its page (50 §50.3).
    if (owner && !open) void restoreDraft(pageKey);
  }, [owner, open, pageKey]);
  return (
    <>
      <PageBanner pageKey={pageKey} />
      {editing && (
        <div className="editing" data-ref="edit-area">
          <Toolbar />
          {edit.banner && <SaveBanner banner={edit.banner} />}
          {edit.error && <div className="banner err" role="alert"><span className="bt">{edit.error}</span></div>}
          {!edit.unit && !edit.error && <p className="edit-loading" role="status">Opening for editing…</p>}
          {edit.unit && (
            <div key={edit.generation}>
              {edit.unit.parts.map((p, i) => (
                <Fragment key={i}>
                  {i === keptAt && kept?.node}
                  <PartView part={p} />
                </Fragment>
              ))}
            </div>
          )}
          {edit.unit && edit.unit.parts.length === 0 && <p className="edit-loading">This page has nothing to edit.</p>}
          {keptAt === -1 && kept?.node}
        </div>
      )}
      <div hidden={editing}>{children}</div>
      {!editing && kept?.node}
    </>
  );
}

/** Opens Versions of `pageKey`, remembering the page title and route for its heading and Back. */
export function openVersions(pageKey: string, title: string): Promise<boolean> {
  rememberVersionsOrigin(pageKey, { title, back: currentHash() });
  return navigate(versionsHash(pageKey));
}

/** Edit and Versions (owner only, hidden while any edit is open). */
export function EditControls({ pageKey, title }: { pageKey: string; title: string }): ReactNode {
  const { edit } = useEdit();
  const { owner } = useOwner();
  if (!owner || edit) return null;
  return (
    <>
      <button type="button" className="btn" onClick={() => void startEdit(pageKey, title)} data-ref="edit-page">Edit</button>
      <button type="button" className="btn" onClick={() => void openVersions(pageKey, title)} data-ref="edit-versions">Versions</button>
    </>
  );
}
