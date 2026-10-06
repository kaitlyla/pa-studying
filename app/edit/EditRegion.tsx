// Edit mode on a page (plan 50 §50.2–§50.4; UI guide-reader/edit-mode, save-problems): the Edit and
// Versions buttons, the region that swaps the page body for ProseMirror editors seeded from Git, the
// toolbar, and the save banners.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { NodeSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { GAP_CONTENT_PT, type DocJSON, type GapFile } from "../../lib/content/index.ts";
import { pubFigures } from "../../lib/derive/published.ts";
import { BELOW_HEADING } from "../../lib/derive/topics.ts";
import { GapChip, GapFigures, gapClass, type FigurePicking } from "../render/index.ts";
import { currentHash, navigate, versionsHash } from "../shell/route.ts";
import { useOwner } from "../shell/owner.tsx";
import { showToast } from "../shell/toast.tsx";
import { useIsPhone } from "../shell/responsive.ts";
import {
  changeCellMargins, changeColumnWidth, changeLineSpacing, changeSize, changeSpace, deletePicture, deleteRow, HIGHLIGHT_COLORS, insertPicture, insertRow,
  moveParagraph, naturalPictureWidth, removeHighlight, resizePicture, selectionSize, setHighlight, setSize, sizeOptions, steppedPictureWidth,
  toggleBold, toggleItalic, toggleUnderline, type Command, type DocContext,
} from "./editor/commands.ts";
import { addPictureFile, PICTURE_ACCEPT } from "./pictures.ts";
import { createEditorState, PICTURE_REFUSED, pictureFileProps } from "./editor/state.ts";
import { clipboardSerializer, markViews, nodeViews } from "./editor/views.ts";
import { editorConfirm } from "./dialogs.tsx";
import {
  copyWithToast, currentLook, dismissBanner, done, getEditStore, LOAD_NEWER, loadNewer, registerView, restoreDraft, save, SAVE_CONFLICT, SAVE_FAILED, SAVE_OFFLINE,
  setGapLook, startEdit, useEdit, viewChanged, type Banner,
} from "./session.ts";
import { gapLook, type Part, type Slot } from "./units.ts";
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

/** Picture − / + on the picked figure: one steppedPictureWidth step, from its natural size when it has none. */
function resizeFigure(p: PickedFigure, dir: 1 | -1): void {
  const gap = openGap(p.gapId);
  const f = gap?.meta.figures?.[p.index];
  if (!gap || !f) return;
  const look = currentLook(gap);
  const now = look.widths[f.asset] ?? naturalPictureWidth(f.width, GAP_CONTENT_PT);
  setGapLook(gap, { ...look, widths: { ...look.widths, [f.asset]: steppedPictureWidth(now, dir, GAP_CONTENT_PT) } });
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
    const ctx: DocContext = { basePt: slot.basePt, pageContentPt: slot.pageContentPt };
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
  const figures = pubFigures(m).map((f) => {
    const shown = { ...f };
    const w = look.widths[f.asset];
    if (w === undefined) delete shown.widthPt;
    else shown.widthPt = w;
    return shown;
  });
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

function Tool({ label, run, children, refk, disabled }: { label: string; run: () => void; children: ReactNode; refk?: string; disabled?: boolean }): ReactNode {
  return (
    <button
      type="button"
      className="tb"
      title={label}
      aria-label={label}
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
  const cmd = (c: (ctx: DocContext) => Command) => (): void => {
    if (!a) return;
    c(a.ctx)(a.view.state, a.view.dispatch);
    a.view.focus();
  };
  const plainCmd = (c: Command) => cmd(() => c);
  const sel = a?.view.state.selection;
  const picture = sel instanceof NodeSelection && (sel.node.type.name === "image" || sel.node.type.name === "image_block");
  const inTable = a ? changeCellMargins("sides", 1)(a.view.state) : false;
  const canNarrow = a ? changeColumnWidth(-1)(a.view.state) : false;
  const canWiden = a ? changeColumnWidth(1)(a.view.state) : false;
  const sizeNow = a ? selectionSize(a.view.state, a.ctx) : null;
  return (
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
          </>
        ) : picture && (
          <>
            <span className="sep" />
            <span className="tb-gl">Picture:</span>
            <Tool label="Make picture smaller" run={cmd((c) => resizePicture(-1, c))} refk="tb-pic-smaller">−</Tool>
            <Tool label="Make picture bigger" run={cmd((c) => resizePicture(1, c))} refk="tb-pic-bigger">+</Tool>
            <Tool label="Delete picture" run={() => { if (a) void deletePicture(editorConfirm)(a.view); }} refk="tb-pic-delete">Delete picture</Tool>
          </>
        )}
      </div>
      <span className="estat" data-ref="edit-status-row">
        <span data-ref="edit-dirty-state">{edit?.saving ? "Saving…" : edit?.dirty ? "Unsaved changes" : "No changes yet"}</span>
        <button type="button" className="btn" onClick={() => void done()} data-ref="edit-done">Done</button>
        <button type="button" className="btn pri" disabled={!edit?.dirty || edit.saving} onClick={() => void save()} data-ref="edit-save">Save</button>
      </span>
    </div>
  );
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
