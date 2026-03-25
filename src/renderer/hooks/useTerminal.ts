import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { ImageAddon } from '@xterm/addon-image';
import '@xterm/xterm/css/xterm.css';

declare global {
  interface Window {
    wmux: any;
  }
}

interface UseTerminalOptions {
  shell?: string;
  cwd?: string;
}

interface UseTerminalResult {
  terminalRef: React.RefObject<HTMLDivElement | null>;
  fit: () => void;
  xtermRef: React.RefObject<Terminal | null>;
}

export function useTerminal({ shell, cwd }: UseTerminalOptions = {}): UseTerminalResult {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const cleanupFnsRef = useRef<Array<() => void>>([]);

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

    // Create terminal instance
    const terminal = new Terminal({
      theme: {
        background: '#272822',
        foreground: '#fdfff1',
        cursor: '#c0c1b5',
        selectionBackground: '#57584f',
        selectionForeground: '#fdfff1',
      },
      fontFamily: "'Cascadia Mono', 'Consolas', monospace",
      fontSize: 13,
      cursorBlink: true,
      cursorStyle: 'block',
      allowTransparency: false,
      scrollback: 10000,
    });

    xtermRef.current = terminal;

    // Create and load addons
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    const searchAddon = new SearchAddon();
    const unicode11Addon = new Unicode11Addon();
    const imageAddon = new ImageAddon();

    fitAddonRef.current = fitAddon;

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(unicode11Addon);
    terminal.loadAddon(imageAddon);
    terminal.unicode.activeVersion = '11';

    // Open terminal in the DOM
    terminal.open(terminalRef.current);

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

    // Attach custom key handler for Ctrl+C
    terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type === 'keydown' && event.ctrlKey && event.key === 'c') {
        const selection = terminal.getSelection();
        if (selection) {
          // Copy selection to clipboard and clear it
          navigator.clipboard.writeText(selection).catch(() => {
            // Clipboard write can fail in some contexts — ignore
          });
          terminal.clearSelection();
          return false; // Prevent the keystroke from reaching the PTY
        }
        // No selection — let \x03 pass through to PTY normally
      }
      return true;
    });

    // Spawn PTY
    const ptyOptions = {
      shell: shell ?? 'pwsh.exe',
      cwd: cwd ?? '',
      env: {} as Record<string, string>,
    };

    let ptyId: string | null = null;

    window.wmux.pty
      .create(ptyOptions)
      .then((id: string) => {
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
      })
      .catch((err: unknown) => {
        terminal.writeln(`\r\n\x1b[31m[failed to create PTY: ${err}]\x1b[0m`);
      });

    // Wire xterm input → PTY
    const dataDisposable = terminal.onData((data: string) => {
      if (ptyIdRef.current) {
        window.wmux.pty.write(ptyIdRef.current, data);
      }
    });

    // ResizeObserver to auto-fit and relay size to PTY
    const resizeObserver = new ResizeObserver(() => {
      fit();
      const dims = fitAddon.proposeDimensions();
      if (dims && ptyIdRef.current) {
        window.wmux.pty.resize(ptyIdRef.current, dims.cols, dims.rows);
      }
    });

    resizeObserver.observe(terminalRef.current);

    // Cleanup
    return () => {
      resizeObserver.disconnect();
      dataDisposable.dispose();

      // Run all IPC unsubscribe functions
      for (const fn of cleanupFnsRef.current) {
        fn();
      }
      cleanupFnsRef.current = [];

      // Kill the PTY process
      if (ptyId) {
        window.wmux.pty.kill(ptyId);
      }

      // Dispose terminal
      terminal.dispose();
      xtermRef.current = null;
      ptyIdRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { terminalRef, fit, xtermRef };
}
