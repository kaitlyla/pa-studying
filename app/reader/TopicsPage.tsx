// Topic page (40 §40.3, guide-reader/compare): one or more topics stacked. Each shows its update
// notes above its table, its heading row and rows, and its meds panel below.
import type { ReactNode } from "react";
import type { NavJson, PubTopic, SystemJson } from "../../lib/derive/published.ts";
import { MedsPanel } from "../pharm/MedsPanel.tsx";
import { UpdateNotes } from "../render/labels.tsx";
import { Txt } from "../render/Text.tsx";
import { PageNotFound } from "../shell/errors.ts";
import { Icon } from "../shell/Icon.tsx";
import { EditControls, EditRegion, useIsEditing } from "../shell/mounts.tsx";
import { PageHead, type Crumb } from "../shell/Page.tsx";
import { guideViewHash, navigate } from "../shell/route.ts";
import { notesAt, NotesBlock } from "./blocks.tsx";
import { guideCrumbs, systemCrumb, topicHash, useNav, useSite, useSystem } from "./data.ts";
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
  ids: readonly string[];
  multi: boolean;
}

function TopicCard({ guide, nav, id, system: sysId, ids, multi }: TopicCardProps): ReactNode {
  const system = useSystem(guide, sysId);
  const topic = topicIn(system, id);
  const first = topic.rows.map((r) => system.rows[r]).find((r) => r !== undefined);
  const block = first ? system.blocks.find((b) => b.id === first.block) : undefined;
  const pageKey = buildPageKey("topic", guide, topic.id);
  const editing = useIsEditing(pageKey);
  return (
    <section className="tcard" aria-label={topic.title} data-topic={topic.id}>
      <div className="tcard-h">
        {multi && (
          <>
            <b>
              <Txt text={topic.title} />
            </b>
            <span className="loc">{system.title}</span>
          </>
        )}
        <span className="x">
          <EditControls pageKey={pageKey} title={topic.title} />
          {multi && (
            <button type="button" className="iconbtn" aria-label={`Close ${topic.title}`} onClick={() => void navigate(topicHash(guide, ids.filter((x) => x !== id)))}>
              <Icon n="x" size={14} />
            </button>
          )}
        </span>
      </div>
      <UpdateNotes notes={notesAt(system.notes, block ? [block.id, ...topic.rows] : topic.rows)} />
      <EditRegion pageKey={pageKey} title={topic.title}>
        {block && <NotesBlock block={block} basePt={nav.basePt} rows={topic.rows} />}
      </EditRegion>
      <MedsPanel guide={guide} system={system} systems={nav.systems} topic={topic} basePt={nav.basePt} />
      {/* Her own notes and pictures below the topic; while editing, they are in the editor above. */}
      {topic.below && !editing && <NotesBlock block={topic.below} basePt={nav.basePt} />}
    </section>
  );
}

/** The PDF menu's "This topic" / "This page (N topics)" item: offered when every open topic is in one system. */
function TopicsPdf({ guide, nav, ids, system, titles }: { guide: string; nav: NavJson; ids: string[]; system: string; titles: string }): ReactNode {
  const site = useSite();
  const data = useSystem(guide, system);
  return (
    <PdfMenu
      site={site}
      guide={guide}
      nav={nav}
      page={{
        label: ids.length > 1 ? `This page (${ids.length} topics)` : "This topic",
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
  const unique = [...new Set(ids)];
  const located = unique.map((id) => {
    const at = locateEntry(nav, id);
    if (!at) throw new PageNotFound(`topic ${id}`);
    return { id, ...at };
  });
  const multi = located.length > 1;
  const titleOf = (id: string): string => {
    for (const s of nav.systems) {
      const e = [...s.entries, ...s.sections.flatMap((x) => x.entries)].find((x) => x.id === id);
      if (e) return e.title;
    }
    return id;
  };
  const one = located[0];
  if (!one) throw new PageNotFound("no topic");
  const sys = nav.systems.find((s) => s.id === one.system);
  let crumbs: Crumb[] = guideCrumbs(site, guide);
  if (multi) crumbs = [...crumbs, { label: `${located.length} topics open` }];
  else if (sys) {
    crumbs = [...crumbs, systemCrumb(guide, sys)];
    const sec = one.section ? sys.sections.find((s) => s.id === one.section) : undefined;
    if (sec) crumbs.push({ label: sec.title, to: guideViewHash(guide, { kind: "section", system: sys.id, section: sec.id }) });
    crumbs.push({ label: titleOf(one.id) });
  }
  const oneSystem = located.every((l) => l.system === one.system);
  const titles = located.map((l) => titleOf(l.id)).join(", ");
  const last = located[located.length - 1];
  return (
    <div className="topics-page">
      <PageHead
        crumbs={crumbs}
        title={multi ? `Comparing ${located.length} topics` : <Txt text={titleOf(one.id)} />}
        tables
        actions={
          <>
            {multi && last && (
              <button type="button" className="btn" onClick={() => void navigate(topicHash(guide, [last.id]))}>
                Close others
              </button>
            )}
            {oneSystem ? (
              <TopicsPdf guide={guide} nav={nav} ids={located.map((l) => l.id)} system={one.system} titles={titles} />
            ) : (
              <PdfMenu site={site} guide={guide} nav={nav} />
            )}
          </>
        }
      />
      {located.map((l) => (
        <TopicCard key={l.id} guide={guide} nav={nav} id={l.id} system={l.system} ids={unique} multi={multi} />
      ))}
    </div>
  );
}
