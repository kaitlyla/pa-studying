// Initial workup of common presentations (general-topic/workup): an alphabetical list; each item opens
// a page showing only its gap block.
import type { ReactNode } from "react";
import { workupPath, type WorkupJson } from "../../lib/derive/published.ts";
import { GENERAL_LABELS } from "../../lib/derive/routes.ts";
import { useData } from "../data/load.ts";
import { GapBlock, GapChip } from "../render/labels.tsx";
import { Txt } from "../render/Text.tsx";
import { guideCrumbs, guideName, useSite } from "../reader/data.ts";
import { PageNotFound } from "../shell/errors.ts";
import { Link } from "../shell/Link.tsx";
import { EditControls, EditRegion } from "../shell/mounts.tsx";
import { PageHead } from "../shell/Page.tsx";
import { guideViewHash } from "../shell/route.ts";
import { buildPageKey } from "../edit/pageKey.ts";

export function WorkupPage({ guide, item: itemId }: { guide: string; item: string | null }): ReactNode {
  const site = useSite();
  const data = useData<WorkupJson>(workupPath(guide));
  const name = guideName(site, guide);
  const label = GENERAL_LABELS.workup;
  const listHash = guideViewHash(guide, { kind: "workup", item: null });
  const item = itemId ? data.items.find((x) => x.id === itemId) : null;
  if (itemId && !item) throw new PageNotFound(`workup ${itemId}`);
  const crumbs = [...guideCrumbs(site, guide), item ? { label, to: listHash } : { label }];
  if (item) crumbs.push({ label: item.title });
  const head = (
    <>
      {label} <span className="h-sub">for {name}</span>
    </>
  );
  if (item) {
    const pageKey = buildPageKey("workup", guide, item.id);
    return (
      <div className="workup-page">
        <PageHead crumbs={crumbs} title={head} actions={<EditControls pageKey={pageKey} title={`${item.title} — ${label} for ${name}`} />} />
        <section aria-label={item.title}>
          <Link to={listHash} className="linkbtn wk-back">
            ‹ All presentations
          </Link>
          <h2 className="wk-h">
            <Txt text={item.title} />
          </h2>
          <EditRegion pageKey={pageKey} title={item.title}>
            <GapBlock gap={item.gap} />
          </EditRegion>
        </section>
      </div>
    );
  }
  const sorted = [...data.items].sort((a, b) => a.title.localeCompare(b.title));
  return (
    <div className="workup-page">
      <PageHead crumbs={crumbs} title={head} />
      <p className="wk-lead">What to order when a patient presents with…</p>
      <ul className="lnk">
        {sorted.map((x) => (
          <li key={x.id}>
            <Link to={guideViewHash(guide, { kind: "workup", item: x.id })}>
              <span className="lt">
                <Txt text={x.title} />
              </span>
              {x.conds && <span className="ll">Can point to: {x.conds}</span>}
              {!x.gap.asNotes && <GapChip />}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
