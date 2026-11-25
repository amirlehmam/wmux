import { describe, it, expect } from 'vitest';
import { uiColorVars } from '../../src/shared/ui-colors';

describe('uiColorVars', () => {
  it('maps keys to --ui-* vars and derives accent rgb', () => {
    expect(uiColorVars({ 'bg-0': '#000000', accent: '#58a6ff' })).toEqual({
      '--ui-bg-0': '#000000', '--ui-accent': '#58a6ff', '--ui-accent-rgb': '88, 166, 255',
    });
  });
  it('is empty for an empty table', () => expect(uiColorVars({})).toEqual({}));
});
