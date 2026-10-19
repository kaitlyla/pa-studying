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
import { guideViewHash, navigate, useRoute } from "../shell/route.ts";
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
export const moveLabel = (name: string): string => `Move ${name}`;
export const DRAG_TO_MOVE = "Drag to move";
export const updateLabel = (name: string): string => `Update ${name}`;

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

/**
 * Moves a saved comparison to just above (`dir` -1) or just below (`dir` 1) `neighbor` — the comparison
 * beside it in the list she sees (one commit). Moving past a neighbor rather than by an index keeps the
 * move right when the file holds a comparison the sidebar does not list, or another device changed it.
 */
export async function moveComparison(guide: string, name: string, neighbor: string, dir: -1 | 1): Promise<boolean> {
  const path = keyOf(guide);
  const outcome = await writeOwnerFile<ComparisonsFile>(path, "comparisons", `Comparison moved: ${name}`, (file) => {
    const list = listOf(file);
    const moving = list.find((c) => c.name === name);
    const rest = list.filter((c) => c.name !== name);
    const at = rest.findIndex((c) => c.name === neighbor);
    if (moving === undefined || at < 0) return null;
    const next = [...rest.slice(0, dir < 0 ? at : at + 1), moving, ...rest.slice(dir < 0 ? at : at + 1)];
    return next.every((c, i) => c.name === list[i]?.name) ? null : { v: 1, comparisons: next };
  });
  if (outcome.file) setOwnerFileValue(path, listOf(outcome.file));
  return outcome.kind !== "failed";
}

/** Replaces the diagnoses a saved comparison holds, keeping its name and place (one commit). */
export async function setComparisonIds(guide: string, name: string, ids: readonly string[]): Promise<boolean> {
  const path = keyOf(guide);
  const outcome = await writeOwnerFile<ComparisonsFile>(path, "comparisons", `Comparison updated: ${name}`, (file) => {
    const list = listOf(file);
    const now = list.find((c) => c.name === name);
    if (ids.length === 0 || now === undefined || now.ids.join(",") === ids.join(",")) return null;
    return { v: 1, comparisons: list.map((c) => (c.name === name ? { name, ids: [...ids] } : c)) };
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
  /** The comparison she is dragging by its grip, and the row it is over. */
  const [drag, setDrag] = useState<{ name: string; over: string | null } | null>(null);
  const list = useRef<HTMLUListElement>(null);
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
  const view = route.kind === "guide" && route.guide === guide && route.view.kind === "compare" ? route.view : null;
  // The row of the saved comparison she opened stays current while she changes its quadrants; an address
  // naming no comparison marks the row whose diagnoses it shows.
  const isOpen = (c: Comparison): boolean => view !== null && (view.saved ? view.saved === c.name : view.ids.join(",") === c.ids.join(","));
  const names = live.map((c) => c.name);

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
    if (!ok) {
      showToast(COMPARISONS_FAILED);
      return;
    }
    setEditing(null);
    // The open comparison follows its new name, so Update still finds it.
    if (view?.saved === from) void navigate(guideViewHash(guide, { kind: "compare", ids: view.ids, saved: to }));
  };

  const remove = async (name: string): Promise<void> => {
    setBusy(true);
    const ok = await deleteComparison(guide, name);
    setBusy(false);
    if (!ok) showToast(COMPARISONS_FAILED);
  };

  const move = async (name: string, neighbor: string, dir: -1 | 1): Promise<void> => {
    setBusy(true);
    const ok = await moveComparison(guide, name, neighbor, dir);
    setBusy(false);
    if (!ok) showToast(COMPARISONS_FAILED);
  };

  /** The listed comparison under the pointer, if any. */
  const rowAt = (x: number, y: number): string | null => {
    const li = document.elementFromPoint(x, y)?.closest<HTMLElement>("li[data-cmp]");
    return li && list.current?.contains(li) ? (li.dataset.cmp ?? null) : null;
  };
  /** Dropped on a row above, it goes above that row; on a row below, below it. */
  const dirTo = (name: string, over: string): -1 | 1 => (names.indexOf(over) < names.indexOf(name) ? -1 : 1);
  const dropClass = (name: string): string => {
    if (drag === null) return "";
    if (drag.name === name) return "dragging";
    if (drag.over !== name) return "";
    return dirTo(drag.name, name) < 0 ? "drop-before" : "drop-after";
  };

  return (
    <>
      <div className="side-sec">{COMPARISONS_HEADING}</div>
      <ul className="gen" ref={list}>
        {live.map((c, i) => (
          <li key={c.name} data-cmp={c.name} className={dropClass(c.name) || undefined}>
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
                  to={guideViewHash(guide, { kind: "compare", ids: c.ids, saved: c.name })}
                  className={`ent${isOpen(c) ? " open" : ""}`}
                  aria-current={isOpen(c) ? "page" : undefined}
                  title={c.name}
                  onClick={onNavigate}
                >
                  <span className="ent-t">
                    <Txt text={c.name} />
                  </span>
                </Link>
                {owner && (
                  <>
                    {live.length > 1 && (
                      // Drag the grip onto another row to move the comparison there; with the grip
                      // focused, the arrow keys move it one place.
                      <button
                        type="button"
                        className="iconbtn rowact cmp-grip"
                        aria-label={moveLabel(c.name)}
                        title={DRAG_TO_MOVE}
                        disabled={busy}
                        onPointerDown={(e) => {
                          if (e.button !== 0) return;
                          e.preventDefault();
                          e.currentTarget.setPointerCapture(e.pointerId);
                          setDrag({ name: c.name, over: null });
                        }}
                        onPointerMove={(e) => {
                          if (drag?.name !== c.name) return;
                          const over = rowAt(e.clientX, e.clientY);
                          const next = over === c.name ? null : over;
                          if (next !== drag.over) setDrag({ name: c.name, over: next });
                        }}
                        onPointerUp={(e) => {
                          if (drag?.name !== c.name) return;
                          const over = rowAt(e.clientX, e.clientY);
                          setDrag(null);
                          if (over !== null && over !== c.name) void move(c.name, over, dirTo(c.name, over));
                        }}
                        onPointerCancel={() => setDrag(null)}
                        onKeyDown={(e) => {
                          const above = names[i - 1];
                          const below = names[i + 1];
                          if (e.key === "ArrowUp" && above !== undefined) {
                            e.preventDefault();
                            void move(c.name, above, -1);
                          } else if (e.key === "ArrowDown" && below !== undefined) {
                            e.preventDefault();
                            void move(c.name, below, 1);
                          }
                        }}
                      >
                        <Icon n="grip" size={13} />
                      </button>
                    )}
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

/**
 * The compare page's owner-only "Update <name>", on a saved comparison she opened: once she has added,
 * swapped or removed a quadrant, it saves the quadrants on screen as that comparison's diagnoses. It is
 * not shown while the quadrants are the ones saved, or when the comparison is no longer hers.
 */
export function UpdateComparison({ guide, name, ids }: { guide: string; name: string; ids: readonly string[] }): ReactNode {
  const mine = useMine(guide, true);
  const [busy, setBusy] = useState(false);
  const now = mine.state === "ready" ? mine.value.find((c) => c.name === name) : undefined;
  if (now === undefined || now.ids.join(",") === ids.join(",")) return null;

  const update = async (): Promise<void> => {
    setBusy(true);
    const ok = await setComparisonIds(guide, name, ids);
    setBusy(false);
    if (!ok) showToast(COMPARISONS_FAILED);
  };

  return (
    <button type="button" className="btn" disabled={busy} onClick={() => void update()}>
      {updateLabel(name)}
    </button>
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
