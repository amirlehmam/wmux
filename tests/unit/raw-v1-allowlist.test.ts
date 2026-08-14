import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { RAW_V1_VERBS, rawV1Error } from '../../src/cli/wmux';

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
    // args[1] is the verb; the surface id and payload follow as separate argv
    // entries, so a path with spaces cannot turn a good verb into a bad one.
    expect(rawV1Error('report_pwd')).toBeNull();
    // ...and a verb cannot be smuggled in by gluing it to another one.
    expect(rawV1Error('report_pwd notify')).toMatch(/not a passthrough command/);
  });

  it('is the six verbs and no more', () => {
    expect([...RAW_V1_VERBS].sort()).toEqual([
      'clear_git_branch',
      'ports_kick',
      'report_git_branch',
      'report_pwd',
      'report_shell_state',
      'report_startup_command',
    ]);
  });
});
