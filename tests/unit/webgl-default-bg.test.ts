import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import { isDefaultBackgroundSpan, patchRectangleRenderer } from '../../src/renderer/utils/webgl-default-bg';

const DIM = 0x8000000;
const ITALIC = 0x4000000;
const HAS_EXTENDED = 0x10000000;
const INVERSE = 0x4000000;
const CM_P256 = 0x2000000;
const CM_RGB = 0x3000000;

describe('isDefaultBackgroundSpan (#425)', () => {
  it('treats a default-colour background as default whatever attribute flags it carries', () => {
    expect(isDefaultBackgroundSpan(0, DIM | ITALIC)).toBe(true);
    expect(isDefaultBackgroundSpan(0, HAS_EXTENDED)).toBe(true);
  });

  it('keeps real background colours and inverse spans', () => {
    expect(isDefaultBackgroundSpan(0, CM_P256 | 4)).toBe(false);
    expect(isDefaultBackgroundSpan(0, CM_RGB | 0x112233 | DIM)).toBe(false);
    expect(isDefaultBackgroundSpan(INVERSE, DIM)).toBe(false);
  });
});

describe('patchRectangleRenderer (#425)', () => {
  // Same shape as addon-webgl's RectangleRenderer: writes x, y, w, h, r, g, b, a.
  class FakeRectangleRenderer {
    _updateRectangle(vertices: { attributes: Float32Array }, offset: number, _fg: number, _bg: number, startX: number, endX: number, y: number): void {
      vertices.attributes.set([startX, y, endX - startX, 1, 0.1, 0.2, 0.3, 1], offset);
    }
  }

  it('zeroes the width of a default-background rectangle and leaves coloured ones alone', () => {
    const renderer = new FakeRectangleRenderer();
    expect(patchRectangleRenderer(renderer)).toBe(true);
    const vertices = { attributes: new Float32Array(16) };
    renderer._updateRectangle(vertices, 0, 0, DIM | ITALIC, 2, 10, 0);
    renderer._updateRectangle(vertices, 8, 0, CM_P256 | 4 | DIM, 2, 10, 1);
    expect(vertices.attributes[2]).toBe(0);
    expect(vertices.attributes[10]).toBe(8);
  });

  it('patches the prototype once, so a renderer rebuilt after a context loss is covered too', () => {
    patchRectangleRenderer(new FakeRectangleRenderer());
    patchRectangleRenderer(new FakeRectangleRenderer());
    const vertices = { attributes: new Float32Array(8) };
    new FakeRectangleRenderer()._updateRectangle(vertices, 0, 0, DIM, 0, 4, 0);
    expect(vertices.attributes[2]).toBe(0);
  });

  it('declines an object without the expected method', () => {
    expect(patchRectangleRenderer({})).toBe(false);
    expect(patchRectangleRenderer(undefined)).toBe(false);
  });

  it('still matches the private shape of the installed addon-webgl', () => {
    const require = createRequire(import.meta.url);
    const bundle = readFileSync(require.resolve('@xterm/addon-webgl'), 'utf8');
    expect(bundle).toContain('this._renderer=');
    expect(bundle).toContain('_rectangleRenderer.value');
    expect(bundle).toMatch(/_updateRectangle\(\w+,\w+,\w+,\w+,\w+,\w+,\w+\)\{/);
  });
});
