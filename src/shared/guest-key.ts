/**
 * A key pressed inside a browser pane's page, as main hands it to the desktop.
 *
 * A focused <webview> guest gets its keys before the desktop renderer ever
 * does, so wmux's document-level shortcut listeners never see them: Ctrl+W in
 * a page closed nothing, and before #431 it fell through to Electron's default
 * menu and closed the whole window. Main watches the guest's
 * before-input-event and forwards the keys that could be a shortcut. The page
 * still receives every key; the desktop only acts on the tab-level actions
 * a browser reserves from pages (see GLOBAL_IN_PAGE in shortcut-target.ts).
 */
export interface GuestKey {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat: boolean;
}

/** The subset of Electron's before-input-event `Input` this reads. */
export interface GuestInputLike {
  type: string;
  key: string;
  code: string;
  control: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  isAutoRepeat: boolean;
  isComposing?: boolean;
}

/**
 * The key to forward, or null for one that cannot be a wmux shortcut.
 *
 * Only key-downs with Ctrl, Alt or Meta held, and function keys, are
 * forwarded. Plain typing never leaves the page, and IME composition is the
 * page's alone.
 */
export function guestKeyFromInput(input: GuestInputLike): GuestKey | null {
  if (input.type !== 'keyDown' || input.isComposing) return null;
  const chord = input.control || input.alt || input.meta;
  if (!chord && !/^F\d{1,2}$/.test(input.key)) return null;
  return {
    key: input.key,
    code: input.code,
    ctrlKey: input.control,
    shiftKey: input.shift,
    altKey: input.alt,
    metaKey: input.meta,
    repeat: input.isAutoRepeat,
  };
}
