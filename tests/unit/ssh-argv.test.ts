import { describe, it, expect } from 'vitest';
import {
  parseSshArgv,
  isInteractiveSshArgv,
  splitCommandLine,
  normalizedExecutableName,
} from '../../src/main/ssh-argv';

/**
 * The parser behind remote file upload. Its output decides which host a pasted
 * screenshot is copied to, so the failure mode is not "the feature does not
 * work" — it is "the file went somewhere the user did not intend".
 *
 * That is why almost every case below asserts a *rejection*. Parsing
 * `ssh -p 2222 user@host` is the easy half; the half worth testing is refusing
 * to answer when the command line is a port forward, a one-shot remote command,
 * or something with a flag the table does not know.
 *
 * Pure functions, so the whole table runs on any platform.
 */

describe('normalizedExecutableName', () => {
  it('reduces a Windows OpenSSH path to a bare name', () => {
    expect(normalizedExecutableName('C:\\Windows\\System32\\OpenSSH\\ssh.exe')).toBe('ssh');
  });

  it('reduces a POSIX path to a bare name', () => {
    expect(normalizedExecutableName('/usr/bin/ssh')).toBe('ssh');
  });

  it('is empty for blank input rather than throwing', () => {
    expect(normalizedExecutableName('   ')).toBe('');
  });
});

describe('parseSshArgv — the shapes that must work', () => {
  it('reads a bare destination', () => {
    const session = parseSshArgv(['ssh', 'fortuna@honoured-accident']);
    expect(session?.destination).toBe('fortuna@honoured-accident');
    expect(session?.port).toBeUndefined();
  });

  it('accepts an argv with no leading executable', () => {
    expect(parseSshArgv(['fortuna@honoured-accident'])?.destination)
      .toBe('fortuna@honoured-accident');
  });

  it('reads a separated port and identity file', () => {
    const session = parseSshArgv(['ssh', '-p', '2222', '-i', 'C:\\keys\\id_ed25519', 'me@host']);
    expect(session?.port).toBe(2222);
    expect(session?.identityFile).toBe('C:\\keys\\id_ed25519');
    expect(session?.destination).toBe('me@host');
  });

  it('reads a glued port and identity file', () => {
    const session = parseSshArgv(['ssh', '-p2222', '-iC:\\keys\\id_ed25519', 'me@host']);
    expect(session?.port).toBe(2222);
    expect(session?.identityFile).toBe('C:\\keys\\id_ed25519');
  });

  it('merges -l into the destination', () => {
    expect(parseSshArgv(['ssh', '-l', 'fortuna', 'honoured-accident'])?.destination)
      .toBe('fortuna@honoured-accident');
  });

  it('lets an explicit user@ win over -l', () => {
    expect(parseSshArgv(['ssh', '-l', 'ignored', 'real@host'])?.destination).toBe('real@host');
  });

  it('unbundles no-argument flags', () => {
    const session = parseSshArgv(['ssh', '-4AC', 'me@host']);
    expect(session).toMatchObject({ addressFamily: 4, forwardAgent: true, compression: true });
  });

  it('lets a later -6 override an earlier -4', () => {
    // One field rather than two booleans, so "both families forced" is not
    // a representable state for a consumer to have to handle.
    const session = parseSshArgv(['ssh', '-4', '-6', 'me@host']);
    expect(session?.addressFamily).toBe(6);
  });

  it('leaves addressFamily unset when neither -4 nor -6 is given', () => {
    expect(parseSshArgv(['ssh', 'me@host'])?.addressFamily).toBeUndefined();
  });

  it('reads -J and -F', () => {
    const session = parseSshArgv(['ssh', '-J', 'bastion', '-F', '/etc/ssh_config', 'me@host']);
    expect(session?.jumpHost).toBe('bastion');
    expect(session?.configFile).toBe('/etc/ssh_config');
  });

  it('promotes recognized -o options into their own fields', () => {
    const session = parseSshArgv([
      'ssh',
      '-o', 'Port=2200',
      '-o', 'User=fortuna',
      '-o', 'ProxyJump=bastion',
      '-o', 'ControlPath=/tmp/cp',
      '-o', 'IdentityFile=/k/id',
      'host',
    ]);
    expect(session).toMatchObject({
      destination: 'fortuna@host',
      port: 2200,
      jumpHost: 'bastion',
      controlPath: '/tmp/cp',
      identityFile: '/k/id',
    });
    // Promoted, not also echoed into the passthrough list.
    expect(session?.sshOptions).toEqual([]);
  });

  it('passes unrecognized -o options through verbatim', () => {
    const session = parseSshArgv(['ssh', '-o', 'ServerAliveInterval=30', 'host']);
    expect(session?.sshOptions).toEqual(['ServerAliveInterval=30']);
  });

  it('reports -o options as written, including ones scp cannot inherit', () => {
    // The parser describes the command line; deciding what scp tolerates is
    // remote-upload's job (UNSAFE_FOR_TRANSFER). Keeping the filter out of
    // here means the parse can also answer questions that have nothing to do
    // with uploading.
    const session = parseSshArgv([
      'ssh',
      '-o', 'RemoteCommand=none',
      '-o', 'ControlMaster=auto',
      '-o', 'SetEnv=FOO=bar',
      'host',
    ]);
    expect(session?.sshOptions).toEqual(['RemoteCommand=none', 'ControlMaster=auto', 'SetEnv=FOO=bar']);
  });

  it('accepts a destination after --', () => {
    expect(parseSshArgv(['ssh', '--', 'me@host'])?.destination).toBe('me@host');
  });

  it('consumes and ignores a port forward that still opens a shell', () => {
    // -L keeps an interactive shell; only -N / -W remove it.
    const session = parseSshArgv(['ssh', '-L', '9787:127.0.0.1:9787', 'me@host']);
    expect(session?.destination).toBe('me@host');
  });
});

describe('parseSshArgv — which ssh binary was used', () => {
  // Recorded so the upload can use the matching scp. Two ssh builds on one
  // Windows box do not share an agent, so the wrong one authenticates
  // differently against the same host.
  it('records an absolute Windows ssh path', () => {
    const session = parseSshArgv(['C:\\Windows\\System32\\OpenSSH\\ssh.exe', 'me@host']);
    expect(session?.sshExecutable).toBe('C:\\Windows\\System32\\OpenSSH\\ssh.exe');
  });

  it('records a POSIX ssh path', () => {
    expect(parseSshArgv(['/usr/bin/ssh', 'me@host'])?.sshExecutable).toBe('/usr/bin/ssh');
  });

  it('records nothing for a bare ssh, because PATH decided', () => {
    expect(parseSshArgv(['ssh', 'me@host'])?.sshExecutable).toBeUndefined();
  });

  it('records nothing when argv had no executable at all', () => {
    expect(parseSshArgv(['me@host'])?.sshExecutable).toBeUndefined();
  });
});

describe('parseSshArgv — the shapes that must be refused', () => {
  it('refuses an empty argv', () => {
    expect(parseSshArgv([])).toBeNull();
  });

  it('refuses a command line with no destination', () => {
    expect(parseSshArgv(['ssh', '-4'])).toBeNull();
  });

  it('refuses a one-shot remote command', () => {
    expect(parseSshArgv(['ssh', 'me@host', 'ls', '-la'])).toBeNull();
  });

  it('refuses a remote command after --', () => {
    expect(parseSshArgv(['ssh', '--', 'me@host', 'ls'])).toBeNull();
  });

  it('refuses -N, the pure port forward', () => {
    // The shape `wmux bridge` documents. There is no remote shell in this pane,
    // so a paste has no remote destination to be useful at.
    expect(parseSshArgv(['ssh', '-N', '-L', '9787:127.0.0.1:9787', 'me@host'])).toBeNull();
  });

  it('refuses -W, the stdio forward', () => {
    expect(parseSshArgv(['ssh', '-W', 'inner:22', 'me@host'])).toBeNull();
  });

  it('refuses -T, no pty', () => {
    expect(parseSshArgv(['ssh', '-T', 'me@host'])).toBeNull();
  });

  it('refuses -n, stdin from the null device', () => {
    expect(parseSshArgv(['ssh', '-n', 'me@host'])).toBeNull();
  });

  it('refuses -o RequestTTY=no', () => {
    expect(parseSshArgv(['ssh', '-o', 'RequestTTY=no', 'me@host'])).toBeNull();
  });

  it('refuses -o RemoteCommand=<anything but none>', () => {
    expect(parseSshArgv(['ssh', '-o', 'RemoteCommand=tmux attach', 'me@host'])).toBeNull();
  });

  it('refuses -o SessionType=none', () => {
    expect(parseSshArgv(['ssh', '-o', 'SessionType=none', 'me@host'])).toBeNull();
  });

  it('refuses a glued -o RequestTTY=no', () => {
    expect(parseSshArgv(['ssh', '-oRequestTTY=no', 'me@host'])).toBeNull();
  });

  it('refuses an unknown flag rather than guessing past it', () => {
    expect(parseSshArgv(['ssh', '-Z', 'me@host'])).toBeNull();
  });

  it('refuses a non-numeric port', () => {
    expect(parseSshArgv(['ssh', '-p', 'nope', 'me@host'])).toBeNull();
  });

  it('refuses a value flag with nothing after it', () => {
    expect(parseSshArgv(['ssh', '-p'])).toBeNull();
  });
});

describe('parseSshArgv — IPv6 destinations survive intact', () => {
  it('keeps a bracketed literal', () => {
    expect(parseSshArgv(['ssh', 'me@[fe80::1]'])?.destination).toBe('me@[fe80::1]');
  });

  it('keeps a bare literal unbracketed (scpDestination brackets it later)', () => {
    expect(parseSshArgv(['ssh', 'fe80::1'])?.destination).toBe('fe80::1');
  });
});

describe('isInteractiveSshArgv', () => {
  it('accepts a plain interactive session', () => {
    expect(isInteractiveSshArgv(['ssh', 'me@host'])).toBe(true);
  });

  it('accepts -o RemoteCommand=none as an explicit interactive request', () => {
    expect(isInteractiveSshArgv(['ssh', '-o', 'RemoteCommand=none', 'me@host'])).toBe(true);
  });

  it('rejects an argv that never reaches a destination', () => {
    expect(isInteractiveSshArgv(['ssh', '-4', '-C'])).toBe(false);
  });
});

describe('splitCommandLine', () => {
  it('splits on whitespace', () => {
    expect(splitCommandLine('ssh -p 22 me@host')).toEqual(['ssh', '-p', '22', 'me@host']);
  });

  it('keeps a double-quoted run together', () => {
    expect(splitCommandLine('ssh -i "C:\\my keys\\id" me@host'))
      .toEqual(['ssh', '-i', 'C:\\my keys\\id', 'me@host']);
  });

  it('unescapes a doubled quote inside a quoted run', () => {
    expect(splitCommandLine('a "b""c" d')).toEqual(['a', 'b"c', 'd']);
  });

  it('preserves an empty quoted argument', () => {
    expect(splitCommandLine('ssh "" host')).toEqual(['ssh', '', 'host']);
  });

  it('does not treat single quotes as grouping', () => {
    // On Windows these reach the process verbatim. Stripping them would produce
    // a destination that parses cleanly but is not the host that ssh connected
    // to, which is exactly the silent-wrong-host case this must avoid.
    expect(splitCommandLine("ssh 'me@host'")).toEqual(['ssh', "'me@host'"]);
  });

  it('collapses runs of whitespace without emitting empty arguments', () => {
    expect(splitCommandLine('  ssh   me@host  ')).toEqual(['ssh', 'me@host']);
  });

  it('is empty for an empty string', () => {
    expect(splitCommandLine('')).toEqual([]);
  });
});
