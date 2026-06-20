// Inline SVG icons for the terminal toolbar control cluster (issue #34).
// Stroke-based, inherit `currentColor` so hover accents come from CSS.
// NOTE: a future issue may migrate these to `lucide-react` once icon usage
// spreads across the UI — keeping them in one file makes that swap trivial.
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

/** New tab — plus inside a rounded square ("add a tab"). */
export function IconAdd({ className, size = 16 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" strokeWidth={2} {...base}>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <line x1="12" y1="8" x2="12" y2="16" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  );
}

/** Layout / split right — two side-by-side panes (vertical divider). */
export function IconSplit({ className, size = 16 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" strokeWidth={2} {...base}>
      <rect x="3" y="4" width="7" height="16" rx="1.5" />
      <rect x="14" y="4" width="7" height="16" rx="1.5" />
    </svg>
  );
}

/** Split down — two stacked panes (horizontal divider). */
export function IconSplitDown({ className, size = 16 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" strokeWidth={2} {...base}>
      <rect x="4" y="3" width="16" height="7" rx="1.5" />
      <rect x="4" y="14" width="16" height="7" rx="1.5" />
    </svg>
  );
}

/** Close — clean X. */
export function IconClose({ className, size = 16 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" strokeWidth={2.2} {...base}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

/** Dropdown caret — chevron down. */
export function IconCaret({ className, size = 9 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" strokeWidth={2.5} {...base}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
