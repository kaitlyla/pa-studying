// Pharm pages (40 §40.5, UI pharm). With no section chosen: the system pharm page (lead line, the
// list of pharm sections with what they treat, pharm files). With a section: Treats chips, her guide's
// drug tables in full, then her pharm notes by drug class as collapsible cards, then pharm files.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { PubPharmSection, SiteJson, SystemJson } from "../../lib/derive/published.ts";
import { allLinesHidden, hiddenLines, tableRows } from "../../lib/derive/trim.ts";
import { FileChips } from "../files/FileChip.tsx";
import { UpdateNotes } from "../render/labels.tsx";
import { Txt } from "../render/Text.tsx";
import { notesAt, NotesBlock, rowsByBlock } from "../reader/blocks.tsx";
import { guideCrumbs, guideName, systemCrumb, useNav, useSite, useSystem } from "../reader/data.ts";
import { PdfMenu } from "../reader/PdfMenu.tsx";
import { PageNotFound } from "../shell/errors.ts";
import { Icon } from "../shell/Icon.tsx";
import { Link } from "../shell/Link.tsx";
import { EditControls, EditRegion } from "../shell/mounts.tsx";
import { Voice } from "../shell/owner.tsx";
import { PageHead } from "../shell/Page.tsx";
import { guideViewHash, PANCE, useRoute } from "../shell/route.ts";
import { CardNotes, ClassCard } from "./ClassCard.tsx";
import { buildPageKey } from "../edit/pageKey.ts";

const topicTitle = (system: SystemJson, id: string): string => system.topics.find((t) => t.id === id)?.title ?? id;

/** "<Guide>" as the pharm section names her guide ("Family Medicine", "PANCE"). */
const guideLabel = (site: SiteJson, guide: string): string => (guide === PANCE ? "PANCE" : guideName(site, guide));

function PharmFiles({ system }: { system: SystemJson }): ReactNode {
  const files = system.pharm?.files;
  if (!files || files.files.length + files.removed.length + files.pending.length === 0) return null;
  return (
    <div className="gsec">
      {files.files.length > 0 && (
        <h2>
          <Voice owner="Your pharm files" visitor="Pharm files" /> <span className="n">{files.files.length}</span>
        </h2>
      )}
      <FileChips list={files} />
    </div>
  );
}

/** Card keys of a section in page order: Overview, class cards, Learning objectives. */
function cardKeys(sec: PubPharmSection): string[] {
  return [...(sec.overview ? [sec.overview] : []), ...sec.cards, ...(sec.lo ? [sec.lo] : [])];
}

/** The card that holds `id` (a card id, an Overview/LO part id, or one of a card's parts). */
function cardHolding(system: SystemJson, sec: PubPharmSection, id: string | null): string | null {
  if (!id) return null;
  for (const k of cardKeys(sec)) {
    if (k === id) return k;
    if (system.cards[k]?.parts.some((p) => p.id === id)) return k;
  }
  return null;
}

function SectionBody({ guide, system, sec, focus }: { guide: string; system: SystemJson; sec: PubPharmSection; focus: string | null }): ReactNode {
  const site = useSite();
  const nav = useNav(guide);
  const keys = cardKeys(sec);
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const k = cardHolding(system, sec, focus);
    return k ? { [k]: true } : {};
  });
  const byBlock = useMemo(() => rowsByBlock(system), [system]);
  const shownRows = useMemo(() => tableRows(system, sec.tables), [system, sec.tables]);
  const blocks = new Map(system.blocks.map((b) => [b.id, b]));

  useEffect(() => {
    if (!focus) return;
    const el = document.querySelector(`[data-anchor="${CSS.escape(focus)}"]`);
    el?.scrollIntoView?.({ block: "start" });
  }, [focus]);

  const allOpen = keys.length > 0 && keys.every((k) => open[k]);
  const setAll = (v: boolean): void => setOpen(Object.fromEntries(keys.map((k) => [k, v])));
  const toggle = (k: string): void => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const g = guideLabel(site, guide);

  const card = (id: string, also: boolean): ReactNode => {
    const c = system.cards[id];
    if (!c) return null;
    // The card leaves out what the tables above already say.
    const hidden = hiddenLines(system, c.blocks, shownRows);
    return (
      <ClassCard
        key={id}
        anchor={id}
        title={c.title}
        sub={also ? <Voice owner="not in your guide's table" visitor="not in the guide's table" /> : undefined}
        open={!!open[id]}
        onToggle={() => toggle(id)}
      >
        {c.blocks.length > 0 && !allLinesHidden(system, c.blocks, hidden) ? (
          <CardNotes system={system} file={c.file} basePt={c.basePt} parts={c.parts} hidden={hidden} />
        ) : (
          <p className="phn-none">
            <Voice owner="Your pharm notes have" visitor="The pharm notes have" /> nothing more on this one. The row in the table above is all of it.
          </p>
        )}
      </ClassCard>
    );
  };
  const part = (id: string, title: string): ReactNode => {
    const p = system.parts[id];
    if (!p) return null;
    return (
      <ClassCard key={id} anchor={id} title={title} open={!!open[id]} onToggle={() => toggle(id)}>
        <CardNotes system={system} file={p.file} basePt={p.basePt} parts={[{ id: null, blocks: p.blocks }]} />
      </ClassCard>
    );
  };
  const tableCards = sec.cards.slice(0, sec.alsoFrom);
  const alsoCards = sec.cards.slice(sec.alsoFrom);

  return (
    <>
      {sec.treats.length > 0 && (
        <div className="ph-treats">
          <span className="ph-k">Treats</span>
          {sec.treats.map((t) => (
            <Link key={t} to={guideViewHash(guide, { kind: "topics", ids: [t] })} className="ph-tchip">
              <Txt text={topicTitle(system, t)} />
            </Link>
          ))}
        </div>
      )}
      {sec.tables.length > 0 && (
        <div className="ph-src">
          <h2 className="ph-h2">
            <Voice owner={`Your ${g} guide's table`} visitor={`${g} guide's table`} />
          </h2>
          {sec.tables.map((id) => {
            const b = blocks.get(id);
            if (!b) return null;
            return (
              <div key={id} className="ph-rowblk">
                <UpdateNotes notes={notesAt(system.notes, [id, ...(byBlock.get(id) ?? [])])} />
                <NotesBlock block={b} basePt={nav.basePt} />
              </div>
            );
          })}
        </div>
      )}
      {keys.length > 0 && (
        <div className="ph-src">
          <div className="ph-h2row">
            <h2 className="ph-h2">
              <Voice owner="Your pharm notes, by drug class" visitor="Pharm notes, by drug class" />
            </h2>
            <button type="button" className="linkbtn" onClick={() => setAll(!allOpen)}>
              {allOpen ? "Collapse all" : "Expand all"}
            </button>
          </div>
          {sec.overview && part(sec.overview, "Overview")}
          {tableCards.length > 0 && <div className="phc-group">Same order as the table</div>}
          {tableCards.map((id) => card(id, false))}
          {alsoCards.length > 0 && (
            <div className="phc-group">
              <Voice owner="Also in your pharm notes" visitor="Also in the pharm notes" />
            </div>
          )}
          {alsoCards.map((id) => card(id, true))}
          {sec.lo && (
            <>
              <div className="phc-group">Learning objectives &amp; concepts</div>
              {part(sec.lo, `Learning objectives — ${sec.title}`)}
            </>
          )}
        </div>
      )}
    </>
  );
}

function SystemPharm({ guide, system }: { guide: string; system: SystemJson }): ReactNode {
  const sections = system.pharm?.sections ?? [];
  return (
    <>
      {sections.length > 0 && (
        <>
          <p className="ph-lead">
            <Voice owner="Your guide's" visitor="The guide's" /> drug tables for {system.title}, in guide order. Each one is followed by{" "}
            <Voice owner="your" visitor="the" /> pharm notes on the same drug classes.
          </p>
          <ul className="lnk">
            {sections.map((s) => (
              <li key={s.id}>
                <Link to={guideViewHash(guide, { kind: "pharm", system: system.id, section: s.id, target: null })}>
                  <span className="lt">{s.title}</span>
                  {s.treats.length > 0 && <span className="ll">Treats: {s.treats.map((t) => topicTitle(system, t)).join(", ")}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

export function PharmPage({ guide, system: sysId, section: secId, target }: { guide: string; system: string; section: string | null; target: string | null }): ReactNode {
  const site = useSite();
  const nav = useNav(guide);
  const system = useSystem(guide, sysId);
  const route = useRoute();
  if (!system.pharm) throw new PageNotFound(`pharm ${sysId}`);
  const sec = secId ? system.pharm.sections.find((s) => s.id === secId) : null;
  if (secId && !sec) throw new PageNotFound(`pharm section ${sysId}/${secId}`);
  const pharmName = `${system.title} pharm`;
  const pharmHash = guideViewHash(guide, { kind: "pharm", system: system.id, section: null, target: null });
  const crumbs = [...guideCrumbs(site, guide), systemCrumb(guide, system), sec ? { label: "Pharm", to: pharmHash } : { label: "Pharm" }];
  if (sec) crumbs.push({ label: sec.title });
  const pageKey = sec ? buildPageKey("pharm", guide, system.id, sec.id) : null;
  const focus = target ?? route.query.at;
  return (
    <div className="pharm-page">
      <PageHead
        crumbs={crumbs}
        title={
          <>
            <Icon n="pill" size={18} /> {sec ? sec.title : pharmName}
          </>
        }
        tables={!!sec}
        actions={
          <>
            {pageKey && sec && <EditControls pageKey={pageKey} title={sec.title} />}
            <PdfMenu
              site={site}
              guide={guide}
              nav={nav}
              page={
                sec
                  ? { label: "This pharm section", name: `${sec.title} (${pharmName})`, scope: { kind: "pharmSection", id: sec.id }, input: { nav, system } }
                  : { label: "This system's pharm", name: pharmName, scope: { kind: "systemPharm" }, input: { nav, system } }
              }
            />
          </>
        }
      />
      {sec && pageKey ? (
        <EditRegion pageKey={pageKey} title={sec.title}>
          <SectionBody key={`${sec.id}:${focus ?? ""}`} guide={guide} system={system} sec={sec} focus={focus} />
        </EditRegion>
      ) : (
        <SystemPharm guide={guide} system={system} />
      )}
      <PharmFiles system={system} />
    </div>
  );
}
