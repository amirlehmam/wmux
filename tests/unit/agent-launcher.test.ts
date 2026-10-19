import { describe, it, expect } from 'vitest';
import { launchedAgent, lastAgentLauncher, mergeResume, quoteOmpArg } from '../../src/renderer/hooks/agent-launcher';

describe('launchedAgent', () => {
  it.each([
    ['opencode', 'opencode'],
    ['opencode --server https://code.homenode.stream', 'opencode'],
    ['opencode2 --server https://code.homenode.stream', 'opencode'],
    ['opencode2', 'opencode'],
    ['C:\\Tools\\opencode.exe', 'opencode'],
    ['/usr/local/bin/opencode', 'opencode'],
    ['"C:\\Program Files\\opencode.cmd" --server x', 'opencode'],
    ['npx -y opencode', 'opencode'],
    ['npx opencode --server x', 'opencode'],
    ['pnpm dlx codex', 'codex'],
    ['codex --yolo', 'codex'],
    ['claude', 'claude'],
    ['claude-code', 'claude'],
    ['claude2 --model sonnet', 'claude'],
    ['omp', 'omp'],
    ['omp --profile work', 'omp'],
    ['omp2', 'omp'],
    ['"C:\\Program Files\\omp\\omp.exe" --profile work', 'omp'],
    ['npx -y omp', 'omp'],
  ])('%s -> %s', (command, agent) => {
    expect(launchedAgent(command)).toBe(agent);
  });

  it.each([
    // Exact match, never a prefix: this is somebody else's program.
    'opencode-monitor',
    'opencode-dev-server',
    // Quoting this would need a shell parser; being wrong here corrupts a
    // command that is not the agent's.
    'bash -c "opencode"',
    'echo opencode',
    'nvm use',
    'npx',
    'npm run opencode',
    '',
    '   ',
  ])('%s -> undefined', (command) => {
    expect(launchedAgent(command)).toBeUndefined();
  });
});

describe('lastAgentLauncher', () => {
  it('finds nothing in a setup-only base', () => {
    expect(lastAgentLauncher(['nvm use', 'cd packages/app'])).toBeUndefined();
  });

  it('finds the launcher among setup commands', () => {
    expect(lastAgentLauncher(['nvm use', 'opencode2 --server x'])).toEqual({ index: 1, agent: 'opencode' });
  });

  it('takes the last launcher when a pane names two', () => {
    expect(lastAgentLauncher(['opencode', 'claude'])).toEqual({ index: 1, agent: 'claude' });
  });
});

describe('mergeResume', () => {
  it('appends when every command is setup', () => {
    expect(mergeResume(['nvm use'], 'claude', 'abc')).toEqual(['nvm use', 'claude --resume abc']);
  });

  it('appends when there are no commands at all', () => {
    expect(mergeResume(undefined, 'opencode', 'ses_abc')).toEqual(['opencode -s ses_abc']);
  });

  it('merges into the pane\'s own launcher, keeping its name and flags (#302)', () => {
    expect(mergeResume(['opencode2 --server https://code.homenode.stream'], 'opencode', 'ses_abc'))
      .toEqual(['opencode2 --server https://code.homenode.stream -s ses_abc']);
  });

  it('merges into a claude launcher after setup commands', () => {
    expect(mergeResume(['nvm use', 'claude --model sonnet'], 'claude', 'abc'))
      .toEqual(['nvm use', 'claude --model sonnet --resume abc']);
  });

  it('merges codex as a subcommand, flags before it', () => {
    expect(mergeResume(['codex --yolo'], 'codex', 'abc')).toEqual(['codex --yolo resume abc']);
  });

  it('adds nothing when the pane launches a different agent', () => {
    expect(mergeResume(['claude'], 'opencode', 'ses_abc')).toBeNull();
  });

  it('does not mutate the caller\'s array', () => {
    const base = ['opencode2 --server x'];
    mergeResume(base, 'opencode', 'ses_abc');
    expect(base).toEqual(['opencode2 --server x']);
  });

  it('merges into an omp launcher, keeping profile and stripping --continue', () => {
    const path = 'C:/Users/test/my project/session.jsonl';
    expect(mergeResume(['omp --profile work --continue'], 'omp', path, 'cmd.exe'))
      .toEqual([`omp --profile work --resume "${path}"`]);
  });

  it('preserves existing launcher options with quoted spaces and strips conflicting flags', () => {
    const path = 'C:/Users/test/session.jsonl';
    expect(mergeResume(['omp --config "C:\\my tools\\ov.yml" --profile work --resume'], 'omp', path, 'cmd.exe'))
      .toEqual([`omp --config "C:\\my tools\\ov.yml" --profile work --resume "${path}"`]);
    expect(mergeResume(['omp --resume "C:\\old path\\x.jsonl"'], 'omp', path, 'cmd.exe'))
      .toEqual([`omp --resume "${path}"`]);
    expect(mergeResume(["omp --session='C:\\old path\\x.jsonl'"], 'omp', path, 'cmd.exe'))
      .toEqual([`omp --resume "${path}"`]);
    expect(mergeResume(['omp -r "C:\\old path\\x.jsonl" --profile work'], 'omp', path, 'cmd.exe'))
      .toEqual([`omp --profile work --resume "${path}"`]);
    expect(mergeResume(['omp --session-dir "D:\\my sessions" --profile work'], 'omp', path, 'cmd.exe'))
      .toEqual([`omp --session-dir "D:\\my sessions" --profile work --resume "${path}"`]);
    expect(mergeResume(['omp --continue "my message"'], 'omp', path, 'cmd.exe'))
      .toEqual([`omp "my message" --resume "${path}"`]);
  });

  it('keeps double spaces and tabs inside a quoted launcher argument byte-for-byte', () => {
    const path = 'C:/Users/test/session.jsonl';
    const spaced = 'omp --config "C:\\my  tools\\ov.yml" --profile work';
    expect(mergeResume([spaced], 'omp', path, 'cmd.exe'))
      .toEqual([`omp --config "C:\\my  tools\\ov.yml" --profile work --resume "${path}"`]);
    const tabbed = 'omp --config "C:\\my\ttools\\ov.yml"';
    expect(mergeResume([tabbed], 'omp', path, 'cmd.exe'))
      .toEqual([`omp --config "C:\\my\ttools\\ov.yml" --resume "${path}"`]);
    // The same holds when a conflicting flag is removed next to it.
    const withFlag = 'omp --continue --config "C:\\my  tools\\ov.yml"';
    expect(mergeResume([withFlag], 'omp', path, 'cmd.exe'))
      .toEqual([`omp --config "C:\\my  tools\\ov.yml" --resume "${path}"`]);
  });

  it('refuses to resume omp when --restore or --no-session is present', () => {
    const path = 'C:/Users/test/session.jsonl';
    expect(mergeResume(['omp --restore other.jsonl'], 'omp', path)).toBeNull();
    expect(mergeResume(['omp --no-session'], 'omp', path)).toBeNull();
  });
  it('safely skips resume in cmd.exe when path contains percent sign, but powershell supports it verbatim', () => {
    const percentPath = 'C:\\tmp\\100%done\\session.jsonl';
    // cmd.exe cannot pass % without expansion -> returns null (safe skip)
    expect(quoteOmpArg(percentPath, 'cmd.exe')).toBeNull();
    expect(mergeResume(['omp'], 'omp', percentPath, 'cmd.exe')).toBeNull();

    // powershell.exe single quotes protect % completely
    expect(quoteOmpArg(percentPath, 'powershell.exe')).toBe(`'${percentPath}'`);
    expect(mergeResume(['omp'], 'omp', percentPath, 'powershell.exe'))
      .toEqual([`omp --resume '${percentPath}'`]);
  });

  it('quotes omp path safely for powershell and posix shells with verbatim special characters', () => {
    const complexPath = "C:\\test\\my $var `test O'Connor\\session.jsonl";
    expect(mergeResume(['omp'], 'omp', complexPath, 'powershell.exe'))
      .toEqual([`omp --resume 'C:\\test\\my $var \`test O''Connor\\session.jsonl'`]);

    const posixPath = "/home/user/my $var `test O'Connor/session.jsonl";
    expect(mergeResume(['omp'], 'omp', posixPath, 'bash'))
      .toEqual([`omp --resume '/home/user/my $var \`test O'\\''Connor/session.jsonl'`]);
  });
});
