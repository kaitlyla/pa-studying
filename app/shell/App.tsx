// The site frame (site-shell): header with tabs and search, sidebar (laptop: panel or 40px rail;
// phone: drawer), the page, the footer, and the overlays. Routes per 10 §10.4.
import { Component, Suspense, useEffect, useRef, useState, type ErrorInfo, type KeyboardEvent, type ReactNode } from "react";
import type { SiteJson } from "../../lib/derive/published.ts";
import type { RefTabId } from "../../lib/derive/routes.ts";
import { NotFoundError, useData } from "../data/load.ts";
import { FilePage } from "../files/FilePage.tsx";
import { ImageViewer } from "../files/imageViewer.tsx";
import { GeneralPage } from "../general/GeneralPage.tsx";
import { OtherPage } from "../general/OtherPage.tsx";
import { RefSidebar, RefTabPage } from "../general/RefTab.tsx";
import { WorkupPage } from "../general/WorkupPage.tsx";
import { PharmPage } from "../pharm/PharmPage.tsx";
import { Picker } from "../picker/Picker.tsx";
import { BlockPage } from "../reader/BlockPage.tsx";
import { GuideHome } from "../reader/GuideHome.tsx";
import { ReviewSlidesPage } from "../reader/ReviewSlidesPage.tsx";
import { SectionPage } from "../reader/SectionPage.tsx";
import { GuideSidebar } from "../reader/Sidebar.tsx";
import { SystemPage } from "../reader/SystemPage.tsx";
import { TopicsPage } from "../reader/TopicsPage.tsx";
import { SearchBox, SearchHighlightProvider, SearchLanding } from "../search/index.ts";
import { UpdatesPage } from "../updates/UpdatesPage.tsx";
import { PageNotFound } from "./errors.ts";
import { NotOnSite } from "./NotOnSite.tsx";
import { trapTab } from "./focus.ts";
import { Icon } from "./Icon.tsx";
import { Link } from "./Link.tsx";
import { OwnerAvatar, PageBanner, SignInDialog, SignInLink, UnsavedDialog, VersionsPage } from "./mounts.tsx";
import { DrawerContext } from "./Page.tsx";
import { setSidebarHidden, useSidebarHidden } from "./prefs.ts";
import { useIsPhone } from "./responsive.ts";
import { parseHash, PANCE, useRoute, type Route } from "./route.ts";
import { TABS } from "./tabs.ts";
import { Toast } from "./toast.tsx";
import { GapChip, UpdChip } from "../render/labels.tsx";

export const SITE_NAME = "PA Studying";


/** The route that decides the tab and sidebar: a file page borrows them from where it was opened. */
function contextRoute(route: Route): Route {
  if (route.kind === "file" && route.query.from) return parseHash(route.query.from);
  return route;
}

export function tabOf(route: Route): string | null {
  const r = contextRoute(route);
  switch (r.kind) {
    case "picker":
      return "eor";
    case "guide":
      return r.guide === PANCE ? "pance" : "eor";
    case "ref":
      return r.tab;
    case "other":
    case "updates":
      return "other";
    default:
      return null;
  }
}

type SidebarKind = { kind: "guide"; guide: string } | { kind: "ref"; tab: RefTabId } | null;

function sidebarOf(route: Route): SidebarKind {
  const r = contextRoute(route);
  if (r.kind === "guide") return { kind: "guide", guide: r.guide };
  if (r.kind === "ref") return { kind: "ref", tab: r.tab };
  return null;
}

function SidebarContent({ which, onNavigate }: { which: NonNullable<SidebarKind>; onNavigate: () => void }): ReactNode {
  return (
    <Suspense fallback={<div className="loading">Loading…</div>}>
      {which.kind === "guide" ? <GuideSidebar guide={which.guide} onNavigate={onNavigate} /> : <RefSidebar tab={which.tab} onNavigate={onNavigate} />}
    </Suspense>
  );
}

// ---- header and footer -----------------------------------------------------------------------------

function Brand(): ReactNode {
  const site = useData<SiteJson>("site.json");
  return site.name;
}

function Header({ phone, tab }: { phone: boolean; tab: string | null }): ReactNode {
  const tabs = (
    <nav className="tabs" aria-label="Sections">
      {TABS.map((t) => (
        <Link key={t.id} to={t.to} className="tab" aria-current={tab === t.id ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
  const brand = (
    <Link to="#/" className="brand">
      <Suspense fallback={SITE_NAME}>
        <Brand />
      </Suspense>
    </Link>
  );
  if (phone) {
    return (
      <header className="hdr">
        <div className="hdr-top">
          {brand}
          <div className="hdr-right">
            <SearchBox phone />
            <OwnerAvatar />
          </div>
        </div>
        {tabs}
      </header>
    );
  }
  return (
    <header className="hdr">
      {brand}
      {tabs}
      <div className="hdr-right">
        <SearchBox phone={false} />
        <OwnerAvatar />
      </div>
    </header>
  );
}

function Footer(): ReactNode {
  return (
    <footer className="foot">
      <span>{SITE_NAME}</span>
      <span className="own-only legend">
        Anything not from your notes is marked <GapChip /> or <UpdChip />
      </span>
      <SignInLink />
    </footer>
  );
}

// ---- pages -----------------------------------------------------------------------------------------

interface BoundaryState {
  error: Error | null;
}

/** Shows "isn't on the site" for a missing data file, and a plain message for any other failure. */
export class PageBoundary extends Component<{ children?: ReactNode; resetKey: string }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidUpdate(prev: { resetKey: string }): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (!(error instanceof NotFoundError || error instanceof PageNotFound)) console.error(error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (error instanceof NotFoundError || error instanceof PageNotFound) return <NotOnSite />;
    return (
      <div className="notfound" role="alert">
        <h1>This page couldn't load</h1>
        <p>Check the connection and reload the page.</p>
      </div>
    );
  }
}

function PageFor({ route }: { route: Route }): ReactNode {
  switch (route.kind) {
    case "picker":
      return <Picker />;
    case "guide": {
      const { guide, view } = route;
      switch (view.kind) {
        case "home":
          return <GuideHome guide={guide} />;
        case "system":
          return <SystemPage guide={guide} system={view.system} />;
        case "section":
          return <SectionPage guide={guide} system={view.system} section={view.section} />;
        case "topics":
          return <TopicsPage guide={guide} ids={view.ids} />;
        case "block":
          return <BlockPage guide={guide} block={view.id} />;
        case "pharm":
          return <PharmPage guide={guide} system={view.system} section={view.section} target={view.target} />;
        case "general":
          return <GeneralPage guide={guide} topic={view.key} />;
        case "workup":
          return <WorkupPage guide={guide} item={view.item} />;
        case "slides":
          return <ReviewSlidesPage guide={guide} n={view.n} />;
      }
      return <NotOnSite />;
    }
    case "ref":
      return <RefTabPage tab={route.tab} sub={route.sub} />;
    case "other":
      return <OtherPage section={route.section} />;
    case "updates":
      return <UpdatesPage />;
    case "file":
      return <FilePage doc={route.doc} from={route.query.from} />;
    case "versions":
      return <VersionsPage pageKey={route.pageKey} />;
    case "notfound":
      return <NotOnSite />;
  }
}

// ---- the frame -------------------------------------------------------------------------------------

function Drawer({ which, onClose }: { which: NonNullable<SidebarKind>; onClose: () => void }): ReactNode {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
  }, []);
  const onKey = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    trapTab(e);
  };
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="side drawer" aria-label="Contents" role="dialog" aria-modal="true" onKeyDown={onKey}>
        <div className="drawer-top">
          <button type="button" ref={close} className="iconbtn" aria-label="Close contents" onClick={onClose}>
            <Icon n="x" />
          </button>
        </div>
        <SidebarContent which={which} onNavigate={onClose} />
      </aside>
    </>
  );
}

function LaptopSidebar({ which }: { which: NonNullable<SidebarKind> }): ReactNode {
  const hidden = useSidebarHidden();
  const hideBtn = useRef<HTMLButtonElement>(null);
  const showBtn = useRef<HTMLButtonElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    // Focus follows the button that reappears (Hide ↔ rail), but not on first load.
    if (!moved.current) return;
    (hidden ? showBtn : hideBtn).current?.focus();
  }, [hidden]);
  const toggle = (h: boolean): void => {
    moved.current = true;
    setSidebarHidden(h);
  };
  if (hidden) {
    return (
      <div className="side-rail">
        <button type="button" ref={showBtn} aria-expanded={false} aria-controls="site-sidebar" aria-label="Show sidebar" title="Show sidebar" onClick={() => toggle(false)}>
          <Icon n="show" />
          <span className="rail-t" aria-hidden="true">
            Contents
          </span>
        </button>
      </div>
    );
  }
  return (
    <aside className="side" id="site-sidebar" aria-label="Contents">
      <div className="side-bar">
        <span>Contents</span>
        <button type="button" ref={hideBtn} className="side-collapse" aria-expanded={true} aria-controls="site-sidebar" title="Hide sidebar" onClick={() => toggle(true)}>
          <Icon n="hide" size={14} />
          Hide
        </button>
      </div>
      <SidebarContent which={which} onNavigate={() => {}} />
    </aside>
  );
}

export function App(): ReactNode {
  const route = useRoute();
  const phone = useIsPhone();
  const [drawerOpen, setDrawerOpen] = useState<string | null>(null);
  const which = sidebarOf(route);
  const mainRef = useRef<HTMLElement>(null);
  const routeKey = route.path;

  useEffect(() => {
    mainRef.current?.scrollTo?.({ top: 0 });
  }, [routeKey]);

  // The drawer belongs to the route it was opened on; navigating closes it.
  const drawer = drawerOpen === routeKey && phone && which !== null;
  const openDrawer = which && phone ? () => setDrawerOpen(routeKey) : null;

  return (
    <div className={`site${phone ? " is-phone" : ""}`}>
      <a className="skip" href="#page" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>
        Skip to the page
      </a>
      <Header phone={phone} tab={tabOf(route)} />
      <div className="body">
        {which && !phone && <LaptopSidebar which={which} />}
        <main className="main" id="page" ref={mainRef} tabIndex={-1}>
          <div className="main-in">
            <DrawerContext.Provider value={openDrawer}>
              <SearchHighlightProvider>
                <PageBanner />
                <SearchLanding />
                <PageBoundary resetKey={routeKey}>
                  <Suspense fallback={<div className="loading">Loading…</div>}>
                    <PageFor route={route} />
                  </Suspense>
                </PageBoundary>
              </SearchHighlightProvider>
            </DrawerContext.Provider>
            <Footer />
          </div>
        </main>
      </div>
      {drawer && which && <Drawer which={which} onClose={() => setDrawerOpen(null)} />}
      <ImageViewer />
      <SignInDialog />
      <UnsavedDialog />
      <Toast />
    </div>
  );
}
