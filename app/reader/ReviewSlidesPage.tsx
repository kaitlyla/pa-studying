// Review slides (40 §40.3, guide-reader/review-slides). A generated deck opens on a contents slide
// and has per-slide Edit and Versions; her own Psychiatry deck opens on her first slide with the
// contents under it and has "Download original" and document-level actions instead.
import type { ReactNode } from "react";
import { docPath, slidesPath, type DocJson, type SlidesJson } from "../../lib/derive/published.ts";
import { DATA_BASE, useData } from "../data/load.ts";
import { SlideNav, slideKeys } from "../files/SlideNav.tsx";
import { inlineText, RichDoc, type PMNode } from "../render/RichDoc.tsx";
import { GAP_BASE_PT, ReviewSlidesBadge } from "../render/labels.tsx";
import { Txt } from "../render/Text.tsx";
import { PageNotFound } from "../shell/errors.ts";
import { Icon } from "../shell/Icon.tsx";
import { Link } from "../shell/Link.tsx";
import { DocActions, EditControls, EditRegion } from "../shell/mounts.tsx";
import { PageHead } from "../shell/Page.tsx";
import { guideViewHash, navigate, versionsHash } from "../shell/route.ts";
import { guideCrumbs, guideName, useSite } from "./data.ts";
import { buildPageKey } from "../edit/pageKey.ts";

type Slide = SlidesJson["slides"][number];

/** A slide's title: its first heading line. */
export function slideTitle(slide: Slide): string {
  const doc = slide.doc as PMNode;
  const head = (doc.content ?? []).find((n) => n.type === "heading_line") ?? doc.content?.[0];
  return inlineText(head?.content).replace(/\s+/g, " ").trim();
}

function Contents({ slides, offset, go }: { slides: readonly Slide[]; offset: number; go: (n: number) => void }): ReactNode {
  return (
    <ol className="sd-toc">
      {slides.map((s, k) => (
        <li key={s.id}>
          <button type="button" onClick={() => go(k + 1 + offset)}>
            <span className="n">{k + 1 + offset}</span>
            <span>
              <Txt text={slideTitle(s)} />
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function SlideBody({ slide, n, total, basePt = GAP_BASE_PT }: { slide: Slide; n: number; total: number; basePt?: number }): ReactNode {
  return (
    <div className="sd-main" data-anchor={slide.id}>
      <span className="sd-num">
        {n} / {total}
      </span>
      <div className="notes sd-body">
        <RichDoc doc={slide.doc as PMNode} basePt={basePt} />
      </div>
    </div>
  );
}

function OwnDeck({ guide, deck, n }: { guide: string; deck: SlidesJson; n: number }): ReactNode {
  const site = useSite();
  const doc = useData<DocJson>(docPath(deck.file ?? ""));
  const total = deck.slides.length;
  if (n > total) throw new PageNotFound(`slide ${n}`);
  const go = (k: number): void => void navigate(guideViewHash(guide, { kind: "slides", n: k }));
  const slide = deck.slides[n - 1] as Slide;
  const title = "Psych review slides";
  return (
    <div className="slides-page" onKeyDown={slideKeys(n, total, go)}>
      <PageHead
        crumbs={[...guideCrumbs(site, guide), { label: title }]}
        title={title}
        actions={
          <>
            {doc.original && (
              <a className="btn" href={`${DATA_BASE}${doc.original}`} download>
                <Icon n="dl" size={14} />
                Download original
              </a>
            )}
            <DocActions doc={doc} />
            <Link className="btn own-only" to={versionsHash(buildPageKey("doc", doc.id))}>
              Versions
            </Link>
          </>
        }
      />
      <ReviewSlidesBadge generated={false} />
      <SlideNav n={n} total={total} go={go} labels={deck.slides.map((s, k) => (k === 0 ? "Contents" : `${k + 1}. ${slideTitle(s)}`))} />
      <div className="slide" tabIndex={0} aria-label={`Slide ${n}: ${slideTitle(slide)}`}>
        <SlideBody slide={slide} n={n} total={total} basePt={doc.basePt} />
        {n === 1 && (
          <div className="sd-cover">
            <p>
              {title} · {total} slides
            </p>
            <Contents slides={deck.slides.slice(1)} offset={1} go={go} />
          </div>
        )}
      </div>
    </div>
  );
}

function GeneratedDeck({ guide, deck, n }: { guide: string; deck: SlidesJson; n: number }): ReactNode {
  const site = useSite();
  // The stored slides[0] is the contents slide (20 §20.10): its block holds the deck title line and
  // the list of the other slides is generated here.
  const total = deck.slides.length;
  if (n > total) throw new PageNotFound(`slide ${n}`);
  const go = (k: number): void => void navigate(guideViewHash(guide, { kind: "slides", n: k }));
  const slide = deck.slides[n - 1] as Slide;
  const name = guideName(site, guide);
  const pageKey = buildPageKey("slide", guide, slide.id);
  const slideName = `Review slide ${n} for ${name}`;
  return (
    <div className="slides-page" onKeyDown={slideKeys(n, total, go)}>
      <PageHead
        crumbs={[...guideCrumbs(site, guide), { label: deck.title }]}
        title={
          <>
            {deck.title} <span className="h-sub">for {name}</span>
          </>
        }
        actions={<EditControls pageKey={pageKey} title={slideName} />}
      />
      <ReviewSlidesBadge generated />
      <SlideNav n={n} total={total} go={go} labels={deck.slides.map((s, k) => (k === 0 ? "Contents" : `${k + 1}. ${slideTitle(s)}`))} />
      <EditRegion pageKey={pageKey} title={slideName}>
        <div className="slide" tabIndex={0} aria-label={n === 1 ? "Slide 1: Contents" : `Slide ${n}: ${slideTitle(slide)}`}>
          <SlideBody slide={slide} n={n} total={total} />
          {n === 1 && (
            <div className="sd-cover">
              <p>High-yield review · {total} slides</p>
              <Contents slides={deck.slides.slice(1)} offset={1} go={go} />
            </div>
          )}
        </div>
      </EditRegion>
      {slide.summarizes.length > 0 && (
        <div className="hy-links">
          <span className="ph-k">Summarizes</span>
          {slide.summarizes.map((t) => (
            <Link key={t.id} to={t.route} className="ph-tchip">
              <Txt text={t.title} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function ReviewSlidesPage({ guide, n }: { guide: string; n: number }): ReactNode {
  const deck = useData<SlidesJson>(slidesPath(guide));
  if (deck.kind === "own") return <OwnDeck guide={guide} deck={deck} n={n} />;
  return <GeneratedDeck guide={guide} deck={deck} n={n} />;
}
