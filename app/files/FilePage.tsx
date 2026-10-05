// The File page (`#/file/<d_id>`, 40 §40.3, UI file-viewer). The location line and Back come from
// `from`; without it, from the document's first placement. Display by kind: Word → its blocks,
// PDF → every page inline, image → full width (click opens the viewer), slides → one page at a time.
import { Component, useState, type ReactNode } from "react";
import { docPath, HOSTS_PATH, type DocJson, type HostsJson } from "../../lib/derive/published.ts";
import { fileLocation } from "../../lib/derive/routes.ts";
import { DATA_BASE, NotFoundError, useData } from "../data/load.ts";
import { UpdateNotes } from "../render/labels.tsx";
import { useSite } from "../reader/data.ts";
import { NotesBlock } from "../reader/blocks.tsx";
import { Icon } from "../shell/Icon.tsx";
import { DocActions, EditControls, EditRegion, PendingDocPage, ReplaceFailedNote, UploadProblem } from "../shell/mounts.tsx";
import { NotOnSite } from "../shell/NotOnSite.tsx";
import { useOwner } from "../shell/owner.tsx";
import { PageHead, type Crumb } from "../shell/Page.tsx";
import { navigate } from "../shell/route.ts";
import { openImageViewer } from "./imageViewer.tsx";
import { PdfPage, PdfPages, PdfStatus, usePdf } from "./pdf.tsx";
import { SlideNav, slideKeys } from "./SlideNav.tsx";
import { buildPageKey } from "../edit/pageKey.ts";

const fileUrl = (path: string): string => `${DATA_BASE}${path}`;

/** One page of the `view` PDF per slide (Antibiotic Flower Charts, uploaded PowerPoints). */
function PdfSlides({ url }: { url: string }): ReactNode {
  const { doc, error } = usePdf(url);
  const [n, setN] = useState(1);
  if (!doc) return <PdfStatus error={error} />;
  const total = doc.numPages;
  const at = Math.min(n, total);
  return (
    <div className="slides-file" onKeyDown={slideKeys(at, total, setN)}>
      <SlideNav n={at} total={total} go={setN} format="fraction" labels={Array.from({ length: total }, (_, k) => `Slide ${k + 1}`)} />
      <div className="slide" tabIndex={0} aria-label={`Slide ${at} of ${total}`}>
        <PdfPage doc={doc} n={at} />
      </div>
    </div>
  );
}

function WordBody({ doc }: { doc: DocJson }): ReactNode {
  return (
    <div className="wordpage">
      {(doc.blocks ?? []).map((b) => (
        <div key={b.id}>
          <UpdateNotes notes={doc.notes[b.id]} />
          <NotesBlock block={b} basePt={doc.basePt ?? 11} />
        </div>
      ))}
    </div>
  );
}

function FileBody({ doc }: { doc: DocJson }): ReactNode {
  switch (doc.kind) {
    case "word":
      return <WordBody doc={doc} />;
    case "pdf":
      return doc.original ? <PdfPages url={fileUrl(doc.view ?? doc.original)} /> : null;
    case "image":
      if (!doc.original) return null;
      return (
        <div className="imgv">
          <button type="button" className="imgbtn" aria-label={`Open ${doc.name} full size`} onClick={() => openImageViewer(fileUrl(doc.original ?? ""))}>
            <img src={fileUrl(doc.view ?? doc.original)} alt={doc.name} />
          </button>
        </div>
      );
    case "slides":
      return doc.view ? <PdfSlides url={fileUrl(doc.view)} /> : null;
    default:
      return null;
  }
}

function FileView({ id, from }: { id: string; from: string | null }): ReactNode {
  const site = useSite();
  const doc = useData<DocJson>(docPath(id));
  const hosts = useData<HostsJson>(HOSTS_PATH);
  const host = hosts[doc.id];
  const loc = fileLocation(site.index, from) ?? host?.loc ?? null;
  // A document's own hosts entry routes to this page, so only `from` gives the location crumb a target.
  const parts = loc ? loc.split(" › ") : [];
  const crumbs: Crumb[] = parts.map((label, i) => (i === parts.length - 1 && from ? { label, to: from } : { label }));
  crumbs.push({ label: doc.name });
  const pageKey = buildPageKey("doc", doc.id);
  const word = doc.kind === "word";
  return (
    <div className="file-page">
      <PageHead
        crumbs={crumbs}
        title={doc.name}
        tables={word}
        actions={
          <>
            {from && (
              <button type="button" className="btn" onClick={() => void navigate(from)}>
                <Icon n="back" size={14} />
                Back
              </button>
            )}
            {word && <EditControls pageKey={pageKey} title={doc.name} />}
            <DocActions doc={doc} from={from} />
            {doc.original && (
              <a className="btn" href={fileUrl(doc.original)} download>
                <Icon n="dl" size={14} />
                {doc.kind === "pdf" ? "Download original PDF" : "Download"}
              </a>
            )}
          </>
        }
      />
      <ReplaceFailedNote doc={doc} />
      <UploadProblem id={doc.id} />
      <UpdateNotes notes={doc.notes[doc.id]} />
      {word ? (
        <EditRegion pageKey={pageKey} title={doc.name}>
          <FileBody doc={doc} />
        </EditRegion>
      ) : (
        <FileBody doc={doc} />
      )}
    </div>
  );
}

/** Her processing or failed document (D1, E1); everyone else gets "isn't on the site". */
function Unpublished({ id }: { id: string }): ReactNode {
  const { owner } = useOwner();
  return owner ? <PendingDocPage id={id} /> : <NotOnSite />;
}

/** Turns a missing `docs/<d>.json` into the unpublished view; any other error goes to the page boundary. */
class MissingDoc extends Component<{ id: string; children?: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error };
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    if (error instanceof NotFoundError) return <Unpublished id={this.props.id} />;
    throw error;
  }
}

export function FilePage({ doc, from }: { doc: string; from: string | null }): ReactNode {
  return (
    <MissingDoc key={doc} id={doc}>
      <FileView id={doc} from={from} />
    </MissingDoc>
  );
}
