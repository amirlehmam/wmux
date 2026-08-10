import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { guardExitCallback, attachErrorSink } from '../../src/main/pty-crash-guard';

/**
 * Issue #150 — a PTY-side throw aborted the entire Electron main process.
 *
 * The two guards under test each close one route to that abort. Both are
 * modelled here on the real callers rather than on the guards' own shapes: the
 * exit-callback tests drive the prototype the way conpty.node's ThreadSafeFunction
 * does (call it, and treat any escaping exception as a dead process), and the
 * error-sink tests replay node-pty's actual `listeners('error').length < 2`
 * check against a real EventEmitter.
 */
describe('#150 pty crash guard', () => {
  describe('guardExitCallback', () => {
    /** Stand-in for conpty.cc's TSFN lambda: an escaping throw is the crash. */
    function dispatchLikeConpty(host: { _$onProcessExit?: (c: number) => void }, code: number): 'ok' | 'abort' {
      try {
        host._$onProcessExit!.call(host, code);
        return 'ok';
      } catch {
        return 'abort'; // in the real dispatcher there is no catch — this is __fastfail
      }
    }

    it('contains a throwing exit callback instead of letting it abort the process', () => {
      const host = {
        _$onProcessExit(_code: number) {
          // The real fallback branch (useConptyDll: false) does this when a
          // spawn half-failed and _outSocket was never assigned.
          throw new TypeError("Cannot read properties of undefined (reading 'on')");
        },
      };
      expect(dispatchLikeConpty(host, 1)).toBe('abort');

      const onError = vi.fn();
      expect(guardExitCallback(host, onError)).toBe(true);

      expect(dispatchLikeConpty(host, 1)).toBe('ok');
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0]).toBeInstanceOf(TypeError);
    });

    it('passes the exit code through and preserves `this` when nothing throws', () => {
      const seen: Array<{ code: number; self: unknown }> = [];
      const host = {
        tag: 'agent',
        _$onProcessExit(this: { tag: string }, code: number) {
          seen.push({ code, self: this.tag });
        },
      };
      guardExitCallback(host);
      host._$onProcessExit(3);
      expect(seen).toEqual([{ code: 3, self: 'agent' }]);
    });

    it('is idempotent, so repeated installs do not stack wrappers', () => {
      const calls: number[] = [];
      const host = { _$onProcessExit: (c: number) => { calls.push(c); } };
      expect(guardExitCallback(host)).toBe(true);
      expect(guardExitCallback(host)).toBe(false);
      host._$onProcessExit(7);
      expect(calls).toEqual([7]);
    });

    it('reports rather than throws when node-pty renames the callback', () => {
      // A node-pty upgrade must degrade to "unguarded", never to a startup crash.
      expect(guardExitCallback({} as never)).toBe(false);
      expect(guardExitCallback(undefined as never)).toBe(false);
    });
  });

  describe('attachErrorSink', () => {
    /** node-pty's windowsTerminal.js socket error handler, verbatim in shape. */
    function nodePtyErrorHandler(term: EventEmitter, err: Error & { code?: string }): 'contained' | 'crash' {
      if (err.code && (err.code.includes('errno 5') || err.code.includes('EIO'))) return 'contained';
      if (term.listeners('error').length < 2) return 'crash';
      term.emit('error', err);
      return 'contained';
    }

    it('stops node-pty re-throwing an unrecognised socket error', () => {
      const term = new EventEmitter();
      const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });

      expect(nodePtyErrorHandler(term, err)).toBe('crash');

      const onError = vi.fn();
      attachErrorSink(term, onError);

      expect(nodePtyErrorHandler(term, err)).toBe('contained');
      expect(onError).toHaveBeenCalledWith(err);
    });

    it('reports each error exactly once despite needing two listeners', () => {
      // The second listener exists only to satisfy node-pty's count; if it also
      // reported, every socket error would be logged twice.
      const term = new EventEmitter();
      const onError = vi.fn();
      expect(attachErrorSink(term, onError)).toBe(2);
      term.emit('error', new Error('boom'));
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it('tops up rather than duplicating when a listener already exists', () => {
      const term = new EventEmitter();
      term.on('error', () => { /* pre-existing */ });
      expect(attachErrorSink(term, vi.fn())).toBe(1);
      expect(term.listeners('error').length).toBe(2);
    });

    it('adds nothing when the threshold is already met', () => {
      const term = new EventEmitter();
      term.on('error', () => {});
      term.on('error', () => {});
      expect(attachErrorSink(term, vi.fn())).toBe(0);
    });
  });
});
