import { useEffect, useRef } from 'react';
import { Terminal, ITheme } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { ImageAddon } from '@xterm/addon-image';
import { useStore } from '../store';
import { SplitNode, ThemeConfig } from '../../shared/types';
import { UserColorScheme } from '../store/settings-slice';
import { openInWmuxBrowser } from '../utils/open-in-browser';
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
  /** Per-surface color scheme override — takes priority over terminalPrefs.theme. */
  colorScheme?: string;
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

export function useTerminal({ surfaceId, shell, cwd, visible = true, colorScheme }: UseTerminalOptions = {}): UseTerminalResult {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const cleanupFnsRef = useRef<Array<() => void>>([]);

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

    // Open terminal in the DOM
    terminal.open(terminalRef.current);

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

    // Try WebGL renderer, fall back to canvas
    const webglAddon = new WebglAddon();
    try {
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
      });
      terminal.loadAddon(webglAddon);
    } catch {
      // WebGL unavailable — xterm falls back to canvas renderer automatically
      webglAddon.dispose();
    }

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
              window.wmux.pty.write(ptyIdRef.current, filePath);
              handled = true;
            }
          }
          // If no image, paste text
          if (!handled && ptyIdRef.current) {
            try {
              const text = await navigator.clipboard.readText();
              if (text) window.wmux.pty.write(ptyIdRef.current, text);
            } catch {}
          }
        })();
        return false; // Prevent default — we handle paste ourselves
      }
      return true;
    });

    // Connect to PTY — either attach to existing (agent-spawned) or create new
    let ptyId: string | null = null;

    const attachToPty = (id: string) => {
      ptyId = id;
      ptyIdRef.current = id;

      // Wire PTY data → xterm
      const unsubData = window.wmux.pty.onData(id, (data: string) => {
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

    // If surfaceId is given AND a PTY already exists for it (agent spawn or re-mount), attach to it
    if (surfaceId && window.wmux.pty.has) {
      window.wmux.pty.has(surfaceId).then((exists: boolean) => {
        if (exists) {
          attachToPty(surfaceId!);
        } else {
          // No existing PTY — create a new one, passing surfaceId so PTY ID = Surface ID
          window.wmux.pty.create({ shell: shell || '', cwd: cwd ?? '', env: {}, surfaceId })
            .then((created: { id: string; shell: string }) => {
              setResolvedShellForSurface(surfaceId, created.shell);
              attachToPty(created.id);
            })
            .catch((err: unknown) => terminal.writeln(`\r\n\x1b[31m[failed to create PTY: ${err}]\x1b[0m`));
        }
      });
    } else {
      // No surfaceId hint — always create new PTY
      window.wmux.pty.create({ shell: shell || '', cwd: cwd ?? '', env: {} })
        .then((created: { id: string; shell: string }) => {
          setResolvedShellForSurface(surfaceId, created.shell);
          attachToPty(created.id);
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

  // Refit terminal when it becomes visible again (tab/workspace switch)
  useEffect(() => {
    if (visible && fitAddonRef.current && xtermRef.current) {
      // Double-RAF ensures the browser has fully computed layout after
      // visibility changes before we measure and fit the terminal
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          fit();
          const dims = fitAddonRef.current?.proposeDimensions();
          if (dims && ptyIdRef.current) {
            window.wmux.pty.resize(ptyIdRef.current, dims.cols, dims.rows);
          }
        });
      });
    }
  }, [visible]);

  return { terminalRef, fit, xtermRef, searchAddonRef };
}
