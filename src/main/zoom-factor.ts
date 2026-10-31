/** Calculate the next application zoom for a Ctrl+wheel gesture. */
export const MIN_ZOOM_FACTOR = 0.5;
export const MAX_ZOOM_FACTOR = 2;
export const ZOOM_STEP = 0.1;

export function nextZoomFactor(current: number, deltaY: number): number {
  const direction = deltaY < 0 ? 1 : deltaY > 0 ? -1 : 0;
  if (!direction) return current;
  const next = Math.round((current + direction * ZOOM_STEP) * 10) / 10;
  return Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, next));
}
