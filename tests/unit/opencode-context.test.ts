import { describe, it, expect } from 'vitest';
import { injectWmuxBlock } from '../../src/main/opencode-context';
import { pluginNeedsUpdate } from '../../src/main/opencode-context';

const START = '<!-- wmux:start';
const END = '<!-- wmux:end -->';
const BLOCK = `${START} v1 -->\nUse the wmux CLI.\n${END}`;

describe('injectWmuxBlock', () => {
  it('returns the block alone when existing is empty', () => {
    expect(injectWmuxBlock('', BLOCK)).toBe(BLOCK);
  });
  it('appends the block when no markers present', () => {
    const out = injectWmuxBlock('# My rules\n', BLOCK);
    expect(out.startsWith('# My rules')).toBe(true);
    expect(out.includes(BLOCK)).toBe(true);
  });
  it('replaces an existing block, preserving surrounding content', () => {
    const old = `top\n${START} v0 -->\nOLD\n${END}\nbottom`;
    const out = injectWmuxBlock(old, BLOCK);
    expect(out.includes('OLD')).toBe(false);
    expect(out.includes('top')).toBe(true);
    expect(out.includes('bottom')).toBe(true);
    expect(out.includes(BLOCK)).toBe(true);
  });
  it('is idempotent when the block source ends with a newline', () => {
    // Regression: a trailing newline on the source must not accumulate across runs.
    const blockNl = `${BLOCK}\n`;
    const first = injectWmuxBlock('', blockNl);
    const second = injectWmuxBlock(first, blockNl);
    expect(second).toBe(first);
  });
  it('is idempotent when appended after user content', () => {
    const blockNl = `${BLOCK}\n`;
    const first = injectWmuxBlock('# My rules\n', blockNl);
    const second = injectWmuxBlock(first, blockNl);
    expect(second).toBe(first);
  });
});

describe('pluginNeedsUpdate', () => {
  const srcV2 = '// wmux-plugin-version: 2\ncode';
  it('true when target missing', () => {
    expect(pluginNeedsUpdate(srcV2, null)).toBe(true);
  });
  it('false when version markers match', () => {
    expect(pluginNeedsUpdate(srcV2, '// wmux-plugin-version: 2\nDIFFERENT BODY')).toBe(false);
  });
  it('true when version markers differ', () => {
    expect(pluginNeedsUpdate(srcV2, '// wmux-plugin-version: 1\ncode')).toBe(true);
  });
  it('true (fail-safe) when source has no version marker', () => {
    expect(pluginNeedsUpdate('no marker here', '// wmux-plugin-version: 2\ncode')).toBe(true);
  });
});
