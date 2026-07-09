import { useEffect, useRef } from 'react';
import { Terminal, ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { ImageAddon } from '@xterm/addon-image';
import { SerializeAddon } from '@xterm/addon-serialize';
import { useStore } from '../store';
import { collectActiveTerminalSurfaceIds } from '../store/split-utils';
import { SplitNode, ThemeConfig } from '../../shared/types';
import { UserColorScheme } from '../store/settings-slice';
import { openInWmuxBrowser } from '../utils/open-in-browser';
import { attachVisibleRenderer, RendererHandle } from '../utils/terminal-renderer';
import '@xterm/xterm/css/xterm.css';

declare global {
  interface Window {
    wmux: any;
  }
}

interface UseTerminalOptions {
  surfaceId?: string;
  shell?: string;
  cwd?: string;
  /** Whether this terminal tab is currently visible (for refit on tab switch) */
  visible?: boolean;
  /** Whether this pane currently owns keyboard focus in the app.
   *  When both visible AND focused become true we pull DOM focus back onto
   *  xterm's hidden textarea — otherwise keystrokes go to whichever textarea
   *  was last focused (often in a now-hidden workspace), making the new
   *  session look "frozen". */
  focused?: boolean;
  /** Per-surface color scheme override — takes priority over terminalPrefs.theme. */
  colorScheme?: string;
  /** Quick-launch profile commands, run once after the PTY is first created (issue #32). */
  startupCommands?: string[];
}

interface UseTerminalResult {
  terminalRef: React.RefObject<HTMLDivElement | null>;
  fit: () => void;
  xtermRef: React.RefObject<Terminal | null>;
  searchAddonRef: React.RefObject<SearchAddon | null>;
}

function treeHasSurface(node: SplitNode, surfaceId: string): boolean {
  if (node.type === 'leaf') return node.surfaces.some((surface) => surface.id === surfaceId);
  return treeHasSurface(node.children[0], surfaceId) || treeHasSurface(node.children[1], surfaceId);
}

function findSurfaceLocation(node: SplitNode, surfaceId: string): { paneId: string } | null {
  if (node.type === 'leaf') {
    return node.surfaces.some((surface) => surface.id === surfaceId)
      ? { paneId: node.paneId }
      : null;
  }
  return findSurfaceLocation(node.children[0], surfaceId) || findSurfaceLocation(node.children[1], surfaceId);
}

function setResolvedShellForSurface(surfaceId: string | undefined, resolvedShell: string): void {
  if (!surfaceId || !resolvedShell) return;
  const state = useStore.getState();
  const workspace = state.workspaces.find((ws) => treeHasSurface(ws.splitTree, surfaceId));
  if (!workspace) return;
  const location = findSurfaceLocation(workspace.splitTree, surfaceId);
  if (!location) return;
  state.updateSurface(workspace.id, location.paneId as any, surfaceId as any, { shell: resolvedShell });
}

/**
 * Resolve the active color scheme name for a surface.
 * Priority: explicit `colorScheme` prop → user prefs default theme → 'Monokai'.
 */
function resolveSchemeName(override: string | undefined, prefsTheme: string | undefined): string {
  return override || prefsTheme || 'Monokai';
}

/**
 * Build an xterm ITheme from a bundled ThemeConfig plus an optional user
 * override (which partially replaces fields). This is what makes per-pane
 * `--color-scheme prod` work for user-defined schemes that aren't full themes.
 */
function buildXtermTheme(base: ThemeConfig, override?: UserColorScheme): ITheme {
  const fg = override?.foreground || base.foreground;
  const bg = override?.background || base.background;
  const cursor = override?.cursor || base.cursor || fg;
  const palette = [...base.palette];
  if (override?.palette) {
    for (let i = 0; i < override.palette.length && i < 16; i++) {
      if (override.palette[i]) palette[i] = override.palette[i];
    }
  }
  return {
    background: bg,
    foreground: fg,
    cursor,
    cursorAccent: override?.cursorText || base.cursorText || bg,
    selectionBackground: override?.selectionBackground || base.selectionBackground,
    selectionForeground: override?.selectionForeground || base.selectionForeground,
    black: palette[0], red: palette[1], green: palette[2], yellow: palette[3],
    blue: palette[4], magenta: palette[5], cyan: palette[6], white: palette[7],
    brightBlack: palette[8], brightRed: palette[9], brightGreen: palette[10], brightYellow: palette[11],
    brightBlue: palette[12], brightMagenta: palette[13], brightCyan: palette[14], brightWhite: palette[15],
  };
}

const themeCache = new Map<string, ThemeConfig>();

// Tracks whether mouse reporting is active for a given surface. Survives React
// remounts so the wheel handler can distinguish tmux (mouse-enabled) from a
// plain shell even when xterm's buffer.active.type is reset after remount.
const surfaceMouseEnabled = new Map<string, boolean>();

// Cache of serialized xterm buffers keyed by surfaceId. A split-tree
// restructure remounts PaneWrapper (React reconciliation moves it to a
// different depth/parent), disposing and recreating the terminal — which would
// otherwise wipe the scrollback (issue #49). We snapshot on unmount and replay
// on the next mount. Bounded so genuine pane closes can't leak the cache.
const surfaceBufferCache = new Map<string, string>();
const MAX_BUFFER_CACHE = 32;

// Live xterm instances keyed by surfaceId, so the pipe bridge can read screen
// content (surface.read_text / `wmux read-screen`) from the active buffer.
// Module-level like surfaceMouseEnabled: survives remounts; entries are
// registered on mount and removed on unmount (guarded so a StrictMode
// setup→cleanup→setup sequence can't delete the replacement instance).
export const surfaceTerminalRegistry = new Map<string, Terminal>();

// Convert a wheel delta to a line count (sign preserved, magnitude ≥ 1).
function wheelDeltaToLines(ev: WheelEvent, rows: number): number {
  let amount: number;
  if (ev.deltaMode === 1 /* DOM_DELTA_LINE */) amount = ev.deltaY;
  else if (ev.deltaMode === 2 /* DOM_DELTA_PAGE */) amount = ev.deltaY * (rows || 24);
  else amount = ev.deltaY / 17;
  return Math.sign(amount) * Math.max(1, Math.round(Math.abs(amount)));
}

// Approximate the terminal cell (1-based col/row) under the mouse pointer so
// SGR wheel reports carry a sensible origin; falls back to the screen centre
// when geometry is unavailable.
function pointerCell(
  ev: WheelEvent,
  terminal: Terminal,
  host: HTMLElement | null,
): { col: number; row: number } {
  const rect = host?.getBoundingClientRect();
  if (!rect) return { col: Math.ceil(terminal.cols / 2), row: Math.ceil(terminal.rows / 2) };
  const cellW = terminal.cols > 0 ? rect.width / terminal.cols : 0;
  const cellH = terminal.rows > 0 ? rect.height / terminal.rows : 0;
  const col = cellW > 0
    ? Math.max(1, Math.min(terminal.cols, Math.ceil((ev.clientX - rect.left) / cellW)))
    : Math.ceil(terminal.cols / 2);
  const row = cellH > 0
    ? Math.max(1, Math.min(terminal.rows, Math.ceil((ev.clientY - rect.top) / cellH)))
    : Math.ceil(terminal.rows / 2);
  return { col, row };
}

// Forward a wheel scroll to the PTY for an app that owns the screen (alt buffer
// or mouse-tracking): SGR wheel reports (button 64=up/65=down) at the pointer
// cell when mouse tracking is on, else arrow keys (matching xterm's native
// _handlePassiveWheel fallback for non-mouse pagers like less/man).
function writeWheelToPty(
  ev: WheelEvent,
  terminal: Terminal,
  host: HTMLElement | null,
  ptyId: string,
  count: number,
  mouseTracking: boolean,
): void {
  let seq: string;
  if (mouseTracking) {
    const { col, row } = pointerCell(ev, terminal, host);
    const btn = count < 0 ? 64 : 65; // 64 = wheel-up, 65 = wheel-down
    seq = `\x1b[<${btn};${col};${row}M`;
  } else {
    seq = count < 0 ? '\x1b[A' : '\x1b[B'; // arrow keys for non-mouse pagers
  }
  for (let i = 0; i < Math.abs(count); i++) window.wmux.pty.write(ptyId, seq);
}

// Capture-phase wheel handler. We always take ownership (xterm's own forwarding
// is unreliable after the WebGL context swap, #41, and an adjacent <webview>
// compositor otherwise steals un-prevented wheel events, #47):
//   normal buffer + plain shell     → scroll wmux's own scrollback
//   alt buffer OR mouse-tracking app → forward to the PTY
// surfaceMouseEnabled (survives remounts) is the reliable mouse-active signal,
// since tmux doesn't re-send its DECSET enables on SIGWINCH after a remount.
function handleTerminalWheel(
  ev: WheelEvent,
  terminal: Terminal,
  host: HTMLElement | null,
  ptyId: string | null,
  surfaceId: string | undefined,
): void {
  if (ev.deltaY === 0) return;
  const isAltBuffer = terminal.buffer.active.type !== 'normal';
  const isMouseEnabled = !!(surfaceId && surfaceMouseEnabled.get(surfaceId));

  if (!isAltBuffer && !isMouseEnabled) {
    ev.preventDefault();
    ev.stopPropagation();
    const lines = wheelDeltaToLines(ev, terminal.rows);
    if (lines !== 0) terminal.scrollLines(lines);
    return;
  }

  ev.preventDefault();
  ev.stopPropagation();
  if (!ptyId) return;
  const count = wheelDeltaToLines(ev, terminal.rows);
  if (count !== 0) writeWheelToPty(ev, terminal, host, ptyId, count, isMouseEnabled);
}

// Initial PTY resize after attach, retried via rAF until xterm's renderer has
// laid out and proposeDimensions() returns non-null (it can be null briefly
// after open()). Without a successful resize tmux never gets SIGWINCH and won't
// redraw into the new xterm instance. Module-level to avoid deep function nesting.
function scheduleInitialResize(
  ptyId: string,
  fit: () => void,
  fitAddon: FitAddon,
  ptyIdRef: { current: string | null },
  attempt = 0,
): void {
  fit();
  const dims = fitAddon.proposeDimensions();
  if (dims) {
    window.wmux.pty.resize(ptyId, dims.cols, dims.rows);
  } else if (attempt < 8) {
    requestAnimationFrame(() => {
      if (ptyIdRef.current === ptyId) scheduleInitialResize(ptyId, fit, fitAddon, ptyIdRef, attempt + 1);
    });
  }
}

// Deferred visual safety-net: the initial resize already sent the correct PTY
// dimensions, but this ensures the renderer actually paints — refresh() marks
// rows dirty and scrollToBottom() flushes a pending paint regardless of renderer.
// No fit()/resize() here: a second resize at 300ms can return slightly different
// col/row counts (sub-pixel rounding) and clear the viewport just before paint.
// Returns the timer id so the caller can clear it on teardown.
function scheduleDeferredRepaint(terminal: Terminal): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    requestAnimationFrame(() => {
      try {
        terminal.scrollToBottom();
        terminal.refresh(0, terminal.rows - 1);
      } catch {}
    });
  }, 300);
}

async function fetchTheme(name: string): Promise<ThemeConfig> {
  const cached = themeCache.get(name);
  if (cached) return cached;
  try {
    const theme: ThemeConfig = await (window as any).wmux.config.getTheme(name);
    themeCache.set(name, theme);
    return theme;
  } catch {
    return themeCache.get('Monokai') || ({
      name: 'Monokai',
      background: '#272822', foreground: '#fdfff1', cursor: '#c0c1b5',
      cursorText: '', selectionBackground: '#57584f', selectionForeground: '#fdfff1',
      palette: ['#272822','#f92672','#a6e22e','#f4bf75','#66d9ef','#ae81ff','#a1efe4','#f8f8f2',
                '#75715e','#f92672','#a6e22e','#f4bf75','#66d9ef','#ae81ff','#a1efe4','#f9f8f5'],
      fontFamily: 'Cascadia Mono', fontSize: 13, backgroundOpacity: 1.0,
    } as ThemeConfig);
  }
}

export function useTerminal({ surfaceId, shell, cwd, visible = true, focused = true, colorScheme, startupCommands }: UseTerminalOptions = {}): UseTerminalResult {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const cleanupFnsRef = useRef<Array<() => void>>([]);
  const rendererRef = useRef<RendererHandle | null>(null);
  // Captured in a ref so the (mount-once) terminal effect can read the latest
  // startup commands without listing them as a dependency.
  const startupCommandsRef = useRef<string[] | undefined>(startupCommands);
  startupCommandsRef.current = startupCommands;

  // Subscribe to relevant settings so changes apply live.
  const prefs = useStore((s) => s.terminalPrefs);
  const schemeName = resolveSchemeName(colorScheme, prefs.theme);
  const userScheme = prefs.userColorSchemes?.[schemeName];

  const fit = () => {
    if (fitAddonRef.current) {
      try {
        fitAddonRef.current.fit();
      } catch {
        // ignore fit errors (e.g. terminal not yet visible)
      }
    }
  };

  useEffect(() => {
    if (!terminalRef.current) return;

    // Create terminal instance. Theme/font are applied from settings on creation
    // AND kept in sync via a later effect, so live edits repaint without recreation.
    const terminal = new Terminal({
      theme: {
        background: '#272822',
        foreground: '#fdfff1',
        cursor: '#c0c1b5',
        selectionBackground: '#57584f',
        selectionForeground: '#fdfff1',
      },
      fontFamily: prefs.fontFamily || "'Cascadia Mono', 'Consolas', monospace",
      fontSize: prefs.fontSize || 13,
      cursorBlink: prefs.cursorBlink ?? true,
      cursorStyle: prefs.cursorStyle || 'block',
      allowTransparency: false,
      allowProposedApi: true,
      scrollback: prefs.scrollbackLines || 10000,
    });

    xtermRef.current = terminal;

    // Set true by the cleanup below. React StrictMode (dev) double-invokes
    // effects as setup → cleanup → setup, so the terminal can be disposed while
    // async work is still in flight (a late `pty.create().then()`, a buffered
    // `terminal.write()`, a queued requestAnimationFrame). Touching xterm after
    // dispose hits a render service whose renderer is gone and throws
    // "Cannot read properties of undefined (reading 'dimensions')" from deep in
    // Viewport.syncScrollArea. Every async callback checks this flag first.
    let disposed = false;

    // Create and load addons
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon((event, uri) => {
      const forceExternal = !!(event as MouseEvent)?.ctrlKey || !!(event as MouseEvent)?.metaKey;
      openInWmuxBrowser(uri, { forceExternal });
    });
    const searchAddon = new SearchAddon();
    const unicode11Addon = new Unicode11Addon();
    const imageAddon = new ImageAddon();
    const serializeAddon = new SerializeAddon();

    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(unicode11Addon);
    terminal.loadAddon(imageAddon);
    terminal.loadAddon(serializeAddon);
    terminal.unicode.activeVersion = '11';

    // Suppress xterm's automatic Primary Device Attributes (DA1) reply — the
    // main process answers DA1 instead (see DA1_QUERY in pty-manager.ts).
    //
    // xterm would otherwise answer a DA1 query (`\x1b[c` / `\x1b[0c`) by emitting
    // a reply through onData that we forward to the PTY. With the image addon
    // loaded that reply is `\x1b[?62;4;9;22c`. Because the PTY↔renderer hop is
    // multi-process, that reply arrives too late: it lands after the shell has
    // drawn its prompt, so oh-my-posh/PSReadLine echo it as a typed line (the
    // `[?62;4;9;22c` junk) and re-render. The main process now answers the same
    // probe in-process (instant), so we must stop xterm sending its slow
    // duplicate — otherwise the late reply leaks again.
    //
    // Registered AFTER the image addon so it wins precedence: xterm runs CSI
    // handlers newest-first and stops at the first returning true, so neither the
    // image addon's DA1 override nor xterm's built-in reply runs.
    terminal.parser.registerCsiHandler({ final: 'c' }, () => true);

    // Open terminal in the DOM
    terminal.open(terminalRef.current);

    if (surfaceId) surfaceTerminalRegistry.set(surfaceId, terminal);

    // Restore a buffer snapshot captured before a previous unmount (issue #49).
    // Written now — before the PTY reattaches below — so the restored scrollback
    // lands ahead of any new PTY output. We snapshot the normal buffer only
    // (excludeAltBuffer), so a TUI like tmux/vim simply redraws itself via the
    // post-remount SIGWINCH on top of the restored shell scrollback.
    if (surfaceId) {
      const snapshot = surfaceBufferCache.get(surfaceId);
      if (snapshot) {
        surfaceBufferCache.delete(surfaceId);
        terminal.write(snapshot);
      }
    }

    // Wheel handling — we always take ownership on the capture phase (xterm's
    // own forwarding is unreliable after the WebGL context swap, #41, and an
    // adjacent <webview> compositor otherwise steals un-prevented wheel events,
    // #47). Two outcomes, decided per surface:
    //   normal buffer + plain shell      → scroll wmux's own scrollback
    //   alt buffer OR mouse-tracking app  → forward to the PTY (SGR wheel reports
    //                                        if mouse tracking is on, else arrows)
    //
    // Buffer type alone is unreliable: after a React remount tmux doesn't re-send
    // \x1b[?1049h on SIGWINCH (only on a fresh client attach), so
    // xterm's buffer.active.type stays 'normal' even though tmux is drawn there.
    // surfaceMouseEnabled (module-level, survives remounts) is the reliable signal.
    const wheelHost = terminalRef.current;
    const onWheelCapture = (ev: WheelEvent) =>
      handleTerminalWheel(ev, terminal, terminalRef.current, ptyIdRef.current, surfaceId);
    wheelHost.addEventListener('wheel', onWheelCapture, { capture: true, passive: false });
    cleanupFnsRef.current.push(() => {
      wheelHost.removeEventListener('wheel', onWheelCapture, { capture: true } as any);
    });

    // File drag-and-drop → insert the dropped path(s) into the terminal.
    // Windows Terminal and macOS Terminal both do this (issue #33). The browser's
    // DEFAULT drop action is to navigate the window to file:///… which would unload
    // the whole app, so we preventDefault on BOTH dragover (to mark a valid drop
    // target) and drop. Electron 33 removed File.path, so paths come from the
    // preload-exposed webUtils bridge (window.wmux.shell.getPathForFile). Paths
    // are routed through terminal.paste() so bracketed-paste mode is honored,
    // matching the Ctrl+V / image-paste handlers below.
    const dropHost = terminalRef.current;
    const onDragOver = (ev: DragEvent) => {
      if (ev.dataTransfer?.types?.includes('Files')) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'copy';
      }
    };
    const onDrop = (ev: DragEvent) => {
      const files = ev.dataTransfer?.files;
      if (!files || files.length === 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      const getPath = window.wmux?.shell?.getPathForFile;
      if (!getPath) return;
      const parts: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const p = getPath(files[i]);
        // Quote paths containing spaces so they survive as a single shell token.
        if (p) parts.push(/\s/.test(p) ? `"${p}"` : p);
      }
      if (parts.length > 0 && ptyIdRef.current) {
        terminal.paste(parts.join(' '));
        try { terminal.focus(); } catch { /* no-op */ }
      }
    };
    dropHost.addEventListener('dragover', onDragOver);
    dropHost.addEventListener('drop', onDrop);
    cleanupFnsRef.current.push(() => {
      dropHost.removeEventListener('dragover', onDragOver);
      dropHost.removeEventListener('drop', onDrop);
    });

    // Korean/CJK IME reliability fix.
    // xterm.js 5.5's CompositionHelper._finalizeComposition defers reading the
    // textarea via setTimeout(0), which races against fast Hangul composition
    // (an ending jamo can migrate into the next syllable before the timer fires,
    // producing dropped/duplicated/wrong characters). Modern Chromium updates
    // the textarea synchronously before compositionend, so we replace
    // _finalizeComposition with a sync implementation that reads the textarea
    // at event-time and clears the consumed portion to prevent double-consume
    // by the subsequent input event.
    const xtermCore: any = (terminal as any)._core;
    const compositionHelper: any = xtermCore?._compositionHelper;
    if (compositionHelper && xtermCore?.textarea) {
      compositionHelper._finalizeComposition = function (this: any, _waitForPropagation: boolean): void {
        if (this._compositionView) {
          this._compositionView.classList.remove('active');
          this._compositionView.textContent = '';
        }
        this._isComposing = false;
        this._isSendingComposition = false;
        const start: number = this._compositionPosition?.start ?? 0;
        const ta: HTMLTextAreaElement = this._textarea;
        const value = ta.value;
        const input = value.substring(start);
        if (input.length > 0 && this._coreService) {
          this._coreService.triggerDataEvent(input, true);
        }
        ta.value = value.substring(0, start);
        this._compositionPosition = { start: 0, end: 0 };
        this._dataAlreadySent = '';
      };
    }

    // Register OSC notification handlers
    // OSC 9: basic notification (iTerm2 style)
    terminal.parser.registerOscHandler(9, (data) => {
      window.wmux.notification.fire({
        surfaceId: ptyIdRef.current || '',
        text: data,
      });
      return true;
    });

    // OSC 99: rich notification (kitty style)
    terminal.parser.registerOscHandler(99, (data) => {
      // Parse kitty notification format: key=value pairs separated by ;
      const params: Record<string, string> = {};
      data.split(';').forEach(part => {
        const [k, ...v] = part.split('=');
        if (k && v.length) params[k.trim()] = v.join('=').trim();
      });
      window.wmux.notification.fire({
        surfaceId: ptyIdRef.current || '',
        text: params.body || params.d || data,
        title: params.title || params.t,
      });
      return true;
    });

    // OSC 777: rxvt-unicode style (notify;title;body)
    terminal.parser.registerOscHandler(777, (data) => {
      const parts = data.split(';');
      if (parts[0] === 'notify' && parts.length >= 3) {
        window.wmux.notification.fire({
          surfaceId: ptyIdRef.current || '',
          text: parts.slice(2).join(';'),
          title: parts[1],
        });
      }
      return true;
    });

    // Terminal bell (\x07) fallback (issue #53): many in-pane CLI agents —
    // including Claude Code's default "I'm waiting for you" signal — ring the
    // bell rather than emitting an OSC sequence or firing a hook. Surface it as
    // a notification, throttled so a burst of bells (e.g. shell tab-completion
    // with no match) doesn't flood the user.
    let lastBellAt = 0;
    terminal.onBell(() => {
      const now = Date.now();
      if (now - lastBellAt < 3000) return;
      lastBellAt = now;
      window.wmux.notification.fire({
        surfaceId: ptyIdRef.current || '',
        text: 'Terminal bell',
      });
    });

    // OSC 52: clipboard write — emitted by tmux when text is copied (set-clipboard on).
    // navigator.clipboard.writeText() requires a user-gesture context which PTY data
    // callbacks don't have, so we go through Electron's clipboard module via IPC.
    terminal.parser.registerOscHandler(52, (data) => {
      const semi = data.indexOf(';');
      const b64 = semi >= 0 ? data.slice(semi + 1) : data;
      // Ignore read requests (b64 === '?') and empty payloads; otherwise decode
      // and route to Electron's clipboard via IPC. The sequence is consumed
      // (handled) either way.
      if (b64 && b64 !== '?') {
        try {
          // atob() yields a binary (Latin-1) string — one code point per byte.
          // OSC 52 payloads are UTF-8, so decode the bytes as UTF-8; otherwise
          // multi-byte chars (em dash E2 80 94) become mojibake (â€").
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const text = new TextDecoder('utf-8').decode(bytes);
          if (text) window.wmux?.clipboard?.writeText?.(text);
        } catch {}
      }
      return true;
    });

    // GPU renderer (WebGL preferred) is attached by the visibility effect
    // below, only while this terminal is actually on screen. Hidden keep-alive
    // tabs stay on xterm's default DOM renderer so the per-process WebGL
    // context cap (~16 in Chromium) is never approached. The deprecated Canvas
    // addon is only a fallback — it mispaints wide CJK chars and stale rows
    // under load (issues #23, #30).

    // Initial fit
    requestAnimationFrame(() => {
      fit();
    });

    // Attach custom key handler for Ctrl+C and Ctrl+V (image paste)
    terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type === 'keydown' && event.ctrlKey && event.key === 'c') {
        const selection = terminal.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection).catch(() => {});
          terminal.clearSelection();
          return false;
        }
      }
      // Ctrl+V: paste text from clipboard (or image path if clipboard has image)
      if (event.type === 'keydown' && event.ctrlKey && event.key === 'v') {
        // Prevent the browser 'paste' event — without this, xterm's built-in
        // paste handler ALSO writes the clipboard content through onData,
        // causing the text to appear twice in the terminal.
        event.preventDefault();
        (async () => {
          // Check for image first
          let handled = false;
          if (window.wmux?.clipboard?.pasteImage) {
            const filePath = await window.wmux.clipboard.pasteImage();
            if (filePath && ptyIdRef.current) {
              // Route through terminal.paste so bracketed-paste markers wrap
              // the path when the app (e.g. Claude Code) has bracketed paste on.
              terminal.paste(filePath);
              handled = true;
            }
          }
          // If no image, paste text via Electron's clipboard API — navigator.clipboard
          // can return garbled bytes on Windows when the source wrote a non-UTF-8 format.
          if (!handled && ptyIdRef.current) {
            try {
              const text = await window.wmux.clipboard.readText();
              if (text) terminal.paste(text);
            } catch {}
          }
        })();
        return false; // Prevent default — we handle paste ourselves
      }
      return true;
    });

    // Connect to PTY — either attach to existing (agent-spawned) or create new

    // Pending resize dims captured by ResizeObserver before PTY is attached.
    // When ResizeObserver fires before the IPC for pty.create/has resolves,
    // ptyIdRef.current is null and the resize would be silently dropped. We
    // stash the last observed dims and flush them in attachToPty instead.
    let pendingResizeDims: { cols: number; rows: number } | null = null;

    const attachToPty = (id: string) => {
      ptyIdRef.current = id;

      // Wire PTY data → xterm
      const unsubData = window.wmux.pty.onData(id, (data: string) => {
        if (disposed) return;
        // Track SGR/button mouse enable (?1006h, ?1000h, ?1002h, ?1003h) and disable
        // so the wheel handler can distinguish tmux from a plain shell after remount.
        // Mirror the enable pattern for disable so any of the four modes clears the flag.
        if (/\x1b\[\?100[0236]h/.test(data)) surfaceMouseEnabled.set(id, true);
        else if (/\x1b\[\?100[0236]l/.test(data)) surfaceMouseEnabled.set(id, false);
        terminal.write(data);
      });

      // Wire PTY exit → inform user
      const unsubExit = window.wmux.pty.onExit(id, (_code: number) => {
        terminal.writeln('\r\n\x1b[2m[process exited]\x1b[0m');
        // Auto-heal a stuck "Running" badge. shellState is a single
        // last-writer-wins workspace field, written only by the in-pane shell
        // integration (report_shell_state). A shell that emits "running" but is
        // killed before returning to its prompt (e.g. an orchestration agent TUI
        // reaped at teardown) never emits the matching "idle", stranding the
        // sidebar on "Running". A PTY that has exited cannot be the running
        // command, so clear it here.
        try {
          const store = useStore.getState();
          const ws = store.workspaces.find((w) => treeHasSurface(w.splitTree, id));
          if (ws && ws.shellState === 'running') {
            store.updateWorkspaceMetadata(ws.id, { shellState: 'idle' });
          }
        } catch { /* best-effort: badge reset is non-critical */ }
      });

      cleanupFnsRef.current.push(unsubData, unsubExit);

      // Flush any resize that arrived before this PTY was ready
      if (pendingResizeDims) {
        window.wmux.pty.resize(id, pendingResizeDims.cols, pendingResizeDims.rows);
        pendingResizeDims = null;
      } else {
        // Initial resize, retried until the renderer has laid out (see helper).
        scheduleInitialResize(id, fit, fitAddon, ptyIdRef);
      }

      // Deferred visual safety-net (see scheduleDeferredRepaint).
      const deferredResizeId = scheduleDeferredRepaint(terminal);
      cleanupFnsRef.current.push(() => clearTimeout(deferredResizeId));
    };

    // Fallback path for quick-launch startup commands on shells where the main
    // process couldn't bake them into the shell's own init (anything other than
    // PowerShell — see PtyManager.create). PowerShell runs them via the
    // integration script before the first prompt, which avoids a keystroke race
    // against the shell's init-time terminal queries (a ConPTY DA1 response
    // leaking onto the prompt as `\x1b[?62;4;9;22c` and merging with an injected
    // `<cmd>\r` into a bogus line like `62;4;9;22ccls`). When `consumed` is true
    // we MUST NOT also inject, or the commands would run twice.
    const runStartupCommands = (id: string, consumed: boolean) => {
      if (consumed) return;
      const cmds = startupCommandsRef.current;
      if (!cmds || cmds.length === 0) return;
      setTimeout(() => {
        for (const cmd of cmds) {
          if (typeof cmd === 'string' && cmd.length > 0) {
            window.wmux.pty.write(id, cmd + '\r');
          }
        }
      }, 600);
    };

    // Resolve effective shell: explicit (workspace) > user default preference > main-process fallback.
    // Read prefs at spawn time so changing the default later doesn't re-spawn live PTYs.
    const effectiveShell = shell || useStore.getState().workspacePrefs.defaultShell || '';

    // Spawn the PTY at the already-measured terminal size. Otherwise it starts at
    // the 80x24 default and our follow-up resize triggers a window-size-change in
    // the shell, which makes PSReadLine/oh-my-posh redraw the prompt — the doubled
    // prompt users saw. A hidden/unmeasured tab yields no dims and falls back to
    // the default, then resizes correctly when first shown (that redraw isn't
    // visible). proposeDimensions needs the element laid out, which it is after
    // terminal.open() above.
    let initialCols: number | undefined;
    let initialRows: number | undefined;
    try {
      const dims = fitAddon.proposeDimensions();
      if (dims && dims.cols > 0 && dims.rows > 0) {
        initialCols = dims.cols;
        initialRows = dims.rows;
      }
    } catch { /* element not measurable yet — fall back to PTY default */ }

    // If surfaceId is given AND a PTY already exists for it (agent spawn or re-mount), attach to it
    if (surfaceId && window.wmux.pty.has) {
      window.wmux.pty.has(surfaceId).then((exists: boolean) => {
        if (exists) {
          attachToPty(surfaceId!);
        } else {
          // No existing PTY — create a new one, passing surfaceId so PTY ID = Surface ID
          window.wmux.pty.create({ shell: effectiveShell, cwd: cwd ?? '', env: {}, surfaceId, startupCommands: startupCommandsRef.current, cols: initialCols, rows: initialRows })
            .then((created: { id: string; shell: string; startupCommandsConsumed?: boolean }) => {
              // PTY persists (keep-alive); a remount re-attaches via pty.has.
              if (disposed) return;
              setResolvedShellForSurface(surfaceId, created.shell);
              attachToPty(created.id);
              runStartupCommands(created.id, !!created.startupCommandsConsumed);
            })
            .catch((err: unknown) => terminal.writeln(`\r\n\x1b[31m[failed to create PTY: ${err}]\x1b[0m`));
        }
      });
    } else {
      // No surfaceId hint — always create new PTY
      window.wmux.pty.create({ shell: effectiveShell, cwd: cwd ?? '', env: {}, startupCommands: startupCommandsRef.current, cols: initialCols, rows: initialRows })
        .then((created: { id: string; shell: string; startupCommandsConsumed?: boolean }) => {
          if (disposed) return;
          setResolvedShellForSurface(surfaceId, created.shell);
          attachToPty(created.id);
          runStartupCommands(created.id, !!created.startupCommandsConsumed);
        })
        .catch((err: unknown) => terminal.writeln(`\r\n\x1b[31m[failed to create PTY: ${err}]\x1b[0m`));
    }

    // Wire xterm input → PTY
    const dataDisposable = terminal.onData((data: string) => {
      if (!ptyIdRef.current) return;
      // Broadcast-input mode (issue #64, tmux synchronize-panes): fan keystrokes
      // out to every terminal pane in the workspace that owns this surface. Only
      // the focused terminal's onData fires, so this is the single source pane.
      const st = useStore.getState();
      if (st.broadcastInputActive && surfaceId) {
        const ws = st.workspaces.find((w) => treeHasSurface(w.splitTree, surfaceId));
        if (ws) {
          for (const id of collectActiveTerminalSurfaceIds(ws.splitTree)) {
            window.wmux.pty.write(id, data);
          }
          return;
        }
      }
      window.wmux.pty.write(ptyIdRef.current, data);
    });

    // ResizeObserver to auto-fit and relay size to PTY (debounced to prevent IPC spam)
    let resizeRaf: number | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeRaf !== null) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null;
        fit();
        const dims = fitAddon.proposeDimensions();
        if (dims) {
          if (ptyIdRef.current) {
            window.wmux.pty.resize(ptyIdRef.current, dims.cols, dims.rows);
          } else {
            // PTY not attached yet — stash so attachToPty can flush it
            pendingResizeDims = { cols: dims.cols, rows: dims.rows };
          }
        }
        // Mark rows dirty after layout change for plain shells. fit() updates
        // xterm's dimensions but doesn't schedule a repaint, so the renderer
        // won't update until the next keypress — leaving the terminal visually
        // frozen after an adjacent pane is closed/resized.
        // Skip for mouse-enabled apps (tmux, vim…): they receive SIGWINCH from the
        // pty.resize() call above and redraw themselves. A premature refresh here
        // would paint stale/clipped buffer content before their redraw arrives.
        if (!surfaceId || !surfaceMouseEnabled.get(surfaceId)) {
          try { terminal.refresh(0, terminal.rows - 1); } catch {}
        }
      });
    });

    resizeObserver.observe(terminalRef.current);

    // Cleanup
    return () => {
      // Mark disposed FIRST so any async callback that fires during/after
      // teardown (late pty.create().then, buffered write, queued rAF) bails out
      // before touching the soon-to-be-disposed terminal.
      disposed = true;
      resizeObserver.disconnect();
      if (resizeRaf !== null) cancelAnimationFrame(resizeRaf);
      dataDisposable.dispose();

      // Run all IPC unsubscribe functions
      for (const fn of cleanupFnsRef.current) {
        fn();
      }
      cleanupFnsRef.current = [];

      // Do NOT kill the PTY here — only explicit close (handleCloseSurface)
      // kills PTYs. This allows tree restructuring (closing an adjacent pane)
      // to re-mount this component without losing the terminal session.

      // Snapshot the buffer before disposal so a remount (split-tree
      // restructure) can replay it (issue #49). Normal buffer only, so a TUI's
      // own SIGWINCH redraw owns the alt screen after remount. Bounded LRU so a
      // genuine pane close (no remount to consume it) can't grow the cache.
      if (surfaceId) {
        try {
          const snapshot = serializeAddon.serialize({ excludeAltBuffer: true });
          if (snapshot) {
            if (surfaceBufferCache.size >= MAX_BUFFER_CACHE) {
              const oldest = surfaceBufferCache.keys().next().value;
              if (oldest !== undefined) surfaceBufferCache.delete(oldest);
            }
            surfaceBufferCache.set(surfaceId, snapshot);
          }
        } catch {
          // Serialization failure is non-fatal — just lose the snapshot.
        }
      }

      // Drop the read-screen registry entry — but only if it still points at
      // THIS terminal (StrictMode re-setup may already have registered the
      // replacement instance under the same surfaceId).
      if (surfaceId && surfaceTerminalRegistry.get(surfaceId) === terminal) {
        surfaceTerminalRegistry.delete(surfaceId);
      }

      // Release the GPU renderer (and its WebGL budget slot) before disposing
      rendererRef.current?.dispose();
      rendererRef.current = null;

      // Dispose terminal
      terminal.dispose();
      xtermRef.current = null;
      ptyIdRef.current = null;
    };
  }, []);

  // Paste delegated from the keyboard-shortcut handler (e.g. Ctrl+Shift+V).
  // Routed here so it shares the Ctrl+V path's correctness: Electron's
  // clipboard.readText() (navigator.clipboard garbles non-UTF-8 Windows
  // formats — em dash → "â") and terminal.paste() (honors bracketed-paste
  // mode, so multi-line paste into Claude Code doesn't submit on the first \n).
  useEffect(() => {
    const handler = async (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.surfaceId !== surfaceId) return;
      const term = xtermRef.current;
      if (!term || !ptyIdRef.current) return;
      try {
        const text = await window.wmux.clipboard.readText();
        if (text) term.paste(text);
      } catch {}
    };
    document.addEventListener('wmux:paste-terminal', handler);
    return () => document.removeEventListener('wmux:paste-terminal', handler);
  }, [surfaceId]);

  // Apply theme + font whenever the resolved scheme or prefs change.
  // Keeps terminals reactive: changing the global theme in Settings, or
  // assigning a per-pane `--color-scheme`, repaints without recreation.
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    let cancelled = false;
    fetchTheme(schemeName).then((base) => {
      if (cancelled || !xtermRef.current) return;
      xtermRef.current.options.theme = buildXtermTheme(base, userScheme);
    });
    // Font + cursor + scrollback can be applied synchronously.
    term.options.fontFamily = prefs.fontFamily || term.options.fontFamily;
    term.options.fontSize = prefs.fontSize || term.options.fontSize;
    term.options.cursorStyle = prefs.cursorStyle || term.options.cursorStyle;
    term.options.cursorBlink = prefs.cursorBlink ?? term.options.cursorBlink;
    term.options.scrollback = prefs.scrollbackLines || term.options.scrollback;
    return () => { cancelled = true; };
  }, [schemeName, userScheme, prefs.fontFamily, prefs.fontSize, prefs.cursorStyle, prefs.cursorBlink, prefs.scrollbackLines]);

  // Refit + force-repaint when terminal becomes visible again (tab/workspace switch).
  // Canvas2D inside a visibility:hidden ancestor skips paint frames; on return we
  // must trigger an explicit refresh() so the buffer re-draws to the canvas.
  // Also: when this pane is the active one in the now-visible workspace,
  // pull DOM focus back onto xterm's textarea. Without this, after switching
  // sessions keystrokes still target the previously-focused (now hidden)
  // terminal and the new session looks frozen.
  useEffect(() => {
    // Track the nested rAFs so they can be cancelled if the terminal is hidden
    // or unmounted before they fire. Otherwise (notably under StrictMode's
    // double-mount) they run fit()/resize/refresh on a disposed terminal and
    // throw from Viewport.syncScrollArea ("...reading 'dimensions'").
    let raf1: number | null = null;
    let raf2: number | null = null;
    if (visible && fitAddonRef.current && xtermRef.current) {
      const term = xtermRef.current;
      // Attach the GPU renderer on show (WebGL → Canvas → DOM). A Canvas/DOM
      // fallback handle is kept across hides to avoid attach churn; only WebGL
      // is released on hide to return its context to the budget.
      if (!rendererRef.current) {
        rendererRef.current = attachVisibleRenderer(term);
      }
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          // The terminal may have been disposed between scheduling and firing.
          if (!xtermRef.current) return;
          fit();
          const dims = fitAddonRef.current?.proposeDimensions();
          if (dims && ptyIdRef.current) {
            window.wmux.pty.resize(ptyIdRef.current, dims.cols, dims.rows);
          }
          try { term.refresh(0, term.rows - 1); } catch { /* no-op */ }
          if (focused) {
            try { term.focus(); } catch { /* no-op */ }
          }
        });
      });
    } else if (!visible && rendererRef.current?.kind === 'webgl') {
      // Hidden: free the WebGL context. The default DOM renderer takes over
      // for background writes; we re-attach WebGL when shown again.
      rendererRef.current.dispose();
      rendererRef.current = null;
    }
    return () => {
      if (raf1 !== null) cancelAnimationFrame(raf1);
      if (raf2 !== null) cancelAnimationFrame(raf2);
    };
  }, [visible, focused]);

  return { terminalRef, fit, xtermRef, searchAddonRef };
}
