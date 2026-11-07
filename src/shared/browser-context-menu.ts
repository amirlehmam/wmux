// The browser panel's right-click menu and link status bar (#439).
//
// Before this, a right-click inside a <webview> did nothing at all: Electron
// shows no default context menu, so a link could not be copied or opened
// anywhere else, and nothing showed where a link went before clicking it.
//
// Split three ways, so the part worth pinning is testable with no Electron:
//   - this module decides WHICH entries a right-click gets, from the params the
//     <webview> tag's `context-menu` event carries, and which URLs may go where;
//   - the renderer (BrowserPane) labels them in the UI language and performs
//     the chosen action, because "open in new tab" is a store operation;
//   - main only pops the native menu over the host window and answers with the
//     chosen action (browser-context-menu-popup.ts). A native menu, not an HTML
//     one, because clicks inside the guest never reach the host document, so an
//     HTML menu could not tell it had been dismissed.

export const BROWSER_MENU_ACTIONS = [
  'openLinkInNewTab',
  'openLinkExternal',
  'copyLink',
  'openImageInNewTab',
  'copyImage',
  'copyImageAddress',
  'cut',
  'copy',
  'paste',
  'selectAll',
  'back',
  'forward',
  'reload',
  'inspect',
] as const;

export type BrowserMenuAction = (typeof BROWSER_MENU_ACTIONS)[number];

const ACTION_SET: ReadonlySet<string> = new Set(BROWSER_MENU_ACTIONS);

export function isBrowserMenuAction(value: unknown): value is BrowserMenuAction {
  return typeof value === 'string' && ACTION_SET.has(value);
}

export type BrowserMenuEntry =
  | { action: BrowserMenuAction; enabled: boolean }
  | { separator: true };

/** What the menu is shown with, labels already resolved. Crosses the IPC. */
export type BrowserMenuItem =
  | { action: BrowserMenuAction; label: string; enabled: boolean }
  | { separator: true };

/** The subset of Electron's ContextMenuParams the menu reads. */
export interface BrowserContextParams {
  linkURL?: string;
  srcURL?: string;
  mediaType?: string;
  selectionText?: string;
  isEditable?: boolean;
  editFlags?: {
    canCut?: boolean;
    canCopy?: boolean;
    canPaste?: boolean;
    canSelectAll?: boolean;
  };
}

function protocolOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

/**
 * May this URL be handed to `shell.openExternal`? http(s) and mailto only:
 * anything else (`file:`, `javascript:`, a custom protocol handler) would turn
 * a right-click on a hostile page into a local launch.
 */
export function isSystemBrowserUrl(url: string | undefined): boolean {
  const p = protocolOf(url);
  return p === 'http:' || p === 'https:' || p === 'mailto:';
}

/**
 * May this URL open in a new wmux browser tab? http(s) only, the same gate as
 * every other link that reaches the panel (utils/open-link.ts): a `javascript:`
 * or `data:` URL in a fresh tab would run with no page around it.
 */
export function isTabOpenableUrl(url: string | undefined): boolean {
  const p = protocolOf(url);
  return p === 'http:' || p === 'https:';
}

/**
 * The text shown in the link status bar for a hovered link, or '' for none.
 * Chromium sends '' when the pointer leaves a link; a `javascript:` URL is
 * shown as Chrome shows it, since it is only text here.
 */
export function linkStatusText(url: string | undefined | null): string {
  return typeof url === 'string' ? url.trim() : '';
}

function pushGroup(menu: BrowserMenuEntry[], group: BrowserMenuEntry[]): void {
  if (group.length === 0) return;
  if (menu.length > 0) menu.push({ separator: true });
  menu.push(...group);
}

/**
 * The entries for one right-click, in Chrome's order: link, image, then edit
 * or selection. Back/Forward/Reload appear only on the bare page, as in Chrome,
 * where a right-click on a link is about the link. Inspect is always last.
 */
export function buildBrowserContextMenu(
  params: BrowserContextParams,
  nav: { canGoBack: boolean; canGoForward: boolean },
): BrowserMenuEntry[] {
  const menu: BrowserMenuEntry[] = [];
  const link = params.linkURL ?? '';
  const src = params.srcURL ?? '';
  const selection = (params.selectionText ?? '').trim();
  const isImage = params.mediaType === 'image' && src !== '';
  const flags = params.editFlags ?? {};

  if (link) {
    const group: BrowserMenuEntry[] = [];
    if (isTabOpenableUrl(link)) group.push({ action: 'openLinkInNewTab', enabled: true });
    if (isSystemBrowserUrl(link)) group.push({ action: 'openLinkExternal', enabled: true });
    group.push({ action: 'copyLink', enabled: true });
    pushGroup(menu, group);
  }

  if (isImage) {
    const group: BrowserMenuEntry[] = [];
    if (isTabOpenableUrl(src)) group.push({ action: 'openImageInNewTab', enabled: true });
    group.push({ action: 'copyImage', enabled: true });
    // A data: URL can be megabytes of base64; it is not an address anyone wants.
    if (isTabOpenableUrl(src)) group.push({ action: 'copyImageAddress', enabled: true });
    pushGroup(menu, group);
  }

  if (params.isEditable) {
    pushGroup(menu, [
      { action: 'cut', enabled: !!flags.canCut },
      { action: 'copy', enabled: !!flags.canCopy },
      { action: 'paste', enabled: !!flags.canPaste },
      { action: 'selectAll', enabled: !!flags.canSelectAll },
    ]);
  } else if (selection) {
    pushGroup(menu, [{ action: 'copy', enabled: true }]);
  }

  if (menu.length === 0) {
    pushGroup(menu, [
      { action: 'back', enabled: nav.canGoBack },
      { action: 'forward', enabled: nav.canGoForward },
      { action: 'reload', enabled: true },
    ]);
  }

  pushGroup(menu, [{ action: 'inspect', enabled: true }]);
  return menu;
}

const MAX_MENU_ITEMS = 32;
const MAX_LABEL_LENGTH = 200;

/**
 * Re-validate a menu that crossed the IPC. Main pops whatever it is given, so
 * it accepts only known actions with short string labels; anything else
 * answers null and no menu is shown.
 */
export function sanitizeBrowserMenuItems(value: unknown): BrowserMenuItem[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MENU_ITEMS) return null;
  const out: BrowserMenuItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;
    if (item.separator === true) {
      out.push({ separator: true });
      continue;
    }
    if (!isBrowserMenuAction(item.action)) return null;
    if (typeof item.label !== 'string' || item.label === '' || item.label.length > MAX_LABEL_LENGTH) return null;
    out.push({ action: item.action, label: item.label, enabled: item.enabled !== false });
  }
  return out;
}
