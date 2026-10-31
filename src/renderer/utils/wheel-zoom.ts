/** Capture Ctrl+wheel before terminal scrolling can consume or forward it. */
export function installWheelZoom(target: Document, zoom: (deltaY: number) => void): () => void {
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey || event.altKey || event.metaKey || !Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    zoom(event.deltaY);
  };
  target.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return () => target.removeEventListener('wheel', onWheel, true);
}
