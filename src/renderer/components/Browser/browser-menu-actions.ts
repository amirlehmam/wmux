// The renderer half of the browser panel's right-click menu (#439): labels in
// the UI language, and what each chosen action does. Which entries a click gets
// is decided in shared/browser-context-menu.ts; main only pops the menu.

import type { TranslationKey, Translator } from '../../i18n/core';
import {
  isSystemBrowserUrl,
  isTabOpenableUrl,
  type BrowserMenuAction,
  type BrowserMenuEntry,
  type BrowserMenuItem,
} from '../../../shared/browser-context-menu';

/** Label keys, with the English text as the fallback for a user locale that lacks one. */
const LABELS: Record<BrowserMenuAction, [TranslationKey, string]> = {
  openLinkInNewTab: ['browser.menu.openLinkInNewTab', 'Open link in new tab'],
  openLinkExternal: ['browser.menu.openLinkExternal', 'Open link in system browser'],
  copyLink: ['browser.menu.copyLink', 'Copy link address'],
  openImageInNewTab: ['browser.menu.openImageInNewTab', 'Open image in new tab'],
  copyImage: ['browser.menu.copyImage', 'Copy image'],
  copyImageAddress: ['browser.menu.copyImageAddress', 'Copy image address'],
  cut: ['browser.menu.cut', 'Cut'],
  copy: ['browser.menu.copy', 'Copy'],
  paste: ['browser.menu.paste', 'Paste'],
  selectAll: ['browser.menu.selectAll', 'Select all'],
  back: ['browser.menu.back', 'Back'],
  forward: ['browser.menu.forward', 'Forward'],
  reload: ['browser.menu.reload', 'Reload'],
  inspect: ['browser.menu.inspect', 'Inspect'],
};

export function labelBrowserMenu(entries: BrowserMenuEntry[], t: Translator): BrowserMenuItem[] {
  return entries.map((entry) => {
    if ('separator' in entry) return entry;
    const [key, fallback] = LABELS[entry.action];
    return { action: entry.action, label: t(key, fallback), enabled: entry.enabled };
  });
}

/** The <webview> methods an action calls. */
export interface BrowserMenuWebview {
  goBack(): void;
  goForward(): void;
  reload(): void;
  cut(): void;
  copy(): void;
  paste(): void;
  selectAll(): void;
  copyImageAt(x: number, y: number): void;
  inspectElement(x: number, y: number): void;
}

export interface BrowserMenuContext {
  linkURL: string;
  srcURL: string;
  x: number;
  y: number;
  webview: BrowserMenuWebview;
  openInNewTab: (url: string) => void;
  openExternal: (url: string) => void;
  copyText: (text: string) => void;
}

/**
 * Perform the chosen action. URLs are re-checked here, not trusted from the
 * menu that offered them: this is the line right before they leave the page.
 */
export function runBrowserMenuAction(action: BrowserMenuAction, ctx: BrowserMenuContext): void {
  const wv = ctx.webview;
  const handlers: Record<BrowserMenuAction, () => void> = {
    openLinkInNewTab: () => { if (isTabOpenableUrl(ctx.linkURL)) ctx.openInNewTab(ctx.linkURL); },
    openLinkExternal: () => { if (isSystemBrowserUrl(ctx.linkURL)) ctx.openExternal(ctx.linkURL); },
    copyLink: () => { if (ctx.linkURL) ctx.copyText(ctx.linkURL); },
    openImageInNewTab: () => { if (isTabOpenableUrl(ctx.srcURL)) ctx.openInNewTab(ctx.srcURL); },
    copyImage: () => wv.copyImageAt(ctx.x, ctx.y),
    copyImageAddress: () => { if (ctx.srcURL) ctx.copyText(ctx.srcURL); },
    cut: () => wv.cut(),
    copy: () => wv.copy(),
    paste: () => wv.paste(),
    selectAll: () => wv.selectAll(),
    back: () => wv.goBack(),
    forward: () => wv.goForward(),
    reload: () => wv.reload(),
    inspect: () => wv.inspectElement(ctx.x, ctx.y),
  };
  handlers[action]();
}
