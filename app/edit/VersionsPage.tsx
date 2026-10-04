// The Versions page of an editable page (plan 50 §50.6; UI versions): the list newest first with its
// Current and Original badges, View (the page read at that commit, read-only, under the "Viewing the
// version from …" bar), and Restore after its confirm, back on the page with the "Restored" banner.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AsIsFile } from "../../lib/content/index.ts";
import { SignedOutError } from "../auth/session.ts";
import { waitForSignIn } from "../auth/auth.ts";
import { RichDoc } from "../render/index.ts";
import { Icon } from "../shell/Icon.tsx";
import { NotOnSite } from "../shell/NotOnSite.tsx";
import { useOwner } from "../shell/owner.tsx";
import { PageHead } from "../shell/Page.tsx";
import { navigate } from "../shell/route.ts";
import { Dialog } from "./dialogs.tsx";
import { PartView } from "./EditRegion.tsx";
import { versionTime } from "./format.ts";
import { recordSaved } from "./overlay.ts";
import { isOffline, repo, SAVE_FAILED, showPageBanner } from "./session.ts";
import type { EditUnit, Slot } from "./units.ts";
import { pageHash, restoreVersion, versionsOrigin, VersionHistory, viewVersion, type Version } from "./versions.ts";

type Problem = { kind: "offline" } | { kind: "failed" } | { kind: "conflict"; at: string };

/** The list couldn't be read for want of a connection (placeholder wording, pending the Designer). */
export const VERSIONS_OFFLINE = "Couldn’t load the versions — no internet connection.";
/** The list couldn't be read for another reason; the error is logged (placeholder wording, pending the Designer). */
export const VERSIONS_FAILED = "Couldn’t load the versions.";

const readOnly = (slot: Slot): ReactNode => (
  <div className="notes">
    <RichDoc doc={slot.doc} basePt={slot.basePt} />
  </div>
);

/** A stored file's bytes saved under `name` (Download original of an as-is version). */
async function download(unit: EditUnit, file: AsIsFile): Promise<void> {
  const sha = unit.snapshot.files.get(`content/files/${file.id}/${file.original}`);
  if (sha === undefined) return;
  const bytes = await unit.snapshot.git.blobBytes(sha);
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer]));
  const a = document.createElement("a");
  a.href = url;
  a.download = file.original;
  a.click();
  URL.revokeObjectURL(url);
}

/** The page at a version, read-only. A document shown as-is offers its stored file. */
function VersionBody({ unit }: { unit: EditUnit }): ReactNode {
  const [file, setFile] = useState<AsIsFile | null>(null);
  useEffect(() => {
    if (unit.docId === null || unit.parts.length > 0) return;
    let live = true;
    void unit.snapshot.jsonIfExists<AsIsFile>(`content/files/${unit.docId}/file.json`).then((f) => {
      if (live) setFile(f);
    });
    return () => {
      live = false;
    };
  }, [unit]);
  if (unit.parts.length > 0) return <>{unit.parts.map((p, i) => <PartView key={i} part={p} slotView={readOnly} />)}</>;
  if (!file) return null;
  return (
    <p>
      <b>{file.name}</b>{" "}
      <button type="button" className="btn" onClick={() => void download(unit, file)} data-ref="version-download">
        <Icon n="dl" />Download original
      </button>
    </p>
  );
}

function ProblemBanner({ problem, retry, reload }: { problem: Problem; retry: () => void; reload: () => void }): ReactNode {
  switch (problem.kind) {
    case "offline":
      return (
        <div className="banner err" role="alert" data-ref="restore-failed">
          <span className="bt"><b>Couldn’t save — no internet connection.</b></span>
          <span className="ba"><button type="button" className="btn pri" onClick={retry}>Try again</button></span>
        </div>
      );
    case "conflict":
      return (
        <div className="banner err" role="alert" data-ref="restore-conflict">
          <span className="bt"><b>Not saved — this page was saved from another device at {problem.at} after you opened it.</b> Nothing was overwritten.</span>
          <span className="ba"><button type="button" className="btn pri" onClick={reload}>Load newer version</button></span>
        </div>
      );
    case "failed":
      return <div className="banner err" role="alert" data-ref="restore-error"><span className="bt"><b>{SAVE_FAILED.title}</b> {SAVE_FAILED.body}</span></div>;
  }
}

export function VersionsPage({ pageKey }: { pageKey: string }): ReactNode {
  const { owner } = useOwner();
  if (!owner) return <NotOnSite />;
  return <Versions key={pageKey} pageKey={pageKey} />;
}

function Versions({ pageKey }: { pageKey: string }): ReactNode {
  const origin = versionsOrigin(pageKey);
  const back = origin?.back ?? pageHash(pageKey) ?? "#/";
  const title = origin?.title ?? null;
  const [history, setHistory] = useState<VersionHistory | null>(null);
  const [list, setList] = useState<Version[]>([]);
  const [openError, setOpenError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ version: Version; unit: EditUnit | null } | null>(null);
  const [confirm, setConfirm] = useState<Version | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ problem: Problem; version: Version } | null>(null);
  const loadingMore = useRef(false);
  const end = useRef<HTMLDivElement>(null);

  /** Bumped to read the history again (Try again, Load newer version). */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    repo()
      .then(({ git }) => VersionHistory.open(git, pageKey))
      .then(
        (h) => {
          if (!live) return;
          setHistory(h);
          setList(h.versions());
        },
        (e: unknown) => {
          if (!live) return;
          if (!isOffline(e)) console.error("Versions failed to load", e);
          setOpenError(isOffline(e) ? VERSIONS_OFFLINE : VERSIONS_FAILED);
        },
      );
    return () => {
      live = false;
    };
  }, [pageKey, attempt]);

  // Pages with more than 100 commits per file read the next page when she reaches the end of the list.
  useEffect(() => {
    const el = end.current;
    if (!el || !history || history.complete || typeof IntersectionObserver === "undefined") return undefined;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((x) => x.isIntersecting) || loadingMore.current) return;
      loadingMore.current = true;
      void history.more().then(() => setList(history.versions())).finally(() => {
        loadingMore.current = false;
      });
    });
    io.observe(el);
    return () => io.disconnect();
  }, [history, list]);

  const view = async (version: Version): Promise<void> => {
    if (viewing?.version.sha === version.sha) {
      setViewing(null);
      return;
    }
    setViewing({ version, unit: null });
    const { git } = await repo();
    const unit = await viewVersion(git, pageKey, version.sha);
    setViewing((v) => (v?.version.sha === version.sha ? { version, unit } : v));
  };

  const restore = async (version: Version): Promise<void> => {
    setConfirm(null);
    setBusy(true);
    setProblem(null);
    try {
      const { git, site } = await repo();
      const r = await restoreVersion({
        git, key: pageKey, title: title ?? pageKey, version, author: { name: site.owner.commitName, email: site.owner.commitEmail },
      });
      if (r.kind === "saved") {
        if (r.files.size > 0) await recordSaved(r.files, r.commit);
        await navigate(back);
        showPageBanner(pageKey, { kind: "restored", from: version.time });
        return;
      }
      setProblem({ version, problem: r.kind === "conflict" ? { kind: "conflict", at: versionTime(r.at) } : { kind: r.kind === "offline" ? "offline" : "failed" } });
    } catch (e) {
      if (e instanceof SignedOutError) {
        setBusy(false);
        if (await waitForSignIn()) await restore(version);
        return;
      }
      const offline = isOffline(e);
      if (!offline) console.error("Restore failed", e);
      setProblem({ version, problem: { kind: offline ? "offline" : "failed" } });
    } finally {
      setBusy(false);
    }
  };

  const reload = (): void => {
    setProblem(null);
    setOpenError(null);
    setViewing(null);
    setHistory(null);
    setAttempt((n) => n + 1);
  };

  const crumbs = [{ label: title ?? "Back to the page", to: back }, { label: "Versions" }];
  return (
    <div data-surface="versions">
      <PageHead
        crumbs={crumbs}
        title={title !== null ? `Versions of “${title}”` : "Versions"}
        actions={<button type="button" className="btn" onClick={() => void navigate(back)} data-ref="versions-back"><Icon n="back" />Back to the page</button>}
      />
      <p className="vintro">Every save is kept. Restoring a version saves it as the newest version, so nothing is lost. Only you can see this page.</p>
      {problem && <ProblemBanner problem={problem.problem} retry={() => void restore(problem.version)} reload={reload} />}
      {openError && <div className="banner err" role="alert"><span className="bt">{openError}</span><span className="ba"><button type="button" className="btn" onClick={reload}>Try again</button></span></div>}
      {!history && !openError && <p className="loading" role="status">Loading…</p>}
      {history && (
        <ul className="vlist" data-ref="versions-list">
          {list.map((v, i) => {
            const shown = viewing?.version.sha === v.sha;
            return (
              <li key={v.sha} data-ref={`version-${i}`}>
                <span className="vt"><b>{v.time}</b><small>{v.label}</small></span>
                {v.current && <span className="vbadge">Current</span>}
                {v.original && <span className="vbadge">Original</span>}
                <button type="button" className="btn" onClick={() => void view(v)} aria-pressed={shown} data-ref={`version-view-${i}`}>{shown ? "Hide" : "View"}</button>
                {!v.current && <button type="button" className="btn" disabled={busy} onClick={() => setConfirm(v)} data-ref={`version-restore-${i}`}>Restore</button>}
              </li>
            );
          })}
        </ul>
      )}
      <div ref={end} />
      {viewing && (
        <div className="version-preview" data-ref="version-preview">
          <div className="banner info"><span className="bt">Viewing the version from <b>{viewing.version.time}</b>. This isn’t the current version.</span></div>
          <div className="frame">{viewing.unit ? <VersionBody unit={viewing.unit} /> : <p className="loading" role="status">Loading…</p>}</div>
        </div>
      )}
      {confirm && (
        <Dialog
          title="Restore this version?"
          onClose={() => setConfirm(null)}
          actions={<>
            <button type="button" className="btn" onClick={() => setConfirm(null)}>Cancel</button>
            <button type="button" className="btn pri" onClick={() => void restore(confirm)} data-ref="restore-confirm">Restore</button>
          </>}
        >
          <p>The page will go back to the version from <b>{confirm.time}</b>. The current version stays in this list, so you can switch back.</p>
        </Dialog>
      )}
    </div>
  );
}
