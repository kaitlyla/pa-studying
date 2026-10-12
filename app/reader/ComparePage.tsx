// Compare (40 §40.3, guide-reader/compare): up to four diagnoses of one guide side by side, one per
// quadrant, each quadrant scrolling on its own (2 x 2 on desktop, stacked on phone). A quadrant shows
// the same card a topic page shows — notes, meds panel and her own additions — read through the same
// data layer, so an unsaved or just-saved edit shows here too. The owner's favorites menu sits on each
// filled quadrant: saved pairs to compare, and the other open diagnoses to save as a favorite.
import type { ReactNode } from "react";
import type { NavJson } from "../../lib/derive/published.ts";
import { PageNotFound } from "../shell/errors.ts";
import { Icon } from "../shell/Icon.tsx";
import { FavoriteMenu } from "../shell/mounts.tsx";
import { PageHead, type Crumb } from "../shell/Page.tsx";
import { useOwner } from "../shell/owner.tsx";
import { guideViewHash, navigate } from "../shell/route.ts";
import { COMPARE, entryTitle, guideCrumbs, useNav, useSite } from "./data.ts";
import { locateEntry, TopicCard } from "./TopicsPage.tsx";

export const ADD_QUADRANT = "Add quadrant";
export const CHOOSE_DIAGNOSIS = "Choose a diagnosis…";

/** The guide's diagnoses grouped as the sidebar lists them, for a quadrant's picker. */
function topicGroups(nav: NavJson): { id: string; title: string; entries: { id: string; title: string }[] }[] {
  return nav.systems
    .map((s) => ({
      id: s.id,
      title: s.title,
      entries: [...s.entries, ...s.sections.flatMap((x) => x.entries)].filter((e) => e.kind === "topic"),
    }))
    .filter((s) => s.entries.length > 0);
}

export function ComparePage({ guide, ids }: { guide: string; ids: string[] }): ReactNode {
  const site = useSite();
  const nav = useNav(guide);
  const owner = useOwner().owner;
  const groups = topicGroups(nav);
  const slots = ids.map((id) => (id === "" ? null : locateEntry(nav, id)));
  ids.forEach((id, i) => {
    if (id !== "" && slots[i] === null) throw new PageNotFound(`topic ${id}`);
  });
  const titleOf = (id: string): string => entryTitle(nav, id);
  const go = (next: string[]): void => void navigate(guideViewHash(guide, { kind: "compare", ids: next }));
  const pick = (i: number, id: string): void => go(ids.map((x, j) => (j === i ? id : x)));
  /** A saved partner goes to the next empty quadrant (a new one while there is room). */
  const fill = (id: string): void => {
    const empty = ids.findIndex((x) => x === "");
    if (empty >= 0) pick(empty, id);
    else if (ids.length < 4) go([...ids, id]);
  };
  const crumbs: Crumb[] = [...guideCrumbs(site, guide), { label: COMPARE }];
  return (
    <div className="cmp-page">
      <PageHead
        crumbs={crumbs}
        title={COMPARE}
        tables
        actions={ids.length < 4 ? <button type="button" className="btn" onClick={() => go([...ids, ""])}>{ADD_QUADRANT}</button> : undefined}
      />
      <div className="cmp-grid">
        {ids.map((id, i) => {
          const at = slots[i] ?? null;
          return (
            <section className="cmp-q" key={i} aria-label={id === "" ? `Quadrant ${i + 1}` : `${titleOf(id)} (quadrant ${i + 1})`}>
              <div className="cmp-h">
                <select aria-label={`Diagnosis ${i + 1}`} value={id} onChange={(e) => pick(i, e.target.value)}>
                  <option value="">{CHOOSE_DIAGNOSIS}</option>
                  {groups.map((g) => (
                    <optgroup key={g.id} label={g.title}>
                      {g.entries.map((e) => (
                        <option key={e.id} value={e.id}>{e.title}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                {id !== "" && owner && (
                  <FavoriteMenu
                    guide={guide}
                    id={id}
                    others={ids}
                    canPick={ids.some((x) => x === "") || ids.length < 4}
                    onPick={fill}
                    titleOf={titleOf}
                  />
                )}
                {ids.length > 1 && (
                  <button type="button" className="iconbtn" aria-label={`Remove quadrant ${i + 1}`} onClick={() => go(ids.filter((_, j) => j !== i))}>
                    <Icon n="x" size={14} />
                  </button>
                )}
              </div>
              {id !== "" && at !== null && (
                <div className="cmp-body">
                  <TopicCard guide={guide} nav={nav} id={id} system={at.system} ids={[]} multi={false} />
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
