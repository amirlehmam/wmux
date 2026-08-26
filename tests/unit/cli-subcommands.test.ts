import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { subcommandError, browserRequest } from '../../src/cli/wmux';

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

/**
 * Every handler is invoked as `handler(args)` where args[0] is the COMMAND
 * NAME — cmdAgent and cmdPane both read args[1] for their subcommand. `detect`
 * read args[0], so `wmux detect explain` rejected itself with "expected
 * `explain` or `reload`". Only running it found this; the unit tests exercised
 * the engine and the RPC, never the argv seam between them.
 */
describe('subcommand dispatch reads args[1], not args[0]', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'cli', 'wmux.ts'),
    'utf8',
  );

  it('the detect handler takes its subcommand from args[1]', () => {
    const body = source.slice(source.indexOf("'detect': async (args: string[])"));
    const handler = body.slice(0, body.indexOf('\n  },'));
    expect(handler).toContain('const sub = args[1]');
    expect(handler).not.toMatch(/const sub = args\[0\]/);
  });

  it('and slices its flags from index 2, so --file is not eaten as the subcommand', () => {
    const body = source.slice(source.indexOf("'detect': async (args: string[])"));
    const handler = body.slice(0, body.indexOf('\n  },'));
    expect(handler).toContain('args.slice(2)');
  });

  /** The convention this broke — kept honest for the next subcommand added. */
  it('matches how the other group commands dispatch', () => {
    expect(source).toMatch(/AGENT_CMDS\[args\[1\]\]/);
  });
});

/**
 * `wmux browser engine [web|agent] [--surface <id>]` — get or flip which
 * engine a browser surface runs on (Task 12). Unlike every other `browser`
 * subcommand, this one is two distinct V2 methods depending on whether a
 * value was given, and it validates that value client-side rather than
 * leaving a typo to round-trip to the server and back.
 */
describe('browser engine', () => {
  it('a bare "engine" asks the server what engine this surface is on', () => {
    const req = browserRequest(['browser', 'engine']);
    expect(req?.method).toBe('browser.get_engine');
    expect(req?.params).not.toHaveProperty('engine');
  });

  it('"engine agent" asks to switch to agent-browser', () => {
    const req = browserRequest(['browser', 'engine', 'agent']);
    expect(req?.method).toBe('browser.set_engine');
    expect(req?.params.engine).toBe('agent');
  });

  it('"engine web" asks to switch back to the built-in webview', () => {
    const req = browserRequest(['browser', 'engine', 'web']);
    expect(req?.method).toBe('browser.set_engine');
    expect(req?.params.engine).toBe('web');
  });

  it('carries --surface through as the caller, same as every other browser verb', () => {
    // cmdBrowser extracts --surface (or $WMUX_SURFACE_ID) and passes it into
    // browserRequest as `caller` — the same mechanism every other browser
    // subcommand already uses, so no extra CLI code was needed for this.
    const req = browserRequest(['browser', 'engine', 'web'], 'surf-1');
    expect(req?.method).toBe('browser.set_engine');
    expect(req?.params.engine).toBe('web');
    expect(req?.params.caller).toBe('surf-1');
  });

  it('rejects anything other than exactly "web" or "agent", naming both', () => {
    expect(() => browserRequest(['browser', 'engine', 'bogus'])).toThrow(/web/);
    expect(() => browserRequest(['browser', 'engine', 'bogus'])).toThrow(/agent/);
  });

  it('does not silently coerce a near-miss value', () => {
    // Case and whitespace variants must fail exactly like any other typo —
    // "Do not silently coerce" from the task spec, spelled out as a test.
    expect(() => browserRequest(['browser', 'engine', 'Web'])).toThrow();
    expect(() => browserRequest(['browser', 'engine', ' web'])).toThrow();
  });
});
