import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPtyDataBatcher } from '../../src/main/pty-data-batcher';

// The contract under test: leading-edge immediate delivery (a lone keystroke
// echo never waits), then a trailing ~4ms window that coalesces the flood into
// one string per window. flush() exists so trailing output can be delivered
// ahead of PTY_EXIT; dispose() must silence everything after teardown.
describe('pty-data-batcher', () => {
  let delivered: string[];
  let deliver: (data: string) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    delivered = [];
    deliver = (data) => delivered.push(data);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers the first chunk after idle immediately', () => {
    const b = createPtyDataBatcher(deliver);
    b.push('a');
    expect(delivered).toEqual(['a']);
  });

  it('coalesces chunks inside the window into one delivery', () => {
    const b = createPtyDataBatcher(deliver);
    b.push('lead');
    b.push('x');
    b.push('y');
    b.push('z');
    expect(delivered).toEqual(['lead']);
    vi.advanceTimersByTime(5);
    expect(delivered).toEqual(['lead', 'xyz']);
  });

  it('keeps batching across windows under sustained output', () => {
    const b = createPtyDataBatcher(deliver);
    b.push('1');            // immediate
    b.push('2');
    vi.advanceTimersByTime(5);   // window closes → '2', window re-armed
    b.push('3');            // inside the re-armed window → buffered, NOT immediate
    vi.advanceTimersByTime(5);
    expect(delivered).toEqual(['1', '2', '3']);
  });

  it('returns to the immediate path after a quiet window', () => {
    const b = createPtyDataBatcher(deliver);
    b.push('1');
    vi.advanceTimersByTime(5);   // quiet window, nothing buffered → idle
    b.push('2');
    expect(delivered).toEqual(['1', '2']);   // '2' immediate again
  });

  it('forces a mid-window delivery when the buffer grows past the cap', () => {
    const b = createPtyDataBatcher(deliver);
    b.push('lead');
    const big = 'x'.repeat(256 * 1024);
    b.push(big);
    expect(delivered).toEqual(['lead', big]);
  });

  it('flush() delivers buffered data on demand and is a no-op when empty', () => {
    const b = createPtyDataBatcher(deliver);
    b.push('lead');
    b.push('tail');
    b.flush();
    expect(delivered).toEqual(['lead', 'tail']);
    b.flush();
    expect(delivered).toEqual(['lead', 'tail']);
  });

  it('preserves byte order between buffered chunks', () => {
    const b = createPtyDataBatcher(deliver);
    b.push('a');
    b.push('b');
    b.push('c');
    b.push('d');
    vi.advanceTimersByTime(5);
    expect(delivered.join('')).toBe('abcd');
  });

  it('dispose() drops buffered data and ignores later pushes', () => {
    const b = createPtyDataBatcher(deliver);
    b.push('lead');
    b.push('doomed');
    b.dispose();
    vi.advanceTimersByTime(10);
    b.push('after');
    b.flush();
    expect(delivered).toEqual(['lead']);
  });
});
