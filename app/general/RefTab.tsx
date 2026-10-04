// Reference tabs (Labs, Imaging, EKG, Anatomy; UI reference-tab): a landing page with the tab's topics
// and files, and a page per topic in the three-part layout. The sidebar lists topics, then files.
import type { ReactNode } from "react";
import { refPath, type RefTabJson } from "../../lib/derive/published.ts";
import { TAB_LABELS, type RefTabId } from "../../lib/derive/routes.ts";
import { useData } from "../data/load.ts";
import { FileChips } from "../files/FileChip.tsx";
import { Txt } from "../render/Text.tsx";
import { PageNotFound } from "../shell/errors.ts";
import { Link } from "../shell/Link.tsx";
import { AddDocument, EditControls, EditRegion } from "../shell/mounts.tsx";
import { Voice } from "../shell/owner.tsx";
import { PageHead } from "../shell/Page.tsx";
import { fileHash, refHash, useRoute } from "../shell/route.ts";
import { ThreeParts } from "./ThreeParts.tsx";

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
  const pageKey = `ref:${tab}:${sub.id}`;
  return (
    <div className="ref-page">
      <PageHead crumbs={[{ label, to: refHash(tab) }, { label: sub.title }]} title={<Txt text={sub.title} />} actions={<EditControls pageKey={pageKey} title={sub.title} />} />
      <EditRegion pageKey={pageKey} title={sub.title}>
        <ThreeParts links={sub.links} files={{ files: [], removed: [], pending: [] }} gaps={sub.gaps} />
      </EditRegion>
    </div>
  );
}
