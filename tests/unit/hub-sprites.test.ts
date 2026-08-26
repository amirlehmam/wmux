import { describe, it, expect } from 'vitest';
import {
  BODY_FRAMES, FURNITURE, VARIANTS, FURNITURE_PALETTE,
  frameSize, validateFrame, variantFor,
} from '../../src/renderer/components/Hub/sprites';

const FRAME_NAMES = [
  'stand-down', 'stand-up', 'stand-side',
  'walk-down-0', 'walk-down-1', 'walk-up-0', 'walk-up-1', 'walk-side-0', 'walk-side-1',
  'sit-up-0', 'sit-up-1', 'sit-still', 'rest-0', 'rest-1',
] as const;

describe('sprite data integrity', () => {
  it('every body ships every required frame', () => {
    for (const body of ['human', 'cat'] as const) {
      for (const name of FRAME_NAMES) {
        expect(BODY_FRAMES[body][name], `${body}/${name}`).toBeDefined();
      }
    }
  });

  it('every frame is rectangular and uses only palette roles', () => {
    for (const variant of VARIANTS) {
      for (const name of FRAME_NAMES) {
        const rows = BODY_FRAMES[variant.body][name];
        expect(validateFrame(rows, variant.palette), `${variant.body}/${name}`).toBeNull();
      }
    }
  });

  it('bodies have consistent dimensions across frames', () => {
    for (const body of ['human', 'cat'] as const) {
      const sizes = new Set(FRAME_NAMES.map((n) => JSON.stringify(frameSize(BODY_FRAMES[body][n]))));
      expect(sizes.size, body).toBe(1);
    }
  });

  it('furniture validates against the furniture palette and is tile-sized', () => {
    for (const [name, rows] of Object.entries(FURNITURE)) {
      expect(validateFrame(rows, FURNITURE_PALETTE), name).toBeNull();
      const { w, h } = frameSize(rows);
      expect(h, name).toBe(16);
      expect(w % 16, name).toBe(0);
    }
  });

  it('has at least 8 variants and both bodies', () => {
    expect(VARIANTS.length).toBeGreaterThanOrEqual(8);
    expect(VARIANTS.some((v) => v.body === 'cat')).toBe(true);
  });

  it('variantFor is stable and in range', () => {
    const a = variantFor('surf-1234');
    expect(a).toBe(variantFor('surf-1234'));
    for (const id of ['a', 'surf-x', 'surf-00000000-0000-0000-0000-000000000000']) {
      const v = variantFor(id);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(VARIANTS.length);
    }
  });
});
