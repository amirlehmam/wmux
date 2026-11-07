import { describe, it, expect } from 'vitest';
import {
  isExternalWebUrl,
  isInternalAppUrl,
  windowOpenPolicy,
  willNavigatePolicy,
  webviewWindowOpenPolicy,
  needsAppWindowNavigationLock,
  popupWindowTitle,
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
  'sftp://host/x',
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
    // userinfo spoof: an internal url with a host smuggled in after it, e.g.
    // `…//localhost:5199@evil.com/` — it keeps the internal PREFIX, but the host
    // is evil.com and `localhost:5199` is only a username:password.
    for (const u of INTERNAL.filter(x => !x.startsWith('file:'))) {
      const spoof = u.replace(/(:\d+)\//, '$1@evil.com/');
      expect(spoof).toContain('@evil.com/');
      expect(isInternalAppUrl(spoof)).toBe(false);
    }
    expect(isInternalAppUrl('not a url')).toBe(false);
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

// #281 — what the BROWSER PANEL's new-window requests do. Dispositions are the
// ones Electron 43 reports, measured against a standalone harness.
describe('webviewWindowOpenPolicy (#281)', () => {
  const U = 'https://accounts.example/o/oauth2/auth?x=1';

  it('a sized popup is let out as a real window', () => {
    expect(webviewWindowOpenPolicy({ url: U, features: 'width=500,height=600', disposition: 'new-window' })).toEqual({ kind: 'popup' });
    expect(webviewWindowOpenPolicy({ url: U, features: 'popup', disposition: 'new-window' })).toEqual({ kind: 'popup' });
  });

  it.each([
    ['plain window.open(u)', '', 'foreground-tab'],
    ['noopener only', 'noopener', 'foreground-tab'],
    ['shift+click (a new window, but no features: nobody is waiting on it)', '', 'new-window'],
    ['a feature string Chromium still reads as a tab', 'location=yes,toolbar=yes', 'foreground-tab'],
  ])('%s navigates the panel in place', (_name, features, disposition) => {
    expect(webviewWindowOpenPolicy({ url: U, features, disposition })).toEqual({ kind: 'navigate-in-place', url: U });
  });

  // Ctrl+click and middle-click on a link are both 'background-tab', and no
  // script can ask for that disposition on its own: window.open() is
  // 'foreground-tab' at most.
  it('ctrl+click or middle-click opens a new browser tab', () => {
    expect(webviewWindowOpenPolicy({ url: U, features: '', disposition: 'background-tab' })).toEqual({ kind: 'new-tab', url: U });
  });

  it.each(['javascript:alert(1)', 'data:text/html,x', 'file:///C:/Windows/win.ini', 'about:blank'])(
    '%s is dropped, popup or not',
    (url) => {
      expect(webviewWindowOpenPolicy({ url, features: 'width=1', disposition: 'new-window' })).toEqual({ kind: 'drop' });
      expect(webviewWindowOpenPolicy({ url, features: '', disposition: 'foreground-tab' })).toEqual({ kind: 'drop' });
      expect(webviewWindowOpenPolicy({ url, features: '', disposition: 'background-tab' })).toEqual({ kind: 'drop' });
    },
  );

  it('never sends anything from the panel to the OS browser', () => {
    // These requests never reached a handler before #281 (no allowpopups), so
    // an openExternal here would be a new behaviour, not a fix.
    for (const disposition of ['new-window', 'foreground-tab', 'background-tab', 'other']) {
      expect(webviewWindowOpenPolicy({ url: U, features: '', disposition }).kind).not.toBe('popup');
    }
  });
});

describe('needsAppWindowNavigationLock (#281)', () => {
  it('allows the isolated unprivileged dictation profile to follow authentication redirects', () => {
    expect(needsAppWindowNavigationLock('window', false, true)).toBe(false);
    expect(needsAppWindowNavigationLock('browserView', false, true)).toBe(false);
    expect(needsAppWindowNavigationLock('window', false, false)).toBe(true);
  });
  it("locks wmux's own windows", () => {
    expect(needsAppWindowNavigationLock('window', false)).toBe(true);
  });
  it('never locks a webview', () => {
    expect(needsAppWindowNavigationLock('webview', false)).toBe(false);
  });
  it('does not lock a popup the panel opened — sign-in is a chain of navigations', () => {
    expect(needsAppWindowNavigationLock('window', true)).toBe(false);
  });
});

describe('popupWindowTitle (#281)', () => {
  it('always leads with the host, since the popup has no address bar', () => {
    expect(popupWindowTitle('https://accounts.google.com/signin', 'Sign in - Google Accounts')).toBe('accounts.google.com — Sign in - Google Accounts');
  });
  it('a page cannot title itself as something else without its host showing', () => {
    expect(popupWindowTitle('https://evil.example/x', 'wmux — Sign in')).toBe('evil.example — wmux — Sign in');
  });
  it('no title yet, or a title that is just the host: the host alone', () => {
    expect(popupWindowTitle('https://a.example:8443/', '')).toBe('a.example:8443');
    expect(popupWindowTitle('https://a.example/', 'a.example')).toBe('a.example');
  });
  it('an unparseable url keeps the page title', () => {
    expect(popupWindowTitle('', 'Title')).toBe('Title');
  });
});
