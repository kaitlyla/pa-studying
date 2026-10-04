// Reading preferences kept in localStorage (40 §40.9): sidebar hidden (guide-reader/hide-sidebar) and
// the phone table mode (guide-reader/phone-tables).
import { useSyncExternalStore } from "react";

export type TableMode = "stacked" | "table";

const KEYS = { sidebarHidden: "pa.sidebarHidden", tableMode: "pa.tableMode" } as const;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode): the choice lasts for this page only.
  }
}

let sidebarHidden = read(KEYS.sidebarHidden) === "1";
let tableMode: TableMode = read(KEYS.tableMode) === "table" ? "table" : "stacked";
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function setSidebarHidden(hidden: boolean): void {
  sidebarHidden = hidden;
  write(KEYS.sidebarHidden, hidden ? "1" : "0");
  emit();
}

export function setTableMode(mode: TableMode): void {
  tableMode = mode;
  write(KEYS.tableMode, mode);
  emit();
}

export function useSidebarHidden(): boolean {
  return useSyncExternalStore(subscribe, () => sidebarHidden);
}

export function useTableMode(): TableMode {
  return useSyncExternalStore(subscribe, () => tableMode);
}

/** Re-reads both preferences from storage (another tab, or a test that seeded storage). */
export function reloadPrefs(): void {
  sidebarHidden = read(KEYS.sidebarHidden) === "1";
  tableMode = read(KEYS.tableMode) === "table" ? "table" : "stacked";
  emit();
}
