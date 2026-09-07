/** Solid playback glyphs; surrounding controls supply size and theme color. */
export function SolidPlay() {
  return <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true" focusable="false">
    <path d="M6 4.6c0-1.2 1.3-1.95 2.34-1.34l12.1 7.4a1.57 1.57 0 0 1 0 2.68l-12.1 7.4C7.3 21.35 6 20.6 6 19.4Z" />
  </svg>;
}

export function SolidPause() {
  return <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true" focusable="false">
    <rect x="5" y="3" width="5" height="18" rx="1.5" />
    <rect x="14" y="3" width="5" height="18" rx="1.5" />
  </svg>;
}

/**
 * lucide's `square-arrow-right-enter`, drawn here rather than imported.
 *
 * It arrived in lucide 1.x and this app is on 0.468; pulling a major version
 * of the icon set through for one glyph would restyle every other icon in the
 * app. The paths are lucide's own (ISC), at lucide's stroke settings, so it
 * sits beside the imported ones without looking hand-drawn.
 */
export function SourceSwapIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="m10 16 4-4-4-4" />
    <path d="M3 12h11" />
    <path d="M3 8V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3" />
  </svg>;
}
