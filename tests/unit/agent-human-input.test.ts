/**
 * The human answered in the pane (issue #151).
 *
 * Claude Code's hooks have one blind spot: a permission prompt fires
 * `Notification`, the user approves it, and the approved tool then runs for
 * minutes with NO hook in between — `PreToolUse` already ran before the prompt,
 * `PostToolUse` only fires at the end. The pane kept saying "Needs you" long
 * after it had been answered, which is what makes a user stop reading the
 * sidebar and start clicking through tabs instead.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

import {
  reportAgent,
  noteHumanInput,
  isAnsweringInput,
  getAgentState,
  resetAgentState,
} from '../../src/main/agent-state';
import type { SurfaceId } from '../../src/shared/types';

const SID = 'surf-input' as SurfaceId;
const ESC = '';

beforeEach(() => resetAgentState());

const block = () =>
  reportAgent(SID, {
    awaitingHuman: true,
    reason: 'permission to use Bash',
    choices: [{ id: 'allow', label: 'Allow', key: '1' }],
  });

describe('isAnsweringInput', () => {
  it('treats typing, Enter, Escape and edits as answering', () => {
    expect(isAnsweringInput('\r')).toBe(true);
    expect(isAnsweringInput('\n')).toBe(true);
    expect(isAnsweringInput('2')).toBe(true);
    expect(isAnsweringInput('yes')).toBe(true);
    expect(isAnsweringInput(ESC)).toBe(true);
    expect(isAnsweringInput('')).toBe(true);
    expect(isAnsweringInput('\t')).toBe(true);
    expect(isAnsweringInput('café')).toBe(true);
  });

  it('does NOT treat reading the pane as answering it', () => {
    // Being sent to a pane and scrolling to see what it wants is the normal
    // first move. Counting that as a reply would clear the very flag that put
    // the user there.
    expect(isAnsweringInput(`${ESC}[A`)).toBe(false);          // up
    expect(isAnsweringInput(`${ESC}[B${ESC}[B`)).toBe(false);  // down, twice
    expect(isAnsweringInput(`${ESC}[5~`)).toBe(false);         // page up
    expect(isAnsweringInput(`${ESC}OP`)).toBe(false);          // F1 (SS3)
    expect(isAnsweringInput(`${ESC}[<0;12;5M`)).toBe(false);   // mouse report
    expect(isAnsweringInput('')).toBe(false);
  });

  it('sees the keystroke that follows navigation', () => {
    // Arrow down to "Yes, allow", then Enter — one chunk, and the Enter is what
    // matters.
    expect(isAnsweringInput(`${ESC}[B\r`)).toBe(true);
  });
});

describe('noteHumanInput', () => {
  it('clears a block when the human types the answer themselves', () => {
    block();
    expect(getAgentState(SID)?.state).toBe('blocked');

    expect(noteHumanInput(SID, '1')).toBe(true);
    expect(getAgentState(SID)).toMatchObject({ state: 'idle', blockedReason: null, choices: [] });
  });

  it('leaves the block alone while the user is only looking', () => {
    block();
    expect(noteHumanInput(SID, `${ESC}[A`)).toBe(false);
    expect(getAgentState(SID)?.state).toBe('blocked');
  });

  it('does nothing to a pane that is not asking anything', () => {
    reportAgent(SID, { awaitingHuman: false, runDepth: 1 });
    expect(noteHumanInput(SID, 'ls -la\r')).toBe(false);
    expect(getAgentState(SID)?.state).toBe('working');
  });

  it('does nothing for a surface nothing has ever reported for', () => {
    expect(noteHumanInput('surf-nobody' as SurfaceId, '\r')).toBe(false);
    expect(getAgentState('surf-nobody' as SurfaceId)).toBeUndefined();
  });

  it('the agent still has the last word', () => {
    // Clearing early is the bounded, self-healing direction: if the keystroke
    // did not satisfy the agent, its next report — a tool, a turn end, or the
    // 60s idle nudge — puts the pane straight back to asking.
    block();
    noteHumanInput(SID, '\r');
    reportAgent(SID, { awaitingHuman: true, reason: 'still waiting' });
    expect(getAgentState(SID)).toMatchObject({ state: 'blocked', blockedReason: 'still waiting' });
  });
});

describe('Escape interrupts a run (issue #151)', () => {
  beforeEach(() => resetAgentState());

  it('retracts a run the user cancelled', () => {
    // Claude Code fires NO hook on interrupt — measured directly, `updatedAt`
    // is identical before and after. Without this the pane keeps claiming
    // `working` for a turn that is over, until the next prompt or the 15-minute
    // trust window.
    reportAgent(SID, { awaitingHuman: false, runDepth: 1 });
    expect(noteHumanInput(SID, '')).toBe(true);
    expect(getAgentState(SID)?.state).toBe('idle');
  });

  it('escaping a permission prompt clears the prompt with the run', () => {
    reportAgent(SID, { awaitingHuman: true, reason: 'permission to use Bash', runDepth: 1 });
    noteHumanInput(SID, '');
    expect(getAgentState(SID)).toMatchObject({ state: 'idle', blockedReason: null, choices: [] });
  });

  it('an arrow key is not an interrupt', () => {
    // Being sent to a pane and scrolling to see what it wants is the normal
    // first move; it must not retract the run that sent you there.
    reportAgent(SID, { awaitingHuman: false, runDepth: 1 });
    expect(noteHumanInput(SID, '[A')).toBe(false);
    expect(getAgentState(SID)?.state).toBe('working');
  });

  it('Alt+key is not an interrupt', () => {
    // Alt+b arrives as ESC followed by a character, which is why the test is an
    // exact match on the single byte rather than isAnsweringInput's "contains a
    // bare ESC".
    reportAgent(SID, { awaitingHuman: false, runDepth: 1 });
    expect(noteHumanInput(SID, 'b')).toBe(false);
    expect(getAgentState(SID)?.state).toBe('working');
  });

  it('leaves a plain shell alone', () => {
    expect(noteHumanInput('surf-shell' as SurfaceId, '')).toBe(false);
    expect(getAgentState('surf-shell' as SurfaceId)).toBeUndefined();
  });

  it('never asserts anything — an idle pane stays idle', () => {
    reportAgent(SID, { awaitingHuman: false, runDepth: 0 });
    expect(noteHumanInput(SID, '')).toBe(false);
    expect(getAgentState(SID)?.state).toBe('idle');
  });
});
