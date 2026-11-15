import { describe, it, expect, vi, beforeEach } from 'vitest';

const popupCalls: Array<{ template: any[]; options: any }> = [];
let fakeWindow: { isDestroyed: () => boolean } | null = { isDestroyed: () => false };

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => fakeWindow },
  Menu: {
    buildFromTemplate: (template: any[]) => ({
      popup: (options: any) => { popupCalls.push({ template, options }); },
    }),
  },
}));

import {
  BROWSER_MENU_ACTIONS,
  buildBrowserContextMenu,
  isSystemBrowserUrl,
  isTabOpenableUrl,
  linkStatusText,
  sanitizeBrowserMenuItems,
  type BrowserMenuEntry,
} from '../../src/shared/browser-context-menu';
import { labelBrowserMenu, runBrowserMenuAction, type BrowserMenuContext } from '../../src/renderer/components/Browser/browser-menu-actions';
import { popupBrowserContextMenu } from '../../src/main/browser-context-menu-popup';
import { newBrowserTabPane } from '../../src/renderer/utils/open-in-browser';
import { en } from '../../src/renderer/i18n/locales/en';
import { cs } from '../../src/renderer/i18n/locales/cs';
import { de } from '../../src/renderer/i18n/locales/de';
import { es } from '../../src/renderer/i18n/locales/es';
import { fr } from '../../src/renderer/i18n/locales/fr';
import { hi } from '../../src/renderer/i18n/locales/hi';
import { it as itLocale } from '../../src/renderer/i18n/locales/it';
import { ja } from '../../src/renderer/i18n/locales/ja';
import { ko } from '../../src/renderer/i18n/locales/ko';
import { nl } from '../../src/renderer/i18n/locales/nl';
import { pl } from '../../src/renderer/i18n/locales/pl';
import { pt } from '../../src/renderer/i18n/locales/pt';
import { ru } from '../../src/renderer/i18n/locales/ru';
import { sv } from '../../src/renderer/i18n/locales/sv';
import { tr } from '../../src/renderer/i18n/locales/tr';
import { uk } from '../../src/renderer/i18n/locales/uk';
import { zh } from '../../src/renderer/i18n/locales/zh';
import { zhTW } from '../../src/renderer/i18n/locales/zh-TW';

const actionsOf = (menu: BrowserMenuEntry[]) => menu.map((e) => ('separator' in e ? '-' : e.action));
const NAV = { canGoBack: true, canGoForward: false };

describe('browser context menu URL gates (#439)', () => {
  it('lets only http(s) and mailto reach the system browser', () => {
    expect(isSystemBrowserUrl('https://example.com/a')).toBe(true);
    expect(isSystemBrowserUrl('http://example.com')).toBe(true);
    expect(isSystemBrowserUrl('mailto:someone@example.com')).toBe(true);
    for (const url of ['javascript:alert(1)', 'file:///C:/Windows/System32/calc.exe', 'data:text/html,x',
      'ms-settings:privacy', 'vscode://file/x', 'not a url', '', undefined]) {
      expect(isSystemBrowserUrl(url), String(url)).toBe(false);
    }
  });

  it('opens only http(s) in a new wmux tab', () => {
    expect(isTabOpenableUrl('https://example.com')).toBe(true);
    expect(isTabOpenableUrl('mailto:a@b.c')).toBe(false);
    expect(isTabOpenableUrl('javascript:void 0')).toBe(false);
    expect(isTabOpenableUrl('data:image/png;base64,AAAA')).toBe(false);
  });

  it('shows nothing in the status bar for an empty or missing url', () => {
    expect(linkStatusText('')).toBe('');
    expect(linkStatusText(null)).toBe('');
    expect(linkStatusText(undefined)).toBe('');
    expect(linkStatusText('  https://example.com/x ')).toBe('https://example.com/x');
  });
});

describe('buildBrowserContextMenu (#439)', () => {
  it('gives a bare page Back/Forward/Reload with the history state, then Inspect', () => {
    const menu = buildBrowserContextMenu({}, NAV);
    expect(actionsOf(menu)).toEqual(['back', 'forward', 'reload', '-', 'inspect']);
    expect(menu[0]).toEqual({ action: 'back', enabled: true });
    expect(menu[1]).toEqual({ action: 'forward', enabled: false });
  });

  it('gives an http link the three link entries and no page navigation', () => {
    const menu = buildBrowserContextMenu({ linkURL: 'https://example.com/doc' }, NAV);
    expect(actionsOf(menu)).toEqual(['openLinkInNewTab', 'openLinkExternal', 'copyLink', '-', 'inspect']);
  });

  it('offers a mailto link to the system browser but not a tab', () => {
    const menu = buildBrowserContextMenu({ linkURL: 'mailto:a@b.c' }, NAV);
    expect(actionsOf(menu)).toEqual(['openLinkExternal', 'copyLink', '-', 'inspect']);
  });

  it('offers a javascript: link only for copying', () => {
    const menu = buildBrowserContextMenu({ linkURL: 'javascript:alert(1)' }, NAV);
    expect(actionsOf(menu)).toEqual(['copyLink', '-', 'inspect']);
  });

  it('adds image entries for a linked image, and copies a data: image without its address', () => {
    expect(actionsOf(buildBrowserContextMenu(
      { linkURL: 'https://e.com', mediaType: 'image', srcURL: 'https://e.com/i.png' }, NAV,
    ))).toEqual([
      'openLinkInNewTab', 'openLinkExternal', 'copyLink', '-',
      'openImageInNewTab', 'copyImage', 'copyImageAddress', '-', 'inspect',
    ]);
    expect(actionsOf(buildBrowserContextMenu(
      { mediaType: 'image', srcURL: 'data:image/png;base64,AAAA' }, NAV,
    ))).toEqual(['copyImage', '-', 'inspect']);
  });

  it('offers Copy for selected text', () => {
    const menu = buildBrowserContextMenu({ selectionText: 'hello' }, NAV);
    expect(actionsOf(menu)).toEqual(['copy', '-', 'inspect']);
    expect(actionsOf(buildBrowserContextMenu({ selectionText: '   ' }, NAV))).toContain('reload');
  });

  it('gives an editable field the edit entries, enabled from editFlags', () => {
    const menu = buildBrowserContextMenu({
      isEditable: true,
      selectionText: 'x',
      editFlags: { canCut: true, canCopy: true, canPaste: false, canSelectAll: true },
    }, NAV);
    expect(menu.slice(0, 4)).toEqual([
      { action: 'cut', enabled: true },
      { action: 'copy', enabled: true },
      { action: 'paste', enabled: false },
      { action: 'selectAll', enabled: true },
    ]);
  });

  it('never starts or ends with a separator, nor doubles one', () => {
    const cases = [{}, { linkURL: 'https://e.com', selectionText: 'x' }, { isEditable: true }, { mediaType: 'image', srcURL: 'https://e.com/i.png' }];
    for (const params of cases) {
      const a = actionsOf(buildBrowserContextMenu(params, NAV));
      expect(a[0]).not.toBe('-');
      expect(a.at(-1)).not.toBe('-');
      expect(a.join(',')).not.toContain('-,-');
    }
  });
});

describe('sanitizeBrowserMenuItems (#439)', () => {
  it('passes a well-formed menu through', () => {
    const items = [{ action: 'copyLink', label: 'Copy link address', enabled: true }, { separator: true }, { action: 'inspect', label: 'Inspect', enabled: false }];
    expect(sanitizeBrowserMenuItems(items)).toEqual(items);
  });

  it('refuses unknown actions, bad labels and non-arrays', () => {
    expect(sanitizeBrowserMenuItems([{ action: 'runShell', label: 'x', enabled: true }])).toBeNull();
    expect(sanitizeBrowserMenuItems([{ action: 'copy', label: '', enabled: true }])).toBeNull();
    expect(sanitizeBrowserMenuItems([{ action: 'copy', label: 'x'.repeat(201), enabled: true }])).toBeNull();
    expect(sanitizeBrowserMenuItems([{ action: 'copy', label: 42 }])).toBeNull();
    expect(sanitizeBrowserMenuItems([null])).toBeNull();
    expect(sanitizeBrowserMenuItems([])).toBeNull();
    expect(sanitizeBrowserMenuItems('copy')).toBeNull();
    expect(sanitizeBrowserMenuItems(Array.from({ length: 33 }, () => ({ separator: true })))).toBeNull();
  });
});

describe('labelBrowserMenu translations (#439)', () => {
  const LOCALES: Record<string, Record<string, string | undefined>> = {
    en, cs, de, es, fr, hi, it: itLocale, ja, ko, nl, pl, pt, ru, sv, tr, uk, zh, 'zh-TW': zhTW,
  };

  it('has a non-empty label for every action in every bundled locale', () => {
    for (const [code, dict] of Object.entries(LOCALES)) {
      for (const action of BROWSER_MENU_ACTIONS) {
        const value = dict[`browser.menu.${action}`];
        expect(value?.trim(), `${code} browser.menu.${action}`).toBeTruthy();
      }
    }
  });

  it('labels entries through the translator and keeps separators', () => {
    const t = (key: string, fallback?: string) => (fr as Record<string, string>)[key] ?? fallback ?? key;
    const items = labelBrowserMenu([{ action: 'copyLink', enabled: true }, { separator: true }, { action: 'reload', enabled: false }], t as any);
    expect(items).toEqual([
      { action: 'copyLink', label: "Copier l'adresse du lien", enabled: true },
      { separator: true },
      { action: 'reload', label: 'Actualiser', enabled: false },
    ]);
  });
});

describe('runBrowserMenuAction (#439)', () => {
  let ctx: BrowserMenuContext;
  beforeEach(() => {
    ctx = {
      linkURL: 'https://example.com/a',
      srcURL: 'https://example.com/i.png',
      x: 10,
      y: 20,
      webview: {
        goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), cut: vi.fn(), copy: vi.fn(), paste: vi.fn(),
        selectAll: vi.fn(), copyImageAt: vi.fn(), inspectElement: vi.fn(),
      },
      openInNewTab: vi.fn(),
      openExternal: vi.fn(),
      copyText: vi.fn(),
    };
  });

  it('routes link actions to the tab, the OS browser and the clipboard', () => {
    runBrowserMenuAction('openLinkInNewTab', ctx);
    runBrowserMenuAction('openLinkExternal', ctx);
    runBrowserMenuAction('copyLink', ctx);
    expect(ctx.openInNewTab).toHaveBeenCalledWith('https://example.com/a');
    expect(ctx.openExternal).toHaveBeenCalledWith('https://example.com/a');
    expect(ctx.copyText).toHaveBeenCalledWith('https://example.com/a');
  });

  it('re-checks the scheme before a URL leaves the page', () => {
    ctx.linkURL = 'file:///C:/Windows/System32/calc.exe';
    ctx.srcURL = 'javascript:alert(1)';
    runBrowserMenuAction('openLinkExternal', ctx);
    runBrowserMenuAction('openLinkInNewTab', ctx);
    runBrowserMenuAction('openImageInNewTab', ctx);
    expect(ctx.openExternal).not.toHaveBeenCalled();
    expect(ctx.openInNewTab).not.toHaveBeenCalled();
  });

  it('drives the webview for image, edit, navigation and inspect actions', () => {
    runBrowserMenuAction('copyImage', ctx);
    runBrowserMenuAction('inspect', ctx);
    runBrowserMenuAction('copy', ctx);
    runBrowserMenuAction('back', ctx);
    runBrowserMenuAction('reload', ctx);
    expect(ctx.webview.copyImageAt).toHaveBeenCalledWith(10, 20);
    expect(ctx.webview.inspectElement).toHaveBeenCalledWith(10, 20);
    expect(ctx.webview.copy).toHaveBeenCalled();
    expect(ctx.webview.goBack).toHaveBeenCalled();
    expect(ctx.webview.reload).toHaveBeenCalled();
  });
});

describe('popupBrowserContextMenu (#439)', () => {
  beforeEach(() => {
    popupCalls.length = 0;
    fakeWindow = { isDestroyed: () => false };
  });

  it('answers the clicked action', async () => {
    const pending = popupBrowserContextMenu({} as any, [{ action: 'copyLink', label: 'Copy link address', enabled: true }, { separator: true }]);
    expect(popupCalls).toHaveLength(1);
    const [item, sep] = popupCalls[0].template;
    expect(sep).toEqual({ type: 'separator' });
    // Electron may close the menu before running the click; the click still wins.
    popupCalls[0].options.callback();
    item.click();
    await expect(pending).resolves.toBe('copyLink');
  });

  it('answers null when the menu closes with nothing chosen', async () => {
    const pending = popupBrowserContextMenu({} as any, [{ action: 'reload', label: 'Reload', enabled: true }]);
    popupCalls[0].options.callback();
    await expect(pending).resolves.toBeNull();
  });

  it('pops nothing for an invalid menu or a window that is gone', async () => {
    await expect(popupBrowserContextMenu({} as any, [{ action: 'evil', label: 'x' }])).resolves.toBeNull();
    fakeWindow = null;
    await expect(popupBrowserContextMenu({} as any, [{ action: 'reload', label: 'Reload', enabled: true }])).resolves.toBeNull();
    expect(popupCalls).toHaveLength(0);
  });
});

describe('newBrowserTabPane (#439)', () => {
  const leaf = (paneId: string, types: string[]) => ({
    type: 'leaf', paneId, activeSurfaceIndex: 0,
    surfaces: types.map((type, i) => ({ id: `surf-${paneId}-${i}`, type })),
  });

  it('puts a tab opened from the side panel beside an existing browser tab', () => {
    const tree = { type: 'branch', direction: 'horizontal', ratio: 0.5,
      children: [leaf('pane-a', ['terminal']), leaf('pane-b', ['terminal', 'browser'])] };
    expect(newBrowserTabPane(tree as any)).toBe('pane-b');
  });

  it('falls back to the first pane when no browser tab exists', () => {
    const tree = { type: 'branch', direction: 'vertical', ratio: 0.5,
      children: [leaf('pane-a', ['terminal']), leaf('pane-b', ['markdown'])] };
    expect(newBrowserTabPane(tree as any)).toBe('pane-a');
  });

  it('skips a locked pane that holds a browser tab', () => {
    const tree = { type: 'branch', direction: 'horizontal', ratio: 0.5,
      children: [leaf('pane-a', ['terminal']), { ...leaf('pane-b', ['browser']), locked: true }] };
    expect(newBrowserTabPane(tree as any)).toBe('pane-a');
  });

  it('prefers an unlocked pane with a browser tab over a locked first pane', () => {
    const tree = { type: 'branch', direction: 'horizontal', ratio: 0.5,
      children: [{ ...leaf('pane-a', ['terminal']), locked: true }, leaf('pane-b', ['browser'])] };
    expect(newBrowserTabPane(tree as any)).toBe('pane-b');
  });

  it('returns null when every pane is locked', () => {
    const tree = { type: 'branch', direction: 'horizontal', ratio: 0.5,
      children: [{ ...leaf('pane-a', ['terminal']), locked: true }, { ...leaf('pane-b', ['browser']), locked: true }] };
    expect(newBrowserTabPane(tree as any)).toBeNull();
  });
});
