import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { subcommandError } from '../../src/cli/wmux';

/**
 * `wmux browser`, `wmux agent` and `wmux pane` with no subcommand printed the
 * literal word `undefined` (issue #156):
 *
 *     $ wmux browser
 *     Unknown browser command: undefined      (exit 1)
 *
 * Each dispatcher interpolated `args[1]` into its error without checking that
 * it existed, so a MISSING subcommand was reported as an UNKNOWN one named
 * `undefined`. `markdown` and `config`, in the same file, already fell back to
 * usage — and `wmux browser --help` cannot cover the gap, because `browser` is
 * passthrough and `--help` is text to send.
 *
 * The typed `failSubcommand(command: CommandName, …)` makes the other half of
 * the fix a compile-time guarantee rather than a test: the key must exist in
 * COMMAND_SPECS, and CommandSpec requires `usage`, so a group command cannot
 * reach this path without usage text to print.
 */
describe('group commands with no subcommand (issue #156)', () => {
  it('never reports a missing subcommand as one named "undefined"', () => {
    for (const command of ['browser', 'agent', 'pane', 'layout']) {
      expect(subcommandError(command, undefined)).not.toContain('undefined');
      expect(subcommandError(command, '')).not.toContain('undefined');
    }
  });

  it('says which command needs a subcommand, so the usage below it has context', () => {
    expect(subcommandError('browser', undefined)).toBe('wmux browser needs a subcommand.');
    expect(subcommandError('agent', undefined)).toBe('wmux agent needs a subcommand.');
  });

  it('still names the offending token when one was actually typed', () => {
    expect(subcommandError('browser', 'opne')).toBe('Unknown browser subcommand: opne');
    expect(subcommandError('pane', 'splt')).toBe('Unknown pane subcommand: splt');
  });

  // Derived, not restated: a fifth group command added tomorrow with the old
  // `console.error(\`Unknown x: ${args[1]}\`)` shape fails here rather than
  // shipping the same dead end.
  const cli = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'cli', 'wmux.ts'), 'utf-8');

  it('leaves no dispatcher interpolating an unchecked subcommand into its error', () => {
    const raw = [...cli.matchAll(/console\.error\(`Unknown [^`]*\$\{(args\[\d\]|sub|rest\[\d\])\}/g)]
      .map((m) => m[0]);
    expect(raw).toEqual([]);
  });

  it('routes every group command through the usage-printing failure', () => {
    for (const command of ['browser', 'agent', 'pane', 'layout']) {
      expect(cli).toContain(`failSubcommand('${command}'`);
    }
  });
});
