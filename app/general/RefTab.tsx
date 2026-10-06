// Reference tabs (Labs, Imaging, EKG, Anatomy; UI reference-tab): a landing page with the tab's topics
// and files, and a page per topic: its sections (gap blocks), each with where her notes have it, then
// the remaining links. The sidebar lists topics, then files.
import { Fragment, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
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
      {subRuns(ref.subs).map((run) => (
        <Fragment key={run.subs[0]?.id}>
          {run.group !== null && (
            <div className="side-grp">
              <Txt text={run.group} />
            </div>
          )}
          <ul className="gen">
            {run.subs.map((s) => (
              <li key={s.id}>
                <div className="ent-row">
                  <Link to={refHash(tab, s.id)} className={`ent${sub === s.id ? " open" : ""}`} aria-current={sub === s.id ? "page" : undefined} onClick={onNavigate}>
                    <Txt text={s.title} />
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </Fragment>
      ))}
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
        {subRuns(ref.subs).map((run) => {
          const list = (
            <ul className="lnk">
              {run.subs.map((s) => (
                <li key={s.id}>
                  <Link to={refHash(tab, s.id)}>
                    <span className="lt">
                      <Txt text={s.title} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          );
          return run.group === null ? (
            <Fragment key={run.subs[0]?.id}>{list}</Fragment>
          ) : (
            <div key={run.subs[0]?.id} className="gsec ref-grp">
              <h2>
                <Txt text={run.group} />
              </h2>
              {list}
            </div>
          );
        })}
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
      <PageHead crumbs={[{ label, to: refHash(tab) }, ...(sub.group === null ? [] : [{ label: sub.group }]), { label: sub.title }]} title={<Txt text={sub.title} />} actions={<EditControls pageKey={pageKey} title={sub.title} />} />
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

/** Runs of consecutive subs sharing a `group` (null: no group), in order. */
function subRuns(subs: readonly RefSub[]): { group: string | null; subs: RefSub[] }[] {
  const runs: { group: string | null; subs: RefSub[] }[] = [];
  for (const s of subs) {
    const last = runs.at(-1);
    if (last && last.group === s.group) last.subs.push(s);
    else runs.push({ group: s.group, subs: [s] });
  }
  return runs;
}

/** Jumps within the page to one of its sections, first opening it (`reveal`) when it is collapsed. */
function SectionIndex({ gaps, reveal }: { gaps: RefSub["gaps"]; reveal?: (id: string) => void }): ReactNode {
  const jump = (id: string): void => {
    if (reveal) flushSync(() => reveal(id));
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

/** Where her notes have one section (the links whose `gap` names it). */
function SectionLinks({ links }: { links: readonly PubRefLink[] }): ReactNode {
  if (links.length === 0) return null;
  return (
    <div className="sec-links">
      <span className="sl-h">
        <Voice owner="In your notes" visitor="In the notes" />
      </span>
      <LinkGroups links={links} />
    </div>
  );
}

/**
 * A reference-tab topic's body: her own notes shown here, then its sections (the gap blocks, in order),
 * each followed by a compact list of where her notes have it (links whose `gap` names it), then the
 * links that belong to no section. A sub with `intro` shows its intro sections first, open, then every
 * other section as a closed collapsible under its title; a section opens when the route's `at` lands
 * on it or the section index jumps to it.
 */
export function RefSubBody({ sub }: { sub: RefSub }): ReactNode {
  const at = useRoute().query.at;
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set(at === null ? [] : [at]));
  const [landedAt, setLandedAt] = useState(at);
  if (at !== landedAt) {
    setLandedAt(at);
    if (at !== null && !opened.has(at)) setOpened(new Set([...opened, at]));
  }
  const setOpen = (id: string, open: boolean): void => {
    setOpened((prev) => {
      if (prev.has(id) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const sectionIds = new Set(sub.gaps.map((g) => g.id));
  const rest = sub.links.filter((l) => l.gap === undefined || !sectionIds.has(l.gap));
  const intro = sub.intro === null ? null : new Set(sub.intro);
  const shown = intro === null ? sub.gaps : [...sub.gaps.filter((g) => intro.has(g.id)), ...sub.gaps.filter((g) => !intro.has(g.id))];
  return (
    <>
      <PlaceNotes notes={sub.notes} />
      {sub.gaps.length > 2 && <SectionIndex gaps={shown} reveal={intro === null ? undefined : (id) => setOpen(id, true)} />}
      {shown.map((g) => {
        const own = sub.links.filter((l) => l.gap === g.id);
        if (intro === null || intro.has(g.id)) {
          return (
            <div key={g.id} className="ref-sec">
              <GapBlock gap={g} />
              <SectionLinks links={own} />
            </div>
          );
        }
        return (
          <details key={g.id} className="ref-sec ref-find" open={opened.has(g.id)} onToggle={(e) => setOpen(g.id, e.currentTarget.open)}>
            <summary>
              <Txt text={g.title} />
            </summary>
            <GapBlock gap={g} titled={false} />
            <SectionLinks links={own} />
          </details>
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
