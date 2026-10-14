// Topic page (40 §40.3, guide-reader/compare): one diagnosis. It shows its update notes above its
// tables, the rows of every table they continue into, its meds panel below, then her Additional info.
// The Compare button opens the compare view with it in the first quadrant; several diagnoses side by
// side live on that view.
import type { ReactNode } from "react";
import type { NavJson, PubTopic, SystemJson } from "../../lib/derive/published.ts";
import { rowsByBlock } from "../../lib/derive/topics.ts";
import { MedsPanel } from "../pharm/MedsPanel.tsx";
import { UpdateNotes } from "../render/labels.tsx";
import { Txt } from "../render/Text.tsx";
import { PageNotFound } from "../shell/errors.ts";
import { EditControls, EditRegion, useIsEditing } from "../shell/mounts.tsx";
import { PageHead, type Crumb } from "../shell/Page.tsx";
import { guideViewHash, navigate } from "../shell/route.ts";
import { AdditionalInfo, notesAt, NotesBlock } from "./blocks.tsx";
import { COMPARE, entryTitle, guideCrumbs, systemCrumb, useNav, useSite, useSystem } from "./data.ts";
import { PdfMenu } from "./PdfMenu.tsx";
import { buildPageKey } from "../edit/pageKey.ts";

/** The system (and section) whose sidebar lists the topic or listed block `id`. */
export function locateEntry(nav: NavJson, id: string): { system: string; section: string | null } | null {
  for (const s of nav.systems) {
    if (s.entries.some((e) => e.id === id)) return { system: s.id, section: null };
    for (const sec of s.sections) if (sec.entries.some((e) => e.id === id)) return { system: s.id, section: sec.id };
  }
  return null;
}

function topicIn(system: SystemJson, id: string): PubTopic {
  const t = system.topics.find((x) => x.id === id);
  if (!t) throw new PageNotFound(`topic ${id}`);
  return t;
}

interface TopicCardProps {
  guide: string;
  nav: NavJson;
  id: string;
  system: string;
}

export function TopicCard({ guide, nav, id, system: sysId }: TopicCardProps): ReactNode {
  const system = useSystem(guide, sysId);
  const topic = topicIn(system, id);
  // A topic's rows can continue into a later table: every block they sit in shows here, in her order
  // (the published topic rows are the source of truth).
  const blocks = rowsByBlock(topic.rows, (row) => system.rows[row]?.block).flatMap(({ block: id, rows }) => {
    const block = system.blocks.find((b) => b.id === id);
    return block ? [{ block, rows }] : [];
  });
  const pageKey = buildPageKey("topic", guide, topic.id);
  const editing = useIsEditing(pageKey);
  return (
    <section className="tcard" aria-label={topic.title} data-topic={topic.id}>
      <div className="tcard-h">
        <span className="x">
          <EditControls pageKey={pageKey} title={topic.title} />
        </span>
      </div>
      <UpdateNotes notes={notesAt(system.notes, blocks.flatMap(({ block, rows }) => [block.id, ...rows]))} />
      <EditRegion pageKey={pageKey} title={topic.title}>
        {blocks.map(({ block, rows }) => (
          <NotesBlock key={block.id} block={block} basePt={nav.basePt} rows={rows} />
        ))}
      </EditRegion>
      {/* The meds panel and her own notes and pictures below it; while editing, both are in the editors above. */}
      {!editing && <MedsPanel guide={guide} system={system} systems={nav.systems} topic={topic} basePt={nav.basePt} />}
      {topic.below && !editing && <AdditionalInfo block={topic.below} basePt={nav.basePt} />}
    </section>
  );
}

/** The PDF menu's "This topic" item: the diagnosis on this page. */
function TopicsPdf({ guide, nav, ids, system, titles }: { guide: string; nav: NavJson; ids: string[]; system: string; titles: string }): ReactNode {
  const site = useSite();
  const data = useSystem(guide, system);
  return (
    <PdfMenu
      site={site}
      guide={guide}
      nav={nav}
      page={{
        label: "This topic",
        name: titles,
        scope: { kind: "topics", ids },
        input: { nav, system: data },
      }}
    />
  );
}

export function TopicsPage({ guide, ids }: { guide: string; ids: string[] }): ReactNode {
  const site = useSite();
  const nav = useNav(guide);
  // A `t/<id>` route holds one diagnosis (several used to stack on this page; that is the compare view now).
  const id = ids[0];
  if (id === undefined) throw new PageNotFound("no topic");
  const at = locateEntry(nav, id);
  if (!at) throw new PageNotFound(`topic ${id}`);
  const sys = nav.systems.find((s) => s.id === at.system);
  let crumbs: Crumb[] = guideCrumbs(site, guide);
  if (sys) {
    crumbs = [...crumbs, systemCrumb(guide, sys)];
    const sec = at.section ? sys.sections.find((s) => s.id === at.section) : undefined;
    if (sec) crumbs.push({ label: sec.title, to: guideViewHash(guide, { kind: "section", system: sys.id, section: sec.id }) });
    crumbs.push({ label: entryTitle(nav, id) });
  }
  return (
    <div className="topics-page">
      <PageHead
        crumbs={crumbs}
        title={<Txt text={entryTitle(nav, id)} />}
        tables
        actions={
          <>
            <button type="button" className="btn" onClick={() => void navigate(guideViewHash(guide, { kind: "compare", ids: [id] }))}>
              {COMPARE}
            </button>
            <TopicsPdf guide={guide} nav={nav} ids={[id]} system={at.system} titles={entryTitle(nav, id)} />
          </>
        }
      />
      <TopicCard guide={guide} nav={nav} id={id} system={at.system} />
    </div>
  );
}
