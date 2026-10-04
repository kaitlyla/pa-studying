// pdf.js rendering for the File page (40 §40.3): every page inline, top to bottom, or one page at a
// time in the slide viewer. The worker is the same pdfjs-dist version, served from the site's own
// origin (10 §10.6; CSP `worker-src 'self' blob:`). pdfjs-dist 6.4.299 has no eval path, so no
// eval-related option is passed.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

let lib: Promise<typeof import("pdfjs-dist")> | null = null;

function pdfjs(): Promise<typeof import("pdfjs-dist")> {
  lib ??= import("pdfjs-dist").then((m) => {
    m.GlobalWorkerOptions.workerSrc = workerUrl;
    return m;
  });
  return lib;
}

type Loaded = { url: string; doc: PDFDocumentProxy | null; error: boolean };

/** Opens the PDF at `url`; null until loaded. */
export function usePdf(url: string): { doc: PDFDocumentProxy | null; error: boolean } {
  const [state, setState] = useState<Loaded>({ url, doc: null, error: false });
  useEffect(() => {
    let cancelled = false;
    let task: { destroy(): Promise<void> } | null = null;
    pdfjs()
      .then((m) => {
        const t = m.getDocument({ url });
        task = t;
        if (cancelled) void t.destroy();
        return t.promise;
      })
      .then(
        (doc) => {
          if (!cancelled) setState({ url, doc, error: false });
        },
        (e: unknown) => {
          if (cancelled) return;
          console.error(e);
          setState({ url, doc: null, error: true });
        },
      );
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [url]);
  return state.url === url ? state : { doc: null, error: false };
}

/** One page drawn to fit the width of its container. */
export function PdfPage({ doc, n }: { doc: PDFDocumentProxy; n: number }): ReactNode {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let task: { cancel(): void; promise: Promise<void> } | null = null;
    let cancelled = false;
    void doc.getPage(n).then((page) => {
      const c = canvas.current;
      const width = box.current?.clientWidth || 800;
      if (cancelled || !c) return;
      const base = page.getViewport({ scale: 1 });
      const ratio = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: (width / base.width) * ratio });
      c.width = Math.floor(viewport.width);
      c.height = Math.floor(viewport.height);
      c.style.aspectRatio = `${base.width} / ${base.height}`;
      task = page.render({ canvas: c, viewport });
      task.promise.catch((e: unknown) => {
        if ((e as { name?: string })?.name !== "RenderingCancelledException") console.error(e);
      });
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, n]);
  return (
    <div className="pdfpage" ref={box} data-anchor={`p${n}`} aria-label={`Page ${n}`}>
      <canvas ref={canvas} />
    </div>
  );
}

export function PdfStatus({ error }: { error: boolean }): ReactNode {
  return error ? (
    <div className="notfound" role="alert">
      This file couldn't be shown. Use Download to open it.
    </div>
  ) : (
    <div className="loading">Loading…</div>
  );
}

/** Every page, top to bottom. */
export function PdfPages({ url }: { url: string }): ReactNode {
  const { doc, error } = usePdf(url);
  if (!doc) return <PdfStatus error={error} />;
  return (
    <div className="pdfv">
      {Array.from({ length: doc.numPages }, (_, i) => (
        <PdfPage key={i} doc={doc} n={i + 1} />
      ))}
    </div>
  );
}
