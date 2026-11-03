import type { WebglAddon } from '@xterm/addon-webgl';

/**
 * Give a disposed WebGL renderer's context and canvas back right away (#421).
 *
 * `WebglAddon.dispose()` (addon-webgl 0.19.0) takes its canvas out of the
 * document and stops there: the WebGL2 context and the full-size drawing
 * buffer behind it live on until the canvas is garbage collected. wmux disposes
 * that renderer on every hide (workspace switch, parked pane) and on every
 * settled width change (#400), so dead contexts pile up between collections. A
 * reporter's heap snapshot held 34 WebGL2 contexts and 509 MB of canvas backing
 * store with fewer than ten terminals on screen, next to a 45 MB JS heap, and
 * Chromium logged "Too many active WebGL contexts. Oldest context will be lost."
 * Past that cap Chromium force-loses a context, which can be a live terminal's.
 *
 * `WEBGL_lose_context` frees the GPU side and takes the context out of
 * Chromium's count; a 0×0 canvas drops its backing store. Both hold even if
 * something still references the dead canvas.
 */
interface WebglRendererLike {
  _canvas?: HTMLCanvasElement;
  _gl?: WebGLRenderingContext | WebGL2RenderingContext;
  _cursorBlinkStateManager?: { clear(): void };
}

/** Dispose the addon, then release what it leaves behind. Never throws. */
export function disposeWebglAddon(addon: WebglAddon): void {
  // Read the private fields first: they are what dispose() abandons.
  let renderer: WebglRendererLike | undefined;
  try {
    renderer = (addon as unknown as { _renderer?: WebglRendererLike })._renderer;
  } catch { /* internals changed; dispose still runs */ }
  // addon-webgl 0.19.0 never disposes the renderer's cursor-blink manager
  // (xtermjs/xterm.js#5818, fixed upstream after 0.19.0). Its 600 ms interval
  // outlives the addon and keeps the renderer and the whole Terminal, scrollback
  // included, reachable forever, so every hide or close of a focused terminal
  // leaked one. tests/unit/webgl-cursor-blink-leak.test.ts fails once the addon
  // fixes this itself or renames the field.
  try { renderer?._cursorBlinkStateManager?.clear(); } catch { /* internals changed */ }
  try { addon.dispose(); } catch { /* already disposed with the terminal */ }
  // After dispose, so the renderer's own `webglcontextlost` listener is gone
  // and losing the context on purpose is not reported as a context loss.
  releaseWebglRenderer(renderer);
}

export function releaseWebglRenderer(renderer: WebglRendererLike | undefined): void {
  if (!renderer) return;
  try {
    const gl = renderer._gl;
    if (gl && !gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext();
  } catch { /* best effort */ }
  try {
    const canvas = renderer._canvas;
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  } catch { /* best effort */ }
}
