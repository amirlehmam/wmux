import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';

vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\fake\\userData' },
  BrowserWindow: { getAllWindows: () => [] },
}));

import {
  explainFile,
  explainSurface,
  setDetection,
  getDetection,
  listDetections,
  forgetDetection,
  resetDetectionStore,
} from '../../src/main/detection-store';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'detection');
const fixture = (name: string) => path.join(FIXTURES, `${name}.txt`);

beforeEach(() => resetDetectionStore());

/**
 * The offline half of `wmux detect explain`, and the reason it exists: it
 * replays a captured screen through the same engine with no running detection
 * and without the agent installed. That is how a rule regression gets debugged
 * from a `wmux read-screen` capture — and how the bundled Codex and OpenCode
 * manifests were authored, on a machine where neither could reach a live turn.
 */
describe('explainFile', () => {
  it('replays a captured working screen and names the rule that fired', () => {
    const out = explainFile(fixture('claude-working'));
    expect(out).toMatchObject({
      agent: 'claude', state: 'working', ruleId: 'claude.working.spinner', reason: 'matched',
      manifestSource: 'bundled',
    });
    expect(out.evidence.join('\n')).toContain('Unravelling');
    expect(out.manifestVersion).toBe(1);
  });

  it('replays a captured idle screen', () => {
    expect(explainFile(fixture('claude-idle'))).toMatchObject({
      agent: 'claude', state: 'idle', ruleId: 'claude.idle.prompt',
    });
  });

  it('honours --agent for a screen that carries no chrome of its own', () => {
    expect(explainFile(fixture('codex-blocked-update'), 'codex')).toMatchObject({
      agent: 'codex', state: 'blocked', ruleId: 'codex.blocked.menu',
    });
    // Without it, the same screen is genuinely unidentifiable.
    expect(explainFile(fixture('codex-blocked-update'))).toMatchObject({
      agent: null, reason: 'no-agent-signature',
    });
  });

  it('says so plainly for a plain shell', () => {
    expect(explainFile(fixture('plain-shell'))).toMatchObject({
      agent: null, state: 'unknown', reason: 'no-agent-signature',
    });
  });

  /** A debugging command must not need a working path to be useful. */
  it('reports an unreadable file rather than throwing', () => {
    const out = explainFile(path.join(FIXTURES, 'does-not-exist.txt'));
    expect(out.state).toBe('unknown');
    expect(out.reason).toContain('unreadable');
  });

  it('always reports where overrides go, so "where do I put my file?" is answered', () => {
    expect(explainFile(fixture('claude-idle')).manifestDir).toContain('agent-detection');
  });
});

describe('explainSurface', () => {
  it('reports what the renderer last decided, not a fresh scan', () => {
    setDetection('surf-1', {
      agent: 'claude', state: 'blocked', ruleId: 'claude.blocked.permission',
      reason: 'matched', manifestVersion: 1, evidence: ['Do you want to proceed?'],
    });
    expect(explainSurface('surf-1')).toMatchObject({
      surfaceId: 'surf-1', agent: 'claude', state: 'blocked', manifestSource: 'bundled',
    });
  });

  /** A surface the loop never reached is different from one it read as nothing. */
  it('distinguishes "never scanned" from "scanned and found nothing"', () => {
    expect(explainSurface('surf-never')).toMatchObject({
      state: 'unknown', reason: 'not-scanned', agent: null,
    });
  });
});

describe('the mirror', () => {
  const result = {
    agent: 'claude' as const, state: 'idle' as const, ruleId: 'claude.idle.prompt',
    reason: 'matched' as const, manifestVersion: 1, evidence: [],
  };

  it('stores, lists and forgets', () => {
    setDetection('surf-1', result);
    expect(getDetection('surf-1')?.state).toBe('idle');
    expect(listDetections()).toEqual([{ surfaceId: 'surf-1', ...result }]);

    forgetDetection('surf-1');
    expect(getDetection('surf-1')).toBeUndefined();
    expect(listDetections()).toEqual([]);
  });

  it('a null result drops the entry', () => {
    setDetection('surf-1', result);
    setDetection('surf-1', null);
    expect(getDetection('surf-1')).toBeUndefined();
  });

  /** Same bound, and the same reason, as agent-state.ts's record map. */
  it('is bounded — a hostile or buggy reporter cannot grow it without limit', () => {
    for (let i = 0; i < 400; i++) setDetection(`surf-${i}`, result);
    expect(listDetections().length).toBeLessThanOrEqual(256);
    // The newest survive; the oldest were evicted.
    expect(getDetection('surf-399')).toBeDefined();
    expect(getDetection('surf-0')).toBeUndefined();
  });
});
