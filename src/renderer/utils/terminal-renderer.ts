import type { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';

export type RendererKind = 'dom' | 'webgl';

export interface RendererHandle {
  kind: RendererKind;
  dispose(): void;
}

/**
 * Chromium hard-caps WebGL contexts (~16 per renderer process) and force-loses
 * the oldest one past the cap, which used to freeze whole sessions when every
 * keep-alive tab held a context. Only VISIBLE panes need a GPU renderer, so we
 * attach WebGL on show / release on hide and budget well under the cap (the
 * browser webview and devtools also consume contexts).
 */
export const MAX_WEBGL_TERMINALS = 12;

let activeWebglCount = 0;

export function getActiveWebglCount(): number {
  return activeWebglCount;
}

const DOM_RENDERER_HANDLE: RendererHandle = {
  kind: 'dom',
  dispose: () => { /* default renderer, nothing to release */ },
};

/**
 * Attach the best available renderer to a terminal that just became visible.
 * Preference order: WebGL → xterm's default DOM renderer. (xterm 6.0 removed
 * the Canvas addon we previously used as a middle tier — it mispainted
 * wide-char/CJK rows under load anyway, issues #23/#30.)
 */
export function attachVisibleRenderer(terminal: Terminal): RendererHandle {
  if (activeWebglCount >= MAX_WEBGL_TERMINALS) return DOM_RENDERER_HANDLE;

  let webgl: WebglAddon;
  try {
    webgl = new WebglAddon();
    terminal.loadAddon(webgl);
  } catch (err) {
    console.warn('[wmux] WebGL renderer unavailable, staying on DOM renderer:', err);
    return DOM_RENDERER_HANDLE;
  }
  activeWebglCount++;

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    activeWebglCount--;
  };

  const handle: RendererHandle = {
    kind: 'webgl',
    dispose: () => {
      release();
      try { webgl.dispose(); } catch { /* already disposed with terminal */ }
    },
  };

  webgl.onContextLoss(() => {
    // GPU evicted this context (driver reset, or context pressure — Chromium
    // force-loses the oldest WebGL context past its ~16 cap, which happens
    // exactly when panes are split/resized and several terminals flip visible at
    // once). Downgrade this terminal to the DOM renderer instead of leaving it
    // frozen.
    console.warn('[wmux] WebGL context lost, downgrading terminal to DOM renderer');
    release();
    try { webgl.dispose(); } catch { /* no-op */ }
    handle.kind = DOM_RENDERER_HANDLE.kind;
    handle.dispose = DOM_RENDERER_HANDLE.dispose;
    // Disposing the WebGL addon reactivates xterm's DOM renderer, but nothing
    // repaints the existing buffer into it — the canvas the lost context left
    // behind stays blank until the next PTY write, which is the "text disappears
    // when I resize/split panes" bug. Force a full redraw once the DOM renderer
    // is live (next frame, so its layout has settled).
    requestAnimationFrame(() => {
      try { terminal.refresh(0, terminal.rows - 1); } catch { /* no-op */ }
    });
  });

  return handle;
}
