// The guide sidebar (browse/tabs/rules/sidebar, guide-reader/system-open, long-titles, compare):
// systems with their sections and entries, each system's pharm row, general topics and the review
// slides (EOR), or "All systems" and its last document (PANCE).
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { NavEntry, NavJson, NavSystem } from "../../lib/derive/published.ts";
import { Icon } from "../shell/Icon.tsx";
import { Link } from "../shell/Link.tsx";
import { PendingDocs, RemovedDocs } from "../shell/mounts.tsx";
import { fileHash, guideBase, guideViewHash, PANCE, useRoute, type GuideView, type Route } from "../shell/route.ts";
import { Txt } from "../render/Text.tsx";
import { systemsHeading, useNav, useSite, guideName } from "./data.ts";

/** What the current route has open in this guide. */
interface Current {
  view: GuideView | null;
  /** Open topic ids (topics view). */
  ids: readonly string[];
  /** The document open on a file page opened from this guide. */
  file: string | null;
}

/**
 * The `from` a sidebar file link carries: the current route, except on a file page, where it keeps
 * the page's own `from` (or the guide), so re-opening the file keeps its sidebar and Back target.
 */
export function sidebarFrom(route: Route, guide: string): string {
  if (route.kind === "file") return route.query.from ?? guideBase(guide);
  return route.path;
}

function currentOf(route: Route, guide: string): Current {
  if (route.kind === "guide" && route.guide === guide) {
    return { view: route.view, ids: route.view.kind === "topics" ? route.view.ids : [], file: null };
  }
  if (route.kind === "file") return { view: null, ids: [], file: route.doc };
  return { view: null, ids: [], file: null };
}

const sysKey = (s: string): string => `s:${s}`;
const secKey = (s: string, sec: string): string => `g:${s}:${sec}`;
const pharmKey = (s: string): string => `ph:${s}`;

/** The groups the current page lives in: they open automatically. */
function autoOpen(nav: NavJson, cur: Current): Set<string> {
  const out = new Set<string>();
  const v = cur.view;
  if (!v) return out;
  if (v.kind === "system") out.add(sysKey(v.system));
  if (v.kind === "section") {
    out.add(sysKey(v.system));
    out.add(secKey(v.system, v.section));
  }
  if (v.kind === "pharm") out.add(pharmKey(v.system));
  if (v.kind === "topics" || v.kind === "block") {
    const ids = v.kind === "topics" ? v.ids : [v.id];
    for (const s of nav.systems) {
      if (s.entries.some((e) => ids.includes(e.id))) out.add(sysKey(s.id));
      for (const sec of s.sections) {
        if (sec.entries.some((e) => ids.includes(e.id))) {
          out.add(sysKey(s.id));
          out.add(secKey(s.id, sec.id));
        }
      }
    }
  }
  return out;
}

interface Toggle {
  open: boolean;
  /** The route the toggle was made on: on another route, auto-open wins again. */
  path: string;
}

function useExpansion(nav: NavJson, cur: Current, path: string): [(key: string) => boolean, (key: string, open: boolean) => void] {
  const [toggles, setToggles] = useState<Record<string, Toggle>>({});
  const auto = autoOpen(nav, cur);
  const isOpen = (key: string): boolean => {
    const t = toggles[key];
    if (auto.has(key) && (!t || t.path !== path)) return true;
    return t?.open ?? false;
  };
  const set = (key: string, open: boolean): void => setToggles((x) => ({ ...x, [key]: { open, path } }));
  return [isOpen, set];
}

interface EntryProps {
  guide: string;
  entry: NavEntry;
  cur: Current;
  onNavigate: () => void;
}

function Entry({ guide, entry, cur, onNavigate }: EntryProps): ReactNode {
  const v = cur.view;
  const open = entry.kind === "topic" ? cur.ids.includes(entry.id) : v?.kind === "block" && v.id === entry.id;
  const to = entry.kind === "topic" ? guideViewHash(guide, { kind: "topics", ids: [entry.id] }) : guideViewHash(guide, { kind: "block", id: entry.id });
  return (
    <li>
      <div className="ent-row">
        <Link
          to={to}
          className={`ent${open ? " open" : ""}${entry.kind === "block" ? " blk" : ""}`}
          aria-current={open ? "page" : undefined}
          title={entry.title}
          onClick={onNavigate}
        >
          {entry.kind === "block" && (
            <span className="blk-mark" aria-hidden="true">
              ¶
            </span>
          )}
          <span className="ent-t">
            <Txt text={entry.title} />
          </span>
        </Link>
        {entry.kind === "topic" && !open && (
          <Link
            to={guideViewHash(guide, { kind: "topics", ids: [...cur.ids, entry.id] })}
            className="alongside"
            aria-label={`Open ${entry.title} alongside`}
            title="Open alongside"
            onClick={onNavigate}
          >
            <Icon n="plus" size={14} />
          </Link>
        )}
      </div>
    </li>
  );
}

interface GroupRowProps {
  label: ReactNode;
  plain: string;
  to: string;
  open: boolean;
  current: boolean;
  count?: number;
  pct?: string;
  pill?: boolean;
  onToggle: (open: boolean) => void;
  onNavigate: () => void;
  className: string;
}

/** A row with an expand arrow and a name that opens the group's page (and expands it). */
function GroupRow({ label, plain, to, open, current, count, pct, pill, onToggle, onNavigate, className }: GroupRowProps): ReactNode {
  return (
    <div className={className}>
      <button type="button" className="sys-tog" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${plain}`} onClick={() => onToggle(!open)}>
        <Icon n="chev" size={12} />
      </button>
      <Link
        to={to}
        className={`sys-name${current ? " cur" : ""}`}
        aria-current={current ? "page" : undefined}
        title={plain}
        onClick={() => {
          onToggle(true);
          onNavigate();
        }}
      >
        {pill && <Icon n="pill" size={14} />}
        <span className="ent-t">{label}</span>
        {count !== undefined && <span className="grp-n">{count}</span>}
        {pct && <span className="pct">{pct}</span>}
      </Link>
    </div>
  );
}

interface SystemProps {
  guide: string;
  system: NavSystem;
  cur: Current;
  isOpen: (key: string) => boolean;
  setOpen: (key: string, open: boolean) => void;
  onNavigate: () => void;
}

function SystemItem({ guide, system: s, cur, isOpen, setOpen, onNavigate }: SystemProps): ReactNode {
  const v = cur.view;
  const k = sysKey(s.id);
  const open = isOpen(k);
  const pk = pharmKey(s.id);
  const pOpen = isOpen(pk);
  return (
    <div className="sys">
      <GroupRow
        className="sys-row"
        label={<Txt text={s.title} />}
        plain={s.title}
        to={guideViewHash(guide, { kind: "system", system: s.id })}
        open={open}
        current={v?.kind === "system" && v.system === s.id}
        pct={s.pct}
        onToggle={(o) => setOpen(k, o)}
        onNavigate={onNavigate}
      />
      {open && (
        <ul className="ents">
          {s.sections.map((sec) => {
            const gk = secKey(s.id, sec.id);
            const gOpen = isOpen(gk);
            return (
              <li key={sec.id} className="grp">
                <GroupRow
                  className="ent-row grp-row"
                  label={sec.title}
                  plain={sec.title}
                  to={guideViewHash(guide, { kind: "section", system: s.id, section: sec.id })}
                  open={gOpen}
                  current={v?.kind === "section" && v.system === s.id && v.section === sec.id}
                  count={sec.entries.length}
                  onToggle={(o) => setOpen(gk, o)}
                  onNavigate={onNavigate}
                />
                {gOpen && (
                  <ul className="ents grp-ents">
                    {sec.entries.map((e) => (
                      <Entry key={e.id} guide={guide} entry={e} cur={cur} onNavigate={onNavigate} />
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
          {s.entries.map((e) => (
            <Entry key={e.id} guide={guide} entry={e} cur={cur} onNavigate={onNavigate} />
          ))}
        </ul>
      )}
      {s.pharm && (
        <div className="sys ph-sys">
          <GroupRow
            className="sys-row"
            label={`${s.title} pharm`}
            plain={`${s.title} pharm`}
            to={guideViewHash(guide, { kind: "pharm", system: s.id, section: null, target: null })}
            open={pOpen}
            current={v?.kind === "pharm" && v.system === s.id && v.section === null}
            pill
            onToggle={(o) => setOpen(pk, o)}
            onNavigate={onNavigate}
          />
          {pOpen && (
            <ul className="ents">
              {s.pharm.sections.map((p) => {
                const on = v?.kind === "pharm" && v.system === s.id && v.section === p.id;
                return (
                  <li key={p.id}>
                    <div className="ent-row">
                      <Link
                        to={guideViewHash(guide, { kind: "pharm", system: s.id, section: p.id, target: null })}
                        className={`ent${on ? " open" : ""}`}
                        aria-current={on ? "page" : undefined}
                        title={p.title}
                        onClick={onNavigate}
                      >
                        <span className="ent-t">{p.title}</span>
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** The review deck's sidebar label: her own Psychiatry deck, or the generated deck's title. */
export function slidesLabel(guide: string, nav: NavJson): string | null {
  if (!nav.slides) return null;
  return guide === "psy" ? "Psych review slides" : nav.slides.title;
}

export function GuideSidebar({ guide, onNavigate }: { guide: string; onNavigate: () => void }): ReactNode {
  const nav = useNav(guide);
  const site = useSite();
  const route = useRoute();
  const cur = currentOf(route, guide);
  const [isOpen, setOpen] = useExpansion(nav, cur, route.path);
  const root = useRef<HTMLDivElement>(null);
  const v = cur.view;

  useEffect(() => {
    root.current?.querySelector(".open, .cur")?.scrollIntoView?.({ block: "nearest" });
  }, [route.path]);

  const slides = slidesLabel(guide, nav);
  const here = sidebarFrom(route, guide);
  return (
    <div className="side-in" ref={root}>
      <div className="side-top">
        {guide === PANCE ? (
          <div className="gname">PANCE / EOC study guide</div>
        ) : (
          <>
            <span className="side-label">EOR</span>
            <Link to={guideBase(guide)} className="gname" onClick={onNavigate}>
              {guideName(site, guide)}
            </Link>
          </>
        )}
      </div>
      <div className="side-sec">{systemsHeading(guide)}</div>
      <div>
        {nav.systems.map((s) => (
          <SystemItem key={s.id} guide={guide} system={s} cur={cur} isOpen={isOpen} setOpen={setOpen} onNavigate={onNavigate} />
        ))}
      </div>
      {(nav.general.length > 0 || slides) && (
        <>
          <div className="side-sec">General topics</div>
          <ul className="gen">
            {nav.general.map((g) => {
              const on = g.key === "workup" ? v?.kind === "workup" : v?.kind === "general" && v.key === g.key;
              const to = g.key === "workup" ? guideViewHash(guide, { kind: "workup", item: null }) : guideViewHash(guide, { kind: "general", key: g.key });
              return (
                <li key={g.key}>
                  <div className="ent-row">
                    <Link to={to} className={`ent${on ? " open" : ""}`} aria-current={on ? "page" : undefined} onClick={onNavigate}>
                      {g.label}
                    </Link>
                  </div>
                </li>
              );
            })}
            {slides && (
              <li>
                <div className="ent-row">
                  <Link
                    to={guideViewHash(guide, { kind: "slides", n: 1 })}
                    className={`ent${v?.kind === "slides" ? " open" : ""}`}
                    aria-current={v?.kind === "slides" ? "page" : undefined}
                    onClick={onNavigate}
                  >
                    {slides}
                  </Link>
                </div>
              </li>
            )}
          </ul>
          {guide !== PANCE && (
            <div className="side-docs">
              <RemovedDocs items={nav.removed} />
              <PendingDocs items={nav.pending} />
            </div>
          )}
        </>
      )}
      {nav.sidebarEnd && (
        <>
          <div className="side-sec">All systems</div>
          <ul className="gen">
            <li>
              <div className="ent-row">
                <Link
                  to={fileHash(nav.sidebarEnd.id, here)}
                  className={`ent${cur.file === nav.sidebarEnd.id ? " open" : ""}`}
                  aria-current={cur.file === nav.sidebarEnd.id ? "page" : undefined}
                  onClick={onNavigate}
                >
                  <Icon n="pill" size={13} /> <Txt text={nav.sidebarEnd.name} />
                </Link>
              </div>
            </li>
          </ul>
        </>
      )}
      {guide === PANCE && (
        <div className="side-docs">
          <RemovedDocs items={nav.removed} />
          <PendingDocs items={nav.pending} />
        </div>
      )}
    </div>
  );
}
