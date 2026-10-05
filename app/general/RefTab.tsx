// Reference tabs (Labs, Imaging, EKG, Anatomy; UI reference-tab): a landing page with the tab's topics
// and files, and a page per topic: its sections (gap blocks), each with where her notes have it, then
// the remaining links. The sidebar lists topics, then files.
import type { ReactNode } from "react";
import { refPath, type PubRefLink, type RefTabJson } from "../../lib/derive/published.ts";
import { TAB_LABELS, type RefTabId } from "../../lib/derive/routes.ts";
import { useData } from "../data/load.ts";
import { FileChips } from "../files/FileChip.tsx";
import { PlaceNotes } from "./PlaceNotes.tsx";
import { GapBlock, UpdChip } from "../render/labels.tsx";
import { Txt } from "../render/Text.tsx";
import { PageNotFound } from "../shell/errors.ts";
import { Link } from "../shell/Link.tsx";
import { AddDocument, EditControls, EditRegion } from "../shell/mounts.tsx";
import { Voice } from "../shell/owner.tsx";
import { PageHead } from "../shell/Page.tsx";
import { fileHash, refHash, useRoute } from "../shell/route.ts";
import { buildPageKey } from "../edit/pageKey.ts";

export function RefSidebar({ tab, onNavigate }: { tab: RefTabId; onNavigate: () => void }): ReactNode {
  const ref = useData<RefTabJson>(refPath(tab));
  const route = useRoute();
  const sub = route.kind === "ref" ? route.sub : null;
  const file = route.kind === "file" ? route.doc : null;
  const from = refHash(tab);
  return (
    <div className="side-in">
      <div className="side-top">
        <div className="gname">{ref.label}</div>
      </div>
      <div className="side-sec">Topics</div>
      <ul className="gen">
        {ref.subs.map((s) => (
          <li key={s.id}>
            <div className="ent-row">
              <Link to={refHash(tab, s.id)} className={`ent${sub === s.id ? " open" : ""}`} aria-current={sub === s.id ? "page" : undefined} onClick={onNavigate}>
                <Txt text={s.title} />
              </Link>
            </div>
          </li>
        ))}
      </ul>
      {ref.files.files.length > 0 && (
        <>
          <div className="side-sec">
            <Voice owner="Your files" visitor="Files" />
          </div>
          <ul className="gen">
            {ref.files.files.map((f) => (
              <li key={f.id}>
                <div className="ent-row">
                  <Link to={fileHash(f.id, from)} className={`ent${file === f.id ? " open" : ""}`} aria-current={file === f.id ? "page" : undefined} onClick={onNavigate}>
                    <Txt text={f.name} />
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function RefTabPage({ tab, sub: subId }: { tab: RefTabId; sub: string | null }): ReactNode {
  const ref = useData<RefTabJson>(refPath(tab));
  const label = ref.label || TAB_LABELS[tab];
  if (subId === null) {
    return (
      <div className="ref-page">
        <PageHead crumbs={[{ label }]} title={label} actions={<AddDocument place={{ kind: "ref", tab }} title={label} />} />
        <p className="lead">
          Across every rotation and PANCE.<span className="own-only"> Each topic lists your notes first, then your files, then anything added to fill gaps.</span>
        </p>
        <ul className="lnk">
          {ref.subs.map((s) => (
            <li key={s.id}>
              <Link to={refHash(tab, s.id)}>
                <span className="lt">
                  <Txt text={s.title} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <div className="gsec">
          <h2>
            <Voice owner="Your files" visitor="Files" />
          </h2>
          <FileChips list={ref.files} />
        </div>
      </div>
    );
  }
  const sub = ref.subs.find((s) => s.id === subId);
  if (!sub) throw new PageNotFound(`${tab}/${subId}`);
  const pageKey = buildPageKey("ref", tab, sub.id);
  return (
    <div className="ref-page">
      <PageHead crumbs={[{ label, to: refHash(tab) }, { label: sub.title }]} title={<Txt text={sub.title} />} actions={<EditControls pageKey={pageKey} title={sub.title} />} />
      <EditRegion pageKey={pageKey} title={sub.title}>
        <RefSubBody sub={sub} />
      </EditRegion>
    </div>
  );
}

type RefSub = RefTabJson["subs"][number];

/** Links grouped by their `covers` text (the target's title when it has none), in order of first appearance. */
function groupLinks(links: readonly PubRefLink[]): { covers: string; links: PubRefLink[] }[] {
  const groups = new Map<string, PubRefLink[]>();
  for (const l of links) {
    const key = l.covers || l.title;
    const g = groups.get(key);
    if (g) g.push(l);
    else groups.set(key, [l]);
  }
  return [...groups].map(([covers, ls]) => ({ covers, links: ls }));
}

/** One `covers` text, then a link per place her notes have it (with the topic's title where two share a place). */
function LinkGroup({ covers, links }: { covers: string; links: readonly PubRefLink[] }): ReactNode {
  const shared = (loc: string): boolean => links.filter((l) => l.loc === loc).length > 1;
  return (
    <>
      <span className="lg-c">
        <Txt text={covers} />
      </span>
      {links.map((l, i) => (
        <span key={l.target}>
          {i > 0 && " · "}
          <Link to={l.route} title={l.title}>
            {shared(l.loc) ? `${l.loc} › ${l.title}` : l.loc}
          </Link>
          {l.flagged && <UpdChip />}
        </span>
      ))}
    </>
  );
}

function LinkGroups({ links }: { links: readonly PubRefLink[] }): ReactNode {
  return (
    <ul className="lgroups">
      {groupLinks(links).map((g) => (
        <li key={g.covers}>
          <LinkGroup covers={g.covers} links={g.links} />
        </li>
      ))}
    </ul>
  );
}

/** Jumps within the page to one of its sections. */
function SectionIndex({ gaps }: { gaps: RefSub["gaps"] }): ReactNode {
  const jump = (id: string): void => {
    document.querySelector(`[data-anchor="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "start" });
  };
  return (
    <nav className="sec-index" aria-label="Sections on this page">
      {gaps.map((g) => (
        <button key={g.id} type="button" className="srch-link" onClick={() => jump(g.id)}>
          <Txt text={g.title} />
        </button>
      ))}
    </nav>
  );
}

/**
 * A reference-tab topic's body: her own notes shown here, then its sections (the gap blocks, in order),
 * each followed by a compact list of where her notes have it (links whose `gap` names it), then the
 * links that belong to no section.
 */
export function RefSubBody({ sub }: { sub: RefSub }): ReactNode {
  const sectionIds = new Set(sub.gaps.map((g) => g.id));
  const rest = sub.links.filter((l) => l.gap === undefined || !sectionIds.has(l.gap));
  return (
    <>
      <PlaceNotes notes={sub.notes} />
      {sub.gaps.length > 2 && <SectionIndex gaps={sub.gaps} />}
      {sub.gaps.map((g) => {
        const own = sub.links.filter((l) => l.gap === g.id);
        return (
          <div key={g.id} className="ref-sec">
            <GapBlock gap={g} />
            {own.length > 0 && (
              <div className="sec-links">
                <span className="sl-h">
                  <Voice owner="In your notes" visitor="In the notes" />
                </span>
                <LinkGroups links={own} />
              </div>
            )}
          </div>
        );
      })}
      {sub.gaps.length === 0 && <div className="covered own-only">Your notes and files cover this. Nothing was added.</div>}
      {rest.length > 0 && (
        <div className="gsec sec-rest">
          <h2>{sub.gaps.length > 0 ? <Voice owner="Also in your notes" visitor="Also in the notes" /> : <Voice owner="In your notes" visitor="In the notes" />}</h2>
          <LinkGroups links={rest} />
        </div>
      )}
    </>
  );
}
