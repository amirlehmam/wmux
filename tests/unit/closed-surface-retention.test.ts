// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Issue #385: renderer memory that closing workspaces never gave back.
 *
 * useTerminal keeps several maps keyed by surface id at module level. The
 * PTY-exit handler cleared two of them, but a CLOSED pane never runs that
 * handler: the close unmounts the terminal, which unsubscribes from the PTY,
 * before main reports the exit of the PTY the close just killed. So every
 * terminal ever opened left an entry in each map for the life of the window.
 * forgetClosedTerminal is called from the close chokepoint and must leave
 * nothing behind.
 */

// xterm's CSS import has no meaning under Node.
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

import {
  __seedTerminalState,
  __terminalStateEntries,
  forgetClosedTerminal,
} from '../../src/renderer/hooks/useTerminal';

afterEach(() => {
  vi.useRealTimers();
});

describe('forgetClosedTerminal (#385)', () => {
  it('drops every per-surface entry a terminal left behind', () => {
    vi.useFakeTimers();
    const id = 'surf-closed-1';
    __seedTerminalState(id);
    // Seeding must actually reach every map, or the assertion below is vacuous.
    expect(__terminalStateEntries(id).sort()).toEqual(
      ['mouseModes', 'notices', 'outputSeq', 'title', 'titleFlush', 'touch', 'wheel'],
    );

    forgetClosedTerminal(id);

    expect(__terminalStateEntries(id)).toEqual([]);
  });

  it('leaves other surfaces alone', () => {
    vi.useFakeTimers();
    __seedTerminalState('surf-keep');
    __seedTerminalState('surf-gone');

    forgetClosedTerminal('surf-gone');

    expect(__terminalStateEntries('surf-keep').length).toBe(7);
    forgetClosedTerminal('surf-keep');
  });

  it('does not grow with the number of surfaces opened and closed', () => {
    vi.useFakeTimers();
    for (let i = 0; i < 500; i++) {
      const id = `surf-churn-${i}`;
      __seedTerminalState(id);
      forgetClosedTerminal(id);
    }
    for (let i = 0; i < 500; i++) expect(__terminalStateEntries(`surf-churn-${i}`)).toEqual([]);
  });
});

describe('close-path wiring (#385)', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../src/renderer', rel), 'utf8');

  it('the surface-closed handler forgets the terminal maps and the per-surface turn/shell state', () => {
    const app = read('App.tsx');
    const start = app.indexOf('document.addEventListener(SURFACE_CLOSED_EVENT, handler)');
    const handler = app.slice(app.lastIndexOf('const handler', start), start);
    expect(handler).toMatch(/forgetClosedTerminal\(surfaceId\)/);
    expect(handler).toMatch(/forgetProgressTurn\(surfaceId\)/);
    expect(handler).toMatch(/forgetSurfaceShellState\(surfaceId\)/);
    expect(handler).toMatch(/setClaudeActivity\(/);
  });

  it('a terminal torn down while pty.has() is in flight never attaches PTY listeners', () => {
    // Attaching after cleanup ran registers onData/onExit listeners nothing will
    // ever remove, each holding the disposed terminal and its whole buffer.
    expect(read('hooks/useTerminal.ts')).toContain('signal: preparation.signal, isCurrent');
    expect(read('utils/terminal-history.ts')).toMatch(
      /const exists = options\.has \? await options\.has\(\) : false;\s*if \(!current\(\)\) return;/,
    );
  });
});
