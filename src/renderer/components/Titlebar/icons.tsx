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

/** Help — question mark in a circle. */
export function IconHelp({ className, size = 16 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" strokeWidth={2} {...base} aria-hidden="true">
      <circle cx="12" cy="12" r="9.5" />
      <path d="M9.2 9.2a2.9 2.9 0 0 1 5.6 1c0 1.9-2.8 2.8-2.8 2.8" />
      <path d="M12 17.2h.01" />
    </svg>
  );
}

/** DevTools — angle brackets. Replaces the literal `</>` text glyph. */
export function IconCode({ className, size = 16 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" strokeWidth={2} {...base} aria-hidden="true">
      <path d="m16 18 6-6-6-6" />
      <path d="m8 6-6 6 6 6" />
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

/** Settings — 6-lobe rounded cog. Fewer, fatter teeth than the old 12-tooth
 *  filled gear, which is what makes it survive a 16px raster. */
export function IconSettings({ className, size = 16 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" strokeWidth={2} {...base} aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
