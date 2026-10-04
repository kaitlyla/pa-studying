// Section page (40 §40.3): the section's members in guide order; a table shows only the rows of its
// member topics, each run preceded by its heading row; prose and one-column blocks show whole.
import { useMemo, type ReactNode } from "react";
import { PageNotFound } from "../shell/errors.ts";
import { EditControls, EditRegion } from "../shell/mounts.tsx";
import { PageHead } from "../shell/Page.tsx";
import { PlacedBlock, rowsByBlock } from "./blocks.tsx";
import { guideCrumbs, systemCrumb, useNav, useSite, useSystem } from "./data.ts";
import { PdfMenu } from "./PdfMenu.tsx";

export function SectionPage({ guide, system: sysId, section: secId }: { guide: string; system: string; section: string }): ReactNode {
  const site = useSite();
  const nav = useNav(guide);
  const system = useSystem(guide, sysId);
  const byBlock = useMemo(() => rowsByBlock(system), [system]);
  const section = system.sections.find((s) => s.id === secId);
  if (!section) throw new PageNotFound(`section ${sysId}/${secId}`);
  const blocks = new Map(system.blocks.map((b) => [b.id, b]));
  const count = nav.systems.find((s) => s.id === sysId)?.sections.find((s) => s.id === secId)?.entries.length ?? 0;
  const pageKey = `section:${guide}:${system.id}:${section.id}`;
  return (
    <div className="section-page">
      <PageHead
        crumbs={[...guideCrumbs(site, guide), systemCrumb(guide, system), { label: section.title }]}
        title={
          <>
            {section.title}{" "}
            <span className="h-sub">
              {count} {count === 1 ? "topic" : "topics"}
            </span>
          </>
        }
        tables
        actions={
          <>
            <EditControls pageKey={pageKey} title={section.title} />
            <PdfMenu
              site={site}
              guide={guide}
              nav={nav}
              page={{ label: "This section", name: section.title, scope: { kind: "section", id: section.id }, input: { nav, system } }}
            />
          </>
        }
      />
      <EditRegion pageKey={pageKey} title={section.title}>
        {section.items.map((item) => {
          const b = blocks.get(item.block);
          if (!b) return null;
          return <PlacedBlock key={b.id} guide={guide} system={system} block={b} basePt={nav.basePt} rows={item.rows} blockRows={byBlock.get(b.id) ?? []} />;
        })}
      </EditRegion>
    </div>
  );
}
