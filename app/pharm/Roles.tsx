// A meds-panel entry's role labels (content MedsFile `roles`): chips on the entry's header, each
// naming its sources on hover, and the same labels spelled out with their sources inside the open
// entry, so the source shows without hover too.
import type { ReactNode } from "react";
import type { MedsRole, MedsRoleTag } from "../../lib/content/types.ts";
import { Icon } from "../shell/Icon.tsx";
import { Txt } from "../render/Text.tsx";

export const ROLE_LABELS: Record<MedsRole, string> = { "1st": "1st-line", "2nd": "2nd-line", alt: "Alternative", adjunct: "Adjunct" };

const isWebUrl = (u: string | null): u is string => u !== null && /^https?:\/\//.test(u);

/** One source as "Name, Org (Year)", leaving out an empty org or year. */
export function sourceLabel(s: MedsRoleTag["sources"][number]): string {
  return [s.name, s.org].filter((x) => x !== "").join(", ") + (s.year ? ` (${s.year})` : "");
}

/** A role's sources as one line: "Name, Org (Year); …". */
export function roleSources(tag: MedsRoleTag): string {
  return tag.sources.map(sourceLabel).join("; ");
}

/** A role's label with the drugs it names: "1st-line: methimazole". */
export function roleText(tag: MedsRoleTag): string {
  return tag.drugs === null ? ROLE_LABELS[tag.role] : `${ROLE_LABELS[tag.role]}: ${tag.drugs}`;
}

/** The chips on an entry's header; nothing when it has no role labels. */
export function RoleChips({ roles }: { roles: readonly MedsRoleTag[] }): ReactNode {
  if (roles.length === 0) return null;
  return (
    <span className="rolecs">
      {roles.map((r, i) => (
        <span key={i} className={`rolec r-${r.role}`} title={`Source: ${roleSources(r)}`}>
          {roleText(r)}
        </span>
      ))}
    </span>
  );
}

/** The role labels inside the open entry, each with its note and sources. */
export function RoleLines({ roles }: { roles: readonly MedsRoleTag[] }): ReactNode {
  if (roles.length === 0) return null;
  return (
    <ul className="rolels">
      {roles.map((r, i) => (
        <li key={i}>
          <b>
            <Txt text={roleText(r)} />
          </b>
          {r.note !== null && (
            <>
              {" "}
              — <Txt text={r.note} />
            </>
          )}
          <span className="rsrc">
            {" "}
            · Source:{" "}
            {r.sources.map((s, j) => (
              <span key={j}>
                {j > 0 && "; "}
                <Txt text={sourceLabel(s)} />
                {isWebUrl(s.url) && (
                  <>
                    {" "}
                    <a href={s.url} target="_blank" rel="noopener noreferrer" aria-label={`Open source: ${s.name}`}>
                      <Icon n="ext" size={11} />
                    </a>
                  </>
                )}
              </span>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}
