/**
 * Capture Ctrl+wheel before terminal scrolling can consume or forward it. The
 * pane callback gets the event target, so the caller can zoom the pane under
 * the pointer the way Windows Terminal does (#420).
 */
export function installWheelZoom(target: Document, zoom: (deltaY: number, target: EventTarget | null) => void, windowZoom?: (deltaY: number) => void): () => void {
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey || event.altKey || event.metaKey || !Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.shiftKey && windowZoom) windowZoom(event.deltaY);
    else zoom(event.deltaY, event.target);
  };
  target.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return () => target.removeEventListener('wheel', onWheel, true);
}

export function nextPaneZoom(current: number, deltaY: number): number {
  const direction = deltaY < 0 ? 1 : -1;
  return Math.min(2, Math.max(0.5, Math.round((current + direction * 0.1) * 10) / 10));
}

/**
 * A terminal's font size under its pane's zoom (#420).
 *
 * A terminal is zoomed through its font, never CSS `zoom`: xterm measures its
 * cells and its container in unzoomed pixels, so a CSS-zoomed terminal fitted
 * the wrong column count, drew a TUI into a corner of the pane and left the PTY
 * at its old size. Changing the font refits and resizes the PTY, so the text
 * reflows to fill the pane, which is what Windows Terminal does.
 */
export function paneFontSize(base: number, zoom: number | undefined): number {
  if (!zoom || zoom === 1) return base;
  return Math.max(6, Math.round(base * zoom));
}

/** The pane a wheel event happened over, from PaneWrapper's `data-pane-id`. */
export function paneIdAt(target: EventTarget | null): string | null {
  const element = target as { closest?: (selector: string) => { getAttribute(name: string): string | null } | null } | null;
  return element?.closest?.('[data-pane-id]')?.getAttribute('data-pane-id') ?? null;
}
