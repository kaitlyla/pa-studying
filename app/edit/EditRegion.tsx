// Edit mode on a page (plan 50 §50.2–§50.4; UI guide-reader/edit-mode, save-problems): the Edit and
// Versions buttons, the region that swaps the page body for ProseMirror editors seeded from Git, the
// toolbar, and the save banners.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { NodeSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { DocJSON } from "../../lib/content/index.ts";
import { GapChip } from "../render/index.ts";
import { navigate, versionsHash } from "../shell/route.ts";
import { useOwner } from "../shell/owner.tsx";
import { showToast } from "../shell/toast.tsx";
import { useIsPhone } from "../shell/responsive.ts";
import {
  addHighlight, changeLineSpacing, changeSize, changeSpace, deletePicture, deleteRow, insertRow, moveParagraph,
  removeHighlight, resizePicture, toggleBold, toggleUnderline, type Command, type DocContext,
} from "./editor/commands.ts";
import { createEditorState, editorProps, PICTURE_REFUSED } from "./editor/state.ts";
import { clipboardSerializer, markViews, nodeViews } from "./editor/views.ts";
import { editorConfirm } from "./dialogs.tsx";
import {
  copyWithToast, dismissBanner, done, loadNewer, registerView, restoreDraft, save, SAVE_FAILED, startEdit,
  useEdit, viewChanged, type Banner,
} from "./session.ts";
import type { Part, Slot } from "./units.ts";
import "./edit.css";

export { useIsEditing } from "./session.ts";

// ---- the focused editor -------------------------------------------------------------------------

interface Active {
  view: EditorView;
  ctx: DocContext;
}

let active: Active | null = null;
const activeListeners = new Set<() => void>();
const touch = (): void => activeListeners.forEach((l) => l());

function useActive(): Active | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    const l = (): void => setTick((n) => n + 1);
    activeListeners.add(l);
    return () => {
      activeListeners.delete(l);
    };
  }, []);
  return active;
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
      ...editorProps,
      attributes: { "aria-label": "Editable notes", "data-slot": slot.id },
      dispatchTransaction(tr) {
        view.updateState(view.state.apply(tr));
        if (tr.docChanged) viewChanged();
        active = { view, ctx };
        touch();
      },
      handleDOMEvents: {
        focus: () => {
          active = { view, ctx };
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

function GapFrame({ part }: { part: Extract<Part, { kind: "gap" }> }): ReactNode {
  const m = part.gap.meta;
  return (
    <section className="gap" aria-label={m.title}>
      <div className="gap-h"><GapChip /><h3>{m.title}</h3></div>
      <div className="gap-meta">Relevant to: <b>{m.relevantTo}</b> · Written {m.written}</div>
      <SlotEditor slot={part.doc} />
      {part.differs && (
        <div className="gap-diff">
          <b>Differs from your notes.</b>
          <SlotEditor slot={part.differs} />
        </div>
      )}
      <div className="gap-src"><b>Sources</b><ol>{m.sources.map((s, i) => <li key={i}>{s.name}. {s.org}. {s.year}.</li>)}</ol></div>
    </section>
  );
}

function PartView({ part }: { part: Part }): ReactNode {
  switch (part.kind) {
    case "stub":
      return <div className="stub"><span className="stub-t">{part.label}</span> drug table — edited on its pharm section</div>;
    case "gap":
      return <GapFrame part={part} />;
    default:
      return <SlotEditor slot={part.slot} />;
  }
}

// ---- toolbar ------------------------------------------------------------------------------------

function Tool({ label, run, children, refk }: { label: string; run: () => void; children: ReactNode; refk?: string }): ReactNode {
  return (
    <button
      type="button"
      className="tb"
      title={label}
      aria-label={label}
      data-ref={refk}
      onMouseDown={(e) => {
        e.preventDefault();
        run();
      }}
    >
      {children}
    </button>
  );
}

function Toolbar(): ReactNode {
  const { edit } = useEdit();
  const a = useActive();
  const phone = useIsPhone();
  const cmd = (c: (ctx: DocContext) => Command) => (): void => {
    if (!a) return;
    c(a.ctx)(a.view.state, a.view.dispatch);
    a.view.focus();
  };
  const plainCmd = (c: Command) => cmd(() => c);
  const sel = a?.view.state.selection;
  const picture = sel instanceof NodeSelection && (sel.node.type.name === "image" || sel.node.type.name === "image_block");
  return (
    <div className={phone ? "etb phone" : "etb"} data-ref="edit-toolbar">
      <div className="etb-tools" role="toolbar" aria-label="Formatting tools">
        <Tool label="Bold" run={plainCmd(toggleBold)} refk="tb-bold"><b>B</b></Tool>
        <Tool label="Underline" run={plainCmd(toggleUnderline)} refk="tb-underline"><u>U</u></Tool>
        <Tool label="Highlight" run={plainCmd(addHighlight)} refk="tb-highlight"><span className="tb-hl">H</span></Tool>
        <Tool label="Remove highlight" run={plainCmd(removeHighlight)} refk="tb-unhighlight"><s>H</s></Tool>
        <span className="sep" />
        <Tool label="Smaller text" run={cmd((c) => changeSize(-1, c))} refk="tb-smaller">A−</Tool>
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
        {picture && (
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
      return <div className="banner err" role="alert" data-ref="save-failed"><span className="bt"><b>Couldn’t save — no internet connection.</b> Your changes are still here, and the last saved version is unchanged.</span><span className="ba"><button type="button" className="btn pri" onClick={() => void save()} data-ref="save-retry">Try again</button></span></div>;
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
          <span className="bt"><b>Not saved — this page was saved from another device at {banner.at} after you opened it.</b> Nothing was overwritten. Copy your changes, then load the newer version and add them back.</span>
          <span className="ba">
            <button type="button" className="btn" onClick={() => void copyWithToast()} data-ref="conflict-copy">Copy my changes</button>
            <button type="button" className="btn pri" onClick={() => void loadNewer()} data-ref="conflict-load-newer">Load newer version</button>
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

/** Wraps one editable page body. Not editing: the page as published. Editing: toolbar, banners, editors. */
export function EditRegion({ pageKey, children }: { pageKey: string; title?: string; children?: ReactNode }): ReactNode {
  const { edit } = useEdit();
  const { owner } = useOwner();
  const editing = owner && edit !== null && edit.key === pageKey;
  const open = edit !== null;
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
          {edit.unit && <div key={edit.generation}>{edit.unit.parts.map((p, i) => <PartView key={i} part={p} />)}</div>}
          {edit.unit && edit.unit.parts.length === 0 && <p className="edit-loading">This page has nothing to edit.</p>}
        </div>
      )}
      <div hidden={editing}>{children}</div>
    </>
  );
}

/** Edit and Versions (owner only, hidden while any edit is open). */
export function EditControls({ pageKey, title }: { pageKey: string; title: string }): ReactNode {
  const { edit } = useEdit();
  const { owner } = useOwner();
  if (!owner || edit) return null;
  return (
    <>
      <button type="button" className="btn" onClick={() => void startEdit(pageKey, title)} data-ref="edit-page">Edit</button>
      <button type="button" className="btn" onClick={() => void navigate(versionsHash(pageKey))} data-ref="edit-versions">Versions</button>
    </>
  );
}
