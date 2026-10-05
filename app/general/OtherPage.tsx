// The Other tab (UI other-tab): a grid of sections; each section page has its lead gap block, its
// links and files, and (Screenings, Legal, Physical exam, Documentation) its gaps. Guidelines also points to Updated guidelines.
import { Suspense, type ReactNode } from "react";
import { OTHER_PATH, UPDATES_PATH, type OtherJson, type UpdatesJson } from "../../lib/derive/published.ts";
import { otherHash, UPDATES_ROUTE } from "../../lib/derive/routes.ts";
import { useData } from "../data/load.ts";
import { UpdChip } from "../render/labels.tsx";
import { PageNotFound } from "../shell/errors.ts";
import { formatDate } from "../shell/format.ts";
import { Link } from "../shell/Link.tsx";
import { AddDocument, EditControls, EditRegion } from "../shell/mounts.tsx";
import { Voice } from "../shell/owner.tsx";
import { PageHead } from "../shell/Page.tsx";
import { ThreeParts } from "./ThreeParts.tsx";
import { buildPageKey } from "../edit/pageKey.ts";

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

export function OtherPage({ section: id }: { section: string | null }): ReactNode {
  const other = useData<OtherJson>(OTHER_PATH);
  if (id === null) return <Grid other={other} />;
  const s = other.sections.find((x) => x.id === id);
  if (!s) throw new PageNotFound(`other/${id}`);
  const pageKey = buildPageKey("other", s.id);
  return (
    <div className="other-page">
      <PageHead
        crumbs={[{ label: "Other", to: otherHash() }, { label: s.title }]}
        title={s.title}
        actions={
          <>
            <AddDocument place={{ kind: "other", section: s.id }} title={s.title} />
            <EditControls pageKey={pageKey} title={s.title} />
          </>
        }
      />
      {s.id === GUIDELINES && (
        <Suspense fallback={null}>
          <UpdatesEntry />
        </Suspense>
      )}
      <EditRegion pageKey={pageKey} title={s.title}>
        <ThreeParts links={s.links} files={s.files} gaps={s.gaps} lead={s.lead} coveredFor={s.title} />
      </EditRegion>
    </div>
  );
}
