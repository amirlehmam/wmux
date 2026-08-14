import { describe, it, expect } from 'vitest';
import {
  applyMouseModeSequences,
  effectiveEncoding,
  effectiveProtocol,
  emptyMouseModeState,
  isMouseTracking,
  mouseModeReplaySequence,
} from '../../src/renderer/utils/mouse-modes';

const ESC = '\x1b';
const fold = (...chunks: string[]) => {
  const state = emptyMouseModeState();
  for (const c of chunks) applyMouseModeSequences(state, c);
  return state;
};

/**
 * Issue #164: a split-tree restructure remounts the pane and builds a new xterm
 * while the PTY — and the TUI on the far end — survive untouched. SerializeAddon
 * carries the buffer and the mouse tracking PROTOCOL across, but not the
 * coordinate ENCODING, so the replacement terminal reported clicks in the legacy
 * encoding while the application was still decoding SGR.
 *
 * wmux's own wheel handler emits SGR itself and so kept working, which is why
 * the bug presented as "the wheel still works but clicking doesn't".
 */
describe('mouse mode tracking (issue #164)', () => {
  it('records the encoding, not just the protocol', () => {
    // The whole defect in one assertion: the old boolean had nowhere to put
    // 1006, so nothing could restore it.
    const state = fold(`${ESC}[?1002h${ESC}[?1006h`);
    expect(effectiveProtocol(state)).toBe(1002);
    expect(effectiveEncoding(state)).toBe(1006);
  });

  it('handles the combined form applications actually send', () => {
    // `ESC[?1002;1006h` is the usual spelling. The previous single-mode regex
    // matched it once and saw only one of the two modes.
    const state = fold(`${ESC}[?1002;1006h`);
    expect(effectiveProtocol(state)).toBe(1002);
    expect(effectiveEncoding(state)).toBe(1006);
  });

  it('applies every sequence in a chunk, not just the first', () => {
    // An `else if` over two regexes saw an enable and stopped, so a chunk that
    // switched modes left the state describing the wrong one.
    const state = fold(`${ESC}[?1000h${ESC}[?1000l${ESC}[?1003h`);
    expect(effectiveProtocol(state)).toBe(1003);
  });

  it('a DECRST for one protocol does not retract another', () => {
    // Terminals keep these as independent flags. Collapsing them meant turning
    // off 1002 while 1003 was live reported "mouse off" to the wheel handler.
    const state = fold(`${ESC}[?1002h${ESC}[?1003h${ESC}[?1002l`);
    expect(effectiveProtocol(state)).toBe(1003);
    expect(isMouseTracking(state)).toBe(true);
  });

  it('turns tracking off only when every protocol is cleared', () => {
    const state = fold(`${ESC}[?1002;1003h${ESC}[?1002;1003l`);
    expect(isMouseTracking(state)).toBe(false);
    expect(effectiveProtocol(state)).toBeNull();
  });

  it('prefers the most capable active mode', () => {
    expect(effectiveProtocol(fold(`${ESC}[?1000;1003h`))).toBe(1003);
    expect(effectiveEncoding(fold(`${ESC}[?1006;1016h`))).toBe(1016);
    expect(effectiveEncoding(fold(`${ESC}[?1005;1006h`))).toBe(1006);
  });

  it('ignores private modes that are not about the mouse', () => {
    // ?1049 (alt buffer), ?25 (cursor) and ?2004 (bracketed paste) share the
    // same CSI ? form and stream constantly. Treating any of them as mouse
    // state would make a plain shell look mouse-enabled.
    const state = fold(`${ESC}[?1049h${ESC}[?25l${ESC}[?2004h`);
    expect(isMouseTracking(state)).toBe(false);
    expect(mouseModeReplaySequence(state)).toBe('');
  });

  it('is unmoved by ordinary output, including CSI that is not private', () => {
    const state = fold('hello\r\n', `${ESC}[31m`, `${ESC}[2J`, `${ESC}[1;1H`);
    expect(isMouseTracking(state)).toBe(false);
  });

  it('survives a mode change split across two PTY chunks', () => {
    // Chunk boundaries fall wherever the pipe decides. A sequence cut in half
    // is simply not seen — the important part is that the state is not
    // corrupted and the next complete sequence still lands.
    const state = fold(`${ESC}[?100`, `2h${ESC}[?1006h`);
    expect(effectiveEncoding(state)).toBe(1006);
  });

  describe('replay into a replacement terminal', () => {
    it('re-emits every active mode, protocols before encodings', () => {
      // Order matters to some applications' own parsers, and emitting ALL
      // active modes (not just the effective one) means the new terminal's
      // flags match the original — so a later DECRST from the application
      // lands on the state it expects rather than a summary of it.
      const state = fold(`${ESC}[?1002;1003h${ESC}[?1006h`);
      expect(mouseModeReplaySequence(state)).toBe(
        `${ESC}[?1002h${ESC}[?1003h${ESC}[?1006h`,
      );
    });

    it('round-trips: replaying into a fresh state reproduces it', () => {
      const original = fold(`${ESC}[?1003h${ESC}[?1016h`);
      const restored = fold(mouseModeReplaySequence(original));
      expect(effectiveProtocol(restored)).toBe(effectiveProtocol(original));
      expect(effectiveEncoding(restored)).toBe(effectiveEncoding(original));
    });

    it('emits nothing when there is nothing to restore', () => {
      expect(mouseModeReplaySequence(emptyMouseModeState())).toBe('');
      expect(mouseModeReplaySequence(undefined)).toBe('');
    });

    it('restores the case the report describes: DRAG + SGR', () => {
      // From the report's controlled test: before = DRAG/SGR, snapshot tail
      // carried only `ESC[?1002h`, after = DRAG/DEFAULT. The replay is what
      // closes that gap.
      const beforeRemount = fold(`${ESC}[?1002h${ESC}[?1006h`);
      const snapshotOnly = fold(`${ESC}[?1002h`);           // what SerializeAddon gives
      expect(effectiveEncoding(snapshotOnly)).toBeNull();    // the bug

      const afterReplay = fold(`${ESC}[?1002h`, mouseModeReplaySequence(beforeRemount));
      expect(effectiveProtocol(afterReplay)).toBe(1002);
      expect(effectiveEncoding(afterReplay)).toBe(1006);     // the fix
    });
  });

  it('is allocation-free for chunks that cannot change the state', () => {
    // This runs on every PTY data event, so the common path must not do work.
    const state = emptyMouseModeState();
    expect(applyMouseModeSequences(state, 'a lot of ordinary output')).toBe(state);
  });
});
