// "Medications for this condition" under a condition topic (40 §40.5, pharm/meds-panel): one
// collapsible card per drug class, each with its guide rows, her notes, and a link into the pharm
// section. View-only: it sits outside the topic's edit region.
import { useState, type ReactNode } from "react";
import type { PubTopic, SystemJson } from "../../lib/derive/published.ts";
import { Icon } from "../shell/Icon.tsx";
import { Link } from "../shell/Link.tsx";
import { guideViewHash } from "../shell/route.ts";
import { CardNotes, ClassCard, GuideRows } from "./ClassCard.tsx";

export function MedsPanel({ guide, system, topic, basePt }: { guide: string; system: SystemJson; topic: PubTopic; basePt: number }): ReactNode {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (topic.meds.length === 0) return null;
  return (
    <div className="meds">
      <h3 className="meds-hd">
        <Icon n="pill" size={15} /> Medications for this condition <span className="n">{topic.meds.length}</span>
      </h3>
      {topic.meds.map((m) => {
        const card = m.card ? system.cards[m.card] : undefined;
        const key = m.target;
        return (
          <ClassCard key={key} anchor={`meds-${key}`} title={m.title} open={!!open[key]} onToggle={() => setOpen((o) => ({ ...o, [key]: !o[key] }))}>
            {m.rows.length > 0 && <GuideRows system={system} rows={m.rows} basePt={basePt} />}
            {card && card.blocks.length > 0 && <CardNotes system={system} file={card.file} basePt={card.basePt} parts={card.parts} />}
            <Link to={guideViewHash(guide, { kind: "pharm", system: system.id, section: m.section, target: m.target })} className="linkbtn phc-more">
              Open in {system.title} pharm ›
            </Link>
          </ClassCard>
        );
      })}
    </div>
  );
}
