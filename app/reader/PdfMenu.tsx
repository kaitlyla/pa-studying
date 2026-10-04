// "Download PDF" (guide-reader/pdf, pharm/pdf; 70 §70.2). Browser scopes are built by OB8's
// downloadPdf with a "Preparing…" → "Downloaded <file>" toast; "Whole guide" links to the Actions-built
// release asset, with no updating line (ruling PW).
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { NavJson, SiteJson } from "../../lib/derive/published.ts";
import { downloadPdf, wholeGuideUrl, type PdfInput, type PdfScope } from "../pdf/download.ts";
import { Icon } from "../shell/Icon.tsx";
import { Voice } from "../shell/owner.tsx";
import { showToast } from "../shell/toast.tsx";
import { guideFile } from "./data.ts";

export interface PageScope {
  /** "This topic", "This page (2 topics)", "This section", "This system", "This pharm section", "This system's pharm". */
  label: string;
  /** What the scope holds, shown under the label. */
  name: string;
  scope: PdfScope;
  input: PdfInput;
}

export interface PdfMenuProps {
  site: SiteJson;
  guide: string;
  nav: NavJson;
  page?: PageScope | null;
}

/** Shown to everyone when a browser-built PDF fails (design node pdf/rules/fail). */
export const PDF_FAILED = "Couldn't make the PDF. Check your connection and try again.";

/**
 * "Preparing…" until `downloadPdf` settles, then "Downloaded <file>" or the failure toast; both
 * replace "Preparing…" and time out, and the menu stays available for a retry.
 */
export async function runDownload(scope: PdfScope, input: PdfInput): Promise<void> {
  showToast("Preparing…", { ms: 0 });
  try {
    const name = await downloadPdf(scope, input);
    showToast(`Downloaded ${name}`);
  } catch (e) {
    console.error(e);
    showToast(PDF_FAILED);
  }
}

export function PdfMenu({ site, guide, nav, page = null }: PdfMenuProps): ReactNode {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onKey = (e: KeyboardEvent<HTMLSpanElement>): void => {
    if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
      button.current?.focus();
    }
  };

  const file = guideFile(nav);
  return (
    <span className="pdfm" ref={root} onKeyDown={onKey}>
      <button type="button" className="btn" ref={button} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon n="dl" size={14} />
        Download PDF
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="Download PDF">
          <div className="mh">
            <Voice
              owner="Your notes only, in your table layout. Content not from your notes and guideline notes are left out."
              visitor="The guide’s notes, in its table layout."
            />
          </div>
          {page && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void runDownload(page.scope, page.input);
              }}
            >
              {page.label}
              <small>{page.name}</small>
            </button>
          )}
          <a role="menuitem" href={wholeGuideUrl(site.repo, guide, nav.source)} onClick={() => setOpen(false)}>
            Whole guide
            <small>{file} · every system, in guide order</small>
          </a>
        </div>
      )}
    </span>
  );
}
