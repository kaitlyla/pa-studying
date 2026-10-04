// Search UI (60 §60.5). The shell mounts <SearchBox> in the header, wraps the main content in
// <SearchHighlightProvider> with <SearchLanding> at its top, and renders text runs through <HitText>.
export { SearchBox } from "./SearchBox.tsx";
export { HitText, SearchHighlightProvider, SearchLanding } from "./SearchLanding.tsx";
