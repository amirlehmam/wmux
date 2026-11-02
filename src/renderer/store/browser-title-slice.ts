import { StateCreator } from 'zustand';
import { evictOscTitles, normalizeOscTitle, type OscTitleEntry } from './osc-title-slice';

/**
 * surfaceId → the title a browser tab's page last set, for the tab label.
 *
 * Not a `SurfaceRef` field, for the same reason as `osc-title-slice.ts`: that type
 * is persisted, and every write to it rebuilds the split tree, which a page that
 * animates its title would do several times a second. After a restart the label
 * reads from the persisted `url` until the page reports a title again.
 *
 * Not `oscTitles` either: that map is gated by `oscTitleTabs`, and feeds the
 * workspace name. A page title is another site's text, so it stays out of both,
 * and goes through the same cleaning before it reaches the tab strip.
 *
 * In agent mode the page is in a Chrome this window cannot observe, so the pane
 * publishes the host of the URL it last read instead (see BrowserPane).
 */
export interface BrowserTitleSlice {
  /** Absent key = no title known, and the label falls back to the URL. */
  browserTitles: Record<string, OscTitleEntry>;
  /** Record a title; an empty one clears. A repeat is a no-op that costs no render. */
  setBrowserTitle(surfaceId: string, title: string): void;
  /** Forget a surface's title, when its tab is closed. */
  clearBrowserTitle(surfaceId: string): void;
}

export const createBrowserTitleSlice: StateCreator<BrowserTitleSlice, [], [], BrowserTitleSlice> = (set) => ({
  browserTitles: {},

  setBrowserTitle(surfaceId: string, title: string): void {
    if (!surfaceId) return;
    const normalized = normalizeOscTitle(title);
    set((state) => {
      const current = state.browserTitles[surfaceId];
      if (!normalized) {
        if (!current) return state;
        const rest = { ...state.browserTitles };
        delete rest[surfaceId];
        return { browserTitles: rest };
      }
      if (current?.title === normalized) return state;
      return {
        browserTitles: evictOscTitles({ ...state.browserTitles, [surfaceId]: { title: normalized, at: Date.now() } }),
      };
    });
  },

  clearBrowserTitle(surfaceId: string): void {
    set((state) => {
      if (!state.browserTitles[surfaceId]) return state;
      const rest = { ...state.browserTitles };
      delete rest[surfaceId];
      return { browserTitles: rest };
    });
  },
});
