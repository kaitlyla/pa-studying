// Guide home (40 §40.3, ruling D4): the title, the PDF menu, whatever comes before her first system
// heading rendered as her notes with no label, then the system list with percentages.
import type { ReactNode } from "react";
import { homePath, type HomeJson } from "../../lib/derive/published.ts";
import { useData } from "../data/load.ts";
import { UpdateNotes } from "../render/labels.tsx";
import { Link } from "../shell/Link.tsx";
import { PageHead } from "../shell/Page.tsx";
import { guideViewHash, PANCE } from "../shell/route.ts";
import { Txt } from "../render/Text.tsx";
import { NotesBlock } from "./blocks.tsx";
import { guideFile, guideName, useNav, useSite } from "./data.ts";
import { PdfMenu } from "./PdfMenu.tsx";

export function GuideHome({ guide }: { guide: string }): ReactNode {
  const site = useSite();
  const nav = useNav(guide);
  const home = useData<HomeJson>(homePath(guide));
  const crumbs = guide === PANCE ? [{ label: "PANCE" }] : [{ label: "EOR", to: "#/eor" }, { label: guideName(site, guide) }];
  return (
    <div className="guide-home">
      <PageHead
        crumbs={crumbs}
        title={guide === PANCE ? "PANCE / EOC Study Guide" : guideFile(nav)}
        actions={<PdfMenu site={site} guide={guide} nav={nav} />}
        tables={home.preamble.some((b) => b.kind === "table")}
      />
      {home.preamble.map((b) => (
        <div key={b.id}>
          <UpdateNotes notes={home.notes[b.id]} />
          <NotesBlock block={b} basePt={nav.basePt} />
        </div>
      ))}
      <ul className="lnk">
        {home.systems.map((s) => (
          <li key={s.id}>
            <Link to={guideViewHash(guide, { kind: "system", system: s.id })}>
              <span className="lt">
                <Txt text={s.title} />
              </span>
              {s.pct && <span className="ll">{s.pct}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
