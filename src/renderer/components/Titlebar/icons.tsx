// Inline SVG icons for the titlebar control cluster.
// Same contract as `SplitPane/icons.tsx`: stroke-based, viewBox 24, inherit
// `currentColor` so the 0.4 -> 0.9 opacity hover in titlebar.css still drives them.
//
// These replace filled Octicons (a 12-tooth `gear-16`, a solid bell) that were
// rendered at 14px: at that size each gear tooth lands under a pixel and the
// rasteriser returns a jagged edge. Stroke geometry holds its weight because the
// stroke width -- not micro-detail -- is the dominant feature.
import React from 'react';

interface IconProps {
  className?: string;
  size?: number;
}

const base = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/** Sidebar — a window with a narrow navigation panel on the left. */
export function IconSidebar({ className, size = 16 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" strokeWidth={2} {...base} aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  );
}

/** Notifications — outline bell with clapper. */
export function IconBell({ className, size = 16 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" strokeWidth={2} {...base} aria-hidden="true">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

/** Agent office (easter egg) — tiny pixel invader, drawn as filled squares so
 *  it reads as "pixel art" at 16px where strokes would blur. */
export function IconPixelAgent({ className, size = 16 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
      <rect x="6" y="3" width="3" height="3" />
      <rect x="15" y="3" width="3" height="3" />
      <rect x="3" y="6" width="18" height="3" />
      <rect x="3" y="9" width="3" height="3" />
      <rect x="9" y="9" width="6" height="3" />
      <rect x="18" y="9" width="3" height="3" />
      <rect x="3" y="12" width="18" height="3" />
      <rect x="6" y="15" width="3" height="3" />
      <rect x="15" y="15" width="3" height="3" />
      <rect x="3" y="18" width="3" height="3" />
      <rect x="18" y="18" width="3" height="3" />
    </svg>
  );
}

/** Settings — 6-lobe rounded cog. Fewer, fatter teeth than the old 12-tooth
 *  filled gear, which is what makes it survive a 16px raster. */
/** Focus mode — a circle half in shadow: one side lit, the other dimmed,
 *  which is what the mode does to the panes. */
export function IconFocus({ className, size = 16 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" strokeWidth={2} {...base} aria-hidden="true">
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 2.5a9.5 9.5 0 0 1 0 19z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconSettings({ className, size = 16 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" strokeWidth={2} {...base} aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** File explorer (#324) — an outline folder, the same glyph every editor uses
 *  for the side panel that lists files. */
export function IconFolder({ className, size = 16 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" strokeWidth={2} {...base} aria-hidden="true">
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.3l2 2.5h8.7A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />
    </svg>
  );
}

export function IconBrowser({ className, size = 16 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" strokeWidth={2} {...base} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="4" ry="9" />
      <path d="M3 12h18" />
    </svg>
  );
}

/** Git branch — the project Git view (#362). */
export function IconGitBranch({ className, size = 16 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" strokeWidth={2} {...base} aria-hidden="true">
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="7" r="2" />
      <path d="M6 7v10" />
      <path d="M18 9c0 5-6 4-11.2 8.6" />
    </svg>
  );
}

/** Coffee cup — Keep awake (caffeine / lid) icon */
export function IconCoffee({ className, size = 16, active = false }: IconProps & { active?: boolean }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" strokeWidth={2} {...base} aria-hidden="true">
      <path d="M18 8h1a4 4 0 0 1 0 8h-1" />
      <path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z" />
      <line x1="6" y1="1" x2="6" y2="4" strokeOpacity={active ? 1 : 0.4} />
      <line x1="10" y1="1" x2="10" y2="4" strokeOpacity={active ? 1 : 0.4} />
      <line x1="14" y1="1" x2="14" y2="4" strokeOpacity={active ? 1 : 0.4} />
    </svg>
  );
}
