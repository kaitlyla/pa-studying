// The EOR picker (eor-picker): one card per rotation, in picker order.
import type { ReactNode } from "react";
import type { SiteJson } from "../../lib/derive/published.ts";
import { useData } from "../data/load.ts";
import { Link } from "../shell/Link.tsx";
import { guideBase } from "../shell/route.ts";
import { systemsWord } from "../reader/data.ts";

export function Picker(): ReactNode {
  const site = useData<SiteJson>("site.json");
  return (
    <div className="pick">
      <h1>EOR study guides</h1>
      <p>Choose a rotation.</p>
      <div className="cards">
        {site.eors.map((e) => (
          <Link key={e.id} to={guideBase(e.id)} className="card">
            <span className="cn">{e.name}</span>
            <span className="cm">
              {e.systems.length} {systemsWord(e.id, e.systems.length)} · {e.general} general {e.general === 1 ? "topic" : "topics"}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
