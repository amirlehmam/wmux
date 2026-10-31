import { BrowserWindow } from 'electron';

/** Open once; subsequent toolbar clicks restore and raise the same window. */
export function focusBrowserDevTools(guest: Electron.WebContents): void {
  if (!guest.isDevToolsOpened()) guest.openDevTools({ mode: 'detach', activate: true });
  const tools = guest.devToolsWebContents;
  if (!tools || tools.isDestroyed()) return;
  const win = BrowserWindow.fromWebContents(tools);
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  tools.focus();
}
