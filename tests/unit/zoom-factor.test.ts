import { describe, expect, it } from 'vitest';
import { nextZoomFactor } from '../../src/main/zoom-factor';

describe('Ctrl+wheel zoom', () => {
  it('steps up and down and ignores a zero delta', () => {
    expect(nextZoomFactor(1, -100)).toBe(1.1);
    expect(nextZoomFactor(1, 100)).toBe(0.9);
    expect(nextZoomFactor(1, 0)).toBe(1);
  });

  it('clamps to the supported range', () => {
    expect(nextZoomFactor(2, -100)).toBe(2);
    expect(nextZoomFactor(0.5, 100)).toBe(0.5);
  });
});
