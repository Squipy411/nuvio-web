import type { ReactNode } from "react";

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
 * lucide glyphs that arrived in its 1.x, drawn here rather than imported.
 *
 * This app is on lucide 0.468, and pulling a major version of the icon set
 * through for three glyphs would restyle every other icon in it. The paths are
 * lucide's own (ISC) at lucide's stroke settings, so they sit beside the
 * imported ones without looking hand-drawn.
 */
function LucideOutline({ children }: { children: ReactNode }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>;
}

/** `square-arrow-right-enter` */
export function SourceSwapIcon() {
  return <LucideOutline>
    <path d="m10 16 4-4-4-4" />
    <path d="M3 12h11" />
    <path d="M3 8V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3" />
  </LucideOutline>;
}

/** `closed-caption` */
export function ClosedCaptionIcon() {
  return <LucideOutline>
    <path d="M10 9.17a3 3 0 1 0 0 5.66" />
    <path d="M17 9.17a3 3 0 1 0 0 5.66" />
    <rect x="2" y="5" width="20" height="14" rx="2" />
  </LucideOutline>;
}

/** `hd` */
export function HdIcon() {
  return <LucideOutline>
    <path d="M10 12H6" />
    <path d="M10 15V9" />
    <path d="M14 14.5a.5.5 0 0 0 .5.5h1a2.5 2.5 0 0 0 2.5-2.5v-1A2.5 2.5 0 0 0 15.5 9h-1a.5.5 0 0 0-.5.5z" />
    <path d="M6 15V9" />
    <rect x="2" y="5" width="20" height="14" rx="2" />
  </LucideOutline>;
}
