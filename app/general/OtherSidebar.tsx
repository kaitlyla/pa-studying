// The Other tab's sidebar, laid out like the guide sidebar (Sidebar.tsx): every Other section as a
// group row; a section with an outline opens to its headings, and a heading with sub-entries (its sub
// headings, or the documents, gap blocks and table columns of its part) opens to those.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { OTHER_PATH, type OtherJson } from "../../lib/derive/published.ts";
import { useData } from "../data/load.ts";
import { GroupRow } from "../reader/Sidebar.tsx";
import { Txt } from "../render/Text.tsx";
import { Link } from "../shell/Link.tsx";
import { UPDATES_ROUTE } from "../../lib/derive/routes.ts";
import { otherHash, parseHash, useRoute, type Route } from "../shell/route.ts";
import { entryHash, sidebarEntries, splitOutline, type SidebarEntry } from "./outline.ts";

export const OTHER_LABEL = "Other";
export const SECTIONS_HEADING = "Sections";

/** Where the current page sits in the Other tab; a file page counts from where it was opened. */
interface Current {
  section: string | null;
  part: string | null;
  at: string | null;
}

function currentOf(route: Route): Current {
  const r = route.kind === "file" && route.query.from ? parseHash(route.query.from) : route;
  if (r.kind === "other") return { section: r.section, part: r.part, at: r.query.at };
  if (r.kind === "updates") return { section: "guidelines", part: null, at: null };
  return { section: null, part: null, at: null };
}

interface Toggle {
  open: boolean;
  /** The route the toggle was made on: on another route, the current page's groups open again. */
  path: string;
}

function useExpansion(path: string, auto: ReadonlySet<string>): [(key: string) => boolean, (key: string, open: boolean) => void] {
  const [toggles, setToggles] = useState<Record<string, Toggle>>({});
  const isOpen = (key: string): boolean => {
    const t = toggles[key];
    if (auto.has(key) && (!t || t.path !== path)) return true;
    return t?.open ?? false;
  };
  return [isOpen, (key, open) => setToggles((x) => ({ ...x, [key]: { open, path } }))];
}

const secKey = (s: string): string => `s:${s}`;
const partKey = (s: string, p: string): string => `p:${s}:${p}`;

function EntryLink({ to, title, open, onNavigate }: { to: string; title: string; open: boolean; onNavigate: () => void }): ReactNode {
  return (
    <div className="ent-row">
      <Link to={to} className={`ent${open ? " open" : ""}`} aria-current={open ? "page" : undefined} title={title} onClick={onNavigate}>
        <span className="ent-t">
          <Txt text={title} />
        </span>
      </Link>
    </div>
  );
}

interface EntryProps {
  section: string;
  entry: SidebarEntry;
  cur: Current;
  isOpen: (key: string) => boolean;
  setOpen: (key: string, open: boolean) => void;
  onNavigate: () => void;
}

function OutlineEntry({ section, entry: e, cur, isOpen, setOpen, onNavigate }: EntryProps): ReactNode {
  const here = cur.section === section;
  if (e.children.length === 0) {
    return (
      <li>
        <EntryLink to={entryHash(section, e.id)} title={e.title} open={here && cur.part === e.id} onNavigate={onNavigate} />
      </li>
    );
  }
  const k = partKey(section, e.id);
  const open = isOpen(k);
  return (
    <li className="grp">
      <GroupRow
        className="ent-row grp-row"
        label={<Txt text={e.title} />}
        plain={e.title}
        to={entryHash(section, e.id)}
        open={open}
        current={here && cur.part === e.id && cur.at === null}
        count={e.children.length}
        onToggle={(o) => setOpen(k, o)}
        onNavigate={onNavigate}
      />
      {open && (
        <ul className="ents grp-ents">
          {e.children.map((c) => {
            const on = here && (c.part ? cur.part === c.id : cur.part === e.id && cur.at === c.id);
            return (
              <li key={c.id}>
                <EntryLink to={c.part ? entryHash(section, c.id) : entryHash(section, e.id, c.id)} title={c.title} open={on} onNavigate={onNavigate} />
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

export function OtherSidebar({ onNavigate }: { onNavigate: () => void }): ReactNode {
  const other = useData<OtherJson>(OTHER_PATH);
  const route = useRoute();
  const cur = currentOf(route);
  const outlines = other.sections.map((s) => ({ s, entries: sidebarEntries(splitOutline(s.notes)) }));
  const auto = new Set<string>();
  for (const { s, entries } of outlines) {
    if (s.id !== cur.section) continue;
    auto.add(secKey(s.id));
    for (const e of entries) if (e.id === cur.part || e.children.some((c) => c.part && c.id === cur.part)) auto.add(partKey(s.id, e.id));
  }
  const [isOpen, setOpen] = useExpansion(route.path, auto);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.querySelector(".open, .cur")?.scrollIntoView?.({ block: "nearest" });
  }, [route.path]);

  return (
    <div className="side-in" ref={root}>
      <div className="side-top">
        <Link to={otherHash()} className="gname" onClick={onNavigate}>
          {OTHER_LABEL}
        </Link>
      </div>
      <div className="side-sec">{SECTIONS_HEADING}</div>
      <div>
        {outlines.map(({ s, entries }) => {
          const k = secKey(s.id);
          const open = isOpen(k);
          const current = cur.section === s.id && cur.part === null && route.path !== UPDATES_ROUTE;
          return (
            <div key={s.id} className="sys">
              {entries.length > 0 ? (
                <GroupRow
                  className="sys-row"
                  label={<Txt text={s.title} />}
                  plain={s.title}
                  to={otherHash(s.id)}
                  open={open}
                  current={current}
                  onToggle={(o) => setOpen(k, o)}
                  onNavigate={onNavigate}
                />
              ) : (
                <div className="sys-row">
                  <span className="sys-tog" aria-hidden="true" />
                  <Link to={otherHash(s.id)} className={`sys-name${current ? " cur" : ""}`} aria-current={current ? "page" : undefined} onClick={onNavigate}>
                    <span className="ent-t">
                      <Txt text={s.title} />
                    </span>
                  </Link>
                </div>
              )}
              {open && entries.length > 0 && (
                <ul className="ents">
                  {entries.map((e) => (
                    <OutlineEntry key={e.id} section={s.id} entry={e} cur={cur} isOpen={isOpen} setOpen={setOpen} onNavigate={onNavigate} />
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
