import { useEffect, useRef } from 'react';
import { Terminal, ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { ImageAddon } from '@xterm/addon-image';
import { useStore } from '../store';
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

    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(unicode11Addon);
    terminal.loadAddon(imageAddon);
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

    // Always scroll wmux's buffer on wheel — never forward to the app.
    // Without this, when a TUI (Claude Code, vim, tmux…) enables mouse
    // tracking via DECSET 1000/1002/1003/1006, xterm.js sends wheel
    // events to the app instead of scrolling the buffer (see
    // @xterm/xterm Terminal.ts wheel handler: `if (requestedEvents.wheel) return`).
    // That has two visible effects: scrollback is dead, AND the app paints
    // a cell highlight that tracks the mouse cursor. We intercept on the
    // capture phase before xterm's listener runs.
    const wheelHost = terminalRef.current;
    const onWheelCapture = (ev: WheelEvent) => {
      if (ev.deltaY === 0) return;
      // Only hijack the wheel for scrollback on the NORMAL buffer. Full-screen
      // TUIs (Claude Code, vim, less, htop…) switch to the ALTERNATE buffer
      // (DECSET 1049), which has no scrollback — terminal.scrollLines() there is
      // a no-op. If we still preventDefault/stopPropagation we also suppress
      // xterm's native behavior of forwarding the wheel to the app (mouse-wheel
      // reports when mouse tracking is on, otherwise arrow-key sequences), which
      // is the ONLY way those apps scroll their own content. So on the alt
      // buffer we fall through and let xterm handle it.
      if (terminal.buffer.active.type !== 'normal') return;
      ev.preventDefault();
      ev.stopPropagation();
      let amount: number;
      if (ev.deltaMode === 1 /* DOM_DELTA_LINE */) {
        amount = ev.deltaY;
      } else if (ev.deltaMode === 2 /* DOM_DELTA_PAGE */) {
        amount = ev.deltaY * (terminal.rows || 24);
      } else {
        amount = ev.deltaY / 17;
      }
      const lines = Math.sign(amount) * Math.max(1, Math.round(Math.abs(amount)));
      if (lines !== 0) terminal.scrollLines(lines);
    };
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
          const text = atob(b64);
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
          // If no image, paste text
          if (!handled && ptyIdRef.current) {
            try {
              const text = await navigator.clipboard.readText();
              // Use terminal.paste() — it honors bracketed-paste mode and emits
              // the data through onData (already wired to PTY). Writing raw to
              // pty.write strips the \x1b[200~/\x1b[201~ wrappers, so apps like
              // Claude Code see each \n as Enter and only the first line lands.
              if (text) terminal.paste(text);
            } catch {}
          }
        })();
        return false; // Prevent default — we handle paste ourselves
      }
      return true;
    });

    // Connect to PTY — either attach to existing (agent-spawned) or create new
    const attachToPty = (id: string) => {
      ptyIdRef.current = id;

      // Wire PTY data → xterm
      const unsubData = window.wmux.pty.onData(id, (data: string) => {
        if (disposed) return;
        terminal.write(data);
      });

      // Wire PTY exit → inform user
      const unsubExit = window.wmux.pty.onExit(id, (_code: number) => {
        terminal.writeln('\r\n\x1b[2m[process exited]\x1b[0m');
      });

      cleanupFnsRef.current.push(unsubData, unsubExit);

      // Initial resize after PTY is ready
      fit();
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        window.wmux.pty.resize(id, dims.cols, dims.rows);
      }
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
      if (ptyIdRef.current) {
        window.wmux.pty.write(ptyIdRef.current, data);
      }
    });

    // ResizeObserver to auto-fit and relay size to PTY (debounced to prevent IPC spam)
    let resizeRaf: number | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeRaf !== null) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null;
        fit();
        const dims = fitAddon.proposeDimensions();
        if (dims && ptyIdRef.current) {
          window.wmux.pty.resize(ptyIdRef.current, dims.cols, dims.rows);
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

      // Release the GPU renderer (and its WebGL budget slot) before disposing
      rendererRef.current?.dispose();
      rendererRef.current = null;

      // Dispose terminal
      terminal.dispose();
      xtermRef.current = null;
      ptyIdRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
