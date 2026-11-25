/**
 * Custom app-chrome colors: `[appearance.colors]` in config.toml overrides the
 * `--ui-*` CSS variables the sidebar, tabs, pane frames and docks are painted
 * with. Pure and shared so main validates and the renderer applies the same table.
 */
export const UI_COLOR_KEYS = [
  'accent',
  'bg-0', 'bg-1', 'bg-2', 'bg-3', 'bg-4', 'bg-5',
  'border', 'border-strong',
  'text-primary', 'text-secondary', 'text-muted',
] as const;
export type UiColorKey = (typeof UI_COLOR_KEYS)[number];
export type UiColors = Partial<Record<UiColorKey, string>>;

const HEX = /^#([0-9a-f]{6})$/i;

export function isUiColorKey(k: string): k is UiColorKey {
  return (UI_COLOR_KEYS as readonly string[]).includes(k);
}

/** `#rrggbb` only (no alpha, no shorthand), lower-cased; undefined when invalid. */
export function normalizeUiColor(v: string): string | undefined {
  return HEX.test(v) ? v.toLowerCase() : undefined;
}

/** CSS custom properties for a validated table. `accent` also sets `--ui-accent-rgb`. */
export function uiColorVars(colors: UiColors): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of UI_COLOR_KEYS) {
    const v = colors[k];
    if (!v) continue;
    out[`--ui-${k}`] = v;
    if (k === 'accent') {
      const n = parseInt(v.slice(1), 16);
      out['--ui-accent-rgb'] = `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
    }
  }
  return out;
}
