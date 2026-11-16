/**
 * The workspace indicator: a small pill beside a workspace's name, set from
 * outside (`wmux set-indicator`) to flag a state the name should not carry,
 * e.g. that the session runs on a remote machine. It is deliberately not part
 * of the title, so wmux keeps naming the workspace itself.
 */
export interface WorkspaceIndicator {
  text: string;
  /** A CSS colour (`#rgb` / `#rrggbb`). Absent means the theme accent. */
  color?: string;
}

/** Longest text shown; the rest is cut so the pill cannot crowd out the title. */
export const INDICATOR_MAX_LENGTH = 16;

const NAMED_COLORS: Record<string, string> = {
  red: '#C0392B',
  orange: '#D68910',
  amber: '#f59e0b',
  yellow: '#D4AC0D',
  green: '#27AE60',
  teal: '#16A085',
  blue: '#2E86C1',
  purple: '#8E44AD',
  pink: '#D81B60',
  gray: '#7F8C8D',
};

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** `#rgb`, `#rrggbb` or a preset name, as a hex colour; anything else is undefined. */
export function resolveIndicatorColor(color: string | undefined): string | undefined {
  const value = (color ?? '').trim();
  if (HEX_COLOR.test(value)) return value;
  return NAMED_COLORS[value.toLowerCase()];
}

/**
 * The indicator for a `set-indicator` request, or undefined when the text is
 * empty (which clears it). An unusable colour is dropped rather than refused,
 * so the caller still gets its indicator, in the accent colour.
 */
export function normalizeIndicator(text: unknown, color: unknown): WorkspaceIndicator | undefined {
  const label = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  if (!label) return undefined;
  const resolved = resolveIndicatorColor(typeof color === 'string' ? color : undefined);
  return {
    text: Array.from(label).slice(0, INDICATOR_MAX_LENGTH).join(''),
    ...(resolved ? { color: resolved } : {}),
  };
}
