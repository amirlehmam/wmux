/**
 * Keep the application menu's accelerators out of the browser panel.
 *
 * wmux never calls Menu.setApplicationMenu, so Electron installs its default
 * menu. The menu bar is hidden (titleBarStyle: 'hidden'), but its accelerators
 * stay live: Window → Close on Ctrl+W, View → Reload on Ctrl+R, Force Reload,
 * Toggle Developer Tools, the zoom items and Minimize on Ctrl+M.
 *
 * In the desktop's own renderer that is harmless, because useKeyboardShortcuts
 * preventDefaults every binding it claims and a prevented key never reaches
 * the menu. A <webview> guest has no such handler: a key its page leaves
 * unhandled is passed to the embedder and on to the window's menu. Ctrl+W with
 * the browser panel focused therefore ran Window → Close on the whole wmux
 * window — the last window, so the app quit — instead of closing a tab, and
 * Ctrl+R reloaded the entire wmux UI rather than the page.
 *
 * Ignoring menu shortcuts on the guest only touches keys pressed while a page
 * has focus. The page still receives every key, and the desktop's menu
 * behaviour is unchanged.
 */
export function ignoreMenuShortcutsInGuest(contents: Electron.WebContents): void {
  if (contents.getType() !== 'webview') return;
  contents.setIgnoreMenuShortcuts(true);
}
