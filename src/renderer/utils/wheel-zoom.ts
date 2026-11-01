/** Capture Ctrl+wheel before terminal scrolling can consume or forward it. */
export function installWheelZoom(target: Document, zoom: (deltaY: number) => void, windowZoom?: (deltaY: number) => void): () => void {
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey || event.altKey || event.metaKey || !Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.shiftKey && windowZoom) windowZoom(event.deltaY);
    else zoom(event.deltaY);
  };
  target.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return () => target.removeEventListener('wheel', onWheel, true);
}

export function nextPaneZoom(current: number, deltaY: number): number {
  const direction = deltaY < 0 ? 1 : -1;
  return Math.min(2, Math.max(0.5, Math.round((current + direction * 0.1) * 10) / 10));
}
