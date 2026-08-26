/**
 * Hub viewport camera — pure math, no DOM.
 *
 * Small offices auto-fit and center exactly as before. A large office no
 * longer shrinks into unreadability: the scale never drops below MIN_SCALE,
 * and whatever does not fit becomes pannable (drag) and zoomable (wheel).
 * HubView holds {zoom, panX, panY} in a ref and runs it through
 * `computeCamera` every frame, storing the clamped pans back so they never
 * drift outside the office.
 */

/** Below this pixel scale the office pans instead of shrinking further. */
export const MIN_SCALE = 2;
export const MAX_ZOOM = 6;

export interface CameraInput {
  viewW: number;
  viewH: number;
  /** Office size in unscaled px (tiles * TILE). */
  officeW: number;
  officeH: number;
  zoom: number;
  panX: number;
  panY: number;
}

export interface CameraView {
  zoom: number;
  offX: number;
  offY: number;
  /** Clamped pans — store these back to avoid unbounded drift. */
  panX: number;
  panY: number;
  pannableX: boolean;
  pannableY: boolean;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Largest integer scale that fits the viewport, clamped to [MIN_SCALE, MAX_ZOOM]. */
export function fitZoom(viewW: number, viewH: number, officeW: number, officeH: number): number {
  const fit = Math.floor(Math.min(viewW / officeW, viewH / officeH));
  return clamp(fit, MIN_SCALE, MAX_ZOOM);
}

export function computeCamera(input: CameraInput): CameraView {
  const { viewW, viewH, officeW, officeH, zoom } = input;
  const scaledW = officeW * zoom;
  const scaledH = officeH * zoom;

  const pannableX = scaledW > viewW;
  const pannableY = scaledH > viewH;
  const panX = pannableX ? clamp(input.panX, viewW - scaledW, 0) : 0;
  const panY = pannableY ? clamp(input.panY, viewH - scaledH, 0) : 0;
  const offX = pannableX ? panX : (viewW - scaledW) / 2;
  const offY = pannableY ? panY : (viewH - scaledH) / 2;

  return { zoom, offX, offY, panX, panY, pannableX, pannableY };
}

/**
 * Change zoom while keeping the world point under the cursor stationary on
 * every pannable axis. An axis on which the office still fits ignores pan and
 * recenters instead (computeCamera's contract), so the point can shift there
 * — deliberate: a fitting office should stay centered, not drift off-middle.
 * Returns the new camera state; clamping happens on the next computeCamera.
 */
export function zoomAt(
  view: CameraView,
  cursorX: number,
  cursorY: number,
  requestedZoom: number,
): { zoom: number; panX: number; panY: number } {
  const zoom = clamp(Math.round(requestedZoom), MIN_SCALE, MAX_ZOOM);
  const worldX = (cursorX - view.offX) / view.zoom;
  const worldY = (cursorY - view.offY) / view.zoom;
  return {
    zoom,
    panX: cursorX - worldX * zoom,
    panY: cursorY - worldY * zoom,
  };
}
