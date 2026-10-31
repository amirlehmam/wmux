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

/** Surface types share the toolbar's stroke vocabulary in tabs and menus. */
export function IconSurface({ type, isAgent = false, size = 14 }: IconProps & { type: string; isAgent?: boolean }) {
  let drawing: React.ReactNode;
  switch (type) {
    case 'terminal':
      drawing = <><path d="m5 6 6 6-6 6" /><path d={isAgent ? 'M13 18h6' : 'M14 18h4'} /></>;
      break;
    case 'browser':
      drawing = <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></>;
      break;
    case 'markdown':
      drawing = <><path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h6" /></>;
      break;
    case 'diff':
      drawing = <><path d="M4 7h7M7.5 3.5v7M14 17h7M12 3v18" /></>;
      break;
    case 'code':
      drawing = <><path d="m7 6-5 6 5 6m10-12 5 6-5 6M14 3l-4 18" /></>;
      break;
    case 'prompts':
      drawing = <><path d="m3 5 4 4-4 4M11 5h10M11 9h7M3 19h18M3 15h18" /></>;
      break;
    case 'git':
      drawing = <><circle cx="6" cy="5" r="2" /><circle cx="18" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10M18 7v2a5 5 0 0 1-5 5H6" /></>;
      break;
    default:
      drawing = <rect x="4" y="4" width="16" height="16" rx="3" />;
  }
  return <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" strokeWidth={1.7} {...base}>{drawing}</svg>;
}

export function IconDuplicate({ size = 14 }: IconProps) {
  return <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" strokeWidth={1.7} {...base}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4H4v12h4" /></svg>;
}
