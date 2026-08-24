import { describe, it, expect } from 'vitest';
import {
  scpArgs,
  cleanupArgs,
  scpDestination,
  remoteDropPath,
  opensshPath,
  toolForSession,
} from '../../src/main/remote-upload';
import { posixShellQuote } from '../../src/shared/shell-quote';
import type { DetectedSsh } from '../../src/main/ssh-argv';

/**
 * The scp argv is pinned the way cmux pins its own (`scpArgumentsForTesting`):
 * these flags are not stylistic, and each one is here because its absence
 * produces a hang or a wrong-host transfer that is hard to diagnose from the
 * outside. Asserting the composed argv is the only place that stays honest
 * when someone reorders the builder later.
 *
 * Pure argv composition, so this runs on any platform. Only the executable-path
 * test is Windows-shaped, and it asserts the shape rather than the drive.
 */

const session = (over: Partial<DetectedSsh> = {}): DetectedSsh => ({
  destination: 'fortuna@honoured-accident',
  forwardAgent: false,
  compression: false,
  sshOptions: [],
  ...over,
});

describe('opensshPath', () => {
  it('is an absolute path into System32\\OpenSSH, not a bare name', () => {
    // Load-bearing: a bare `scp` would resolve to Git for Windows' MSYS2 build
    // on most dev machines, which cannot reach a Windows named-pipe ssh-agent.
    const scp = opensshPath('scp');
    expect(scp.replace(/\\/g, '/')).toMatch(/\/System32\/OpenSSH\/scp\.exe$/i);
    expect(scp).not.toBe('scp');
  });
});

describe('toolForSession', () => {
  // Windows commonly has two ssh builds and they do not share an agent:
  // Git for Windows' MSYS2 ssh cannot open a Windows named-pipe ssh-agent,
  // System32\OpenSSH can, and Git is usually first on PATH. Uploading with a
  // different build than the pane connected with means a different set of
  // usable keys against the same host.
  const allExist = () => true;
  const noneExist = () => false;

  it('falls back to Windows OpenSSH when the session named no path', () => {
    const scp = toolForSession(session(), 'scp', allExist);
    expect(scp.replace(/\\/g, '/')).toMatch(/\/System32\/OpenSSH\/scp\.exe$/i);
  });

  it('prefers the scp sitting beside the ssh the pane actually used', () => {
    const scp = toolForSession(
      session({ sshExecutable: 'C:\\Program Files\\Git\\usr\\bin\\ssh.exe' }),
      'scp',
      allExist
    );
    expect(scp).toBe('C:\\Program Files\\Git\\usr\\bin\\scp.exe');
  });

  it('resolves the ssh sibling too, for the rollback', () => {
    const ssh = toolForSession(
      session({ sshExecutable: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' }),
      'ssh',
      allExist
    );
    expect(ssh).toBe('C:\\Windows\\System32\\OpenSSH\\ssh.exe');
  });

  it('falls back when the sibling does not exist', () => {
    // A vendored ssh with no scp beside it is better served by the system
    // OpenSSH than by a path that cannot be spawned at all.
    const scp = toolForSession(
      session({ sshExecutable: 'C:\\vendor\\ssh.exe' }),
      'scp',
      noneExist
    );
    expect(scp.replace(/\\/g, '/')).toMatch(/\/System32\/OpenSSH\/scp\.exe$/i);
  });

  it('handles a POSIX-style ssh path with no extension', () => {
    const scp = toolForSession(session({ sshExecutable: '/usr/bin/ssh' }), 'scp', allExist);
    expect(scp.replace(/\\/g, '/')).toBe('/usr/bin/scp.exe');
  });
});

describe('posixShellQuote', () => {
  it('wraps a plain path in single quotes', () => {
    expect(posixShellQuote('/tmp/wmux-drop-abc.png')).toBe("'/tmp/wmux-drop-abc.png'");
  });

  it('survives a path containing spaces', () => {
    expect(posixShellQuote('/tmp/a b.png')).toBe("'/tmp/a b.png'");
  });

  it('closes and reopens the quote around an embedded single quote', () => {
    expect(posixShellQuote("it's")).toBe(`'it'"'"'s'`);
  });

  it('neutralizes shell metacharacters', () => {
    // The remote path is machine-generated, but the quoting is what guarantees
    // that stays true even if a filename ever reaches this function.
    expect(posixShellQuote('/tmp/x; rm -rf /')).toBe("'/tmp/x; rm -rf /'");
  });
});

describe('remoteDropPath', () => {
  it('uses the /tmp/wmux-drop-<uuid> shape with a lowercased extension', () => {
    expect(remoteDropPath('C:\\Temp\\Shot.PNG', 'AB-CD')).toBe('/tmp/wmux-drop-ab-cd.png');
  });

  it('omits the suffix for an extensionless file', () => {
    expect(remoteDropPath('C:\\Temp\\Makefile', 'abc')).toBe('/tmp/wmux-drop-abc');
  });

  it('does not carry the local basename onto the remote', () => {
    // Distinct uuids, not names: two `screenshot.png` pastes in one session must
    // not overwrite each other, and Windows-legal names are not all sane on the
    // far side.
    const a = remoteDropPath('C:\\Temp\\screenshot.png');
    const b = remoteDropPath('C:\\Temp\\screenshot.png');
    expect(a).not.toBe(b);
    expect(a).not.toContain('screenshot');
  });
});

describe('scpDestination', () => {
  it('leaves a hostname alone', () => {
    expect(scpDestination('fortuna@honoured-accident')).toBe('fortuna@honoured-accident');
  });

  it('brackets a bare IPv6 literal', () => {
    // Unbracketed, scp splits `::1:/tmp/x` on the first colon and copies to the
    // wrong place. cmux shipped this as a bugfix (PR #6874).
    expect(scpDestination('::1')).toBe('[::1]');
  });

  it('brackets a bare IPv6 literal behind a user', () => {
    expect(scpDestination('me@fe80::1')).toBe('me@[fe80::1]');
  });

  it('leaves an already-bracketed literal alone', () => {
    expect(scpDestination('me@[fe80::1]')).toBe('me@[fe80::1]');
  });
});

describe('scpArgs', () => {
  it('composes the baseline transfer', () => {
    expect(scpArgs(session(), 'C:\\Temp\\a.png', '/tmp/wmux-drop-1.png')).toEqual([
      '-q',
      '-o', 'ConnectTimeout=6',
      '-o', 'ServerAliveInterval=20',
      '-o', 'ServerAliveCountMax=2',
      '-o', 'BatchMode=yes',
      '-o', 'ControlMaster=no',
      '-o', 'ClearAllForwardings=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      'C:\\Temp\\a.png',
      'fortuna@honoured-accident:/tmp/wmux-drop-1.png',
    ]);
  });

  it('always sets BatchMode, so a prompt can never hang the transfer', () => {
    // scp runs detached with no TTY. Without BatchMode a passphrase prompt has
    // nowhere to draw and the upload blocks for the full 45s timeout.
    const args = scpArgs(session(), 'a', 'b');
    expect(args.join(' ')).toContain('BatchMode=yes');
  });

  it('uses -P for the port, not -p', () => {
    // scp's lowercase -p is "preserve mtime". Getting this wrong silently
    // connects to port 22 instead of the requested one.
    const args = scpArgs(session({ port: 2222 }), 'a', 'b');
    expect(args).toContain('-P');
    expect(args[args.indexOf('-P') + 1]).toBe('2222');
    expect(args).not.toContain('-p');
  });

  it('replays identity, config, jump host and address family', () => {
    const args = scpArgs(
      session({
        identityFile: 'C:\\k\\id',
        configFile: 'C:\\c\\cfg',
        jumpHost: 'bastion',
        addressFamily: 6,
        forwardAgent: true,
        compression: true,
      }),
      'a',
      'b'
    );
    expect(args).toContain('-6');
    expect(args).toContain('-A');
    expect(args).toContain('-C');
    expect(args[args.indexOf('-i') + 1]).toBe('C:\\k\\id');
    expect(args[args.indexOf('-F') + 1]).toBe('C:\\c\\cfg');
    expect(args[args.indexOf('-J') + 1]).toBe('bastion');
  });

  it('reuses the pane control path so the agent is not asked twice', () => {
    const args = scpArgs(session({ controlPath: '/tmp/cp' }), 'a', 'b');
    expect(args.join(' ')).toContain('ControlPath=/tmp/cp');
  });

  it('does not override a ControlPath the user already set via -o', () => {
    const args = scpArgs(
      session({ controlPath: '/tmp/ours', sshOptions: ['ControlPath=/tmp/theirs'] }),
      'a',
      'b'
    );
    expect(args.join(' ')).toContain('ControlPath=/tmp/theirs');
    expect(args.join(' ')).not.toContain('ControlPath=/tmp/ours');
  });

  it('does not override a StrictHostKeyChecking the user already set', () => {
    const args = scpArgs(session({ sshOptions: ['StrictHostKeyChecking=yes'] }), 'a', 'b');
    expect(args.join(' ')).toContain('StrictHostKeyChecking=yes');
    expect(args.join(' ')).not.toContain('StrictHostKeyChecking=accept-new');
  });

  it('drops -o options scp cannot inherit, and replays the rest', () => {
    // RemoteCommand / RequestTTY break the transfer outright; the others are
    // session-shaping options that mean nothing for a one-shot copy. The
    // parser reports them as written, so the filtering has to happen here.
    const args = scpArgs(
      session({
        sshOptions: ['RemoteCommand=none', 'ControlMaster=auto', 'SetEnv=FOO=bar', 'ServerAliveCountMax=9'],
      }),
      'a',
      'b'
    );
    expect(args.join(' ')).not.toContain('RemoteCommand');
    expect(args.join(' ')).not.toContain('SetEnv');
    expect(args.join(' ')).toContain('ServerAliveCountMax=9');
    // ControlMaster is set by us, and the user's value must not be replayed
    // on top of it.
    expect(args.filter((a) => a.startsWith('ControlMaster='))).toEqual(['ControlMaster=no']);
  });

  it('brackets an IPv6 destination in the remote target', () => {
    const args = scpArgs(session({ destination: 'me@fe80::1' }), 'a.png', '/tmp/x.png');
    expect(args[args.length - 1]).toBe('me@[fe80::1]:/tmp/x.png');
  });

  it('puts the local path immediately before the remote target', () => {
    const args = scpArgs(session(), 'C:\\Temp\\a.png', '/tmp/x.png');
    expect(args[args.length - 2]).toBe('C:\\Temp\\a.png');
    expect(args[args.length - 1]).toBe('fortuna@honoured-accident:/tmp/x.png');
  });
});

describe('cleanupArgs', () => {
  it('builds a quoted rm across every path in the batch', () => {
    const args = cleanupArgs(session(), ['/tmp/wmux-drop-1.png', '/tmp/wmux-drop-2.png']);
    expect(args[args.length - 1]).toBe(
      `sh -c 'rm -f -- '"'"'/tmp/wmux-drop-1.png'"'"' '"'"'/tmp/wmux-drop-2.png'"'"''`
    );
  });

  it('uses -p for the port, since this arm is ssh not scp', () => {
    const args = cleanupArgs(session({ port: 2222 }), ['/tmp/x']);
    expect(args).toContain('-p');
    expect(args[args.indexOf('-p') + 1]).toBe('2222');
    expect(args).not.toContain('-P');
  });

  it('passes -T, because the rollback wants no pty', () => {
    expect(cleanupArgs(session(), ['/tmp/x'])[0]).toBe('-T');
  });

  it('names the destination as a bare host, without an scp path suffix', () => {
    const args = cleanupArgs(session(), ['/tmp/x']);
    expect(args[args.length - 2]).toBe('fortuna@honoured-accident');
  });

  it('uses -- so a path could never be read as an rm flag', () => {
    expect(cleanupArgs(session(), ['/tmp/x']).join(' ')).toContain('rm -f --');
  });
});
