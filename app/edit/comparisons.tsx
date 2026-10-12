// Her saved comparisons (site/compare, 20 §20.7): named quadrant sets saved through the owner's own save
// path (50 §50.4) to the guide's comparisons.json — a published file, so a visitor sees the list
// (read-only) while only she can save, rename and delete. Favorites stay owner-only; this module's file
// does not. The sidebar lists them and the compare page saves the quadrants on screen.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { COMPARISON_NAME_MAX, comparisonsPath, type ComparisonsFile } from "../../lib/content/index.ts";
import { comparisonsPath as comparisonsDataPath, type ComparisonsJson } from "../../lib/derive/published.ts";
import { loadData } from "../data/load.ts";
import { Txt } from "../render/Text.tsx";
import { Icon } from "../shell/Icon.tsx";
import { Link } from "../shell/Link.tsx";
import { useOwner } from "../shell/owner.tsx";
import { guideViewHash, useRoute } from "../shell/route.ts";
import { showToast } from "../shell/toast.tsx";
import { setOwnerFileValue, useOwnerFile, writeOwnerFile, type FileState } from "./ownerFile.ts";

export type Comparison = { name: string; ids: string[] };

export const COMPARISONS_HEADING = "Comparisons";
export const SAVE_COMPARISON = "Save comparison";
export const COMPARISONS_NONE = "None saved yet. Open Compare and press Save comparison.";
export const NAME_IT = "Name it";
export const COMPARISONS_FAILED = "Couldn’t save the comparison. Check your connection and try again.";
export const COMPARISON_TAKEN = "You already have a comparison with that name.";
export const renameLabel = (name: string): string => `Rename ${name}`;
export const deleteLabel = (name: string): string => `Delete ${name}`;

/** The comparisons a file holds, in her order. */
const listOf = (file: ComparisonsFile | null): Comparison[] => (file?.comparisons ?? []).map((c) => ({ name: c.name, ids: [...c.ids] }));

const keyOf = (guide: string): string => comparisonsPath(guide);

const isTaken = (items: readonly Comparison[], name: string, except?: string): boolean => items.some((c) => c.name === name && c.name !== except);

/** Her own file over Git, read once per session (the owner; a visitor never reads it). */
function useMine(guide: string, enabled: boolean): FileState<Comparison[]> {
  return useOwnerFile<Comparison[]>(keyOf(guide), [], enabled, async (snapshot) =>
    listOf((await snapshot.jsonIfExists<ComparisonsFile>(comparisonsPath(guide))) ?? null),
  );
}

/** Saves the quadrants on screen under `name` (one commit). */
export async function saveComparison(guide: string, name: string, ids: readonly string[]): Promise<boolean> {
  const path = keyOf(guide);
  const outcome = await writeOwnerFile<ComparisonsFile>(path, "comparisons", `Comparison: ${name}`, (file) => {
    const list = listOf(file);
    if (isTaken(list, name)) return null;
    return { v: 1, comparisons: [...list, { name, ids: [...ids] }] };
  });
  if (outcome.file) setOwnerFileValue(path, listOf(outcome.file));
  return outcome.kind === "saved";
}

/** Renames a saved comparison (one commit); the list keeps its position. */
export async function renameComparison(guide: string, from: string, to: string): Promise<boolean> {
  const path = keyOf(guide);
  const outcome = await writeOwnerFile<ComparisonsFile>(path, "comparisons", `Comparison renamed: ${from} → ${to}`, (file) => {
    const list = listOf(file);
    if (isTaken(list, to, from) || !list.some((c) => c.name === from)) return null;
    return { v: 1, comparisons: list.map((c) => (c.name === from ? { name: to, ids: c.ids } : c)) };
  });
  if (outcome.file) setOwnerFileValue(path, listOf(outcome.file));
  return outcome.kind !== "failed";
}

/** Takes a saved comparison off the list (one commit). */
export async function deleteComparison(guide: string, name: string): Promise<boolean> {
  const path = keyOf(guide);
  const outcome = await writeOwnerFile<ComparisonsFile>(path, "comparisons", `Comparison deleted: ${name}`, (file) => {
    const list = listOf(file);
    return list.some((c) => c.name === name) ? { v: 1, comparisons: list.filter((c) => c.name !== name) } : null;
  });
  if (outcome.file) setOwnerFileValue(path, listOf(outcome.file));
  return outcome.kind !== "failed";
}

/**
 * The guide's comparisons: hers fresh over Git, the published copy for a visitor (and until hers loads).
 * The published read does not hold the sidebar up: the list appears when the file arrives, and a read
 * that fails leaves it empty — a browser can meet a page whose data is served by an edge that has not
 * seen the guide's comparisons file yet, and that must not take the page down.
 */
function useComparisons(guide: string): { owner: boolean; items: Comparison[] } {
  const owner = useOwner().owner;
  const mine = useMine(guide, owner);
  const [published, setPublished] = useState<Comparison[]>([]);
  useEffect(() => {
    let live = true;
    void loadData<ComparisonsJson>(comparisonsDataPath(guide)).then(
      (json) => {
        if (live) setPublished(json.comparisons.map((c) => ({ name: c.name, ids: [...c.ids] })));
      },
      (e: unknown) => console.warn("Couldn’t read the saved comparisons", e),
    );
    return () => {
      live = false;
    };
  }, [guide]);
  return { owner, items: owner && mine.state === "ready" ? mine.value : published };
}

/**
 * The sidebar's Comparisons list, under the guide's name. It is always up for the owner — with a line
 * saying how to make one while none is saved — so she can see the place her comparisons go; a visitor
 * sees it only when there is something in it.
 */
export function ComparisonsSection({ guide, onNavigate, topics }: { guide: string; onNavigate: () => void; topics: ReadonlyMap<string, string> }): ReactNode {
  const { owner, items } = useComparisons(guide);
  const route = useRoute();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  // A comparison whose diagnosis the guide no longer lists is listed without it, so the row opens what is
  // left; one whose diagnoses are all gone is not listed at all — never a row onto an empty page.
  const live = items.flatMap((c) => {
    const ids = c.ids.filter((id) => topics.has(id));
    return ids.length === 0 ? [] : [{ name: c.name, ids }];
  });
  if (live.length === 0 && !owner) return null;
  if (live.length === 0) {
    return (
      <>
        <div className="side-sec">{COMPARISONS_HEADING}</div>
        <p className="side-note">{COMPARISONS_NONE}</p>
      </>
    );
  }
  const open = route.kind === "guide" && route.guide === guide && route.view.kind === "compare" ? route.view.ids.join(",") : null;

  const rename = async (from: string): Promise<void> => {
    const to = draft.trim();
    if (to === "") return;
    if (to === from) {
      setEditing(null);
      return;
    }
    if (isTaken(items, to, from)) {
      showToast(COMPARISON_TAKEN);
      return;
    }
    setBusy(true);
    const ok = await renameComparison(guide, from, to);
    setBusy(false);
    if (ok) setEditing(null);
    else showToast(COMPARISONS_FAILED);
  };

  const remove = async (name: string): Promise<void> => {
    setBusy(true);
    const ok = await deleteComparison(guide, name);
    setBusy(false);
    if (!ok) showToast(COMPARISONS_FAILED);
  };

  return (
    <>
      <div className="side-sec">{COMPARISONS_HEADING}</div>
      <ul className="gen">
        {live.map((c) => (
          <li key={c.name}>
            {editing === c.name ? (
              <form
                className="cmp-rename"
                onSubmit={(e) => {
                  e.preventDefault();
                  void rename(c.name);
                }}
              >
                <input
                  aria-label={`New name for ${c.name}`}
                  value={draft}
                  maxLength={COMPARISON_NAME_MAX}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setEditing(null);
                    }
                  }}
                />
                <button type="submit" className="btn" disabled={busy || draft.trim() === ""}>
                  Save
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </form>
            ) : (
              <div className="ent-row">
                <Link
                  to={guideViewHash(guide, { kind: "compare", ids: c.ids })}
                  className={`ent${open === c.ids.join(",") ? " open" : ""}`}
                  aria-current={open === c.ids.join(",") ? "page" : undefined}
                  title={c.name}
                  onClick={onNavigate}
                >
                  <span className="ent-t">
                    <Txt text={c.name} />
                  </span>
                </Link>
                {owner && (
                  <>
                    <button
                      type="button"
                      className="iconbtn rowact"
                      aria-label={renameLabel(c.name)}
                      disabled={busy}
                      onClick={() => {
                        setDraft(c.name);
                        setEditing(c.name);
                      }}
                    >
                      <Icon n="pen" size={13} />
                    </button>
                    <button type="button" className="iconbtn rowact" aria-label={deleteLabel(c.name)} disabled={busy} onClick={() => void remove(c.name)}>
                      <Icon n="x" size={13} />
                    </button>
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

/** The compare page's owner-only "Save comparison": names the quadrants on screen. */
export function SaveComparison({ guide, ids }: { guide: string; ids: readonly string[] }): ReactNode {
  const mine = useMine(guide, true);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const chosen = ids.filter((x) => x !== "");

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const save = async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed === "" || chosen.length === 0) return;
    if (isTaken(mine.value, trimmed)) {
      showToast(COMPARISON_TAKEN);
      return;
    }
    setBusy(true);
    const ok = await saveComparison(guide, trimmed, chosen);
    setBusy(false);
    if (!ok) showToast(COMPARISONS_FAILED);
    else {
      setOpen(false);
      setName("");
    }
  };

  return (
    <span className="savecmp" ref={root} onKeyDown={(e) => { if (e.key === "Escape" && open) { e.preventDefault(); setOpen(false); } }}>
      <button type="button" className="btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {SAVE_COMPARISON}
      </button>
      {open && (
        <form
          className="menu cmp-save"
          aria-label={SAVE_COMPARISON}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input aria-label="Name" placeholder={NAME_IT} value={name} maxLength={COMPARISON_NAME_MAX} autoFocus onChange={(e) => setName(e.target.value)} />
          <div className="cmp-save-row">
            <button type="submit" className="btn" disabled={busy || name.trim() === ""}>
              Save
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </span>
  );
}
