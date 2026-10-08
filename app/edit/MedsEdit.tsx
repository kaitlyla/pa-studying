// A topic's meds panel in edit mode (her own panel for the condition, content MedsFile): each card it
// shows with editors in place of its text (an edit makes her version for this condition only), and the
// buttons that take a card off, put one back, add one, or go back to the original card.
import { useState, type ReactNode } from "react";
import { ClassCard, CardPieces } from "../pharm/ClassCard.tsx";
import { OWN_VERSION } from "../pharm/MedsPanel.tsx";
import { Icon } from "../shell/Icon.tsx";
import { currentMeds, setMeds, useEdit } from "./session.ts";
import { entrySlots, fileChoice, shownEntries, showsOwn, takeOff, uncut, type MedsChoice, type MedsPart, type Slot } from "./units.ts";

export const MEDS_HEADING = "Medications for this condition";
export const REMOVE_CARD = "Remove from this condition";
export const USE_ORIGINAL = "Use the original";
export const USE_MINE = "Use my version";
export const REMOVED_HEADING = "Removed from this condition";
export const PUT_BACK = "Put back";
export const ADD_CARD = "Add a card";
/** Beside a card she added that this page has none of the notes of (they come with the next site update). */
export const ADDED_LATER = "Its notes show here once the site updates.";

/** How many cards the Add a card list shows at once. */
const MATCHES = 12;

/**
 * The panel. `editing`: the open edit's (her choices as she changed them, with the buttons); else as
 * stored (Versions' View). `slotView` draws an editor (or, in Versions, a stored doc).
 */
export function MedsFrame({ part, slotView, editing }: { part: MedsPart; slotView: (slot: Slot) => ReactNode; editing: boolean }): ReactNode {
  // Subscribed to the open edit, so the panel redraws when her choices change.
  useEdit();
  const choice = editing ? currentMeds(part) : fileChoice(part);
  // In edit mode a card starts open, so its editors are there for her changes and for a restored draft.
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const entries = shownEntries(part, choice);
  const later = choice.add.filter((id) => !part.entries.some((e) => !e.derived && e.med.target === id));
  const removed = part.entries.filter((e) => e.derived && choice.remove.includes(e.med.target));
  const update = (c: Partial<MedsChoice>): void => setMeds(part, { ...choice, ...c });
  const off = (target: string): void => setMeds(part, takeOff(part, choice, target));
  // Either version shows whole: the boxes she cut come back.
  const showVersion = (target: string, original: string[]): void => setMeds(part, uncut(part, { ...choice, original }, target));
  const add = (id: string): void => {
    if (choice.remove.includes(id)) update({ remove: choice.remove.filter((x) => x !== id) });
    else update({ add: [...choice.add, id] });
  };
  const title = (id: string): string => part.catalog.find((c) => c.id === id)?.title ?? id;
  return (
    <section className="meds meds-edit" aria-label={MEDS_HEADING}>
      <h3 className="meds-hd">
        <Icon n="pill" size={15} /> {MEDS_HEADING} <span className="n">{entries.length + later.length}</span>
      </h3>
      {entries.map((e) => {
        const t = e.med.target;
        const slots = entrySlots(e, choice);
        const own = showsOwn(e, choice);
        return (
          <ClassCard key={t} anchor={`meds-${t}`} title={e.med.title} open={!closed[t]} onToggle={() => setClosed((c) => ({ ...c, [t]: !c[t] }))}>
            {own && <div className="phn-k own-only">{OWN_VERSION}</div>}
            <CardPieces pieces={slots.map((s) => ({ ...s.piece, part: null }))} body={(i) => (slots[i] ? slotView(slots[i]) : null)} />
            {editing && (
              <div className="meds-acts">
                {own && <button type="button" className="btn" onClick={() => showVersion(t, [...choice.original, t])} data-ref="meds-original">{USE_ORIGINAL}</button>}
                {!own && e.own !== null && (
                  <button type="button" className="btn" onClick={() => showVersion(t, choice.original.filter((x) => x !== t))} data-ref="meds-mine">{USE_MINE}</button>
                )}
                <button type="button" className="btn" onClick={() => off(t)} data-ref="meds-remove">{REMOVE_CARD}</button>
              </div>
            )}
          </ClassCard>
        );
      })}
      {later.map((id) => (
        <div key={id} className="meds-later" data-ref="meds-later">
          <b>{title(id)}</b> — {ADDED_LATER}
          {editing && <button type="button" className="linkbtn" onClick={() => off(id)} data-ref="meds-remove">{REMOVE_CARD}</button>}
        </div>
      ))}
      {editing && removed.length > 0 && (
        <div className="meds-removed" data-ref="meds-removed">
          <div className="meds-sub">{REMOVED_HEADING}</div>
          <ul>
            {removed.map((e) => (
              <li key={e.med.target}>
                {e.med.title}{" "}
                <button type="button" className="linkbtn" onClick={() => update({ remove: choice.remove.filter((x) => x !== e.med.target) })} data-ref="meds-put-back">{PUT_BACK}</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {editing && <AddCard part={part} choice={choice} onAdd={add} />}
    </section>
  );
}

/** "Add a card": type to find one of her class cards the panel doesn't show, then pick it. */
function AddCard({ part, choice, onAdd }: { part: MedsPart; choice: MedsChoice; onAdd: (id: string) => void }): ReactNode {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const shown = new Set([...shownEntries(part, choice).map((e) => e.med.target), ...choice.add]);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = part.catalog.filter((c) => !shown.has(c.id) && words.every((w) => c.title.toLowerCase().includes(w))).slice(0, MATCHES);
  if (!open) return <button type="button" className="btn meds-add" onClick={() => setOpen(true)} data-ref="meds-add">{ADD_CARD}</button>;
  return (
    <div className="meds-add" data-ref="meds-add-open">
      <input type="search" value={q} onChange={(e) => setQ(e.currentTarget.value)} placeholder="Find a card" aria-label="Find a card" data-ref="meds-add-find" autoFocus />
      <ul data-ref="meds-add-list">
        {matches.map((c) => (
          <li key={c.id}>
            <button type="button" className="linkbtn" onClick={() => { onAdd(c.id); setOpen(false); setQ(""); }} data-ref="meds-add-pick">{c.title}</button>
          </li>
        ))}
      </ul>
      <button type="button" className="linkbtn" onClick={() => setOpen(false)}>Cancel</button>
    </div>
  );
}
