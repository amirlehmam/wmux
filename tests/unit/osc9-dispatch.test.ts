import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { ProgressAddon } from '@xterm/addon-progress';
import { isConEmuSubcommand } from '../../src/renderer/hooks/osc9';

describe('isConEmuSubcommand', () => {
  it('treats a leading numeric field as a ConEmu subcommand', () => {
    expect(isConEmuSubcommand('4;1;50')).toBe(true);
    expect(isConEmuSubcommand('9;C:\\Users\\me')).toBe(true);
    expect(isConEmuSubcommand('12;')).toBe(true);
  });

  it('treats bare text as an iTerm2 notification', () => {
    expect(isConEmuSubcommand('Build finished')).toBe(false);
    expect(isConEmuSubcommand('done')).toBe(false);
    expect(isConEmuSubcommand('')).toBe(false);
  });

  it('does not mistake a digit-leading sentence for a subcommand', () => {
    // No semicolon after the digits, so it is notification text.
    expect(isConEmuSubcommand('3 tests failed')).toBe(false);
    expect(isConEmuSubcommand('100% complete')).toBe(false);
  });
});

// Mirrors the OSC 9 wiring in useTerminal.ts: ProgressAddon is loaded FIRST,
// the notification handler is registered AFTER it. xterm runs OSC handlers
// newest-first and stops at the first returning true, so the notification
// handler always sees the sequence before the addon does — it must DECLINE
// ConEmu subcommands (return false) rather than swallow them (return true),
// or OSC 9;4 progress never reaches the addon (regression guard for #127).
function makeTerminal() {
  const term = new Terminal({ allowProposedApi: true });

  const progress = new ProgressAddon();
  term.loadAddon(progress);
  const progressSeen: Array<{ state: number; value: number }> = [];
  progress.onChange(p => progressSeen.push({ state: p.state, value: p.value }));

  const notified: string[] = [];
  term.parser.registerOscHandler(9, data => {
    if (isConEmuSubcommand(data)) return false;
    notified.push(data);
    return true;
  });

  return { term, progressSeen, notified };
}

const write = (t: Terminal, s: string) => new Promise<void>(resolve => t.write(s, resolve));

describe('OSC 9 dispatch order', () => {
  it('a cwd report fires no notification (issue #127 prompt-redraw spam)', async () => {
    const { term, notified } = makeTerminal();
    // What wmux-cmd-integration.cmd emits on every single prompt redraw.
    await write(term, '\x1b]9;9;C:\\Users\\me\\project\x07');
    await write(term, '\x1b]9;9;C:\\Users\\me\\project\x07');
    expect(notified).toEqual([]);
  });

  it('a progress report reaches ProgressAddon instead of the notification path', async () => {
    const { term, progressSeen, notified } = makeTerminal();
    await write(term, '\x1b]9;4;1;50\x07');
    expect(progressSeen).toEqual([{ state: 1, value: 50 }]);
    expect(notified).toEqual([]);
  });

  it('progress state 0 still reaches the addon so the bar can be cleared', async () => {
    const { term, progressSeen } = makeTerminal();
    await write(term, '\x1b]9;4;1;70\x07');
    await write(term, '\x1b]9;4;0;0\x07');
    expect(progressSeen).toEqual([
      { state: 1, value: 70 },
      { state: 0, value: 0 },
    ]);
  });

  it('bare text still raises a notification', async () => {
    const { term, notified } = makeTerminal();
    await write(term, '\x1b]9;Build finished\x07');
    expect(notified).toEqual(['Build finished']);
  });

  it('interleaved traffic routes each payload to exactly one consumer', async () => {
    const { term, progressSeen, notified } = makeTerminal();
    await write(term, '\x1b]9;9;C:\\tmp\x07');
    await write(term, '\x1b]9;4;3;0\x07');
    await write(term, '\x1b]9;Agent needs you\x07');
    await write(term, '\x1b]9;9;C:\\tmp\x07');
    expect(notified).toEqual(['Agent needs you']);
    expect(progressSeen).toEqual([{ state: 3, value: 0 }]);
  });
});
