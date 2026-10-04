// The head of every page: breadcrumbs, title, actions; on phone the Contents button and, on pages
// with her tables, the Stacked/Table switch (guide-reader/phone-tables).
import { createContext, useContext, type ReactNode } from "react";
import { Icon } from "./Icon.tsx";
import { Link } from "./Link.tsx";
import { setTableMode, useTableMode } from "./prefs.ts";
import { useIsPhone } from "./responsive.ts";

export interface Crumb {
  label: string;
  to?: string;
}

export function Crumbs({ items }: { items: readonly Crumb[] }): ReactNode {
  return (
    <nav className="crumbs" aria-label="Location">
      {items.map((c, i) => (
        <span key={i} className="crumb">
          {i > 0 && <span aria-hidden="true">›</span>}
          {c.to ? <Link to={c.to}>{c.label}</Link> : <span aria-current={i === items.length - 1 ? "page" : undefined}>{c.label}</span>}
        </span>
      ))}
    </nav>
  );
}

/** Opens the phone Contents drawer; provided by the shell when the page has a sidebar. */
export const DrawerContext = createContext<(() => void) | null>(null);

export function TableModeSwitch(): ReactNode {
  const mode = useTableMode();
  return (
    <span className="layout-tog" role="group" aria-label="Table layout">
      <button type="button" aria-pressed={mode === "stacked"} onClick={() => setTableMode("stacked")}>
        Stacked
      </button>
      <button type="button" aria-pressed={mode === "table"} onClick={() => setTableMode("table")}>
        Table
      </button>
    </span>
  );
}

/** True when her tables should render stacked (phone, Stacked chosen). */
export function useStacked(): boolean {
  const phone = useIsPhone();
  const mode = useTableMode();
  return phone && mode === "stacked";
}

export interface PageHeadProps {
  crumbs: readonly Crumb[];
  title: ReactNode;
  actions?: ReactNode;
  /** The page shows her tables: offer the Stacked/Table switch on phone. */
  tables?: boolean;
}

export function PageHead({ crumbs, title, actions, tables = false }: PageHeadProps): ReactNode {
  const phone = useIsPhone();
  const openDrawer = useContext(DrawerContext);
  return (
    <>
      <Crumbs items={crumbs} />
      <div className="ph">
        <h1>{title}</h1>
        <div className="acts">
          {phone && tables && <TableModeSwitch />}
          {actions}
        </div>
      </div>
      {phone && openDrawer && (
        <button type="button" className="contents-btn" onClick={openDrawer}>
          <Icon n="menu" />
          Contents
        </button>
      )}
    </>
  );
}
