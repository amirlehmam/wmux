import { describe, it, expect } from 'vitest';
import {
  SshDetector,
  attributeSshProcesses,
  parseProcessTable,
  type SurfaceProcessSource,
} from '../../src/main/ssh-detect';

/**
 * Detection precedence and process attribution.
 *
 * The precedence tests matter because the three sources routinely disagree: a
 * `wmux ssh` pane has a managed answer forever, while the probe may briefly see
 * nothing (sweep in flight) or something stale (ssh already exited). Whichever
 * source is most authoritative has to win regardless of arrival order.
 *
 * The attribution tests stand in for the check cmux gets for free. On macOS it
 * asks the kernel which process group owns the tty; Windows has no tpgid, so
 * ancestry is the substitute — and ancestry has failure modes (a pane adopting
 * another pane's ssh) that a tty check simply cannot have.
 */

const source = (pids: Record<string, number>): SurfaceProcessSource => ({
  getPid: (surfaceId) => pids[surfaceId],
  liveSurfaceIds: () => Object.keys(pids),
});

const proc = (pid: number, ppid: number, commandLine: string) => ({ pid, ppid, commandLine });


describe('SshDetector precedence', () => {
  it('reports null for a plain local pane', () => {
    const detector = new SshDetector(source({ 'surf-1': 100 }));
    expect(detector.detect('surf-1')).toBeNull();
  });

  it('detects a wmux ssh surface from its shell string alone', () => {
    const detector = new SshDetector(source({ 'surf-1': 100 }));
    detector.setSurfaceShell('surf-1', 'ssh fortuna@honoured-accident');
    expect(detector.detect('surf-1')?.destination).toBe('fortuna@honoured-accident');
  });

  it('detects a wmux ssh surface launched by absolute path', () => {
    const detector = new SshDetector(source({ 'surf-1': 100 }));
    detector.setSurfaceShell('surf-1', 'C:\\Windows\\System32\\OpenSSH\\ssh.exe fortuna@honoured-accident');
    expect(detector.detect('surf-1')).toMatchObject({
      destination: 'fortuna@honoured-accident',
      sshExecutable: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    });
  });

  it('is local for an ssh executable with no destination attached', () => {
    // The contract with the PTY_CREATE caller, pinned after this bit me live:
    // ptyManager.create() returns the RESOLVED executable with arguments split
    // off into shellExtraArgs, so passing its `shell` back here hands us a bare
    // `…\ssh.exe`. That parses to no destination and the pane silently looks
    // local. The caller must pass the requested spec, not the resolved one.
    const detector = new SshDetector(source({ 'surf-1': 100 }));
    detector.setSurfaceShell('surf-1', 'C:\\Windows\\System32\\OpenSSH\\ssh.exe');
    expect(detector.detect('surf-1')).toBeNull();
  });

  it('treats a non-ssh shell as local', () => {
    const detector = new SshDetector(source({ 'surf-1': 100 }));
    detector.setSurfaceShell('surf-1', 'pwsh.exe');
    expect(detector.detect('surf-1')).toBeNull();
  });

  it('detects a typed ssh from the preexec report', () => {
    const detector = new SshDetector(source({ 'surf-1': 100 }));
    detector.reportCommand('surf-1', 'ssh -p 2222 fortuna@honoured-accident');
    expect(detector.detect('surf-1')).toMatchObject({
      destination: 'fortuna@honoured-accident',
      port: 2222,
    });
  });

  it('lets a managed surface outrank a contradicting preexec report', () => {
    // A `wmux ssh` pane knows what it launched. If the preexec hook somehow
    // reports something else, the launch spec is the one that is certainly true.
    const detector = new SshDetector(source({ 'surf-1': 100 }));
    detector.setSurfaceShell('surf-1', 'ssh managed@host');
    detector.reportCommand('surf-1', 'ssh reported@elsewhere');
    expect(detector.detect('surf-1')?.destination).toBe('managed@host');
  });

  it('clears the reported session when the shell returns to its prompt', () => {
    const detector = new SshDetector(source({ 'surf-1': 100 }));
    detector.reportCommand('surf-1', 'ssh fortuna@honoured-accident');
    detector.clearReported('surf-1');
    expect(detector.detect('surf-1')).toBeNull();
  });

  it('clears the reported session when a later command is not ssh', () => {
    // Otherwise `ssh host` then exit then `ls` would keep uploading to a host
    // the pane left minutes ago.
    const detector = new SshDetector(source({ 'surf-1': 100 }));
    detector.reportCommand('surf-1', 'ssh fortuna@honoured-accident');
    detector.reportCommand('surf-1', 'ls -la');
    expect(detector.detect('surf-1')).toBeNull();
  });

  it('clears the reported session when a later command is a non-interactive ssh', () => {
    const detector = new SshDetector(source({ 'surf-1': 100 }));
    detector.reportCommand('surf-1', 'ssh fortuna@honoured-accident');
    detector.reportCommand('surf-1', 'ssh -N -L 9787:127.0.0.1:9787 fortuna@honoured-accident');
    expect(detector.detect('surf-1')).toBeNull();
  });

  it('keeps the managed session when a remount re-reports the bare executable', () => {
    // The clobber this guards against, seen live: the renderer overwrites
    // SurfaceRef.shell with the RESOLVED executable once a terminal mounts
    // (setResolvedShellForSurface), so a remount re-runs PTY_CREATE with a
    // destination-less `…\ssh.exe`. Re-recording that would flip a correctly
    // detected pane to "local" while its ssh is still running. The caller only
    // records on a genuinely new PTY; this pins the value that must survive.
    const detector = new SshDetector(source({ 'surf-1': 100 }));
    detector.setSurfaceShell('surf-1', 'C:\\Windows\\System32\\OpenSSH\\ssh.exe fortuna@honoured-accident');
    expect(detector.detect('surf-1')?.destination).toBe('fortuna@honoured-accident');

    // A genuinely new PTY that is not ssh must still reset it, though.
    detector.setSurfaceShell('surf-1', 'pwsh.exe');
    expect(detector.detect('surf-1')).toBeNull();
  });

  it('forgets everything about a closed surface', () => {
    const detector = new SshDetector(source({ 'surf-1': 100 }));
    detector.setSurfaceShell('surf-1', 'ssh me@host');
    detector.forget('surf-1');
    expect(detector.detect('surf-1')).toBeNull();
  });

  it('keeps surfaces independent', () => {
    const detector = new SshDetector(source({ 'surf-1': 100, 'surf-2': 200 }));
    detector.reportCommand('surf-1', 'ssh a@one');
    detector.reportCommand('surf-2', 'ssh b@two');
    expect(detector.detect('surf-1')?.destination).toBe('a@one');
    expect(detector.detect('surf-2')?.destination).toBe('b@two');
  });
});

describe('attributeSshProcesses', () => {
  // The parent table is passed in rather than read from module state, so each
  // case states the whole process tree it is asserting against.
  it('attributes an ssh that IS the PTY root', () => {
    // `wmux ssh user@host` spawns ssh as the pane's own shell, so the PTY root
    // pid is the ssh pid. Verified against a live dev instance: the pane's ssh
    // was parented directly to the Electron main process, with no shell in
    // between. A walk that started at the parent would never see it.
    const found = attributeSshProcesses(
      [proc(100, 4, 'ssh fortuna@honoured-accident')],
      new Map([[100, 4]]),
      source({ 'surf-1': 100 })
    );
    expect(found.get('surf-1')?.destination).toBe('fortuna@honoured-accident');
  });

  it('attributes an ssh that is a direct child of the PTY root', () => {
    const found = attributeSshProcesses(
      [proc(200, 100, 'ssh fortuna@honoured-accident')],
      new Map([[200, 100]]),
      source({ 'surf-1': 100 })
    );
    expect(found.get('surf-1')?.destination).toBe('fortuna@honoured-accident');
  });

  it('attributes an ssh nested behind intermediate shells', () => {
    // `bash -c 'ssh host'` — the case both the managed and preexec layers miss,
    // and the whole reason the probe exists.
    const found = attributeSshProcesses(
      [proc(300, 250, 'ssh fortuna@honoured-accident')],
      new Map([[300, 250], [250, 100]]),
      source({ 'surf-1': 100 })
    );
    expect(found.get('surf-1')?.destination).toBe('fortuna@honoured-accident');
  });

  it('does not attribute an ssh belonging to no tracked pane', () => {
    // An ssh the user started from Explorer or another terminal must never make
    // a wmux pane look remote.
    const found = attributeSshProcesses(
      [proc(300, 999, 'ssh stranger@elsewhere')],
      new Map([[300, 999]]),
      source({ 'surf-1': 100 })
    );
    expect(found.size).toBe(0);
  });

  it('keeps two panes on separate hosts apart', () => {
    const found = attributeSshProcesses(
      [proc(200, 100, 'ssh a@one'), proc(400, 300, 'ssh b@two')],
      new Map([[200, 100], [400, 300]]),
      source({ 'surf-1': 100, 'surf-2': 300 })
    );
    expect(found.get('surf-1')?.destination).toBe('a@one');
    expect(found.get('surf-2')?.destination).toBe('b@two');
  });

  it('prefers the innermost ssh when a pane has nested sessions', () => {
    // ssh to a bastion, then ssh onward from there. The file belongs on the host
    // the user is actually typing at, which is the deepest one.
    const found = attributeSshProcesses(
      [proc(200, 100, 'ssh outer@bastion'), proc(300, 200, 'ssh inner@target')],
      new Map([[200, 100], [300, 200]]),
      source({ 'surf-1': 100 })
    );
    expect(found.get('surf-1')?.destination).toBe('inner@target');
  });

  it('ignores a non-interactive ssh even when it is correctly attributed', () => {
    const found = attributeSshProcesses(
      [proc(200, 100, 'ssh -N -L 9787:127.0.0.1:9787 fortuna@honoured-accident')],
      new Map([[200, 100]]),
      source({ 'surf-1': 100 })
    );
    expect(found.size).toBe(0);
  });

  it('is empty when no surface has a live pty', () => {
    const found = attributeSshProcesses(
      [proc(200, 100, 'ssh me@host')],
      new Map([[200, 100]]),
      source({})
    );
    expect(found.size).toBe(0);
  });

  it('terminates on a parent cycle instead of spinning', () => {
    // Windows recycles pids, so a stale parent table can describe a loop that
    // never existed. The walk has to give up, not hang the probe.
    const found = attributeSshProcesses(
      [proc(200, 300, 'ssh me@host')],
      new Map([[200, 300], [300, 200]]),
      source({ 'surf-1': 100 })
    );
    expect(found.size).toBe(0);
  });
});

describe('parseProcessTable', () => {
  it('keeps only ssh.exe rows', () => {
    const { sshProcesses } = parseProcessTable(
      ['100|4|pwsh.exe|pwsh.exe', '200|100|ssh.exe|ssh fortuna@honoured-accident'].join('\n')
    );
    expect(sshProcesses).toEqual([{ pid: 200, ppid: 100, commandLine: 'ssh fortuna@honoured-accident' }]);
  });

  it('returns parents for non-ssh rows too, so the walk can cross them', () => {
    // The ssh list holds only ssh rows, but the ancestry walk needs the shells
    // in between — a `bash -c ssh` is two hops from its pane.
    const { parents } = parseProcessTable(
      ['100|4|pwsh.exe|pwsh.exe', '250|100|bash.exe|bash -c x'].join('\n')
    );
    expect(parents.get(250)).toBe(100);
    expect(parents.get(100)).toBe(4);
  });

  it('keeps pipes that appear inside a command line', () => {
    const { sshProcesses } = parseProcessTable('200|100|ssh.exe|ssh me@host -o ProxyCommand=a|b');
    expect(sshProcesses[0].commandLine).toBe('ssh me@host -o ProxyCommand=a|b');
  });

  it('skips malformed and blank rows without throwing', () => {
    const { sshProcesses } = parseProcessTable(['', 'garbage', 'x|y|ssh.exe|ssh me@host', '   '].join('\n'));
    expect(sshProcesses).toEqual([]);
  });

  it('skips an ssh row with an empty command line', () => {
    // CommandLine is null for processes the query cannot open; there is nothing
    // to parse and guessing a destination would be the worst possible outcome.
    expect(parseProcessTable('200|100|ssh.exe|').sshProcesses.length).toBe(0);
  });

  it('is case-insensitive about the image name', () => {
    expect(parseProcessTable('200|100|SSH.EXE|ssh me@host').sshProcesses.length).toBe(1);
  });

  it('handles CRLF output', () => {
    const { sshProcesses } = parseProcessTable('200|100|ssh.exe|ssh me@host\r\n300|4|pwsh.exe|pwsh\r\n');
    expect(sshProcesses.length).toBe(1);
  });
});
