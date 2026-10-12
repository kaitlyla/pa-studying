// Compare (40 §40.3, guide-reader/compare): up to four diagnoses of one guide side by side, one per
// quadrant, each quadrant scrolling on its own (2 x 2 on desktop, stacked on phone). A quadrant shows
// the same card a topic page shows — notes, meds panel and her own additions — read through the same
// data layer, so an unsaved or just-saved edit shows here too. The sidebar's + adds the next diagnosis;
// each quadrant has its picker and its ✕. The owner's favorites menu sits on each quadrant (saved pairs
// to compare, and every diagnosis of the guide to save, the ones on screen first), and she can save the
// quadrants as a named comparison.
import { useLayoutEffect, type ReactNode } from "react";
import type { NavJson } from "../../lib/derive/published.ts";
import { PageNotFound } from "../shell/errors.ts";
import { Icon } from "../shell/Icon.tsx";
import { FavoriteMenu, SaveComparison } from "../shell/mounts.tsx";
import { PageHead, type Crumb } from "../shell/Page.tsx";
import { useOwner } from "../shell/owner.tsx";
import { addToCompare, guideViewHash, navigate, syncFromLocation } from "../shell/route.ts";
import { COMPARE, entryTitle, guideCrumbs, useNav, useSite } from "./data.ts";
import { locateEntry, TopicCard } from "./TopicsPage.tsx";

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
  // An old `t/a,b` link parses as this view; an empty slot in it is not a quadrant, so it is dropped.
  const shown = ids.filter((x) => x !== "");
  const slots = shown.map((id) => locateEntry(nav, id));
  shown.forEach((id, i) => {
    if (slots[i] === null) throw new PageNotFound(`topic ${id}`);
  });
  const titleOf = (id: string): string => entryTitle(nav, id);
  const go = (next: string[]): void => void navigate(guideViewHash(guide, { kind: "compare", ids: next }));
  const pick = (i: number, id: string): void => go(shown.map((x, j) => (j === i ? id : x)));
  /** A saved partner goes to the next free quadrant (the same rule the sidebar's + uses). */
  const fill = (id: string): void => {
    const next = addToCompare(shown, id);
    if (next !== null) go(next);
  };

  // A multi-topic link from the old stacked page (and any empty slot) lands here; make the address the
  // canonical compare route, replacing the entry so Back leaves the comparison rather than bouncing.
  useLayoutEffect(() => {
    const canonical = guideViewHash(guide, { kind: "compare", ids: ids.filter((x) => x !== "") });
    if (location.hash !== canonical) {
      history.replaceState(null, "", canonical);
      syncFromLocation();
    }
  }, [guide, ids]);

  const crumbs: Crumb[] = [...guideCrumbs(site, guide), { label: COMPARE }];
  return (
    <div className="cmp-page">
      <PageHead crumbs={crumbs} title={COMPARE} tables actions={owner ? <SaveComparison guide={guide} ids={shown} /> : undefined} />
      <div className="cmp-grid">
        {shown.map((id, i) => {
          const at = slots[i] ?? null;
          return (
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
                    canPick={shown.length < 4}
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
              {at !== null && (
                <div className="cmp-body">
                  <TopicCard guide={guide} nav={nav} id={id} system={at.system} />
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
