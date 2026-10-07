// "Medications for this condition" under a condition topic (40 §40.5, pharm/meds-panel): one
// collapsible card per entry of the panel as she shaped it for this condition (lib/derive/panel.ts),
// each with its guide rows and her notes, or her own version of them, and a drug class's link into
// the pharm section that holds it. View-only: in edit mode the topic's region edits the panel.
import { useState, type ReactNode } from "react";
import { panelEntries, shownPieces } from "../../lib/derive/panel.ts";
import type { NavSystem, PubTopic, SystemJson } from "../../lib/derive/published.ts";
import { Icon } from "../shell/Icon.tsx";
import { Link } from "../shell/Link.tsx";
import { guideViewHash } from "../shell/route.ts";
import { CardPieces, ClassCard } from "./ClassCard.tsx";

/** Owner-only label on an entry she edited for this condition. */
export const OWN_VERSION = "Your version for this condition";

export function MedsPanel({ guide, system, systems, topic, basePt }: { guide: string; system: SystemJson; systems: readonly NavSystem[]; topic: PubTopic; basePt: number }): ReactNode {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const entries = panelEntries(topic);
  if (entries.length === 0) return null;
  return (
    <div className="meds">
      <h3 className="meds-hd">
        <Icon n="pill" size={15} /> Medications for this condition <span className="n">{entries.length}</span>
      </h3>
      {entries.map((e) => {
        const m = e.med;
        const key = m.target;
        const toggle = (): void => setOpen((o) => ({ ...o, [key]: !o[key] }));
        // A part of her pharm notes attached to this condition is in no pharm section, so no link.
        const linked = m.part !== undefined || m.system === null ? undefined : systems.find((s) => s.id === m.system);
        return (
          <ClassCard key={key} anchor={`meds-${key}`} title={m.title} open={!!open[key]} onToggle={toggle}>
            {e.own && <div className="phn-k own-only">{OWN_VERSION}</div>}
            <CardPieces pieces={shownPieces(system, topic, e, basePt)} />
            {linked && (
              <Link to={guideViewHash(guide, { kind: "pharm", system: linked.id, section: m.section, target: m.target })} className="linkbtn phc-more">
                Open in {linked.title} pharm ›
              </Link>
            )}
          </ClassCard>
        );
      })}
    </div>
  );
}
