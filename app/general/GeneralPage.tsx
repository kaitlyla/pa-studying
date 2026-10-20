// An EOR's general topic (general-topic): "<Label> for <EOR>", the how-to pointer when the subject
// isn't prominent in the EOR, then the three parts.
import type { ReactNode } from "react";
import type { GeneralKey } from "../../lib/content/types.ts";
import { generalPath, refPath, type GeneralJson, type RefTabJson } from "../../lib/derive/published.ts";
import { isRefTab, refHash, TAB_LABELS, type RefTabId } from "../../lib/derive/routes.ts";
import { useData } from "../data/load.ts";
import { guideCrumbs, guideName, useSite } from "../reader/data.ts";
import { Link } from "../shell/Link.tsx";
import { FileChips } from "../files/FileChip.tsx";
import { AddDocument, EditControls, EditRegion } from "../shell/mounts.tsx";
import { Voice } from "../shell/owner.tsx";
import { PageHead } from "../shell/Page.tsx";
import { ThreeParts } from "./ThreeParts.tsx";
import { VisitsPage } from "./VisitsPage.tsx";
import { WorkupPage } from "./WorkupPage.tsx";
import { buildPageKey } from "../edit/pageKey.ts";

/** "Only what <EOR> needs is shown here. Full how-to: <Tab> tab › how to interpret". */
function HowTo({ tab, eor }: { tab: RefTabId; eor: string }): ReactNode {
  const ref = useData<RefTabJson>(refPath(tab));
  const sub = ref.subs.find((s) => /how to/i.test(s.title));
  return (
    <div className="howto">
      Only what {eor} needs is shown here. Full how-to: <Link to={refHash(tab, sub?.id ?? null)}>{TAB_LABELS[tab]} tab › how to interpret</Link>
    </div>
  );
}

function GeneralTopic({ guide, topic: key }: { guide: string; topic: GeneralKey }): ReactNode {
  const site = useSite();
  const data = useData<GeneralJson>(generalPath(guide, key));
  const name = guideName(site, guide);
  const title = `${data.label} for ${name}`;
  const pageKey = buildPageKey("general", guide, key);
  return (
    <div className="general-page">
      <PageHead
        crumbs={[...guideCrumbs(site, guide), { label: data.label }]}
        title={
          <>
            {data.label} <span className="h-sub">for {name}</span>
          </>
        }
        actions={<EditControls pageKey={pageKey} title={title} />}
      />
      <EditRegion pageKey={pageKey} title={title}>
        <ThreeParts
          links={data.links}
          files={data.files}
          gaps={data.gaps}
          coveredFor={name}
          howto={data.howto && isRefTab(data.howto) ? <HowTo tab={data.howto} eor={name} /> : null}
        />
      </EditRegion>
    </div>
  );
}

/** Reference tables: only her files, with "+ Add document" for the owner. */
function TablesTopic({ guide }: { guide: string }): ReactNode {
  const site = useSite();
  const data = useData<GeneralJson>(generalPath(guide, "tables"));
  const name = guideName(site, guide);
  const n = data.files.files.length;
  return (
    <div className="general-page">
      <PageHead
        crumbs={[...guideCrumbs(site, guide), { label: data.label }]}
        title={
          <>
            {data.label} <span className="h-sub">for {name}</span>
          </>
        }
        actions={<AddDocument place={{ kind: "general", guide, key: "tables" }} title={`${data.label} for ${name}`} />}
      />
      <div className="gsec">
        <h2>
          <Voice owner="Your files" visitor="Files" /> <span className="n">{n}</span>
        </h2>
        {n === 0 && <p className="lead">No files yet.</p>}
        <FileChips list={data.files} />
      </div>
    </div>
  );
}

export function GeneralPage({ guide, topic }: { guide: string; topic: GeneralKey }): ReactNode {
  if (topic === "tables") return <TablesTopic guide={guide} />;
  if (topic === "workup") return <WorkupPage guide={guide} item={null} />;
  if (topic === "visits") return <VisitsPage guide={guide} item={null} />;
  return <GeneralTopic guide={guide} topic={topic} />;
}
