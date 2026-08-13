import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { browserRequest, timeoutMessage } from '../../src/cli/wmux';

/**
 * `wmux browser open <url>` failed with a bare `Error: timeout` after ~5s on any
 * page that took longer than that to load — while the navigation itself went on
 * to succeed. The CLI applied one flat 5s deadline to every V2 method, but the
 * main process is allowed to spend far more than that serving a browser command:
 * cdp-bridge's navigate() waits 30s for did-finish-load and wait() polls for 10s,
 * and before either runs v2-browser may split a pane and poll 5s for CDP.
 *
 * So the client deadline was shorter than the server's own budget. Two things
 * followed, and the second is the worse one:
 *
 *   1. A command that succeeded late was reported as a failure.
 *   2. The server's real diagnosis ('Could not open browser panel',
 *      'browser_not_open', 'ref_not_found: …') could never reach the user,
 *      because it arrived after the CLI had already hung up. A bare `timeout`
 *      was the only thing left, which reads like a broken install.
 *
 * The deadlines below are therefore not free-floating numbers — each one has to
 * clear the corresponding main-process budget. These tests read those budgets
 * out of the main-process source rather than restating them, so raising a
 * default in cdp-bridge.ts fails here instead of quietly reintroducing the bug.
 */

const SRC = path.join(__dirname, '..', '..', 'src', 'main');
const cdpBridge = fs.readFileSync(path.join(SRC, 'cdp-bridge.ts'), 'utf-8');
const v2Browser = fs.readFileSync(path.join(SRC, 'v2-browser.ts'), 'utf-8');

/** Pull a `timeout = <ms>` default off a method signature in cdp-bridge.ts. */
function cdpDefault(method: string): number {
  const match = cdpBridge.match(new RegExp(`async ${method}\\([^)]*timeout = (\\d+)`));
  if (!match) throw new Error(`no timeout default found for cdp-bridge ${method}()`);
  return Number(match[1]);
}

/** The longest wait v2-browser can spend readying a browser before the verb runs. */
function browserReadyBudget(): number {
  const waits = [...v2Browser.matchAll(/(?:Date\.now\(\) \+ |pollSurfaceWcId\([^,]+,\s*)(\d+)/g)]
    .map((m) => Number(m[1]));
  if (waits.length === 0) throw new Error('no readiness budget found in v2-browser.ts');
  return Math.max(...waits);
}

const deadlineOf = (argv: string[]): number => {
  const req = browserRequest(argv);
  if (!req) throw new Error(`unknown browser verb: ${argv[1]}`);
  return req.timeoutMs;
};

// Every verb the CLI exposes, as `wmux browser …` argv.
const VERBS: string[][] = [
  ['browser', 'open', 'https://example.com'],
  ['browser', 'snapshot'],
  ['browser', 'click', 'e5'],
  ['browser', 'type', 'e5', 'hello'],
  ['browser', 'fill', 'e5', 'value'],
  ['browser', 'screenshot'],
  ['browser', 'get-text'],
  ['browser', 'eval', '1+1'],
  ['browser', 'wait', 'e5'],
  ['browser', 'back'],
  ['browser', 'forward'],
  ['browser', 'reload'],
];

describe('browser command deadlines outlast the main process', () => {
  it('finds the budgets it is meant to be checking', () => {
    // Guards the guard: a refactor that renames these would make the
    // comparisons below vacuously pass against a default of 0.
    expect(cdpDefault('navigate')).toBeGreaterThan(0);
    expect(cdpDefault('wait')).toBeGreaterThan(0);
    expect(browserReadyBudget()).toBeGreaterThan(0);
  });

  // The reported symptom, in one assertion: a page slower than the CLI deadline
  // but faster than the server's is exactly the window where `browser open`
  // printed `timeout` for a navigation that worked.
  it('waits out a full-length navigation instead of quitting mid-load', () => {
    expect(deadlineOf(['browser', 'open', 'https://example.com'])).toBeGreaterThan(cdpDefault('navigate'));
  });

  it('waits out a ref poll that runs its default course', () => {
    expect(deadlineOf(['browser', 'wait', 'e5'])).toBeGreaterThan(cdpDefault('wait'));
  });

  // `browser wait e5 20000` asks the server for a 20s poll. A client deadline
  // pinned to the 10s default would cut off the very wait the user requested.
  it('honours an explicit wait budget rather than its own default', () => {
    expect(deadlineOf(['browser', 'wait', 'e5', '20000'])).toBeGreaterThan(20000);
  });

  // Readying a browser happens before *any* verb runs, so no verb — not even
  // `back` — can be given a deadline that expires during it.
  it('leaves room for a cold browser bring-up on every verb', () => {
    const ready = browserReadyBudget();
    for (const argv of VERBS) {
      expect(deadlineOf(argv), `${argv[1]} deadline`).toBeGreaterThan(ready);
    }
  });

  it('covers every verb the CLI dispatches', () => {
    // Keeps the sweep above honest: a subcommand added to BROWSER_CMDS without a
    // deadline opinion would otherwise never be measured by it.
    const cli = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'cli', 'wmux.ts'), 'utf-8');
    const start = cli.indexOf('const BROWSER_CMDS');
    const end = cli.indexOf('export function browserRequest');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const dispatched = [...cli.slice(start, end).matchAll(/^ {2}'?([a-z-]+)'?:/gm)].map((m) => m[1]);

    expect(new Set(dispatched)).toEqual(new Set(VERBS.map((argv) => argv[1])));
  });

  it('rejects an unknown verb instead of guessing a deadline', () => {
    expect(browserRequest(['browser', 'teleport'])).toBeNull();
  });
});

describe('--surface targets a browser from outside a pane', () => {
  // The rest of the CLI already takes --surface (send, read-screen,
  // agent-activity, report-agent). Browser commands only ever read
  // $WMUX_SURFACE_ID, so a shell wmux did not spawn had no way to say which
  // pane's browser it meant.
  it('sends the surface as the caller the isolation routing expects', () => {
    const req = browserRequest(['browser', 'snapshot'], 'surf-abc');
    expect(req?.params.caller).toBe('surf-abc');
  });

  it('omits caller entirely when there is none, preserving the legacy path', () => {
    // Not `caller: undefined` — sendV2 fills that field from the environment,
    // and the main process treats absent-caller as "use the shared browser".
    const req = browserRequest(['browser', 'snapshot']);
    expect(req?.params).not.toHaveProperty('caller');
  });

  it('keeps the flag out of the text it types into the page', () => {
    // `browser type e5 --surface surf-x hello world` must type "hello world".
    // cmdBrowser strips the flag before the verb reads its positional args;
    // this pins the joined-text behaviour that strip protects.
    const req = browserRequest(['browser', 'type', 'e5', 'hello', 'world'], 'surf-x');
    expect(req?.params.text).toBe('hello world');
    expect(req?.params.caller).toBe('surf-x');
  });
});

describe('the timeout message', () => {
  // A bare 'timeout' named neither what stalled nor how long we waited, so a
  // slow command and a broken install produced identical output.
  it('names the method and the deadline it actually waited', () => {
    const message = timeoutMessage('browser.navigate', 40000);
    expect(message).toContain('browser.navigate');
    expect(message).toContain('40000ms');
    expect(message).not.toBe('timeout');
  });

  it('says the command may have run, because it may have', () => {
    expect(timeoutMessage('browser.navigate', 40000).toLowerCase()).toContain('may still have completed');
  });
});
