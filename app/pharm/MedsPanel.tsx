// "Medications for this condition" under a condition topic (40 §40.5, pharm/meds-panel): one
// collapsible card per entry of the panel as she shaped it for this condition (lib/derive/panel.ts),
// each with its guide rows and her notes, or her own version of them (with the sourced block her
// version holds under them, if any), and a drug class's link into
// the pharm section that holds it; then the sourced cards placed under this condition only (gap
// blocks). Entries of one of her drug classes share one card under the class's title, each under its
// own title inside it, each fact shown once across them. Entries with role labels are ordered by
// role, each label shown with its source. A search result landing on an entry opens its card.
// View-only: in edit mode the topic's region edits the panel.
import { useState, type ReactNode } from "react";
import type { MedsRoleTag } from "../../lib/content/types.ts";
import { classAnchor, itemPieces, itemTarget, panelItems, scenarioGroups, type PanelEntryItem, type PanelPiece } from "../../lib/derive/panel.ts";
import type { NavSystem, PubGap, PubTopic, SystemJson } from "../../lib/derive/published.ts";
import { collapse, docText } from "../../lib/derive/text.ts";
import { GapBlock } from "../render/labels.tsx";
import { Txt } from "../render/Text.tsx";
import { Icon } from "../shell/Icon.tsx";
import { Link } from "../shell/Link.tsx";
import { guideViewHash, useRoute } from "../shell/route.ts";
import { CardPieces, ClassCard } from "./ClassCard.tsx";
import { ROLE_LABELS, RoleChips, RoleLines } from "./Roles.tsx";

/** Owner-only label on an entry she edited for this condition. */
export const OWN_VERSION = "Your version for this condition";

/** Where search lands on an entry: a sourced card's gap id itself, else `meds-<target>`. */
export const entryAnchor = (item: PanelEntryItem): string => (item.kind === "gap" ? item.gap.id : `meds-${itemTarget(item)}`);

/** An entry's title. */
const entryTitle = (item: PanelEntryItem): string => (item.kind === "gap" ? item.gap.title : item.entry.med.title);

/** What one role names on a scenario card's header: its drugs, its role unless 1st-line, and its note ("cipro · Alternative · PCN allergy: with clindamycin"). */
export function scenarioDrugs(r: MedsRoleTag): string {
  return [r.drugs, r.role === "1st" ? null : ROLE_LABELS[r.role], r.note].filter((x) => x !== null).join(" · ");
}

/** A sourced gap block under a scenario's header (e.g. how long it is treated), as one line with its sources linked. */
function ScenarioLine({ gap }: { gap: PubGap }): ReactNode {
  return (
    <p className="meds-scn-l" data-anchor={gap.id}>
      <b>Duration:</b> <Txt text={collapse(docText(gap.doc))} />
      {gap.sources.map((s, i) => (
        <span key={i} className="rsrc">
          {" "}
          · <Txt text={s.name} />
          {s.url !== null && /^https?:\/\//.test(s.url) && (
            <>
              {" "}
              <a href={s.url} target="_blank" rel="noopener noreferrer" aria-label={`Open source: ${s.name}`}>
                <Icon n="ext" size={11} />
              </a>
            </>
          )}
        </span>
      ))}
    </p>
  );
}

export function MedsPanel({ guide, system, systems, topic, basePt }: { guide: string; system: SystemJson; systems: readonly NavSystem[]; topic: PubTopic; basePt: number }): ReactNode {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const at = useRoute().query.at;
  const items = panelItems(topic);
  if (items.length === 0) return null;
  /** What an entry shows inside its card (its role labels `roles` with their sources first), with its pieces `pieces`. */
  const body = (item: PanelEntryItem, pieces: PanelPiece[], roles: readonly MedsRoleTag[] = item.roles): ReactNode => {
    if (item.kind === "gap") {
      return (
        <>
          <RoleLines roles={roles} />
          <GapBlock gap={item.gap} titled={false} />
        </>
      );
    }
    const e = item.entry;
    const m = e.med;
    // A part of her pharm notes attached to this condition is in no pharm section, so no link.
    const linked = m.part !== undefined || m.system === null ? undefined : systems.find((s) => s.id === m.system);
    return (
      <>
        <RoleLines roles={roles} />
        {e.own && <div className="phn-k own-only">{OWN_VERSION}</div>}
        <CardPieces pieces={pieces} />
        {e.gap && <GapBlock gap={e.gap} titled={false} />}
        {linked && (
          <Link to={guideViewHash(guide, { kind: "pharm", system: linked.id, section: m.section, target: m.target })} className="linkbtn phc-more">
            Open in {linked.title} pharm ›
          </Link>
        )}
      </>
    );
  };
  const sc = scenarioGroups(topic);
  if (sc !== null) {
    /**
     * An entry's card under a scenario: titled by the entry (its drug class), with the drugs its roles
     * there name on one line beside the title. Its first scenario holds the entry's anchor (search
     * lands there); a later one is anchored `<anchor>@<scenario index>`.
     */
    const card = (item: PanelEntryItem, roles: readonly MedsRoleTag[], key: string, landing: boolean): ReactNode => {
      const isOpen = open[key] ?? (landing && entryAnchor(item) === at);
      const toggle = (): void => setOpen((o) => ({ ...o, [key]: !isOpen }));
      const pieces = isOpen ? itemPieces(system, topic, item, basePt) : [];
      return (
        <ClassCard key={key} anchor={key} title={entryTitle(item)} sub={roles.map(scenarioDrugs).join("; ")} open={isOpen} onToggle={toggle}>
          {body(item, pieces[0] ?? [], roles)}
        </ClassCard>
      );
    };
    const shown = new Set([...sc.groups.flatMap((g) => g.entries.map((x) => entryAnchor(x.item))), ...sc.rest.map(entryAnchor)]);
    return (
      <div className="meds">
        <h3 className="meds-hd">
          <Icon n="pill" size={15} /> Medications for this condition <span className="n">{shown.size}</span>
        </h3>
        {sc.groups.map((g, i) => (
          <section key={g.title} className="meds-scn" aria-label={g.title}>
            <h4 className="meds-scn-t">{g.title}</h4>
            {g.gaps.map((gap) => (
              <ScenarioLine key={gap.id} gap={gap} />
            ))}
            {g.entries.map(({ item, roles, first }) => card(item, roles, first ? entryAnchor(item) : `${entryAnchor(item)}@${i}`, first))}
          </section>
        ))}
        {sc.rest.map((item) => card(item, item.roles, entryAnchor(item), true))}
      </div>
    );
  }
  return (
    <div className="meds">
      <h3 className="meds-hd">
        <Icon n="pill" size={15} /> Medications for this condition <span className="n">{items.length}</span>
      </h3>
      {items.map((item) => {
        const members = item.kind === "class" ? item.members : [item];
        const first = members[0];
        if (!first) return null;
        // An entry's card is keyed and anchored by the entry, a class's by its own anchor; it starts open when a search result lands on one of its entries.
        const key = item.kind === "class" ? classAnchor(itemTarget(first)) : entryAnchor(first);
        const isOpen = open[key] ?? members.some((m) => entryAnchor(m) === at);
        const toggle = (): void => setOpen((o) => ({ ...o, [key]: !isOpen }));
        const chips = <RoleChips roles={item.roles} />;
        const pieces = isOpen ? itemPieces(system, topic, item, basePt) : [];
        if (item.kind !== "class") {
          return (
            <ClassCard key={key} anchor={key} title={entryTitle(item)} chips={chips} open={isOpen} onToggle={toggle}>
              {body(item, pieces[0] ?? [])}
            </ClassCard>
          );
        }
        return (
          <ClassCard key={key} anchor={key} title={item.title} chips={chips} open={isOpen} onToggle={toggle}>
            {item.members.map((m, i) => (
              <div key={entryAnchor(m)} className="meds-mem" data-anchor={entryAnchor(m)}>
                <h4 className="meds-mt">{entryTitle(m)}</h4>
                {body(m, pieces[i] ?? [])}
              </div>
            ))}
          </ClassCard>
        );
      })}
    </div>
  );
}
