// Search UI (60 §60.5). The shell mounts <SearchBox> in the header, wraps the main content in
// <SearchHighlightProvider> with <SearchLanding> at its top, and renders text runs through <HitText>
// (inside a paragraph's <HitBlock>, with each run's offset in the paragraph's joined text).
export { SearchBox } from "./SearchBox.tsx";
export { HitBlock, HitText, SearchHighlightProvider, SearchLanding } from "./SearchLanding.tsx";
