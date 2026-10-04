// The Updated guidelines list and source status (80 §80.5).
import type { ReactNode } from "react";
import type { PubFlag, UpdatesJson } from "../../lib/derive/published.ts";
import { useData } from "../data/load.ts";
import { UpdateNote, UpdChip } from "../render/labels.tsx";
import { Txt } from "../render/Text.tsx";
import { formatDate } from "../shell/format.ts";
import { Icon } from "../shell/Icon.tsx";
import { Link } from "../shell/Link.tsx";
import { PageHead } from "../shell/Page.tsx";

/** The fixed sources in 80 §80.3 order, with their names (80 §80.5). */
export const FIXED_SOURCES: readonly { id: string; name: string }[] = [
  { id: "uspstf", name: "USPSTF recommendations" },
  { id: "cpr", name: "AHA CPR & ECC (ACLS) guidelines" },
  { id: "hf", name: "ACC/AHA/HFSA heart failure guideline" },
  { id: "ada", name: "ADA Standards of Care in Diabetes" },
  { id: "gold", name: "GOLD report (COPD)" },
  { id: "gina", name: "GINA report (asthma)" },
];

function EditionNote({ flag }: { flag: PubFlag }): ReactNode {
  return (
    <aside className="upd" aria-label="New edition published" data-anchor={flag.id}>
      <div className="upd-h">
        <UpdChip />
        <span className="ut">New edition published</span>
      </div>
      <div className="ut">
        <Txt text={flag.guideline} />
      </div>
      <div className="um">
        <Txt text={flag.org} /> · Detected {formatDate(flag.flagged)}
      </div>
      {/^https?:\/\//.test(flag.url) && (
        <a href={flag.url} target="_blank" rel="noopener noreferrer">
          Open the guideline <Icon n="ext" size={11} />
        </a>
      )}
    </aside>
  );
}

function Entry({ flag }: { flag: PubFlag }): ReactNode {
  if (flag.kind === "edition") {
    return (
      <div className="upd-entry">
        <EditionNote flag={flag} />
      </div>
    );
  }
  return (
    <div className="upd-entry">
      <UpdateNote note={flag} />
      {flag.addedTo.length > 0 && (
        <div className="added">
          Added to:
          <ul>
            {flag.addedTo.map((p, i) => (
              <li key={i}>
                <Link to={p.route}>{p.loc}</Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function sourceStatus(s: UpdatesJson["sources"][number], lastRun: string | null): string {
  if (s.status === "ok") return `Checked ${formatDate(s.lastSuccess)}`;
  const first = `Couldn't be checked on ${formatDate(lastRun ?? s.lastAttempt)}.`;
  return s.lastSuccess ? `${first} Last successful check ${formatDate(s.lastSuccess)}. Will retry next month.` : `${first} Will retry next month.`;
}

export function UpdatesPage(): ReactNode {
  const u = useData<UpdatesJson>("updates.json");
  const byId = new Map(u.sources.map((s) => [s.id, s]));
  const rows = [...FIXED_SOURCES.map((f) => ({ id: f.id, name: f.name })), ...u.series.map((s) => ({ id: s.id, name: s.label }))];
  return (
    <div className="updates-page">
      <PageHead
        crumbs={[
          { label: "Other", to: "#/other" },
          { label: "Guidelines", to: "#/other/guidelines" },
          { label: "Updated guidelines" },
        ]}
        title="Updated guidelines"
      />
      <p className="lead">
        Checked once a month against the tracked sources. Last check: <b>{u.lastRun ? formatDate(u.lastRun, "long") : "not yet"}</b>
        {u.nextRun ? ` · next: ${formatDate(u.nextRun, "long")}` : ""}. Newest first.
      </p>
      {u.flags.map((f) => (
        <Entry key={f.id} flag={f} />
      ))}
      <div className="gsec">
        <h2>Sources checked</h2>
        <table className="ustat">
          <tbody>
            {rows.map((r) => {
              const s = byId.get(r.id);
              return (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td className={s?.status === "fail" ? "st-fail" : "st-ok"}>{s ? sourceStatus(s, u.lastRun) : "Not checked yet"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
