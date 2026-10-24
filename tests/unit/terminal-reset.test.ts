import { describe, it, expect, vi } from 'vitest';
import {
  alternateScreenResetAction,
  FORCE_LEAVE_WINDOW_MS,
  resetTerminalModes,
  shellOwnsScreen,
  terminalResetSequence,
  type AlternateScreenFacts,
} from '../../src/renderer/utils/terminal-reset';
import { Terminal } from '@xterm/xterm';
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

/**
 * Issue #347: the manual reset left the alternate screen while the program that
 * entered it was still running. A fullscreen program sends ?1049h once, so its
 * later frames went into the shell's scrollback and its exit ?1049l printed the
 * prompt over the stale frame. The manual reset now keeps the alternate screen
 * unless the shell has reported it is back at its prompt.
 */
describe('manual reset under a live fullscreen program (issue #347)', () => {
  const ESC = '\x1b';
  const write = (t: Terminal, d: string) => new Promise<void>((r) => t.write(d, r));
  const row = (t: Terminal, y: number) => t.buffer.active.getLine(t.buffer.active.viewportY + y)?.translateToString(true) ?? '';

  it('only a shell back at its prompt owns the screen', () => {
    expect(shellOwnsScreen('idle')).toBe(true);
    expect(shellOwnsScreen('interrupted')).toBe(true);
    expect(shellOwnsScreen('running')).toBe(false);
    // No report at all: a program started during shell init (a restored
    // `claude --resume`) was never announced, and must not lose its screen.
    expect(shellOwnsScreen(undefined)).toBe(false);
  });

  it('keepAlternateScreen drops ?1049l and still resets every other mode', () => {
    const writes: string[] = [];
    const fake = { buffer: { active: { type: 'alternate' } }, write: (d: string) => writes.push(d) } as any;
    resetTerminalModes(fake, { keepAlternateScreen: true });
    expect(writes).toEqual([terminalResetSequence(false)]);
    expect(writes[0]).toContain(`${ESC}[?1003l`);
  });

  it('a live program keeps drawing on the alternate screen, and its exit restores the shell', async () => {
    const t = new Terminal({ cols: 30, rows: 6, allowProposedApi: true });
    await write(t, 'MAIN-1\r\nMAIN-2\r\nPS> app\r\n');
    await write(t, `${ESC}[?1049h${ESC}[HALT-BEFORE`);
    resetTerminalModes(t, { keepAlternateScreen: true });
    await write(t, '\r\nALT-AFTER');
    expect(t.buffer.active.type).toBe('alternate');

    await write(t, `${ESC}[?1049lPS> `);
    expect(t.buffer.active.type).toBe('normal');
    expect([row(t, 0), row(t, 1), row(t, 2), row(t, 3)]).toEqual(['MAIN-1', 'MAIN-2', 'PS> app', 'PS> ']);
    t.dispose();
  });

  it('still leaves the alternate screen a dead program abandoned (#175)', async () => {
    const t = new Terminal({ cols: 30, rows: 6, allowProposedApi: true });
    await write(t, `MAIN-1\r\n${ESC}[?1049hDEAD-TUI`);
    resetTerminalModes(t);
    await write(t, '');
    expect(t.buffer.active.type).toBe('normal');
    t.dispose();
  });
});


/**
 * Issue #357: since #347 the manual reset left the alternate screen only when
 * the shell had reported it was back at its prompt, and only wmux's PowerShell
 * integration reports that. A pane stuck on a dead program's alternate screen
 * in cmd, Git Bash, WSL, SSH or a nested shell could no longer be recovered.
 *
 * The decision now weighs the pane's own output first: an OSC 133;A drawn ON
 * the alternate screen means a shell is prompting there (`owner: 'shell'`),
 * while a DECSET 47/1047/1049 since then means a program entered it
 * (`owner: 'program'`). Shell state is the fallback when the stream said
 * neither, and a second press inside the window forces.
 */
describe('alternateScreenResetAction (issue #357)', () => {
  const facts = (over: Partial<AlternateScreenFacts> = {}): AlternateScreenFacts => ({
    onAlternateBuffer: true,
    owner: undefined,
    shellState: undefined,
    lastKeptAt: undefined,
    now: 100_000,
    forceRequested: false,
    ...over,
  });

  it('has nothing to do on the normal buffer, whatever else is true', () => {
    expect(alternateScreenResetAction(facts({ onAlternateBuffer: false, owner: 'program', forceRequested: true }))).toBe('none');
  });

  it('leaves when a shell prompted on the alternate screen, with no shell state at all', () => {
    // cmd, Git Bash with a prompt mark, a remote shell: none of them report state.
    expect(alternateScreenResetAction(facts({ owner: 'shell' }))).toBe('leave');
  });

  it('a prompt mark overrides `running`: the outer shell reported the ssh/wsl command, the inner one prompted', () => {
    expect(alternateScreenResetAction(facts({ owner: 'shell', shellState: 'running' }))).toBe('leave');
  });

  it('keeps when a program entered the alternate screen after the prompt (#347 still holds)', () => {
    expect(alternateScreenResetAction(facts({ owner: 'program' }))).toBe('keep');
    expect(alternateScreenResetAction(facts({ owner: 'program', shellState: 'running' }))).toBe('keep');
  });

  it('keeps while a command started from a prompt on the alternate screen runs (133;C)', () => {
    // An inline program (Claude Code's inline mode, a dev server) enters nothing,
    // and a local `running` report used to lose to the earlier prompt mark.
    expect(alternateScreenResetAction(facts({ owner: 'command' }))).toBe('keep');
    expect(alternateScreenResetAction(facts({ owner: 'command', shellState: 'running' }))).toBe('keep');
    expect(alternateScreenResetAction(facts({ owner: 'command', shellState: 'idle' }))).toBe('keep');
    expect(alternateScreenResetAction(facts({ owner: 'command', lastKeptAt: 99_000 }))).toBe('force');
  });

  it('a program on the alternate screen outranks an `idle` report (PowerShell without PSReadLine)', () => {
    // `running` is reported only from the PSReadLine Enter handler, so without it
    // the state reads idle while vim runs. The in-band entry is the fresher fact.
    expect(alternateScreenResetAction(facts({ owner: 'program', shellState: 'idle' }))).toBe('keep');
    expect(alternateScreenResetAction(facts({ owner: 'program', shellState: 'interrupted' }))).toBe('keep');
  });

  it('with no in-band evidence, falls back to the #347 shell-state rule', () => {
    expect(alternateScreenResetAction(facts({ shellState: 'idle' }))).toBe('leave');
    expect(alternateScreenResetAction(facts({ shellState: 'interrupted' }))).toBe('leave');
    expect(alternateScreenResetAction(facts({ shellState: 'running' }))).toBe('keep');
    expect(alternateScreenResetAction(facts())).toBe('keep');
  });

  it('a second press within the window forces', () => {
    const now = 100_000;
    expect(alternateScreenResetAction(facts({ owner: 'program', lastKeptAt: now - 1, now }))).toBe('force');
    expect(alternateScreenResetAction(facts({ owner: 'program', lastKeptAt: now - FORCE_LEAVE_WINDOW_MS, now }))).toBe('force');
  });

  it('a second press after the window keeps again', () => {
    const now = 100_000;
    expect(alternateScreenResetAction(facts({ owner: 'program', lastKeptAt: now - FORCE_LEAVE_WINDOW_MS - 1, now }))).toBe('keep');
  });

  it('a clock that went backwards does not count as inside the window', () => {
    expect(alternateScreenResetAction(facts({ owner: 'program', lastKeptAt: 200_000, now: 100_000 }))).toBe('keep');
  });

  it('the palette entry forces without a first press', () => {
    expect(alternateScreenResetAction(facts({ owner: 'program', shellState: 'running', forceRequested: true }))).toBe('force');
  });

  it('the window is a few seconds, long enough to read the notice', () => {
    expect(FORCE_LEAVE_WINDOW_MS).toBeGreaterThanOrEqual(3000);
    expect(FORCE_LEAVE_WINDOW_MS).toBeLessThanOrEqual(10_000);
  });
});
