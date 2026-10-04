// A listed block's page (`…/b/<block>`): a prose block the sidebar lists by name, shown whole.
import type { ReactNode } from "react";
import { UpdateNotes } from "../render/labels.tsx";
import { PageNotFound } from "../shell/errors.ts";
import { EditControls, EditRegion } from "../shell/mounts.tsx";
import { PageHead, type Crumb } from "../shell/Page.tsx";
import { guideViewHash } from "../shell/route.ts";
import { NotesBlock } from "./blocks.tsx";
import { guideCrumbs, systemCrumb, useNav, useSite, useSystem } from "./data.ts";
import { PdfMenu } from "./PdfMenu.tsx";
import { locateEntry } from "./TopicsPage.tsx";

export function BlockPage({ guide, block: id }: { guide: string; block: string }): ReactNode {
  const nav = useNav(guide);
  const at = locateEntry(nav, id);
  if (!at) throw new PageNotFound(`block ${id}`);
  return <BlockBody guide={guide} id={id} at={at} />;
}

function BlockBody({ guide, id, at }: { guide: string; id: string; at: { system: string; section: string | null } }): ReactNode {
  const site = useSite();
  const nav = useNav(guide);
  const system = useSystem(guide, at.system);
  const block = system.blocks.find((b) => b.id === id);
  if (!block) throw new PageNotFound(`block ${id}`);
  const navSys = nav.systems.find((s) => s.id === at.system);
  const sec = at.section ? navSys?.sections.find((s) => s.id === at.section) : undefined;
  const entry = [...(navSys?.entries ?? []), ...(sec?.entries ?? [])].find((e) => e.id === id);
  const title = entry?.title ?? system.title;
  const crumbs: Crumb[] = [...guideCrumbs(site, guide), systemCrumb(guide, system)];
  if (sec) crumbs.push({ label: sec.title, to: guideViewHash(guide, { kind: "section", system: system.id, section: sec.id }) });
  crumbs.push({ label: title });
  const pageKey = `listed:${guide}:${block.id}`;
  return (
    <div className="block-page">
      <PageHead
        crumbs={crumbs}
        title={title}
        tables={block.kind === "table"}
        actions={
          <>
            <EditControls pageKey={pageKey} title={title} />
            <PdfMenu site={site} guide={guide} nav={nav} />
          </>
        }
      />
      <UpdateNotes notes={system.notes[block.id]} />
      <EditRegion pageKey={pageKey} title={title}>
        <NotesBlock block={block} basePt={nav.basePt} />
      </EditRegion>
    </div>
  );
}
