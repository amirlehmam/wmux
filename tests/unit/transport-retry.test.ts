import { describe, expect, it, vi } from 'vitest';
import { isTransientWmuxError, retryTransient } from '../../src/cli/transport-retry';

/**
 * A busy wmux named pipe answers `All pipe instances are busy` (native) or
 * makes npiperelay exit before it attaches (WSL). Session/status reports are
 * idempotent, so the CLI may ask again instead of losing the handle.
 */
describe('isTransientWmuxError', () => {
  it('recognises the native pipe-busy codes', () => {
    for (const code of ['EBUSY', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']) {
      expect(isTransientWmuxError(Object.assign(new Error('x'), { code }))).toBe(true);
    }
  });

  it('recognises the npiperelay busy message', () => {
    expect(isTransientWmuxError(
      new Error('npiperelay exited with code 1: open //./pipe/wmux: All pipe instances are busy'),
    )).toBe(true);
    expect(isTransientWmuxError(
      new Error('pane.report_agent_session timed out after 1500ms — wmux accepted the request but sent no reply.'),
    )).toBe(true);
  });

  it('does not retry a missing wmux or a protocol answer', () => {
    expect(isTransientWmuxError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false);
    expect(isTransientWmuxError(new Error('Unknown method'))).toBe(false);
    expect(isTransientWmuxError(null)).toBe(false);
  });
});

describe('retryTransient', () => {
  it('asks again after a transient failure and returns the result', async () => {
    let attempts = 0;
    const request = vi.fn(async () => {
      attempts += 1;
      if (attempts < 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return 'ok';
    });

    const result = await retryTransient(request, { budgetMs: 5_000, firstAttemptMs: 1_000 });

    expect(result).toBe('ok');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permanent answer', async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error('no wmux'), { code: 'ENOENT' });
    });

    await expect(retryTransient(request, { budgetMs: 5_000, firstAttemptMs: 1_000 })).rejects.toThrow('no wmux');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('stops at the budget instead of retrying forever', async () => {
    let now = 0;
    const request = vi.fn(async () => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    });
    const sleep = vi.fn(async (ms: number) => { now += ms; });

    await expect(retryTransient(request, { budgetMs: 1_000, firstAttemptMs: 500 }, () => now, sleep))
      .rejects.toThrow('busy');
    expect(request.mock.calls.length).toBeLessThan(5);
  });

  it('grows the attempt timeout and tells the caller once', async () => {
    const timeouts: number[] = [];
    let now = 0;
    const onWait = vi.fn();
    const request = vi.fn(async (timeoutMs: number) => {
      timeouts.push(timeoutMs);
      if (timeouts.length < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return 'ok';
    });
    const sleep = vi.fn(async (ms: number) => { now += ms; });

    await retryTransient(request, { budgetMs: 10_000, firstAttemptMs: 1_000, onWait }, () => now, sleep);

    expect(timeouts).toEqual([1_000, 2_000, 4_000]);
    expect(onWait).toHaveBeenCalledTimes(1);
  });
});
