import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { ProgressAddon } from '@xterm/addon-progress';
import { isConEmuSubcommand, osc9CwdToOsc7 } from '../../src/renderer/hooks/osc9';
import { parseOsc7Cwd } from '../../src/shared/osc7';

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

describe('OSC 9 cwd adaptation', () => {
  it('preserves literal percent escapes, semicolons and Unicode directory names', () => {
    const cwd = 'C:\\My Repo\\%20; café 日本語';
    expect(parseOsc7Cwd(osc9CwdToOsc7(`9;${cwd}`)!, 'MY-PC')).toBe(cwd);
    expect(parseOsc7Cwd(osc9CwdToOsc7('9;C:\\')!, 'MY-PC')).toBe('C:\\');
  });

  it('leaves unsafe paths subject to the main-process allow-list', () => {
    for (const path of ['\\\\attacker\\share', '\\\\?\\C:\\secret', 'C:\\a\\..\\b', 'C:\\a\nb', 'C:\\a:stream', 'relative']) {
      expect(parseOsc7Cwd(osc9CwdToOsc7(`9;${path}`)!, 'MY-PC')).toBeNull();
    }
  });

  it('ignores other subcommands, empty paths and malformed Unicode', () => {
    for (const data of ['4;1;50', 'Build finished', '9;', '9;C:\\\uD800']) {
      expect(osc9CwdToOsc7(data)).toBeNull();
    }
  });
});

// Mirrors the OSC 9 wiring in useTerminal.ts: ProgressAddon is loaded FIRST,
// the notification handler is registered AFTER it. xterm runs OSC handlers
// newest-first and stops at the first returning true, so the notification
// handler always sees the sequence before the addon does — after handling cwd,
// it must DECLINE other ConEmu subcommands rather than swallow them,
// or OSC 9;4 progress never reaches the addon (regression guard for #127).
function makeTerminal() {
  const term = new Terminal({ allowProposedApi: true });

  const progress = new ProgressAddon();
  term.loadAddon(progress);
  const progressSeen: Array<{ state: number; value: number }> = [];
  progress.onChange(p => progressSeen.push({ state: p.state, value: p.value }));

  const notified: string[] = [];
  const cwdReports: string[] = [];
  term.parser.registerOscHandler(9, data => {
    const cwdReport = osc9CwdToOsc7(data);
    if (cwdReport !== null) {
      cwdReports.push(cwdReport);
      return true;
    }
    if (isConEmuSubcommand(data)) return false;
    notified.push(data);
    return true;
  });

  return { term, progressSeen, notified, cwdReports };
}

const write = (t: Terminal, s: string) => new Promise<void>(resolve => t.write(s, resolve));

describe('OSC 9 dispatch order', () => {
  it('routes CMD prompt cwd changes without firing notifications', async () => {
    const { term, notified, cwdReports } = makeTerminal();
    await write(term, '\x1b]133;A\x1b\\\x1b]9;9;C:\\Users\\me\\project\x1b\\C:\\Users\\me\\project>\x1b]133;B\x1b\\');
    await write(term, '\x1b]9;9;D:\\other project\x07');
    expect(cwdReports.map(data => parseOsc7Cwd(data, 'MY-PC'))).toEqual([
      'C:\\Users\\me\\project', 'D:\\other project',
    ]);
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
