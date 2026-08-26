import { describe, it, expect } from 'vitest';
import {
  MIN_SCALE, MAX_ZOOM, fitZoom, computeCamera, zoomAt,
} from '../../src/renderer/components/Hub/camera';

describe('fitZoom', () => {
  it('picks the largest integer scale that fits, capped at MAX_ZOOM', () => {
    expect(fitZoom(1000, 1000, 100, 100)).toBe(MAX_ZOOM);
    expect(fitZoom(350, 1000, 100, 100)).toBe(3);
  });

  it('never drops below MIN_SCALE, even when the office does not fit', () => {
    expect(fitZoom(300, 300, 1000, 1000)).toBe(MIN_SCALE);
    expect(fitZoom(50, 50, 1000, 1000)).toBe(MIN_SCALE);
  });
});

describe('computeCamera', () => {
  it('centers a fitting office and reports it not pannable', () => {
    const view = computeCamera({ viewW: 1000, viewH: 800, officeW: 200, officeH: 100, zoom: 2, panX: -999, panY: 999 });
    expect(view).toMatchObject({ offX: 300, offY: 300, pannableX: false, pannableY: false });
  });

  it('clamps pan so the office edges pin to the viewport edges', () => {
    // office 1000*2 = 2000 wide in a 1000 viewport: panX must stay in [-1000, 0]
    const left = computeCamera({ viewW: 1000, viewH: 800, officeW: 1000, officeH: 100, zoom: 2, panX: 500, panY: 0 });
    expect(left.offX).toBe(0);
    expect(left.pannableX).toBe(true);
    const right = computeCamera({ viewW: 1000, viewH: 800, officeW: 1000, officeH: 100, zoom: 2, panX: -5000, panY: 0 });
    expect(right.offX).toBe(-1000);
  });

  it('mixes axes independently', () => {
    const view = computeCamera({ viewW: 1000, viewH: 100, officeW: 200, officeH: 400, zoom: 2, panX: 0, panY: -100 });
    expect(view.pannableX).toBe(false);
    expect(view.offX).toBe(300);
    expect(view.pannableY).toBe(true);
    expect(view.offY).toBe(-100);
  });
});

describe('zoomAt', () => {
  it('keeps the world point under the cursor stable across a zoom change', () => {
    const before = computeCamera({ viewW: 1000, viewH: 800, officeW: 1000, officeH: 800, zoom: 2, panX: -300, panY: -200 });
    const cursor = { x: 400, y: 300 };
    const worldX = (cursor.x - before.offX) / 2;
    const worldY = (cursor.y - before.offY) / 2;

    const next = zoomAt(before, cursor.x, cursor.y, 3);
    const after = computeCamera({ viewW: 1000, viewH: 800, officeW: 1000, officeH: 800, zoom: next.zoom, panX: next.panX, panY: next.panY });
    expect((cursor.x - after.offX) / after.zoom).toBeCloseTo(worldX, 5);
    expect((cursor.y - after.offY) / after.zoom).toBeCloseTo(worldY, 5);
  });

  it('clamps the requested zoom to [MIN_SCALE, MAX_ZOOM]', () => {
    const view = computeCamera({ viewW: 500, viewH: 500, officeW: 400, officeH: 400, zoom: 2, panX: 0, panY: 0 });
    expect(zoomAt(view, 0, 0, 99).zoom).toBe(MAX_ZOOM);
    expect(zoomAt(view, 0, 0, 0).zoom).toBe(MIN_SCALE);
  });

  it('recenters a non-pannable axis instead of anchoring the cursor there', () => {
    // Office fits at both zooms: cursor anchoring is deliberately sacrificed
    // so a fitting office stays centered (documented in zoomAt's contract).
    const before = computeCamera({ viewW: 1000, viewH: 800, officeW: 100, officeH: 100, zoom: 2, panX: 0, panY: 0 });
    const next = zoomAt(before, 100, 100, 3);
    const after = computeCamera({ viewW: 1000, viewH: 800, officeW: 100, officeH: 100, zoom: next.zoom, panX: next.panX, panY: next.panY });
    expect(after.offX).toBe((1000 - 300) / 2);
    expect(after.offY).toBe((800 - 300) / 2);
    expect(after.pannableX).toBe(false);
  });
});
