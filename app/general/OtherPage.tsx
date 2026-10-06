// The Other tab (UI other-tab): a grid of sections; each section page has its lead gap block, then
// its outline (her documents shown whole, her notes, gap blocks and links, under headings the sidebar
// lists) and whatever it lists outside the outline; a section without an outline shows its links,
// files and gaps (ThreeParts). A part page (`#/other/<section>/<part>`) shows one heading's part.
// Guidelines also points to Updated guidelines.
import { Suspense, useEffect, type ReactNode } from "react";
import { OTHER_PATH, UPDATES_PATH, type OtherJson, type UpdatesJson } from "../../lib/derive/published.ts";
import { otherHash, UPDATES_ROUTE } from "../../lib/derive/routes.ts";
import { useData } from "../data/load.ts";
import { GapBlock, UpdChip } from "../render/labels.tsx";
import { PageNotFound } from "../shell/errors.ts";
import { formatDate } from "../shell/format.ts";
import { Link } from "../shell/Link.tsx";
import { AddDocument, EditControls, EditRegion } from "../shell/mounts.tsx";
import { Voice } from "../shell/owner.tsx";
import { PageHead } from "../shell/Page.tsx";
import { useRoute } from "../shell/route.ts";
import { ThreeParts } from "./ThreeParts.tsx";
import { buildPageKey } from "../edit/pageKey.ts";
import { Leftovers, OutlineItems, OutlinePartView, PartItems } from "./OtherOutline.tsx";
import { splitOutline, type Outline, type OutlinePart } from "./outline.ts";

export const GUIDELINES = "guidelines";

function UpdatesEntry(): ReactNode {
  const u = useData<UpdatesJson>(UPDATES_PATH);
  return (
    <div className="howto" data-ref="updates-entry">
      <UpdChip /> <Link to={UPDATES_ROUTE}>Updated guidelines</Link> — {u.flags.length} {u.flags.length === 1 ? "flag" : "flags"}
      {u.lastRun ? ` · last checked ${formatDate(u.lastRun, "long")}` : ""}
    </div>
  );
}

function Grid({ other }: { other: OtherJson }): ReactNode {
  return (
    <div className="other-page">
      <PageHead crumbs={[{ label: "Other" }]} title="Other" />
      <div className="ogrid">
        {other.sections.map((s) => {
          const n = s.files.files.length;
          return (
            <Link key={s.id} to={otherHash(s.id)} className="ocard">
              <b>{s.title}</b>
              <small>
                {n > 0 ? (
                  <>
                    {n} <Voice owner="of your files" visitor={n === 1 ? "file" : "files"} />
                  </>
                ) : (
                  "Sourced reference"
                )}
                {s.id === GUIDELINES ? " · updated guidelines" : ""}
              </small>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

/** A part and, for a top heading, the sub headings' parts that follow it. */
function partGroup(outline: Outline, id: string): OutlinePart[] {
  const i = outline.parts.findIndex((p) => p.id === id);
  const first = outline.parts[i];
  if (!first) return [];
  if (first.sub) return [first];
  const end = outline.parts.findIndex((p, j) => j > i && !p.sub);
  return outline.parts.slice(i, end === -1 ? undefined : end);
}

/** Scrolls to the route's `at` anchor (a sidebar sub-entry); with a search query, search landing scrolls instead. */
function useLandAt(): void {
  const { at, q } = useRoute().query;
  useEffect(() => {
    if (!at || q) return;
    document.querySelector(`.other-page [data-anchor="${CSS.escape(at)}"]`)?.scrollIntoView?.({ block: "start" });
  }, [at, q]);
}

export function OtherPage({ section: id, part = null }: { section: string | null; part?: string | null }): ReactNode {
  const other = useData<OtherJson>(OTHER_PATH);
  useLandAt();
  if (id === null) return <Grid other={other} />;
  const s = other.sections.find((x) => x.id === id);
  if (!s) throw new PageNotFound(`other/${id}`);
  const outline = splitOutline(s.notes);
  const shown = part === null ? null : partGroup(outline, part);
  if (shown !== null && shown.length === 0) throw new PageNotFound(`other/${id}/${part}`);
  const pageKey = buildPageKey("other", s.id);
  const from = otherHash(s.id, part);
  const head = shown?.[0];
  return (
    <div className="other-page">
      <PageHead
        crumbs={head ? [{ label: "Other", to: otherHash() }, { label: s.title, to: otherHash(s.id) }, { label: head.title }] : [{ label: "Other", to: otherHash() }, { label: s.title }]}
        title={head ? head.title : s.title}
        tables
        actions={
          <>
            {!head && <AddDocument place={{ kind: "other", section: s.id }} title={s.title} />}
            <EditControls pageKey={pageKey} title={s.title} />
          </>
        }
      />
      {!head && s.id === GUIDELINES && (
        <Suspense fallback={null}>
          <UpdatesEntry />
        </Suspense>
      )}
      <EditRegion pageKey={pageKey} title={s.title}>
        {shown ? (
          shown.map((p, i) => (i === 0 ? <PartItems key={p.id} part={p} from={from} /> : <OutlinePartView key={p.id} part={p} from={from} />))
        ) : s.notes.length > 0 ? (
          <>
            {s.lead && <GapBlock gap={s.lead} />}
            <OutlineItems items={outline.intro} from={from} />
            {outline.parts.map((p) => (
              <OutlinePartView key={p.id} part={p} from={from} />
            ))}
            <Leftovers section={s} />
          </>
        ) : (
          <ThreeParts links={s.links} files={s.files} gaps={s.gaps} lead={s.lead} notes={[]} coveredFor={s.title} />
        )}
      </EditRegion>
    </div>
  );
}
