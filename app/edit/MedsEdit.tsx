// A topic's meds panel in edit mode (her own panel for the condition, content MedsFile): each card it
// shows with editors in place of its text (an edit makes her version for this condition only), its
// role labels with their wording editable, and the buttons that take a card or a role label off, put
// one back, add a card, or go back to the original card. A panel shown by scenario shows here as the
// reader shows it: each scenario, then each patient group of it, with the entries under them.
import { Fragment, useState, type ReactNode } from "react";
import type { MedsRoleTag } from "../../lib/content/types.ts";
import { byScenario, classAnchor, withClasses } from "../../lib/derive/panel.ts";
import { ClassCard, CardPieces } from "../pharm/ClassCard.tsx";
import { OWN_VERSION, scenarioDrugs } from "../pharm/MedsPanel.tsx";
import { ROLE_LABELS, RoleChips, RoleLines, roleSources } from "../pharm/Roles.tsx";
import { Icon } from "../shell/Icon.tsx";
import { currentMeds, setMeds, useEdit } from "./session.ts";
import {
  entrySlots, fileChoice, removedRoles, rewordRole, roleBack, rolesOff, shownEntries, shownRoles, showsOwn, takeOff, uncut,
  type GapPart, type MedsChoice, type MedsEntry, type MedsPart, type ShownRole, type Slot,
} from "./units.ts";

export const MEDS_HEADING = "Medications for this condition";
export const REMOVE_CARD = "Remove from this condition";
export const USE_ORIGINAL = "Use the original";
export const USE_MINE = "Use my version";
export const REMOVED_HEADING = "Removed from this condition";
export const PUT_BACK = "Put back";
export const ADD_CARD = "Add a card";
/** Beside a card she added that this page has none of the notes of (they come with the next site update). */
export const ADDED_LATER = "Its notes show here once the site updates.";
/** Takes one role label off this condition's panel. */
export const REMOVE_LABEL = "Remove";
/** Takes every role label of a patient group (e.g. Allergy) under one scenario off this condition's panel. */
export const REMOVE_GROUP = "Remove this group";
/** Heading of the role labels she took off, each with Put back. */
export const REMOVED_LABELS = "Labels removed from this condition";
/** Beside an entry shown again under a later scenario: its card text is edited where it first shows. */
export const EDITED_ABOVE = "Its card is edited where it first shows.";
/** The empty-field hints of a role label's drugs and note. */
export const LABEL_DRUGS = "drugs";
export const LABEL_NOTE = "note";

/** How many cards the Add a card list shows at once. */
const MATCHES = 12;

/** An entry of the panel being edited: a card entry, or a sourced card placed in it. */
type Item = { entry: MedsEntry } | { gap: GapPart };

/** What a role label is for, spelled out: its scenario and patient group, when it has them. */
const roleWhere = (r: MedsRoleTag): string => [r.scenario, r.population].filter((x) => x !== undefined).join(" · ");

/**
 * The panel. `editing`: the open edit's (her choices as she changed them, with the buttons); else as
 * stored (Versions' View). `slotView` draws an editor (or, in Versions, a stored doc).
 */
export function MedsFrame({ part, gaps, entryGaps = [], gapView, slotView, editing }: {
  part: MedsPart;
  /** The sourced cards placed in this panel (MedsFile `gaps`), and how one is drawn (its gap box). */
  gaps: readonly GapPart[];
  /** The blocks her versions of its entries hold (MedsFile own `gap`), each shown under its version. */
  entryGaps?: readonly GapPart[];
  gapView: (gap: GapPart) => ReactNode;
  slotView: (slot: Slot) => ReactNode;
  editing: boolean;
}): ReactNode {
  // Subscribed to the open edit, so the panel redraws when her choices change.
  useEdit();
  const choice = editing ? currentMeds(part) : fileChoice(part);
  // In edit mode a card starts open, so its editors are there for her changes and for a restored draft.
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const shownTags = shownRoles(part, choice);
  const shownOf = new Map(shownTags.map((r) => [r.tag, r]));
  const rolesOf = (target: string): MedsRoleTag[] => shownTags.filter((r) => r.target === target).map((r) => r.tag);
  const targetOf = (x: Item): string => ("entry" in x ? x.entry.med.target : x.gap.gap.id);
  const titleOf = (x: Item): string => ("gap" in x ? x.gap.gap.meta.title : x.entry.med.title);
  const shownItems: Item[] = [...shownEntries(part, choice).map((entry) => ({ entry })), ...gaps.filter((g) => !choice.remove.includes(g.gap.id)).map((gap) => ({ gap }))];
  const later = choice.add.filter((id) => !part.entries.some((e) => !e.derived && e.med.target === id));
  const removed = [
    ...part.entries.filter((e) => e.derived && choice.remove.includes(e.med.target)).map((e) => ({ id: e.med.target, title: e.med.title })),
    ...gaps.filter((g) => choice.remove.includes(g.gap.id)).map((g) => ({ id: g.gap.id, title: g.gap.meta.title })),
  ];
  const offLabels = removedRoles(part, choice);
  const update = (c: Partial<MedsChoice>): void => setMeds(part, { ...choice, ...c });
  const off = (target: string): void => setMeds(part, takeOff(part, choice, target));
  // Either version shows whole: the boxes she cut come back.
  const showVersion = (target: string, original: string[]): void => setMeds(part, uncut(part, { ...choice, original }, target));
  const add = (id: string): void => {
    if (choice.remove.includes(id)) update({ remove: choice.remove.filter((x) => x !== id) });
    else update({ add: [...choice.add, id] });
  };
  const title = (id: string): string => part.catalog.find((c) => c.id === id)?.title ?? id;
  // Where search lands on an entry, as in the reader: a sourced card's gap id, else `meds-<target>`.
  const anchorOf = (x: Item): string => ("gap" in x ? x.gap.gap.id : `meds-${x.entry.med.target}`);
  const keysOf = (tags: readonly MedsRoleTag[]): string[] => tags.flatMap((t) => shownOf.get(t)?.key ?? []);

  /** Role labels `tags`: as the reader spells them out, or, while editing, each with its wording in fields and a Remove button. */
  const roleLines = (tags: readonly MedsRoleTag[]): ReactNode => {
    if (!editing) return <RoleLines roles={tags} />;
    const lines = tags.flatMap((t) => shownOf.get(t) ?? []);
    if (lines.length === 0) return null;
    return (
      <ul className="rolels role-edit">
        {lines.map((r) => (
          <RoleLine key={r.key} role={r} onWording={(w) => setMeds(part, rewordRole(part, choice, r.key, w))} onRemove={() => setMeds(part, rolesOff(choice, [r.key]))} />
        ))}
      </ul>
    );
  };

  /** What an entry shows inside its card: role labels `tags`, its editors or gap box (unless `textHere` is false), and its buttons. */
  const body = (item: Item, tags: readonly MedsRoleTag[], textHere = true): ReactNode => {
    if ("gap" in item) {
      const g = item.gap.gap.id;
      return (
        <>
          {roleLines(tags)}
          {textHere ? gapView(item.gap) : <p className="meds-above">{EDITED_ABOVE}</p>}
          {editing && textHere && (
            <div className="meds-acts">
              <button type="button" className="btn" onClick={() => off(g)} data-ref="meds-remove">{REMOVE_CARD}</button>
            </div>
          )}
        </>
      );
    }
    const e = item.entry;
    const t = e.med.target;
    if (!textHere) {
      return (
        <>
          {roleLines(tags)}
          <p className="meds-above">{EDITED_ABOVE}</p>
        </>
      );
    }
    const slots = entrySlots(e, choice);
    const own = showsOwn(e, choice);
    return (
      <>
        {roleLines(tags)}
        {own && <div className="phn-k own-only">{OWN_VERSION}</div>}
        <CardPieces pieces={slots.map((s) => ({ ...s.piece, part: null }))} body={(i) => (slots[i] ? slotView(slots[i]) : null)} />
        {own && entryGaps.filter((g) => g.entry === t).map((g) => <Fragment key={g.gap.id}>{gapView(g)}</Fragment>)}
        {editing && (
          <div className="meds-acts">
            {own && <button type="button" className="btn" onClick={() => showVersion(t, [...choice.original, t])} data-ref="meds-original">{USE_ORIGINAL}</button>}
            {!own && e.own !== null && (
              <button type="button" className="btn" onClick={() => showVersion(t, choice.original.filter((x) => x !== t))} data-ref="meds-mine">{USE_MINE}</button>
            )}
            <button type="button" className="btn" onClick={() => off(t)} data-ref="meds-remove">{REMOVE_CARD}</button>
          </div>
        )}
      </>
    );
  };

  const toggle = (k: string): void => setClosed((c) => ({ ...c, [k]: !c[k] }));

  /** Entries `items` as a panel by drug class shows them: one card each, her drug classes under one card. */
  const byClass = (items: readonly Item[]): ReactNode =>
    withClasses<Item>(items, targetOf, (x) => rolesOf(targetOf(x)), part.file?.classes ?? []).map((item) => {
      if ("members" in item) {
        // One of her drug classes: one card under its title, each entry under its own title inside it.
        const first = item.members[0];
        if (!first) return null;
        const k = classAnchor(targetOf(first));
        return (
          <ClassCard key={k} anchor={k} title={item.title} chips={<RoleChips roles={item.roles} />} open={!closed[k]} onToggle={() => toggle(k)}>
            {item.members.map((m) => (
              <div key={anchorOf(m)} className="meds-mem" data-anchor={anchorOf(m)}>
                <h4 className="meds-mt">{titleOf(m)}</h4>
                {body(m, rolesOf(targetOf(m)))}
              </div>
            ))}
          </ClassCard>
        );
      }
      const k = anchorOf(item);
      return (
        <ClassCard key={k} anchor={k} title={titleOf(item)} chips={<RoleChips roles={rolesOf(targetOf(item))} />} open={!closed[k]} onToggle={() => toggle(k)}>
          {body(item, rolesOf(targetOf(item)))}
        </ClassCard>
      );
    });

  const scenarios = part.file?.scenarios;
  let cards: ReactNode;
  let count = shownItems.length;
  if (scenarios === undefined) cards = byClass(shownItems);
  else {
    // A sourced card placed under a scenario's header is no entry: it shows under that header.
    const intro = new Set(scenarios.flatMap((s) => s.gaps));
    const entries = shownItems.filter((x) => !("gap" in x && intro.has(x.gap.gap.id)));
    const groups = byScenario(entries, targetOf, (x) => rolesOf(targetOf(x)), scenarios.map((s) => ({ title: s.title, gaps: gaps.filter((g) => s.gaps.includes(g.gap.id) && !choice.remove.includes(g.gap.id)) })));
    const rest = entries.filter((x) => !rolesOf(targetOf(x)).some((r) => r.scenario !== undefined));
    count = entries.length;
    // Its first place holds the entry's card text and anchor; a later place shows only its labels there.
    const card = ({ item, roles, first }: { item: Item; roles: MedsRoleTag[]; first: boolean }, place: string): ReactNode => {
      const k = first ? anchorOf(item) : `${anchorOf(item)}@${place}`;
      return (
        <ClassCard key={k} anchor={k} title={titleOf(item)} sub={roles.map(scenarioDrugs).join("; ")} open={!closed[k]} onToggle={() => toggle(k)}>
          {body(item, roles, first)}
        </ClassCard>
      );
    };
    cards = (
      <>
        {groups.map((g, i) => (
          <section key={g.title} className="meds-scn" aria-label={g.title}>
            <h4 className="meds-scn-t">{g.title}</h4>
            {g.gaps.map((gap) => (
              <Fragment key={gap.gap.id}>
                {gapView(gap)}
                {editing && (
                  <div className="meds-acts">
                    <button type="button" className="btn" onClick={() => off(gap.gap.id)} data-ref="meds-remove">{REMOVE_CARD}</button>
                  </div>
                )}
              </Fragment>
            ))}
            {g.entries.map((x) => card(x, String(i)))}
            {g.populations.map((p) => (
              <section key={p.population} className="meds-pop" aria-label={`${g.title}: ${p.population}`}>
                <h5 className="meds-pop-t">
                  {p.population}
                  {editing && (
                    <>
                      {" "}
                      <button type="button" className="linkbtn" onClick={() => setMeds(part, rolesOff(choice, keysOf(p.entries.flatMap((x) => x.roles))))} data-ref="meds-group-remove">{REMOVE_GROUP}</button>
                    </>
                  )}
                </h5>
                {p.entries.map((x) => card(x, `${i}.${p.population}`))}
              </section>
            ))}
          </section>
        ))}
        {byClass(rest)}
      </>
    );
  }

  return (
    <section className="meds meds-edit" aria-label={MEDS_HEADING}>
      <h3 className="meds-hd">
        <Icon n="pill" size={15} /> {MEDS_HEADING} <span className="n">{count + later.length}</span>
      </h3>
      {cards}
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
              <li key={e.id}>
                {e.title}{" "}
                <button type="button" className="linkbtn" onClick={() => update({ remove: choice.remove.filter((x) => x !== e.id) })} data-ref="meds-put-back">{PUT_BACK}</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {editing && offLabels.length > 0 && (
        <div className="meds-removed" data-ref="meds-labels-removed">
          <div className="meds-sub">{REMOVED_LABELS}</div>
          <ul>
            {offLabels.map((r) => (
              <li key={r.key}>
                {[roleWhere(r.tag), `${ROLE_LABELS[r.tag.role]}${r.tag.drugs === null ? "" : `: ${r.tag.drugs}`}`].filter((x) => x !== "").join(" — ")}
                {r.tag.note !== null && ` — ${r.tag.note}`}{" "}
                <button type="button" className="linkbtn" onClick={() => setMeds(part, roleBack(choice, r.key))} data-ref="meds-label-put-back">{PUT_BACK}</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {editing && <AddCard part={part} choice={choice} onAdd={add} />}
    </section>
  );
}

/**
 * One role label while editing: its role, its drugs and note in fields (a change is her wording for
 * this condition), its source kept beside it, and Remove.
 */
function RoleLine({ role, onWording, onRemove }: { role: ShownRole; onWording: (w: { drugs: string | null; note: string | null }) => void; onRemove: () => void }): ReactNode {
  const { tag } = role;
  const where = roleWhere(tag);
  return (
    <li data-ref="meds-label">
      <b>{ROLE_LABELS[tag.role]}</b>
      {where !== "" && <span className="rsrc"> ({where})</span>}{" "}
      <input
        type="text" className="role-in" value={tag.drugs ?? ""} placeholder={LABEL_DRUGS} aria-label={`${ROLE_LABELS[tag.role]} ${LABEL_DRUGS}`} data-ref="meds-label-drugs"
        onChange={(e) => onWording({ drugs: e.currentTarget.value, note: tag.note })}
      />{" "}
      —{" "}
      <input
        type="text" className="role-in role-note" value={tag.note ?? ""} placeholder={LABEL_NOTE} aria-label={`${ROLE_LABELS[tag.role]} ${LABEL_NOTE}`} data-ref="meds-label-note"
        onChange={(e) => onWording({ drugs: tag.drugs, note: e.currentTarget.value })}
      />
      <span className="rsrc"> · Source: {roleSources(tag)}</span>{" "}
      <button type="button" className="linkbtn" onClick={onRemove} data-ref="meds-label-remove">{REMOVE_LABEL}</button>
    </li>
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
