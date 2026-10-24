import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Terminal } from '@xterm/xterm';
import {
  alternateScreenOwner,
  applyManualReset,
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
      // A sub-parameter list is not a mode number.
      expect(entersAlternateScreen([[1049, 1]])).toBe(false);
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
