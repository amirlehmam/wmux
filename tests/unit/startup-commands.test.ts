import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  classifyStartupChunk,
  ctrlUDiscardsLine,
  deliverStartupCommandsWhenReady,
  DEFAULT_STARTUP_GATE_TIMING,
  hasPromptMark,
  initialStartupGateState,
  looksLikePrompt,
  startupGateStep,
  startupKeystrokes,
  type StartupGateEvent,
  type StartupGateState,
} from '../../src/main/startup-commands';
import { looksLikePrompt as reexported } from '../../src/main/agent-manager';

/**
 * Issue #251: startup commands (restore's `claude --resume <id>` among them)
 * were typed into non-PowerShell panes on a blind 600 ms timer, i.e. whenever
 * the PTY had been CREATED rather than when the shell was READING. These pin
 * the rule PtyManager now applies instead, for every caller.
 */

const ESC = '\x1b';
const ST = `${ESC}\\`;
const BEL = '\x07';

function run(events: StartupGateEvent[], state: StartupGateState = initialStartupGateState()) {
  const actions = [];
  for (const e of events) {
    const next = startupGateStep(state, e);
    state = next.state;
    actions.push(next.action);
  }
  return { state, actions };
}

describe('readiness classification', () => {
  it('reads an OSC 133 A or B mark as a prompt, BEL- or ST-terminated, with params', () => {
    expect(hasPromptMark(`${ESC}]133;A${BEL}`)).toBe(true);
    expect(hasPromptMark(`${ESC}]133;B${ST}`)).toBe(true);
    expect(hasPromptMark(`${ESC}]133;A;cl=m${ST}C:\\>`)).toBe(true);
  });

  it('does NOT read C or D as ready — they bracket command output', () => {
    expect(hasPromptMark(`${ESC}]133;C${ST}`)).toBe(false);
    expect(hasPromptMark(`${ESC}]133;D;0${ST}`)).toBe(false);
  });

  it('the cmd integration prompt (mark + drive prompt) classifies as a mark, not as text', () => {
    // What wmux-cmd-integration.cmd's PROMPT draws: A, the prompt, B.
    expect(classifyStartupChunk(`${ESC}]133;A${ESC}\\C:\\Users\\me>${ESC}]133;B${ESC}\\`)).toBe('prompt-mark');
  });

  it('recognises a PowerShell prompt followed by an OSC 133;B mark (#207 lesson, moved from agent-manager)', () => {
    expect(looksLikePrompt(`PS C:\\x> ${ESC}]133;B${ST}`)).toBe(true);
  });

  it('recognises a prompt followed by trailing CSI sequences (cursor show, SGR reset)', () => {
    expect(looksLikePrompt(`user@host:~$ ${ESC}[0m${ESC}[?25h`)).toBe(true);
  });

  it('does not treat a banner as a prompt', () => {
    expect(classifyStartupChunk('Loading personal and system profiles took 812ms.\r\n')).toBe('quiet');
    expect(classifyStartupChunk('Microsoft Windows [Version 10.0.26200]\r\n')).toBe('quiet');
  });

  it('agent-manager still exports the same looksLikePrompt', () => {
    expect(reexported).toBe(looksLikePrompt);
  });
});

describe('startupGateStep', () => {
  const t = DEFAULT_STARTUP_GATE_TIMING;

  it('arms the short settle on a prompt mark', () => {
    const { actions } = run([{ kind: 'data', data: `${ESC}]133;A${ST}C:\\>` }]);
    expect(actions[0]).toEqual({ kind: 'arm', delayMs: t.settleMs, signal: 'prompt-mark' });
  });

  it('arms the quiet timer on plain output, and every further chunk pushes it back', () => {
    const { actions } = run([
      { kind: 'data', data: 'banner line 1\r\n' },
      { kind: 'data', data: 'banner line 2\r\n' },
    ]);
    expect(actions).toEqual([
      { kind: 'arm', delayMs: t.quietMs, signal: 'quiet' },
      { kind: 'arm', delayMs: t.quietMs, signal: 'quiet' },
    ]);
  });

  it('a prompt after a banner upgrades the quiet wait to the settle', () => {
    const { actions } = run([
      { kind: 'data', data: 'banner\r\n' },
      { kind: 'data', data: 'C:\\Users\\me>' },
    ]);
    expect(actions[1]).toEqual({ kind: 'arm', delayMs: t.settleMs, signal: 'prompt-text' });
  });

  it('never lets weaker output push a prompt-mark send back out', () => {
    const { actions } = run([
      { kind: 'data', data: `${ESC}]133;B${ST}` },
      { kind: 'data', data: 'right-prompt redraw\r\n' },
      { kind: 'data', data: 'C:\\>' },
    ]);
    expect(actions.slice(1)).toEqual([{ kind: 'wait' }, { kind: 'wait' }]);
  });

  it('a second prompt of the same kind keeps the timer already counting down', () => {
    const { actions } = run([
      { kind: 'data', data: 'C:\\>' },
      { kind: 'data', data: 'C:\\>' },
    ]);
    expect(actions[1]).toEqual({ kind: 'wait' });
  });

  it('sends with the armed signal as the reason, exactly once', () => {
    const { actions, state } = run([
      { kind: 'data', data: `${ESC}]133;A${ST}` },
      { kind: 'signal' },
      { kind: 'ceiling' },
      { kind: 'data', data: 'C:\\>' },
    ]);
    expect(actions[1]).toEqual({ kind: 'send', reason: 'prompt-mark' });
    expect(actions.slice(2)).toEqual([{ kind: 'wait' }, { kind: 'wait' }]);
    expect(state.sent).toBe(true);
  });

  it('the ceiling sends even with nothing seen at all', () => {
    const { actions } = run([{ kind: 'ceiling' }]);
    expect(actions[0]).toEqual({ kind: 'send', reason: 'max-wait' });
  });
});

describe('deliverStartupCommandsWhenReady', () => {
  afterEach(() => { vi.useRealTimers(); });

  function harness(alive = true) {
    let listener: ((d: string) => void) | null = null;
    const write = vi.fn();
    const unsubscribe = vi.fn(() => { listener = null; });
    const deps = {
      onData: (cb: (d: string) => void) => { listener = cb; return unsubscribe; },
      write,
      isAlive: () => alive,
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    const feed = (d: string) => listener?.(d);
    return { deps, write, unsubscribe, feed, listening: () => listener !== null };
  }

  it('types NOTHING before the shell is ready — the #251 race, where a blind 600 ms timer typed into a shell still starting', () => {
    vi.useFakeTimers();
    const h = harness();
    deliverStartupCommandsWhenReady(h.deps, ['claude --resume 0123abcd-4567']);
    h.feed('PowerShell 7.5.0\r\n'); // still initialising
    vi.advanceTimersByTime(1400);
    h.feed('Loading profile...\r\n');
    vi.advanceTimersByTime(1400);
    expect(h.write).not.toHaveBeenCalled();
  });

  it('types the whole command once the prompt mark arrives, after the settle', () => {
    vi.useFakeTimers();
    const h = harness();
    deliverStartupCommandsWhenReady(h.deps, ['claude --resume 0123abcd-4567']);
    h.feed('Microsoft Windows [Version 10.0.26200]\r\n');
    h.feed(`${ESC}]133;A${ST}C:\\Users\\me>${ESC}]133;B${ST}`);
    vi.advanceTimersByTime(DEFAULT_STARTUP_GATE_TIMING.settleMs - 1);
    expect(h.write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.write).toHaveBeenCalledWith('claude --resume 0123abcd-4567\r');
    expect(h.listening()).toBe(false);
  });

  it('sends several commands in order, in one write', () => {
    expect(startupKeystrokes(['cd C:\\proj', 'claude --resume abcdefgh'])).toBe('cd C:\\proj\rclaude --resume abcdefgh\r');
  });

  // wmux answers a DA1 probe by writing `ESC[?62;4;9;22c` to the PTY's stdin. A
  // bash/zsh line editor that nobody asked drops `ESC[?` and inserts
  // `62;4;9;22c` on the command line, so the typed command arrives as
  // `62;4;9;22ccd '…' && …` and bash runs `62`, `4`, `9`, `22ccd` instead.
  // Ctrl-U (readline unix-line-discard) empties the line before the command.
  it('discards whatever is already on the line before typing, when asked', () => {
    expect(startupKeystrokes(['cd /w && ./launch.sh'], { discardLine: true })).toBe('\x15cd /w && ./launch.sh\r');
    expect(startupKeystrokes(['a', 'b'], { discardLine: true })).toBe('\x15a\rb\r');
    expect(startupKeystrokes(['a'], { discardLine: false })).toBe('a\r');
  });

  it('only prefixes Ctrl-U for shells whose line editor reads it as kill-line', () => {
    expect(ctrlUDiscardsLine('wsl')).toBe(true); // bash/zsh inside the distro
    expect(ctrlUDiscardsLine('unknown')).toBe(true); // Git Bash, fish, nu
    expect(ctrlUDiscardsLine('cmd')).toBe(false);
    expect(ctrlUDiscardsLine('powershell')).toBe(false);
  });

  it('asks discardLine at SEND time, so a reply that lands during the settle window still counts', () => {
    vi.useFakeTimers();
    const h = harness();
    let replied = false;
    deliverStartupCommandsWhenReady({ ...h.deps, discardLine: () => replied }, ['echo hi']);
    h.feed(`${ESC}]133;A${BEL}$ `); // prompt mark: arms the settle timer
    replied = true; // wmux answered a DA1 probe after the mark, before the send
    vi.advanceTimersByTime(DEFAULT_STARTUP_GATE_TIMING.settleMs);
    expect(h.write).toHaveBeenCalledWith('\x15echo hi\r');
  });

  it('types the plain commands when no reply was written', () => {
    vi.useFakeTimers();
    const h = harness();
    deliverStartupCommandsWhenReady({ ...h.deps, discardLine: () => false }, ['echo hi']);
    h.feed(`${ESC}]133;A${BEL}$ `);
    vi.advanceTimersByTime(DEFAULT_STARTUP_GATE_TIMING.settleMs);
    expect(h.write).toHaveBeenCalledWith('echo hi\r');
  });

  it('a shell that never goes quiet still gets its command at the ceiling', () => {
    vi.useFakeTimers();
    const h = harness();
    deliverStartupCommandsWhenReady(h.deps, ['echo hi']);
    for (let i = 0; i < 60; i++) {
      h.feed(`noise ${i}\r\n`);
      vi.advanceTimersByTime(100);
    }
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.write).toHaveBeenCalledWith('echo hi\r');
  });

  it('a silent shell gets its command at the ceiling', () => {
    vi.useFakeTimers();
    const h = harness();
    deliverStartupCommandsWhenReady(h.deps, ['echo hi']);
    vi.advanceTimersByTime(DEFAULT_STARTUP_GATE_TIMING.maxWaitMs - 1);
    expect(h.write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.write).toHaveBeenCalledWith('echo hi\r');
  });

  it('output that goes quiet counts as ready (a prompt the sniff cannot recognise)', () => {
    vi.useFakeTimers();
    const h = harness();
    deliverStartupCommandsWhenReady(h.deps, ['echo hi']);
    h.feed('my-weird-prompt :: ');
    vi.advanceTimersByTime(DEFAULT_STARTUP_GATE_TIMING.quietMs);
    expect(h.write).toHaveBeenCalledWith('echo hi\r');
  });

  it('sends exactly once even when several prompts arrive', () => {
    vi.useFakeTimers();
    const h = harness();
    deliverStartupCommandsWhenReady(h.deps, ['echo hi']);
    h.feed(`PS C:\\x> ${ESC}]133;B${ST}`);
    vi.advanceTimersByTime(200);
    h.feed('PS C:\\x> ');
    vi.advanceTimersByTime(10_000);
    expect(h.write).toHaveBeenCalledTimes(1);
  });

  it('writes nothing into a shell that has already exited', () => {
    vi.useFakeTimers();
    const h = harness(false);
    deliverStartupCommandsWhenReady(h.deps, ['echo hi']);
    vi.advanceTimersByTime(10_000);
    expect(h.write).not.toHaveBeenCalled();
  });

  it('cancel stops everything — no write, no listener left behind', () => {
    vi.useFakeTimers();
    const h = harness();
    const cancel = deliverStartupCommandsWhenReady(h.deps, ['echo hi']);
    h.feed('C:\\>');
    cancel();
    vi.advanceTimersByTime(10_000);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.unsubscribe).toHaveBeenCalled();
  });
});
