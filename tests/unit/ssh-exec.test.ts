import { describe, expect, it } from 'vitest';
import { runSsh, sshArgs, toolForSession } from '../../src/main/ssh-exec';
import { parseSshArgv } from '../../src/main/ssh-argv';

describe('runSsh', () => {
  it('feeds stdin and returns text and raw bytes', async () => {
    const result = await runSsh(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], 10_000, { input: 'héllo' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('héllo');
    expect(result.stdoutBuffer).toEqual(Buffer.from('héllo'));
  });

  it('answers the exit status and stderr of a failing process', async () => {
    const result = await runSsh(process.execPath, ['-e', "console.error('nope'); process.exit(255)"], 10_000);
    expect(result.status).toBe(255);
    expect(result.stderr).toContain('nope');
  });

  it('answers status 1 for an executable that cannot start', async () => {
    const result = await runSsh('/definitely/not/here/ssh', [], 10_000);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toBe('');
  });

  it('does not throw when the child exits before reading its input', async () => {
    const result = await runSsh(process.execPath, ['-e', ''], 10_000, { input: 'x'.repeat(1 << 20) });
    expect(typeof result.status).toBe('number');
  });

  it('honours maxBuffer', async () => {
    const result = await runSsh(process.execPath, ['-e', "process.stdout.write('x'.repeat(5000))"], 10_000, { maxBuffer: 100 });
    expect(result.status).not.toBe(0);
  });
});

describe('sshArgs', () => {
  it('is non-interactive and replays only the pane\'s connection options', () => {
    const session = parseSshArgv(['ssh', '-F', '/c', '-J', 'jump', '-p', '2200', '-i', '/k', '-o', 'LocalCommand=x', '-o', 'BatchMode=no', 'dev@box'])!;
    const args = sshArgs(session, '-p');
    expect(args).toEqual(expect.arrayContaining(['BatchMode=yes', 'ConnectTimeout=6', 'ClearAllForwardings=yes', '-F', '/c', '-J', 'jump', '-i', '/k']));
    expect(args[args.indexOf('-p') + 1]).toBe('2200');
    expect(args.join(' ')).not.toContain('LocalCommand');
    expect(args).not.toContain('BatchMode=no');
  });
});

describe('toolForSession', () => {
  it('prefers the sibling of the ssh the pane used, and refuses when it is missing', () => {
    const session = parseSshArgv(['/opt/ssh/bin/ssh', 'box'])!;
    expect(toolForSession(session, 'ssh', () => true)).toMatch(/ssh/);
    expect(() => toolForSession(session, 'ssh', () => false)).toThrow(/not found/);
  });
});
