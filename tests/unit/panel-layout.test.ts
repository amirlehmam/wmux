// The persisted-width regression: `explorerWidth`/`browserWidth` were clamped
// only during a DRAG, so the clamp only ever saw the monitor the drag happened
// on. A width chosen on a wide display came back verbatim on a narrow one, with
// flexShrink:0 and a second unclamped panel beside it — and restore is the one
// path where the user never chose the bad width.
//
// These are the numbers both clamps now share. Nothing here decides which panel
// yields first when even the floor cannot be met; each panel is simply capped
// at what is left once the other one, the sidebar and the terminal floor are
// accounted for.

import { describe, it, expect } from 'vitest';
import {
  TERMINAL_MIN_WIDTH, PANEL_HANDLE_WIDTH, EXPLORER_MIN_WIDTH, BROWSER_MIN_WIDTH,
  panelReservedWidth, clampPanelWidth,
} from '../../src/renderer/panel-layout';

describe('panelReservedWidth', () => {
  it('is the terminal floor alone with no sidebar and no other panel', () => {
    expect(panelReservedWidth({ sidebarWidth: 0, otherPanelOpen: false, otherPanelWidth: 420 }))
      .toBe(TERMINAL_MIN_WIDTH);
  });

  it('adds the sidebar', () => {
    expect(panelReservedWidth({ sidebarWidth: 240, otherPanelOpen: false, otherPanelWidth: 420 }))
      .toBe(TERMINAL_MIN_WIDTH + 240);
  });

  it('adds the other panel AND its drag handle when that panel is open', () => {
    expect(panelReservedWidth({ sidebarWidth: 240, otherPanelOpen: true, otherPanelWidth: 420 }))
      .toBe(TERMINAL_MIN_WIDTH + 240 + PANEL_HANDLE_WIDTH + 420);
  });
});

describe('clampPanelWidth', () => {
  it('leaves a width the viewport can afford alone', () => {
    const reserved = panelReservedWidth({
      sidebarWidth: 240, otherPanelOpen: false, otherPanelWidth: 0,
    });
    expect(clampPanelWidth(600, { reserved, min: EXPLORER_MIN_WIDTH, viewportWidth: 1920 }))
      .toBe(600);
  });

  // The actual bug: sized on a 3840px monitor, restored on a 1366px laptop.
  it('caps a width restored from a wider monitor', () => {
    const reserved = panelReservedWidth({
      sidebarWidth: 240, otherPanelOpen: false, otherPanelWidth: 0,
    });
    const restored = 1200;
    const clamped = clampPanelWidth(restored, {
      reserved, min: EXPLORER_MIN_WIDTH, viewportWidth: 1366,
    });
    expect(clamped).toBeLessThan(restored);
    expect(clamped).toBe(1366 - TERMINAL_MIN_WIDTH - 240);
    // The terminal keeps its floor, which is the whole point.
    expect(1366 - 240 - clamped).toBeGreaterThanOrEqual(TERMINAL_MIN_WIDTH);
  });

  it('accounts for the OTHER open panel, so two restored panels cannot both win', () => {
    const viewportWidth = 1366;
    const browser = 420;
    const explorer = clampPanelWidth(900, {
      reserved: panelReservedWidth({
        sidebarWidth: 240, otherPanelOpen: true, otherPanelWidth: browser,
      }),
      min: EXPLORER_MIN_WIDTH,
      viewportWidth,
    });
    // 1366 - 400 floor - 240 sidebar - 4 handle - 420 browser = 302
    expect(explorer).toBe(302);
  });

  it('holds the panel minimum rather than collapsing or inverting it', () => {
    // A viewport too narrow to satisfy everything: viewportWidth - reserved goes
    // negative. Returning that would collapse the panel to a sliver; holding the
    // minimum overflows visibly instead, and expresses no yield order.
    const reserved = panelReservedWidth({
      sidebarWidth: 240, otherPanelOpen: true, otherPanelWidth: 420,
    });
    expect(clampPanelWidth(900, { reserved, min: EXPLORER_MIN_WIDTH, viewportWidth: 700 }))
      .toBe(EXPLORER_MIN_WIDTH);
    expect(clampPanelWidth(900, { reserved, min: BROWSER_MIN_WIDTH, viewportWidth: 700 }))
      .toBe(BROWSER_MIN_WIDTH);
  });

  it('raises a width below the panel minimum up to it', () => {
    expect(clampPanelWidth(50, {
      reserved: TERMINAL_MIN_WIDTH, min: EXPLORER_MIN_WIDTH, viewportWidth: 1920,
    })).toBe(EXPLORER_MIN_WIDTH);
  });
});
