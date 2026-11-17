import { describe, it, expect } from 'vitest';
import {
  INDICATOR_MAX_LENGTH,
  normalizeIndicator,
  resolveIndicatorColor,
} from '../../src/shared/workspace-indicator';

describe('resolveIndicatorColor', () => {
  it('accepts #rgb and #rrggbb', () => {
    expect(resolveIndicatorColor('#f59e0b')).toBe('#f59e0b');
    expect(resolveIndicatorColor('#fa0')).toBe('#fa0');
  });

  it('maps a preset name, ignoring case and padding', () => {
    expect(resolveIndicatorColor(' Amber ')).toBe('#f59e0b');
  });

  it.each(['', 'nope', '#12', '#gggggg', 'red; background:url(x)', 'rgb(1,2,3)'])('drops %j', (value) => {
    expect(resolveIndicatorColor(value)).toBeUndefined();
  });

  it('treats a missing colour as none', () => {
    expect(resolveIndicatorColor(undefined)).toBeUndefined();
  });
});

describe('normalizeIndicator', () => {
  it('keeps text and a valid colour', () => {
    expect(normalizeIndicator('SSH', '#112233')).toEqual({ text: 'SSH', color: '#112233' });
  });

  it('omits the colour when it is unusable, rather than refusing the indicator', () => {
    expect(normalizeIndicator('SSH', 'bogus')).toEqual({ text: 'SSH' });
    expect(normalizeIndicator('SSH', undefined)).toEqual({ text: 'SSH' });
  });

  it.each(['', '   ', undefined, null, 42])('clears on empty text %j', (text) => {
    expect(normalizeIndicator(text, '#112233')).toBeUndefined();
  });

  it('collapses whitespace and cuts at the limit without splitting a character', () => {
    const long = '🚀'.repeat(INDICATOR_MAX_LENGTH + 4);
    expect(normalizeIndicator(long, undefined)?.text).toBe('🚀'.repeat(INDICATOR_MAX_LENGTH));
    expect(normalizeIndicator('dev \n  box', undefined)?.text).toBe('dev box');
  });

  it('ignores a non-string colour', () => {
    expect(normalizeIndicator('SSH', 7)).toEqual({ text: 'SSH' });
  });
});
