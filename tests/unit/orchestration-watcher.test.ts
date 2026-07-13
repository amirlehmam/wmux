import { describe, it, expect } from 'vitest';
import { isValidState } from '../../src/main/orchestration-watcher';

/**
 * state.json is written by the wmux-orchestrator plugin (or by an agent
 * hand-rolling the file), so the watcher treats it as untrusted input. A run
 * that reached the sidebar without an `id` threw during React's render, which
 * unmounts the whole tree and leaves a black window until wmux is restarted.
 */

const validState = {
  id: 'sixpack-prod',
  task: 'six-pack production readiness',
  status: 'running',
  startedAt: '2026-07-12T06:33:32Z',
  waves: [
    {
      index: 0,
      status: 'running',
      agents: [{ id: 'a', label: 'redis-hybrid-cache', status: 'running' }],
    },
  ],
};

describe('orchestration-watcher / isValidState', () => {
  it('accepts a well-formed run', () => {
    expect(isValidState(validState)).toBe(true);
  });

  it('accepts a run with no agents in a wave', () => {
    expect(isValidState({ ...validState, waves: [{ index: 0, status: 'pending', agents: [] }] })).toBe(true);
  });

  it('rejects the orchestrationId-instead-of-id shape that blanked the window', () => {
    const { id, ...rest } = validState;
    expect(isValidState({ ...rest, orchestrationId: id })).toBe(false);
  });

  it('rejects a missing or non-string id', () => {
    expect(isValidState({ ...validState, id: undefined })).toBe(false);
    expect(isValidState({ ...validState, id: '' })).toBe(false);
    expect(isValidState({ ...validState, id: 42 })).toBe(false);
  });

  it('rejects a missing status', () => {
    expect(isValidState({ ...validState, status: undefined })).toBe(false);
  });

  it('rejects waves that are absent or not an array', () => {
    expect(isValidState({ ...validState, waves: undefined })).toBe(false);
    expect(isValidState({ ...validState, waves: {} })).toBe(false);
  });

  it('rejects a wave missing its index or agents array', () => {
    expect(isValidState({ ...validState, waves: [{ status: 'running', agents: [] }] })).toBe(false);
    expect(isValidState({ ...validState, waves: [{ index: 0, status: 'running' }] })).toBe(false);
    expect(isValidState({ ...validState, waves: [null] })).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isValidState(null)).toBe(false);
    expect(isValidState(undefined)).toBe(false);
    expect(isValidState('running')).toBe(false);
    expect(isValidState([])).toBe(false);
  });
});
