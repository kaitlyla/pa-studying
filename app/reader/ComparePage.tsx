// Compare (40 §40.3, guide-reader/compare): the diagnoses of one guide side by side, two per row, one per
// quadrant, each quadrant scrolling on its own (stacked on phone). A quadrant shows the same card a topic
// page shows — notes, meds panel and her own additions — read through the same data layer, so an unsaved or
// just-saved edit shows here too. Her card is drawn stacked (the phone's Stacked layout), so her sections
// read top to bottom instead of as sideways columns. The sidebar's + adds the next diagnosis; each quadrant
// has its picker and its ✕, and there is no limit on how many she compares. The owner's favorites menu sits
// on each quadrant (saved pairs to compare, and every diagnosis of the guide to save, the ones on screen
// first), and she can save the quadrants as a named comparison.
import { useLayoutEffect, type ReactNode } from "react";
import type { NavJson } from "../../lib/derive/published.ts";
import { PageNotFound } from "../shell/errors.ts";
import { Icon } from "../shell/Icon.tsx";
import { FavoriteMenu, SaveComparison } from "../shell/mounts.tsx";
import { PageHead, StackedContext, type Crumb } from "../shell/Page.tsx";
import { useOwner } from "../shell/owner.tsx";
import { addToCompare, guideViewHash, navigate, syncFromLocation } from "../shell/route.ts";
import { COMPARE, entryTitle, guideCrumbs, topicSystems, useNav, useSite } from "./data.ts";
import { TopicCard } from "./TopicsPage.tsx";

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
  // An old `t/a,b` link parses as this view; an empty slot is not a quadrant, and neither is a diagnosis
  // the guide no longer lists — a saved comparison opens on the quadrants that are still there.
  const systems = topicSystems(nav);
  const quadrants = ids.flatMap((id) => {
    const system = systems.get(id);
    return system === undefined ? [] : [{ id, system }];
  });
  if (quadrants.length === 0) throw new PageNotFound(`topic ${ids.find((x) => x !== "") ?? ""}`);
  const shown = quadrants.map((q) => q.id);
  const titleOf = (id: string): string => entryTitle(nav, id);
  const go = (next: string[]): void => void navigate(guideViewHash(guide, { kind: "compare", ids: next }));
  const pick = (i: number, id: string): void => go(shown.map((x, j) => (j === i ? id : x)));
  /** A saved partner goes to the next free quadrant (the same rule the sidebar's + uses). */
  const fill = (id: string): void => go(addToCompare(shown, id));

  // A multi-topic link from the old stacked page (and any empty slot, or a diagnosis the guide no longer
  // has) lands here; make the address the canonical compare route, replacing the entry so Back leaves the
  // comparison rather than bouncing off the old address.
  useLayoutEffect(() => {
    const known = topicSystems(nav);
    const canonical = guideViewHash(guide, { kind: "compare", ids: ids.filter((id) => known.has(id)) });
    if (location.hash !== canonical) {
      history.replaceState(null, "", canonical);
      syncFromLocation();
    }
  }, [guide, ids, nav]);

  const crumbs: Crumb[] = [...guideCrumbs(site, guide), { label: COMPARE }];
  return (
    <div className="cmp-page">
      <PageHead crumbs={crumbs} title={COMPARE} actions={owner ? <SaveComparison guide={guide} ids={shown} /> : undefined} />
      <div className="cmp-grid">
        {quadrants.map(({ id, system }, i) => (
          <section className="cmp-q" key={i} aria-label={`${titleOf(id)} (quadrant ${i + 1})`}>
            <div className="cmp-h">
              <select aria-label={`Diagnosis ${i + 1}`} value={id} onChange={(e) => pick(i, e.target.value)}>
                {groups.map((g) => (
                  <optgroup key={g.id} label={g.title}>
                    {g.entries.map((e) => (
                      <option key={e.id} value={e.id}>{e.title}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              {owner && (
                <FavoriteMenu
                  guide={guide}
                  id={id}
                  others={shown}
                  groups={groups}
                  onPick={fill}
                  titleOf={titleOf}
                />
              )}
              {shown.length > 1 && (
                <button type="button" className="iconbtn" aria-label={`Remove quadrant ${i + 1}`} onClick={() => go(shown.filter((_, j) => j !== i))}>
                  <Icon n="x" size={14} />
                </button>
              )}
            </div>
            <div className="cmp-body">
              {/* Her card stacked, like the phone's Stacked layout: her sections top to bottom, no sideways columns. */}
              <StackedContext.Provider value={true}>
                <TopicCard guide={guide} nav={nav} id={id} system={system} />
              </StackedContext.Provider>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
