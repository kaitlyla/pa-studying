// Well child visits (general-topic/visits): the visits in age order; each opens a page with the links
// into her notes and the gap blocks for that visit.
import type { ReactNode } from "react";
import { visitsPath, type DocList, type VisitsJson } from "../../lib/derive/published.ts";
import { GENERAL_LABELS } from "../../lib/derive/routes.ts";
import { useData } from "../data/load.ts";
import { Txt } from "../render/Text.tsx";
import { guideCrumbs, guideName, useSite } from "../reader/data.ts";
import { PageNotFound } from "../shell/errors.ts";
import { Link } from "../shell/Link.tsx";
import { EditControls, EditRegion } from "../shell/mounts.tsx";
import { PageHead } from "../shell/Page.tsx";
import { guideViewHash } from "../shell/route.ts";
import { buildPageKey } from "../edit/pageKey.ts";
import { ThreeParts } from "./ThreeParts.tsx";

const NO_FILES: DocList = { files: [], removed: [], pending: [] };

export function VisitsPage({ guide, item: itemId }: { guide: string; item: string | null }): ReactNode {
  const site = useSite();
  const data = useData<VisitsJson>(visitsPath(guide));
  const name = guideName(site, guide);
  const label = GENERAL_LABELS.visits;
  const listHash = guideViewHash(guide, { kind: "visits", item: null });
  const at = itemId ? data.items.findIndex((x) => x.id === itemId) : -1;
  const item = data.items[at];
  if (itemId && !item) throw new PageNotFound(`visit ${itemId}`);
  const crumbs = [...guideCrumbs(site, guide), item ? { label, to: listHash } : { label }];
  if (item) crumbs.push({ label: item.title });
  const head = (
    <>
      {label} <span className="h-sub">for {name}</span>
    </>
  );
  if (item) {
    const pageKey = buildPageKey("visit", guide, item.id);
    const prev = data.items[at - 1];
    const next = data.items[at + 1];
    return (
      <div className="visits-page">
        <PageHead crumbs={crumbs} title={head} actions={<EditControls pageKey={pageKey} title={`${item.title} — ${label} for ${name}`} />} />
        <section aria-label={item.title}>
          <nav className="vis-nav" aria-label="Visits">
            <Link to={listHash} className="linkbtn">
              ‹ All visits
            </Link>
            {prev && (
              <Link to={guideViewHash(guide, { kind: "visits", item: prev.id })} className="linkbtn" rel="prev">
                ← <Txt text={prev.title} />
              </Link>
            )}
            {next && (
              <Link to={guideViewHash(guide, { kind: "visits", item: next.id })} className="linkbtn" rel="next">
                <Txt text={next.title} /> →
              </Link>
            )}
          </nav>
          <h2 className="vis-h">
            <Txt text={item.title} />
          </h2>
          <EditRegion pageKey={pageKey} title={item.title}>
            <ThreeParts links={item.links} files={NO_FILES} gaps={item.gaps} coveredFor={name} />
          </EditRegion>
        </section>
      </div>
    );
  }
  return (
    <div className="visits-page">
      <PageHead crumbs={crumbs} title={head} />
      <ul className="lnk">
        {data.items.map((x) => (
          <li key={x.id}>
            <Link to={guideViewHash(guide, { kind: "visits", item: x.id })}>
              <span className="lt">
                <Txt text={x.title} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
