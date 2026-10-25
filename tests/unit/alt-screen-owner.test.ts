import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Terminal } from '@xterm/xterm';
import {
  alternateScreenOwner,
  applyManualReset,
  beginSnapshotReplay,
  endSnapshotReplay,
  entersAlternateScreen,
  forgetAlternateScreen,
  resetAlternateScreenOwners,
  trackAlternateScreenOwner,
  type ResetNoticeDetail,
} from '../../src/renderer/utils/alt-screen-owner';
import { FORCE_LEAVE_WINDOW_MS } from '../../src/renderer/utils/terminal-reset';
import { __resetPromptLog, handlePromptMark } from '../../src/renderer/utils/prompt-log';
import { recordSurfaceShellState, resetSurfaceShellStates } from '../../src/renderer/utils/surface-shell-state';

/**
 * Issue #357, end to end through a real xterm: the record of who is on the
 * alternate screen comes from the pane's own output — DECSET 47/1047/1049 seen
 * by a CSI hook, OSC 133;A seen by the prompt log's existing parse — and the
 * `wmux:reset-terminal` handler's decision is `applyManualReset`.
 */
const ESC = '\x1b';
const SURFACE = 'surf-357';
const ALT_ON = `${ESC}[?1049h${ESC}[H`;
const PROMPT_MARK = `${ESC}]133;A${ESC}\\`;
const INPUT_MARK = `${ESC}]133;B${ESC}\\`;
const COMMAND_START = `${ESC}]133;C${ESC}\\`;
const COMMAND_END = `${ESC}]133;D;0${ESC}\\`;

const write = (t: Terminal, d: string) => new Promise<void>((r) => t.write(d, r));

/** A terminal wired the way useTerminal wires one: the owner tracker plus the prompt log's OSC 133 handler. */
function wiredTerminal(notify?: (d: ResetNoticeDetail) => void): Terminal {
  const t = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
  trackAlternateScreenOwner(t, SURFACE, { notify });
  t.parser.registerOscHandler(133, (data) => handlePromptMark(t, SURFACE, data));
  return t;
}

/** Main-buffer history, then a program that enters the alternate screen and dies there. */
async function stuckOnAlternateScreen(t: Terminal): Promise<void> {
  await write(t, 'MAIN-1\r\nMAIN-2\r\n$ tui\r\n');
  await write(t, `${ALT_ON}TUI FRAME`);
}

describe('who owns the alternate screen (issue #357)', () => {
  let terminals: Terminal[] = [];
  const track = (t: Terminal) => { terminals.push(t); return t; };

  beforeEach(() => {
    resetAlternateScreenOwners();
    resetSurfaceShellStates();
    __resetPromptLog();
  });
  afterEach(() => {
    for (const t of terminals) t.dispose();
    terminals = [];
  });

  describe('entersAlternateScreen()', () => {
    it('recognises every DECSET that activates the alternate buffer, alone or among others', () => {
      expect(entersAlternateScreen([1049])).toBe(true);
      expect(entersAlternateScreen([1047])).toBe(true);
      expect(entersAlternateScreen([47])).toBe(true);
      expect(entersAlternateScreen([1006, 1049])).toBe(true);
    });

    it('ignores the other private modes', () => {
      expect(entersAlternateScreen([25])).toBe(false);
      expect(entersAlternateScreen([1002, 1006])).toBe(false);
      expect(entersAlternateScreen([])).toBe(false);
    });
  });

  describe('through a real xterm: the CSI hook sees what xterm acts on', () => {
    it.each([
      ['?47h', `${ESC}[?47h`],
      ['?1047h', `${ESC}[?1047h`],
      ['?1049h', `${ESC}[?1049h`],
      ['?1049;1006h', `${ESC}[?1049;1006h`],
      ['?1006;1049h', `${ESC}[?1006;1049h`],
      // xterm hands the hook [1049, [1]] and still switches buffers on it.
      ['?1049:1h', `${ESC}[?1049:1h`],
    ])('%s enters the alternate screen and is recorded', async (_name, seq) => {
      const t = track(wiredTerminal());
      await write(t, seq);
      expect(t.buffer.active.type).toBe('alternate');
      expect(alternateScreenOwner(SURFACE)).toBe('program');
    });

    it.each([
      ['?25h', `${ESC}[?25h`],
      ['?1002;1006h', `${ESC}[?1002;1006h`],
      ['?2004h', `${ESC}[?2004h`],
    ])('%s is not an alternate-screen entry', async (_name, seq) => {
      const t = track(wiredTerminal());
      await write(t, seq);
      expect(t.buffer.active.type).toBe('normal');
      expect(alternateScreenOwner(SURFACE)).toBeUndefined();
    });

    it('RIS (ESC c) returns to the normal buffer and clears the record, the arm and the notice', async () => {
      const notices: ResetNoticeDetail[] = [];
      const notify = (d: ResetNoticeDetail) => { notices.push(d); };
      const t = track(wiredTerminal(notify));
      await stuckOnAlternateScreen(t);
      expect(applyManualReset(t, SURFACE, { now: 10_000, notify })).toBe('keep');
      await write(t, `${ESC}c`);
      expect(t.buffer.active.type).toBe('normal');
      expect(alternateScreenOwner(SURFACE)).toBeUndefined();
      expect(notices.at(-1)).toEqual({ surfaceId: SURFACE, until: null });
      await write(t, ALT_ON);
      expect(applyManualReset(t, SURFACE, { now: 11_000 })).toBe('keep');
    });
  });

  it('a program entering the alternate screen is recorded as its owner', async () => {
    const t = track(wiredTerminal());
    await stuckOnAlternateScreen(t);
    expect(t.buffer.active.type).toBe('alternate');
    expect(alternateScreenOwner(SURFACE)).toBe('program');
  });

  it('a prompt mark on the normal buffer says nothing about the alternate screen', async () => {
    const t = track(wiredTerminal());
    await write(t, `${PROMPT_MARK}$ `);
    expect(alternateScreenOwner(SURFACE)).toBeUndefined();
  });

  it('stuck on the alternate screen with no shell state, a prompt mark, then reset leaves', async () => {
    const t = track(wiredTerminal());
    await stuckOnAlternateScreen(t);
    // The program died; the shell (cmd, or a remote bash) prompts on its screen.
    await write(t, `\r\n${PROMPT_MARK}$ `);
    expect(alternateScreenOwner(SURFACE)).toBe('shell');

    expect(applyManualReset(t, SURFACE, { now: 1000 })).toBe('leave');
    await write(t, '');
    expect(t.buffer.active.type).toBe('normal');
  });

  it('the same, but a program re-entered the alternate screen after the prompt: reset keeps', async () => {
    const t = track(wiredTerminal());
    await stuckOnAlternateScreen(t);
    await write(t, `\r\n${PROMPT_MARK}$ vim\r\n`);
    // Already on the alternate buffer, so xterm fires no buffer change here —
    // only the CSI hook can see this re-entry.
    await write(t, `${ALT_ON}VIM FRAME`);
    expect(alternateScreenOwner(SURFACE)).toBe('program');

    expect(applyManualReset(t, SURFACE, { now: 1000 })).toBe('keep');
    await write(t, '');
    expect(t.buffer.active.type).toBe('alternate');
  });

  it('a prompt mark overrides a stale `running` from the outer shell (ssh, wsl, nested pwsh)', async () => {
    const t = track(wiredTerminal());
    recordSurfaceShellState(SURFACE, 'running');
    await stuckOnAlternateScreen(t);
    await write(t, `\r\n${PROMPT_MARK}remote$ `);
    expect(applyManualReset(t, SURFACE, { now: 1000 })).toBe('leave');
    await write(t, '');
    expect(t.buffer.active.type).toBe('normal');
  });

  it('`running` with no prompt mark keeps (#347)', async () => {
    const t = track(wiredTerminal());
    recordSurfaceShellState(SURFACE, 'running');
    await stuckOnAlternateScreen(t);
    expect(applyManualReset(t, SURFACE, { now: 1000 })).toBe('keep');
    await write(t, '\r\nSTILL DRAWING');
    expect(t.buffer.active.type).toBe('alternate');
  });

  it('a second press within the window forces the alternate screen off', async () => {
    const t = track(wiredTerminal());
    await stuckOnAlternateScreen(t);
    expect(applyManualReset(t, SURFACE, { now: 10_000 })).toBe('keep');
    expect(applyManualReset(t, SURFACE, { now: 10_000 + FORCE_LEAVE_WINDOW_MS - 1 })).toBe('force');
    await write(t, '');
    expect(t.buffer.active.type).toBe('normal');
  });

  it('a second press after the window keeps again, and re-arms', async () => {
    const t = track(wiredTerminal());
    await stuckOnAlternateScreen(t);
    expect(applyManualReset(t, SURFACE, { now: 10_000 })).toBe('keep');
    const late = 10_000 + FORCE_LEAVE_WINDOW_MS + 1;
    expect(applyManualReset(t, SURFACE, { now: late })).toBe('keep');
    await write(t, '');
    expect(t.buffer.active.type).toBe('alternate');
    // The late press is itself a kept reset, so a third one right after it forces.
    expect(applyManualReset(t, SURFACE, { now: late + 500 })).toBe('force');
  });

  it('the force window is per surface', async () => {
    const t = track(wiredTerminal());
    await stuckOnAlternateScreen(t);
    const other = track(new Terminal({ cols: 40, rows: 6, allowProposedApi: true }));
    trackAlternateScreenOwner(other, 'surf-other');
    await write(other, ALT_ON);
    expect(applyManualReset(other, 'surf-other', { now: 10_000 })).toBe('keep');
    expect(applyManualReset(t, SURFACE, { now: 10_100 })).toBe('keep');
  });

  it('the palette force leaves at once', async () => {
    const t = track(wiredTerminal());
    recordSurfaceShellState(SURFACE, 'running');
    await stuckOnAlternateScreen(t);
    expect(applyManualReset(t, SURFACE, { now: 1000, forceLeave: true })).toBe('force');
    await write(t, '');
    expect(t.buffer.active.type).toBe('normal');
  });

  it('the notice appears only when the screen was kept, and goes away otherwise', async () => {
    const t = track(wiredTerminal());
    const notices: ResetNoticeDetail[] = [];
    const notify = (d: ResetNoticeDetail) => { notices.push(d); };

    // Normal buffer: nothing kept, nothing shown.
    await write(t, 'MAIN\r\n');
    applyManualReset(t, SURFACE, { now: 1000, notify });
    expect(notices.at(-1)).toEqual({ surfaceId: SURFACE, until: null });

    // Kept: shown until the force window closes.
    await write(t, ALT_ON);
    applyManualReset(t, SURFACE, { now: 2000, notify });
    expect(notices.at(-1)).toEqual({ surfaceId: SURFACE, until: 2000 + FORCE_LEAVE_WINDOW_MS });

    // Forced: hidden.
    applyManualReset(t, SURFACE, { now: 2500, notify });
    expect(notices.at(-1)).toEqual({ surfaceId: SURFACE, until: null });
    expect(notices.filter((n) => n.until !== null)).toHaveLength(1);
  });

  it('leaving the alternate screen clears the record, so the next program starts fresh', async () => {
    const t = track(wiredTerminal());
    await stuckOnAlternateScreen(t);
    await write(t, `\r\n${PROMPT_MARK}$ `);
    applyManualReset(t, SURFACE, { now: 1000 });
    await write(t, '');
    expect(alternateScreenOwner(SURFACE)).toBeUndefined();

    await write(t, ALT_ON);
    expect(alternateScreenOwner(SURFACE)).toBe('program');
    expect(applyManualReset(t, SURFACE, { now: 2000 })).toBe('keep');
  });

  it('a program that exits normally clears the record too', async () => {
    const t = track(wiredTerminal());
    await stuckOnAlternateScreen(t);
    await write(t, `${ESC}[?1049l`);
    expect(alternateScreenOwner(SURFACE)).toBeUndefined();
  });

  describe('a command started from a prompt on the alternate screen (OSC 133;C)', () => {
    /** A shell prompting on a dead program's screen, then running `cmd` from it. */
    async function commandFromStalePrompt(t: Terminal, cmd: string): Promise<void> {
      await stuckOnAlternateScreen(t);
      await write(t, `\r\n${PROMPT_MARK}PS> ${INPUT_MARK}${cmd}\r\n${COMMAND_START}`);
    }

    it('keeps the screen while the command runs: an inline program draws there', async () => {
      const t = track(wiredTerminal());
      // Claude Code's inline mode, a dev server: no DECSET, just output.
      await commandFromStalePrompt(t, 'claude');
      await write(t, '> working...');
      expect(alternateScreenOwner(SURFACE)).toBe('command');
      expect(applyManualReset(t, SURFACE, { now: 1000 })).toBe('keep');
      await write(t, '');
      expect(t.buffer.active.type).toBe('alternate');
    });

    it('keeps it even when the shell reports idle (PowerShell without PSReadLine)', async () => {
      const t = track(wiredTerminal());
      recordSurfaceShellState(SURFACE, 'idle');
      await commandFromStalePrompt(t, 'npm run dev');
      expect(applyManualReset(t, SURFACE, { now: 1000 })).toBe('keep');
    });

    it('the command ending (133;D) gives the screen back to the shell', async () => {
      const t = track(wiredTerminal());
      await commandFromStalePrompt(t, 'npm run dev');
      await write(t, `^C\r\n${COMMAND_END}`);
      expect(alternateScreenOwner(SURFACE)).toBe('shell');
      expect(applyManualReset(t, SURFACE, { now: 1000 })).toBe('leave');
    });

    it('so does the next prompt, for a shell that emits no D', async () => {
      const t = track(wiredTerminal());
      await commandFromStalePrompt(t, 'ls');
      await write(t, `file\r\n${PROMPT_MARK}PS> `);
      expect(applyManualReset(t, SURFACE, { now: 1000 })).toBe('leave');
    });

    it('a command mark on the normal buffer says nothing about the alternate screen', async () => {
      const t = track(wiredTerminal());
      await write(t, `${PROMPT_MARK}$ ${INPUT_MARK}ls\r\n${COMMAND_START}file\r\n${COMMAND_END}`);
      expect(alternateScreenOwner(SURFACE)).toBeUndefined();
    });

    it('a command end without a command start on the screen changes nothing', async () => {
      const t = track(wiredTerminal());
      await stuckOnAlternateScreen(t);
      await write(t, COMMAND_END);
      expect(alternateScreenOwner(SURFACE)).toBe('program');
    });

    it('ssh from a local shell: the outer `running` and command do not block the inner prompt', async () => {
      const t = track(wiredTerminal());
      // The local shell runs `ssh host`: its C lands on the normal buffer and
      // its `running` report stays up for the whole session.
      await write(t, `${PROMPT_MARK}PS> ${INPUT_MARK}ssh host\r\n${COMMAND_START}`);
      recordSurfaceShellState(SURFACE, 'running');
      // A remote TUI dies on the alternate screen, and the remote shell prompts there.
      await write(t, `${ALT_ON}TUI FRAME\r\n${PROMPT_MARK}remote$ `);
      expect(applyManualReset(t, SURFACE, { now: 1000 })).toBe('leave');
      await write(t, '');
      expect(t.buffer.active.type).toBe('normal');
    });

    it('ssh: a remote command that ran and finished from the inner prompt still leaves', async () => {
      const t = track(wiredTerminal());
      recordSurfaceShellState(SURFACE, 'running');
      await stuckOnAlternateScreen(t);
      await write(t, `\r\n${PROMPT_MARK}remote$ ${INPUT_MARK}ls\r\n${COMMAND_START}file\r\n${COMMAND_END}`);
      expect(applyManualReset(t, SURFACE, { now: 1000 })).toBe('leave');
    });
  });

  describe('a terminal rebuilt from a remount snapshot', () => {
    /** The old terminal's tracker goes with it; the record, module state, stays. */
    function remount(old: { dispose(): void }): Terminal {
      old.dispose();
      return track(wiredTerminal());
    }

    it("the snapshot's replayed ?1049h is not a program entering", async () => {
      const t = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
      terminals.push(t);
      const tracker = trackAlternateScreenOwner(t, SURFACE);
      t.parser.registerOscHandler(133, (data) => handlePromptMark(t, SURFACE, data));
      await stuckOnAlternateScreen(t);
      await write(t, `\r\n${PROMPT_MARK}$ `);
      expect(alternateScreenOwner(SURFACE)).toBe('shell');

      const rebuilt = remount(tracker);
      beginSnapshotReplay(SURFACE);
      await new Promise<void>((done) => rebuilt.write(`MAIN-1\r\n${ALT_ON}TUI FRAME\r\n$ `, () => {
        endSnapshotReplay(SURFACE);
        done();
      }));
      expect(rebuilt.buffer.active.type).toBe('alternate');
      expect(alternateScreenOwner(SURFACE)).toBe('shell');
      expect(applyManualReset(rebuilt, SURFACE, { now: 1000 })).toBe('leave');
    });

    it('a program entering after the replay is recorded again', async () => {
      const t = track(wiredTerminal());
      beginSnapshotReplay(SURFACE);
      await write(t, ALT_ON);
      endSnapshotReplay(SURFACE);
      expect(alternateScreenOwner(SURFACE)).toBeUndefined();
      await write(t, ALT_ON);
      expect(alternateScreenOwner(SURFACE)).toBe('program');
    });

    it('a terminal disposed mid-replay does not leave its replacement deaf to DECSETs', async () => {
      const t = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
      terminals.push(t);
      const tracker = trackAlternateScreenOwner(t, SURFACE);
      // The write callback never runs for a terminal disposed before it parsed.
      beginSnapshotReplay(SURFACE);
      const rebuilt = remount(tracker);
      await write(rebuilt, ALT_ON);
      expect(alternateScreenOwner(SURFACE)).toBe('program');
    });

    it('the replay is per surface', async () => {
      const t = track(wiredTerminal());
      beginSnapshotReplay('surf-other');
      await write(t, ALT_ON);
      endSnapshotReplay('surf-other');
      expect(alternateScreenOwner(SURFACE)).toBe('program');
    });
  });

  describe('the force window belongs to the screen it was armed on', () => {
    it('quitting the program and starting another one does not leave the arm behind', async () => {
      const t = track(wiredTerminal());
      await stuckOnAlternateScreen(t);
      // Reset in a live vim: kept, and a second press would force.
      expect(applyManualReset(t, SURFACE, { now: 10_000 })).toBe('keep');
      // vim quits normally, and a new vim starts inside the old window.
      await write(t, `${ESC}[?1049l$ vim
`);
      await write(t, `${ALT_ON}VIM FRAME`);
      expect(applyManualReset(t, SURFACE, { now: 11_000 })).toBe('keep');
      await write(t, '');
      expect(t.buffer.active.type).toBe('alternate');
    });

    it('a program entering the screen the reset kept starts a new screen too', async () => {
      const t = track(wiredTerminal());
      await stuckOnAlternateScreen(t);
      expect(applyManualReset(t, SURFACE, { now: 10_000 })).toBe('keep');
      // Typed into the stuck screen of a shell that emits no prompt marks.
      await write(t, `
$ vim
${ALT_ON}VIM FRAME`);
      expect(applyManualReset(t, SURFACE, { now: 11_000 })).toBe('keep');
    });

    it('the notice goes away when the program leaves the alternate screen', async () => {
      const notices: ResetNoticeDetail[] = [];
      const notify = (d: ResetNoticeDetail) => { notices.push(d); };
      const t = track(wiredTerminal(notify));
      await stuckOnAlternateScreen(t);
      applyManualReset(t, SURFACE, { now: 10_000, notify });
      expect(notices.at(-1)?.until).toBe(10_000 + FORCE_LEAVE_WINDOW_MS);
      await write(t, `${ESC}[?1049l`);
      expect(notices.at(-1)).toEqual({ surfaceId: SURFACE, until: null });
    });

    it('the notice goes away when a program enters the alternate screen again', async () => {
      const notices: ResetNoticeDetail[] = [];
      const notify = (d: ResetNoticeDetail) => { notices.push(d); };
      const t = track(wiredTerminal(notify));
      await stuckOnAlternateScreen(t);
      applyManualReset(t, SURFACE, { now: 10_000, notify });
      await write(t, ALT_ON);
      expect(notices.at(-1)).toEqual({ surfaceId: SURFACE, until: null });
    });

    it('with no notice up, buffer changes announce nothing', async () => {
      const notices: ResetNoticeDetail[] = [];
      const t = track(wiredTerminal((d) => { notices.push(d); }));
      await stuckOnAlternateScreen(t);
      await write(t, `${ESC}[?1049l${ALT_ON}${ESC}[?1049l`);
      expect(notices).toEqual([]);
    });
  });

  it('forgetAlternateScreen drops the record and the force arm', async () => {
    const t = track(wiredTerminal());
    await stuckOnAlternateScreen(t);
    expect(applyManualReset(t, SURFACE, { now: 1000 })).toBe('keep');
    forgetAlternateScreen(SURFACE);
    expect(alternateScreenOwner(SURFACE)).toBeUndefined();
    // No owner and no shell state: kept, not forced — the arm went with it.
    expect(applyManualReset(t, SURFACE, { now: 1500 })).toBe('keep');
  });
});
