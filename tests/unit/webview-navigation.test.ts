import { describe, it, expect } from 'vitest';
import {
  isExternalWebUrl,
  isInternalAppUrl,
  windowOpenPolicy,
  willNavigatePolicy,
} from '../../src/main/webview-navigation';

// The webview/navigation hardening in index.ts routes external URLs to the OS
// browser from TWO handlers — setWindowOpenHandler (new-window requests) and
// will-navigate (same-frame navigations). In Electron 43 those fire for disjoint
// gestures, so one click reaches one handler, never both. The regression this
// pins is the older shape where each handler wrote out the "open http(s)"
// decision by hand and could drift: a scheme one path launched while the other
// blocked it. windowOpenPolicy and willNavigatePolicy must agree on the launch
// decision for every URL, so nothing is ever double- or divergently launched.

const HTTP = ['http://example.com', 'https://example.com/a?b=c', 'HTTPS://EXAMPLE.COM'];
const NON_HTTP = [
  'javascript:alert(1)',
  'data:text/html,<script>1</script>',
  'file:///C:/Windows/win.ini',
  'mailto:a@b.com',
  'chrome://settings',
  'about:blank',
  'ftp://host/x',
];
const INTERNAL = ['http://localhost:5199/', 'http://127.0.0.1:5199/x', 'file:///app/index.html'];

describe('external web url classification', () => {
  it('accepts only http/https, case-insensitively', () => {
    for (const u of HTTP) expect(isExternalWebUrl(u)).toBe(true);
    for (const u of NON_HTTP) expect(isExternalWebUrl(u)).toBe(false);
  });
});

describe('internal app url classification', () => {
  it('accepts localhost, 127.0.0.1 and file:// only', () => {
    for (const u of INTERNAL) expect(isInternalAppUrl(u)).toBe(true);
    expect(isInternalAppUrl('http://example.com')).toBe(false);
    expect(isInternalAppUrl('http://localhost.evil.com/')).toBe(false); // no port sep → not us
    expect(isInternalAppUrl('https://localhost:5199/')).toBe(false); // dev server is http
  });
});

describe('windowOpenPolicy (setWindowOpenHandler)', () => {
  it('always denies the in-app window', () => {
    for (const u of [...HTTP, ...NON_HTTP, ...INTERNAL]) {
      expect(windowOpenPolicy(u).response).toEqual({ action: 'deny' });
    }
  });

  it('opens http(s) externally and nothing else', () => {
    for (const u of HTTP) expect(windowOpenPolicy(u).openExternal).toBe(true);
    for (const u of NON_HTTP) expect(windowOpenPolicy(u).openExternal).toBe(false);
  });
});

describe('willNavigatePolicy (will-navigate on the main window)', () => {
  it('lets the app window navigate within its own UI', () => {
    for (const u of INTERNAL) {
      expect(willNavigatePolicy(u)).toEqual({ preventDefault: false, openExternal: false });
    }
  });

  it('prevents external http(s) and redirects it to the OS browser', () => {
    for (const u of HTTP) {
      expect(willNavigatePolicy(u)).toEqual({ preventDefault: true, openExternal: true });
    }
  });

  it('prevents a non-http remote scheme without launching it', () => {
    for (const u of NON_HTTP.filter(u => !isInternalAppUrl(u))) {
      expect(willNavigatePolicy(u)).toEqual({ preventDefault: true, openExternal: false });
    }
  });
});

describe('the two handlers cannot diverge on the launch decision', () => {
  // For a remote URL (the only kind either path launches), both paths must reach
  // the SAME shell.openExternal decision. If a future edit taught one path to
  // launch a scheme the other refuses, this fails — that is the mismatched-launch
  // class. Internal URLs are deliberately excluded: a new-window request to
  // localhost opens the OS browser while a same-frame nav to localhost is the
  // app's own UI and stays in place, so the two genuinely differ there.
  it('agrees on openExternal for every remote url', () => {
    for (const u of [...HTTP, ...NON_HTTP].filter(u => !isInternalAppUrl(u))) {
      expect(windowOpenPolicy(u).openExternal).toBe(willNavigatePolicy(u).openExternal);
    }
  });
});
