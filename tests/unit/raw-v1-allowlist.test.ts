import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { RAW_V1_VERBS, rawV1Error, rawV1Parse } from '../../src/cli/wmux';

/**
 * `wmux raw-v1` exists so the bash integration can report shell state from
 * inside a devcontainer, where it cannot reach the pipe directly (issue #19).
 * It began as a generic passthrough: whatever line you handed it went to the V1
 * handler.
 *
 * That makes it a standing side door. Every V1 command added later becomes
 * reachable from a container the day it lands, without anyone deciding it should
 * be, and the V1 surface stops being defined by the V1 handler alone. The set
 * the integration actually emits is six verbs long, so name them.
 */

const INTEGRATION = path.resolve(__dirname, '../../src/shell-integration/wmux-bash-integration.sh');
const POWERSHELL_INTEGRATION = path.resolve(
  __dirname,
  '../../src/shell-integration/wmux-powershell-integration.ps1'
);

describe('raw-v1 allowlist', () => {
  it('accepts every verb the shipped bash integration emits', () => {
    // Read from the script rather than restating the list: the allowlist and the
    // integration drifting apart is the one failure that breaks reporting in a
    // container, and it would otherwise be invisible until someone ran one.
    const emitted = [...fs.readFileSync(INTEGRATION, 'utf8').matchAll(/_wmux_report "([a-z_]+)/g)].map((m) => m[1]);
    expect(emitted.length).toBeGreaterThan(0);
    for (const verb of new Set(emitted)) {
      expect(rawV1Error(verb), `${verb} is emitted by the integration but not allowlisted`).toBeNull();
    }
  });

  it('accepts report_startup_command, which comes from the devcontainer side', () => {
    // Not in the shipped script — the devcontainer feature appends it to its own
    // copy so a restored pane can be relaunched. Asserted separately so the loop
    // above staying green does not hide its removal.
    expect(rawV1Error('report_startup_command')).toBeNull();
  });

  it('rejects a V1 verb the integration does not emit, naming the accepted set', () => {
    // notify and report_pr are real V1 commands the pipe server handles. They are
    // not the shell integration's to send, so they are not reachable this way.
    for (const verb of ['notify', 'report_pr']) {
      const err = rawV1Error(verb);
      expect(err).toContain(verb);
      expect(err).toContain('report_pwd');
    }
  });

  it('rejects an unknown verb rather than passing it through', () => {
    expect(rawV1Error('rm')).toMatch(/not a passthrough command/);
  });

  it('prints usage when no verb is given at all', () => {
    expect(rawV1Error(undefined)).toMatch(/^Usage: wmux raw-v1/);
    expect(rawV1Error('')).toMatch(/^Usage: wmux raw-v1/);
  });

  it('matches on the verb alone, not on the rest of the line', () => {
    // rawV1Error takes a verb, never a whole line — extracting the verb from
    // argv is rawV1Parse's job (see below). Asserting that here is what let the
    // two drift: this stayed green while the shipped caller handed the CLI an
    // entire line and had every report rejected.
    expect(rawV1Error('report_pwd')).toBeNull();
    // ...and a verb cannot be smuggled in by gluing it to another one.
    expect(rawV1Error('report_pwd notify')).toMatch(/not a passthrough command/);
  });

  it('is the seven verbs and no more', () => {
    expect([...RAW_V1_VERBS].sort()).toEqual([
      'clear_git_branch',
      'ports_kick',
      'report_command',
      'report_git_branch',
      'report_pwd',
      'report_shell_state',
      'report_startup_command',
    ]);
  });
});

/**
 * The allowlist above was correct and still rejected every real report, because
 * nothing tested how the verb is recovered from argv.
 *
 * wmux-bash-integration.sh builds the V1 line as one string and passes it
 * quoted — `wmux raw-v1 "report_pwd $surface_id $(pwd)"` — so args[1] is the
 * whole line, not the verb. Checking args[1] meant checking
 * "report_pwd surf-1 /tmp" against a list of bare verbs: never a match, exit 1
 * before sendV1, and silence, since the caller fires into `>/dev/null 2>&1 &`.
 *
 * These cover the argv layer specifically. Asserting on rawV1Error alone cannot
 * catch this class of bug, which is exactly how it shipped.
 */
describe('raw-v1 argv parsing', () => {
  const SURFACE = 'surf-1';

  it('recovers the verb when the whole line arrives as one argument', () => {
    // THE regression: the shape wmux-bash-integration.sh actually sends.
    const { line, verb } = rawV1Parse(['raw-v1', `report_pwd ${SURFACE} /tmp/x`]);

    expect(verb).toBe('report_pwd');
    expect(rawV1Error(verb)).toBeNull();
    expect(line).toBe('report_pwd surf-1 /tmp/x');
  });

  it('recovers the verb when argv is pre-split, as a hand-typed call is', () => {
    const { line, verb } = rawV1Parse(['raw-v1', 'report_pwd', SURFACE, '/tmp/x']);

    expect(verb).toBe('report_pwd');
    expect(rawV1Error(verb)).toBeNull();
    expect(line).toBe('report_pwd surf-1 /tmp/x');
  });

  it('treats both argv shapes as the same request', () => {
    // The shape a caller happens to use must not change what the server sees;
    // that equivalence is the whole contract of the passthrough.
    const quoted = rawV1Parse(['raw-v1', `report_git_branch ${SURFACE} main dirty`]);
    const split = rawV1Parse(['raw-v1', 'report_git_branch', SURFACE, 'main', 'dirty']);

    expect(quoted).toEqual(split);
  });

  it('still rejects a non-allowlisted verb in the one-argument shape', () => {
    // The fix must not become a hole: taking the first token is only safe if a
    // bad first token is still refused.
    const { verb } = rawV1Parse(['raw-v1', `rm -rf / ${SURFACE}`]);

    expect(rawV1Error(verb)).toMatch(/not a passthrough command/);
  });

  it('cannot be tricked into allowing a second verb further down the line', () => {
    // "report_pwd notify" is a report_pwd whose surface id is "notify" — the
    // pipe server reads the command as the first token too, so allowlist and
    // parser agree on what was requested.
    const { verb } = rawV1Parse(['raw-v1', 'report_pwd notify']);

    expect(verb).toBe('report_pwd');
  });

  it('preserves a path containing spaces', () => {
    // report_pwd's payload is free text and the V1 handler keeps it as one
    // argument, so the line must survive the round trip byte for byte.
    const { line, verb } = rawV1Parse(['raw-v1', `report_pwd ${SURFACE} /tmp/my dir/sub`]);

    expect(verb).toBe('report_pwd');
    expect(line).toBe('report_pwd surf-1 /tmp/my dir/sub');
  });

  it('asks for usage when no line is given', () => {
    expect(rawV1Error(rawV1Parse(['raw-v1']).verb)).toMatch(/^Usage: wmux raw-v1/);
    expect(rawV1Error(rawV1Parse(['raw-v1', '   ']).verb)).toMatch(/^Usage: wmux raw-v1/);
  });

  it('accepts every line the shipped bash integration can actually emit', () => {
    // The drift guard above proves the verbs are allowlisted. This proves they
    // survive the transport the integration uses to send them — the half that
    // was broken. Built from the script so a new report cannot skip the check.
    const emitted = [...fs.readFileSync(INTEGRATION, 'utf8').matchAll(/_wmux_report "([a-z_]+)/g)].map((m) => m[1]);
    expect(emitted.length).toBeGreaterThan(0);

    for (const emittedVerb of new Set(emitted)) {
      const { verb } = rawV1Parse(['raw-v1', `${emittedVerb} ${SURFACE} payload`]);
      expect(rawV1Error(verb), `${emittedVerb} is emitted but rejected in the one-argument shape`).toBeNull();
    }
  });
});

describe('ssh lifecycle report ordering', () => {
  it('gives every Bash ssh command and shell-state report a shared sequence marker', () => {
    const script = fs.readFileSync(INTEGRATION, 'utf8');
    const lifecycleReports = [...script.matchAll(
      /_wmux_report "(report_(?:command|shell_state)) ([^"]+)"/g
    )];

    expect(lifecycleReports.length).toBe(4);
    for (const [, verb, payload] of lifecycleReports) {
      expect(payload, `${verb} must carry the ordering marker`).toContain(
        'seq=${_wmux_ssh_event_seq}'
      );
    }
    expect(script).toContain('_wmux_ssh_event_seq=$((_wmux_ssh_event_seq + 1))');
  });

  it('uses the same sequence wire shape in PowerShell', () => {
    const script = fs.readFileSync(POWERSHELL_INTEGRATION, 'utf8');

    expect(script).toContain('$script:WmuxSshEventSequence++');
    expect(script).toContain('return "seq=$($script:WmuxSshEventSequence)"');
    expect(script).toContain('Send-WmuxMessage "report_shell_state $surfaceId $sequence $State"');
    expect(script).toContain('Send-WmuxMessage "report_command $surfaceId $sequence $flat"');
  });

  it('recognizes exact PowerShell ssh executable tokens in every supported path form', () => {
    const script = fs.readFileSync(POWERSHELL_INTEGRATION, 'utf8');
    const pattern = /\$line -notmatch '([^']+)'/.exec(script)?.[1];
    expect(pattern).toBeTruthy();
    const isSshCommand = (line: string) => new RegExp(pattern!, 'i').test(line);

    expect(isSshCommand('ssh user@host')).toBe(true);
    expect(isSshCommand('C:\\Windows\\System32\\OpenSSH\\ssh.exe user@host')).toBe(true);
    expect(isSshCommand('"C:\\Program Files\\OpenSSH\\ssh.exe" user@host')).toBe(true);
    expect(isSshCommand('& "C:\\Program Files\\OpenSSH\\ssh.exe" user@host')).toBe(true);
    expect(isSshCommand('& "ssh" user@host')).toBe(true);
    expect(isSshCommand('"ssh" user@host')).toBe(false);
    expect(isSshCommand('myssh.exe user@host')).toBe(false);
    expect(isSshCommand('Write-Output ssh user@host')).toBe(false);
  });
});
