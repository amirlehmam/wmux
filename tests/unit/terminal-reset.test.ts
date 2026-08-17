import { describe, it, expect, vi } from 'vitest';
import { resetTerminalModes, terminalResetSequence } from '../../src/renderer/utils/terminal-reset';
import { applyMouseModeSequences, emptyMouseModeState, isMouseTracking } from '../../src/renderer/utils/mouse-modes';

/**
 * Issue #175: a TUI killed rather than exited (`opencode`, "Process exited with
 * code -1") leaves the terminal in the modes it negotiated at startup. The
 * modes belong to the terminal, not the dead process, so they outlive it — and
 * the reported symptom is that mouse selection stops working, because
 * `?1002`/`?1003` tracking keeps routing mousedown to an application that is
 * no longer there.
 *
 * wmux cleared its own record of the modes on PTY exit but never told xterm to
 * leave them, which is the gap these tests pin.
 */
describe('terminal reset (issue #175)', () => {
  const seq = () => terminalResetSequence(false);

  it('disables every mouse tracking protocol, which is the reported symptom', () => {
    // ?9 X10, ?1000 click, ?1001 highlight, ?1002 drag, ?1003 any-motion.
    // ?1002/?1003 are the ones that eat a selection drag; the rest are here so
    // recovery does not depend on guessing which one the dead app used.
    for (const mode of [9, 1000, 1001, 1002, 1003]) {
      expect(seq()).toContain(`\x1b[?${mode}l`);
    }
  });

  it('clears the coordinate encodings too, so the next app inherits nothing', () => {
    // The #164 failure reached from the other side: an encoding left set is
    // invisible until something starts tracking again and reports in it.
    for (const mode of [1005, 1006, 1015, 1016]) {
      expect(seq()).toContain(`\x1b[?${mode}l`);
    }
  });

  it('restores the input modes a shell needs to be usable', () => {
    const s = seq();
    expect(s).toContain('\x1b[?2004l'); // bracketed paste — else a paste shows `200~`
    expect(s).toContain('\x1b[?1004l'); // focus reporting — else alt-tab types ESC[I
    expect(s).toContain('\x1b[?1l');    // DECCKM — else arrows send ESC O A
    expect(s).toContain('\x1b[?7h');    // autowrap back on
    expect(s).toContain('\x1b[?25h');   // cursor visible again
    expect(s).toContain('\x1b[0m');     // and not painted in the dead app's colours
  });

  it('never emits RIS — the buffer is the thing the user is trying to copy', () => {
    // `ESC c` would be the obvious reset and would wipe the scrollback in
    // xterm.js. Recovering a pane in order to erase it is not a recovery.
    expect(seq()).not.toContain('\x1bc');
  });

  /**
   * Two sequences in the reset move the cursor as a side effect. Both were read
   * out of xterm.js's InputHandler rather than assumed, and both are guarded —
   * these are the tests that keep the guards from being "simplified" away.
   */
  describe('cursor-moving sequences are guarded', () => {
    it('leaves the alternate buffer only when actually on it', () => {
      // `?1049l` ends in restoreCursor(), which falls back to savedX/savedY of
      // 0 when nothing ever saved them. On a terminal that never entered the
      // alt buffer that silently homes the cursor and the shell's next line
      // overwrites row 1.
      expect(terminalResetSequence(true)).toContain('\x1b[?1049l');
      expect(terminalResetSequence(false)).not.toContain('\x1b[?1049l');
    });

    it('emits ?1049l first, so everything after it lands on the normal buffer', () => {
      const s = terminalResetSequence(true);
      expect(s.indexOf('\x1b[?1049l')).toBe(0);
    });

    it('wraps the scroll-region reset in DECSC/DECRC', () => {
      // `ESC[r` calls _setCursor(0, 0) unconditionally in xterm.js.
      expect(seq()).toContain('\x1b7\x1b[r\x1b8');
    });

    it('clears attributes after DECRC, not before', () => {
      // DECRC restores the saved colours along with the position, so an ESC[0m
      // emitted before the sandwich would be undone by it.
      const s = seq();
      expect(s.indexOf('\x1b8')).toBeLessThan(s.lastIndexOf('\x1b[0m'));
    });
  });

  describe('resetTerminalModes()', () => {
    const fakeTerminal = (type: 'normal' | 'alternate', writes: string[]) => ({
      buffer: { active: { type } },
      write: (d: string) => { writes.push(d); },
    }) as any;

    it('writes the alt-buffer form when the terminal is on the alt buffer', () => {
      const writes: string[] = [];
      resetTerminalModes(fakeTerminal('alternate', writes));
      expect(writes).toEqual([terminalResetSequence(true)]);
    });

    it('writes the normal form otherwise', () => {
      const writes: string[] = [];
      resetTerminalModes(fakeTerminal('normal', writes));
      expect(writes).toEqual([terminalResetSequence(false)]);
    });

    it('falls back to the unconditional sequence when the buffer is unreadable', () => {
      // A disposed terminal throws on property access. Skipping the only
      // conditional sequence is the safe branch, not a degraded one.
      const writes: string[] = [];
      const broken = {
        get buffer(): never { throw new Error('disposed'); },
        write: (d: string) => { writes.push(d); },
      } as any;
      resetTerminalModes(broken);
      expect(writes).toEqual([terminalResetSequence(false)]);
    });

    it('swallows a write to a disposed terminal', () => {
      // Resetting a pane that no longer exists is a no-op by definition. It must
      // not propagate out of a PTY exit handler, which is not in a try/catch.
      const disposed = {
        buffer: { active: { type: 'normal' } },
        write: vi.fn(() => { throw new Error('Terminal is disposed'); }),
      } as any;
      expect(() => resetTerminalModes(disposed)).not.toThrow();
      expect(disposed.write).toHaveBeenCalledOnce();
    });
  });

  /**
   * The reset and wmux's own mouse-mode cache have to be cleared together. If
   * only the emulator is reset, the next remount replays the cached modes
   * straight back in (mouseModeReplaySequence, issue #164) and the pane is
   * stuck again — which is why both call sites in useTerminal delete the map
   * entry immediately after resetting.
   */
  it('the reset sequence is what the mode tracker reads as "nothing active"', () => {
    const state = emptyMouseModeState();
    applyMouseModeSequences(state, '\x1b[?1002;1006h'); // a TUI starting up
    expect(isMouseTracking(state)).toBe(true);

    applyMouseModeSequences(state, terminalResetSequence(false));
    expect(isMouseTracking(state)).toBe(false);
    expect(state.encodings.size).toBe(0);
  });
});
