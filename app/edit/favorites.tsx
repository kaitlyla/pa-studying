// Her comparison favorites (site/compare): the topic pairs she compares, "both ways". Saved to the
// site through the owner's own save path (50 §50.4) as one content file per guide, so every device she
// signs in on shows them; a visitor neither reads nor sees them. The pairs a compare quadrant's menu
// shows come from here, and each change re-reads the file first, so two devices merge instead of losing.
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { commitMessage, favoritesPath, serializeFile, type FavoritesFile } from "../../lib/content/index.ts";
import { Icon } from "../shell/Icon.tsx";
import { showToast } from "../shell/toast.tsx";
import { commitChanges } from "./commit.ts";
import { repo } from "./session.ts";
import { Snapshot } from "./snapshot.ts";

/** A pair of topic ids, in id order (the pair stands for both directions). */
export type Pair = [string, string];

export const FAVORITES_FAILED = "Couldn’t save the favorite. Check your connection and try again.";
export const FAVORITES_LOAD_FAILED = "Couldn’t load your favorites.";
export const NO_FAVORITES = "No saved favorites yet.";
export const FAVORITES_HEADING = "Saved favorites";
export const SAVE_HEADING = "Save a favorite";
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

const EMPTY: GuideFavorites = { state: "idle", pairs: [] };
const guides = new Map<string, GuideFavorites>();
const listeners = new Set<() => void>();

const stateOf = (guide: string): GuideFavorites => guides.get(guide) ?? EMPTY;

function setGuide(guide: string, next: GuideFavorites): void {
  guides.set(guide, next);
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Clears the session's cache (tests). */
export function resetFavoritesForTests(): void {
  guides.clear();
  for (const l of listeners) l();
}

const isEqual = (x: readonly Pair[], y: readonly Pair[]): boolean => JSON.stringify(x) === JSON.stringify(y);

/** The guide's saved pairs as the file holds them, with the snapshot they were read at. */
async function read(guide: string): Promise<{ pairs: Pair[]; snapshot: Snapshot }> {
  const { git } = await repo();
  const snapshot = await Snapshot.at(git);
  const file = await snapshot.jsonIfExists<FavoritesFile>(favoritesPath(guide));
  return { pairs: pairList(file?.pairs ?? []), snapshot };
}

/** The guide's pairs for the menu; read once per session (a change re-reads before it writes). */
export function useFavorites(guide: string): GuideFavorites {
  const state = useSyncExternalStore(subscribe, () => stateOf(guide), () => stateOf(guide));
  useEffect(() => {
    const now = stateOf(guide);
    if (now.state === "loading" || now.state === "ready") return;
    setGuide(guide, { state: "loading", pairs: now.pairs });
    void read(guide).then(
      ({ pairs }) => setGuide(guide, { state: "ready", pairs }),
      (e: unknown) => {
        console.warn("Couldn’t read your favorites", e);
        setGuide(guide, { state: "error", pairs: [] });
      },
    );
  }, [guide]);
  return state;
}

/**
 * Adds or removes the pair (one commit, `subject` as its subject line). A set operation on a fresh
 * read, so a save that raced another device's is retried against what is there rather than lost.
 */
export async function setFavorite(guide: string, x: string, y: string, add: boolean, subject: string): Promise<boolean> {
  const path = favoritesPath(guide);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { pairs, snapshot } = await read(guide);
      const next = add ? pairList([...pairs, [x, y]]) : pairs.filter(([a, b]) => `${a},${b}` !== pairKey(x, y));
      if (isEqual(next, pairs)) {
        setGuide(guide, { state: "ready", pairs });
        return true;
      }
      const { git, site } = await repo();
      const outcome = await commitChanges({
        git,
        base: snapshot.commit,
        baseFiles: snapshot.files,
        scope: { files: [path], dirs: [] },
        changes: [{ path, content: serializeFile(path, { v: 1, pairs: next } satisfies FavoritesFile) }],
        message: commitMessage(subject, { kind: "favorites" }),
        author: { name: site.owner.commitName, email: site.owner.commitEmail },
      });
      if (outcome.kind === "saved") {
        setGuide(guide, { state: "ready", pairs: next });
        return true;
      }
      if (outcome.kind !== "conflict") {
        console.warn("Couldn’t save your favorites", outcome.kind);
        return false;
      }
    }
    return false;
  } catch (e) {
    console.warn("Couldn’t save your favorites", e);
    return false;
  }
}

export interface FavoriteMenuProps {
  guide: string;
  /** This quadrant's diagnosis. */
  id: string;
  /** The diagnoses open in the quadrants, this one included. */
  others: readonly string[];
  /** There is room for one more: an empty quadrant, or a free slot. */
  canPick: boolean;
  /** She picked a saved partner: the compare view puts it in the next empty quadrant. */
  onPick: (dx: string) => void;
  /** The title shown for a diagnosis. */
  titleOf: (dx: string) => string;
}

/** The favorites menu of one compared diagnosis (owner-only; the compare view mounts it only for her). */
export function FavoriteMenu({ guide, id, others, canPick, onPick, titleOf }: FavoriteMenuProps): ReactNode {
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

  const partners = fav.pairs.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a));
  const open2 = [...new Set(others.filter((x) => x !== "" && x !== id))];
  const saveable = open2.filter((x) => !partners.includes(x));

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
          {partners.length > 0 && <div className="mh">{FAVORITES_HEADING}</div>}
          {partners.map((p) => (
            <div className="fmenu-row" key={p}>
              <button type="button" role="menuitem" disabled={!canPick} onClick={() => { setOpen(false); onPick(p); }}>
                {compareWith(titleOf(p))}
              </button>
              <button type="button" className="iconbtn" aria-label={removeFavorite(titleOf(p))} disabled={busy} onClick={() => void toggle(p, false)}>
                <Icon n="x" size={14} />
              </button>
            </div>
          ))}
          {saveable.length > 0 && <div className="mh">{SAVE_HEADING}</div>}
          {saveable.map((o) => (
            <button key={o} type="button" role="menuitem" disabled={busy} onClick={() => void toggle(o, true)}>
              {saveFavorite(titleOf(o))}
            </button>
          ))}
          {fav.state !== "loading" && fav.state !== "error" && partners.length === 0 && saveable.length === 0 && (
            <div className="mh">{NO_FAVORITES}</div>
          )}
        </div>
      )}
    </span>
  );
}
