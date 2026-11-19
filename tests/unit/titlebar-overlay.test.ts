import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { overlayHeightForZoom, syncTitleBarOverlay, TITLEBAR_CSS_HEIGHT } from '../../src/main/titlebar-overlay';

// Issue #465: zoomed out, the native caption buttons stayed 38 window pixels
// tall and 137 wide over a titlebar that had shrunk, and covered the settings
// button.
describe('caption overlay under page zoom (#465)', () => {
  it('keeps the overlay as tall as the titlebar at every zoom step', () => {
    expect(overlayHeightForZoom(1)).toBe(38);
    expect(overlayHeightForZoom(0.7)).toBe(27);
    expect(overlayHeightForZoom(0.5)).toBe(19);
    expect(overlayHeightForZoom(2)).toBe(76);
  });

  it('falls back to 100 % for a zoom it cannot use', () => {
    expect(overlayHeightForZoom(0)).toBe(38);
    expect(overlayHeightForZoom(Number.NaN)).toBe(38);
  });

  it('resizes the overlay from the window zoom, or the one it is given', () => {
    const setTitleBarOverlay = vi.fn();
    const win = { isDestroyed: () => false, setTitleBarOverlay, webContents: { getZoomFactor: () => 0.7 } };
    syncTitleBarOverlay(win as any);
    expect(setTitleBarOverlay).toHaveBeenLastCalledWith({ height: 27 });
    syncTitleBarOverlay(win as any, 1.5);
    expect(setTitleBarOverlay).toHaveBeenLastCalledWith({ height: 57 });
  });

  it('leaves a frameless or destroyed window alone', () => {
    const frameless = {
      isDestroyed: () => false,
      setTitleBarOverlay: () => { throw new Error('Titlebar overlay is not enabled'); },
      webContents: { getZoomFactor: () => 0.7 },
    };
    expect(() => syncTitleBarOverlay(frameless as any)).not.toThrow();
    const setTitleBarOverlay = vi.fn();
    syncTitleBarOverlay({ isDestroyed: () => true, setTitleBarOverlay } as any);
    expect(setTitleBarOverlay).not.toHaveBeenCalled();
  });

  it('the titlebar is the height the overlay is computed from, and reserves the buttons by env()', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/styles/titlebar.css'), 'utf8');
    const rule = (selector: string) => css.slice(css.indexOf(`${selector} {`), css.indexOf('}', css.indexOf(`${selector} {`)));
    expect(rule('.titlebar')).toContain(`height: ${TITLEBAR_CSS_HEIGHT}px`);
    expect(rule('.titlebar__right')).toContain('env(titlebar-area-width');
  });
});
