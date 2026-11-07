// Pops the browser panel's right-click menu (#439) as a native menu over the
// window that asked, and answers with the action the user picked, or null.
//
// Main decides nothing about WHAT is in the menu: the renderer builds it from
// the <webview>'s context-menu params (shared/browser-context-menu.ts) and
// performs the action itself, because opening a tab is a store operation. All
// main does is re-validate the items, so a renderer cannot pop arbitrary text
// over the window, and pop it.

import { BrowserWindow, Menu, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { sanitizeBrowserMenuItems, type BrowserMenuAction } from '../shared/browser-context-menu';

export function popupBrowserContextMenu(sender: WebContents, rawItems: unknown): Promise<BrowserMenuAction | null> {
  const items = sanitizeBrowserMenuItems(rawItems);
  const win = BrowserWindow.fromWebContents(sender);
  if (!items || !win || win.isDestroyed()) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: BrowserMenuAction | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const template: MenuItemConstructorOptions[] = items.map((item) => {
      if ('separator' in item) return { type: 'separator' };
      const { action } = item;
      return { label: item.label, enabled: item.enabled, click: () => settle(action) };
    });
    Menu.buildFromTemplate(template).popup({
      window: win,
      // The close callback can run before the chosen item's click on some
      // platforms; deferring the "nothing chosen" answer lets the click win.
      callback: () => { setTimeout(() => settle(null), 0); },
    });
  });
}
