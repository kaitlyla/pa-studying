// Her comparison favorites (site/compare): the topic pairs she compares, "both ways". Saved to the
// site through the owner's own save path (50 §50.4) as one content file per guide, so every device she
// signs in on shows them; a visitor neither reads nor sees them. The pairs a compare quadrant's menu
// shows come from here, and each change re-reads the file first, so two devices merge instead of losing.
import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { favoritesPath, type FavoritesFile } from "../../lib/content/index.ts";
import { Icon } from "../shell/Icon.tsx";
import { showToast } from "../shell/toast.tsx";
import { setOwnerFileValue, useOwnerFile, writeOwnerFile } from "./ownerFile.ts";

/** A pair of topic ids, in id order (the pair stands for both directions). */
export type Pair = [string, string];

export const FAVORITES_FAILED = "Couldn’t save the favorite. Check your connection and try again.";
export const FAVORITES_LOAD_FAILED = "Couldn’t load your favorites.";
export const NO_FAVORITES = "No saved favorites yet.";
export const FAVORITES_HEADING = "Saved favorites";
export const SAVE_HEADING = "Save a favorite";
export const OPEN_NOW = "Open now";
export const compareWith = (title: string): string => `Compare with ${title}`;
export const saveFavorite = (title: string): string => `Save ${title} as a favorite`;
export const removeFavorite = (title: string): string => `Remove ${title} from favorites`;

/** `a,b` for a pair, both ways. */
const pairKey = (x: string, y: string): string => (x < y ? `${x},${y}` : `${y},${x}`);

/** The canonical pair list: each pair in id order, the list sorted, no pair twice, no topic with itself. */
export function pairList(pairs: Iterable<Pair>): Pair[] {
  const byKey = new Map<string, Pair>();
  for (const [x, y] of pairs) if (x !== y) byKey.set(pairKey(x, y), x < y ? [x, y] : [y, x]);
  return [...byKey.entries()].sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0)).map(([, pair]) => pair);
}

export interface GuideFavorites {
  state: "idle" | "loading" | "ready" | "error";
  pairs: Pair[];
}

const isEqual = (x: readonly Pair[], y: readonly Pair[]): boolean => JSON.stringify(x) === JSON.stringify(y);

/** The guide's pairs for the menu; read once per session (a change re-reads before it writes). */
export function useFavorites(guide: string): GuideFavorites {
  const file = useOwnerFile<Pair[]>(favoritesPath(guide), [], true, async (snapshot) =>
    pairList((await snapshot.jsonIfExists<FavoritesFile>(favoritesPath(guide)))?.pairs ?? []),
  );
  return { state: file.state, pairs: file.value };
}

/**
 * Adds or removes the pair (one commit, `subject` as its subject line). A set operation on a fresh
 * read, so a save that raced another device's is retried against what is there rather than lost.
 */
export async function setFavorite(guide: string, x: string, y: string, add: boolean, subject: string): Promise<boolean> {
  const path = favoritesPath(guide);
  const outcome = await writeOwnerFile<FavoritesFile>(path, "favorites", subject, (file) => {
    const pairs = pairList(file?.pairs ?? []);
    const next = add ? pairList([...pairs, [x, y]]) : pairs.filter(([a, b]) => `${a},${b}` !== pairKey(x, y));
    return isEqual(next, pairs) ? null : { v: 1, pairs: next };
  });
  if (outcome.file) setOwnerFileValue(path, pairList(outcome.file.pairs));
  return outcome.kind !== "failed";
}

/** The guide's diagnoses, grouped as the sidebar and the quadrant picker list them. */
export interface DxGroup {
  id: string;
  title: string;
  entries: readonly { id: string; title: string }[];
}

/** One heading of the menu's save list. */
export interface SaveGroup {
  id: string;
  title: string;
  entries: { id: string; title: string }[];
}

export interface MenuModel {
  /** The saved favorites offered: the partner, when it is not already on screen. */
  offered: string[];
  /** The save list: the diagnoses on screen first, then every other one, grouped as the picker lists them. */
  groups: SaveGroup[];
}

const OPEN_NOW_ID = "open-now";

/**
 * What the menu offers for `id`: its saved partners (both ways) that are not on screen, and every
 * diagnosis of the guide to save — the ones on screen first, then the rest grouped by system. `id`
 * itself and the saved ones stay out; a diagnosis from the partners above is not listed again below.
 */
export function menuModel(groups: readonly DxGroup[], pairs: readonly Pair[], id: string, open: readonly string[]): MenuModel {
  const titles = new Map(groups.flatMap((g) => g.entries.map((e) => [e.id, e.title] as const)));
  const here = new Set(open.filter((x) => x !== "" && x !== id));
  const saved = new Set(pairs.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)));
  const onScreen = [...here].filter((x) => !saved.has(x)).map((x) => ({ id: x, title: titles.get(x) ?? x }));
  return {
    offered: [...saved].filter((x) => !here.has(x)),
    groups: [
      ...(onScreen.length > 0 ? [{ id: OPEN_NOW_ID, title: OPEN_NOW, entries: onScreen }] : []),
      ...groups
        .map((g) => ({ id: g.id, title: g.title, entries: g.entries.filter((e) => e.id !== id && !saved.has(e.id) && !here.has(e.id)) }))
        .filter((g) => g.entries.length > 0),
    ],
  };
}

export interface FavoriteMenuProps {
  guide: string;
  /** This quadrant's diagnosis. */
  id: string;
  /** The diagnoses open in the quadrants, this one included. */
  others: readonly string[];
  /** The guide's diagnoses, grouped as the quadrant picker lists them. */
  groups: readonly DxGroup[];
  /** She picked a saved partner: the compare view puts it in the next quadrant. */
  onPick: (dx: string) => void;
  /** The title shown for a diagnosis. */
  titleOf: (dx: string) => string;
}

/**
 * The favorites menu of one compared diagnosis (owner-only; the compare view mounts it only for her).
 * Its save list holds every diagnosis of the guide — the ones on screen first — and it stays open, so
 * she can favorite several in a row and fill the quadrants one after another.
 */
export function FavoriteMenu({ guide, id, others, groups, onPick, titleOf }: FavoriteMenuProps): ReactNode {
  const fav = useFavorites(guide);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
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

  const model = menuModel(groups, fav.pairs, id, others);

  const toggle = async (other: string, add: boolean): Promise<void> => {
    setBusy(true);
    const ok = await setFavorite(guide, id, other, add, `Favorites: ${titleOf(id)} + ${titleOf(other)}`);
    if (!ok) showToast(FAVORITES_FAILED);
    setBusy(false);
  };

  return (
    <span className="favm" ref={root} onKeyDown={onKey}>
      <button type="button" className="btn" ref={button} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Favorites
      </button>
      {open && (
        <div className="menu" role="menu" aria-label={`Favorites for ${titleOf(id)}`}>
          {fav.state === "error" && <div className="mh">{FAVORITES_LOAD_FAILED}</div>}
          {model.offered.length > 0 && <div className="mh">{FAVORITES_HEADING}</div>}
          {model.offered.map((p) => (
            <div className="fmenu-row" key={p}>
              <button type="button" role="menuitem" onClick={() => onPick(p)}>
                {compareWith(titleOf(p))}
              </button>
              <button type="button" className="iconbtn" aria-label={removeFavorite(titleOf(p))} disabled={busy} onClick={() => void toggle(p, false)}>
                <Icon n="x" size={14} />
              </button>
            </div>
          ))}
          {model.groups.length > 0 && <div className="mh">{SAVE_HEADING}</div>}
          {model.groups.map((g) => (
            <Fragment key={g.id}>
              <div className="mh">{g.title}</div>
              {g.entries.map((e) => (
                <button key={e.id} type="button" role="menuitem" disabled={busy} onClick={() => void toggle(e.id, true)}>
                  {saveFavorite(e.title)}
                </button>
              ))}
            </Fragment>
          ))}
          {fav.state !== "loading" && fav.state !== "error" && model.offered.length === 0 && model.groups.length === 0 && (
            <div className="mh">{NO_FAVORITES}</div>
          )}
        </div>
      )}
    </span>
  );
}
