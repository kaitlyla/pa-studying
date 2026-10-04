// System page (40 §40.3, guide-reader/system-open): every block of the system in guide order, drug
// tables as stubs, update notes above the tables holding flagged topics.
import { useMemo, type ReactNode } from "react";
import { EditControls, EditRegion } from "../shell/mounts.tsx";
import { PageHead } from "../shell/Page.tsx";
import { PlacedBlock, rowsByBlock } from "./blocks.tsx";
import { guideCrumbs, useNav, useSite, useSystem } from "./data.ts";
import { PdfMenu } from "./PdfMenu.tsx";
import { buildPageKey } from "../edit/pageKey.ts";

export function SystemPage({ guide, system: id }: { guide: string; system: string }): ReactNode {
  const site = useSite();
  const nav = useNav(guide);
  const system = useSystem(guide, id);
  const byBlock = useMemo(() => rowsByBlock(system), [system]);
  const pageKey = buildPageKey("system", guide, system.id);
  return (
    <div className="system-page">
      <PageHead
        crumbs={[...guideCrumbs(site, guide), { label: system.title }]}
        title={
          <>
            {system.title} {system.pct && <span className="h-sub">{system.pct}</span>}
          </>
        }
        tables
        actions={
          <>
            <EditControls pageKey={pageKey} title={system.title} />
            <PdfMenu
              site={site}
              guide={guide}
              nav={nav}
              page={{ label: "This system", name: system.title, scope: { kind: "system" }, input: { nav, system } }}
            />
          </>
        }
      />
      <EditRegion pageKey={pageKey} title={system.title}>
        {system.blocks.map((b) => (
          <PlacedBlock key={b.id} guide={guide} system={system} block={b} basePt={nav.basePt} rows={null} blockRows={byBlock.get(b.id) ?? []} />
        ))}
      </EditRegion>
    </div>
  );
}
