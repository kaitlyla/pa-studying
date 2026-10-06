// A listed block's page (`…/b/<block>`): a block the sidebar lists by name, shown whole, with the
// rest of its run when the entry lists a run of blocks.
import type { ReactNode } from "react";
import type { PubBlock } from "../../lib/derive/published.ts";
import { UpdateNotes } from "../render/labels.tsx";
import { PageNotFound } from "../shell/errors.ts";
import { EditControls, EditRegion } from "../shell/mounts.tsx";
import { PageHead, type Crumb } from "../shell/Page.tsx";
import { guideViewHash } from "../shell/route.ts";
import { NotesBlock } from "./blocks.tsx";
import { guideCrumbs, systemCrumb, useNav, useSite, useSystem } from "./data.ts";
import { PdfMenu } from "./PdfMenu.tsx";
import { locateEntry } from "./TopicsPage.tsx";
import { buildPageKey } from "../edit/pageKey.ts";

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
  const navSys = nav.systems.find((s) => s.id === at.system);
  const sec = at.section ? navSys?.sections.find((s) => s.id === at.section) : undefined;
  const entry = [...(navSys?.entries ?? []), ...(sec?.entries ?? [])].find((e) => e.id === id);
  const blocks = (entry?.blocks ?? [id]).map((b) => system.blocks.find((x) => x.id === b));
  if (blocks.some((b) => b === undefined)) throw new PageNotFound(`block ${id}`);
  const shown = blocks as PubBlock[];
  const title = entry?.title ?? system.title;
  const crumbs: Crumb[] = [...guideCrumbs(site, guide), systemCrumb(guide, system)];
  if (sec) crumbs.push({ label: sec.title, to: guideViewHash(guide, { kind: "section", system: system.id, section: sec.id }) });
  crumbs.push({ label: title });
  const pageKey = buildPageKey("listed", guide, id);
  return (
    <div className="block-page">
      <PageHead
        crumbs={crumbs}
        title={title}
        tables={shown.some((b) => b.kind === "table")}
        actions={
          <>
            <EditControls pageKey={pageKey} title={title} />
            <PdfMenu site={site} guide={guide} nav={nav} />
          </>
        }
      />
      {shown.map((b) => <UpdateNotes key={b.id} notes={system.notes[b.id]} />)}
      <EditRegion pageKey={pageKey} title={title}>
        {shown.map((b) => <NotesBlock key={b.id} block={b} basePt={nav.basePt} />)}
      </EditRegion>
    </div>
  );
}
