import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { createPromptSlice, type PromptSlice, type PromptEntry } from '../../src/renderer/store/prompt-slice';

/**
 * Which terminal a `prompts` PANE lists (issue #207 follow-up).
 *
 * The overlay never had to answer this — it is rendered by the pane whose
 * prompts it shows. A panel lives elsewhere in the split tree, so the answer is
 * store state, and the ways it goes wrong are all "the panel shows the wrong
 * thing, or nothing, and says otherwise".
 */
const useTestStore = create<PromptSlice>()((...args) => ({ ...createPromptSlice(...args) }));

const entry = (surfaceId: string, seq: number): PromptEntry => ({
  id: `${surfaceId}:${seq}`,
  surfaceId,
  seq,
  text: `prompt ${seq}`,
  source: 'agent',
  at: 1_000_000 + seq,
  line: 10 + seq,
  rows: 1,
});

beforeEach(() => {
  useTestStore.setState({
    prompts: {},
    promptOutlineSurface: null,
    pinnedPrompts: {},
    promptSourceSurface: null,
    promptPaneLocks: {},
  });
});

describe('promptSourceSurface', () => {
  it('records the terminal a panel should follow', () => {
    useTestStore.getState().setPromptSourceSurface('surf-term');
    expect(useTestStore.getState().promptSourceSurface).toBe('surf-term');
  });

  /**
   * The writer is a focus effect that re-runs on every split-tree edit. A store
   * write with an unchanged value re-renders every subscriber — the shape of the
   * over-invalidation in issue #141 — so the no-op has to be in the setter, not
   * left to each caller to remember.
   */
  it('does not replace state when the value has not changed', () => {
    useTestStore.getState().recordPrompt(entry('surf-term', 1));
    useTestStore.getState().setPromptSourceSurface('surf-term');
    const before = useTestStore.getState();

    useTestStore.getState().setPromptSourceSurface('surf-term');

    // Zustand always hands back a fresh top-level object, so identity there
    // proves nothing. What a selector actually subscribes to is the sub-object,
    // and THAT must survive untouched.
    expect(useTestStore.getState().prompts).toBe(before.prompts);
    expect(useTestStore.getState().promptSourceSurface).toBe('surf-term');
  });

  it('forgets a source surface that goes away', () => {
    useTestStore.getState().setPromptSourceSurface('surf-term');
    useTestStore.getState().clearPromptsForSurface('surf-term');
    expect(useTestStore.getState().promptSourceSurface).toBeNull();
  });
});

describe('promptPaneLocks', () => {
  it('pins a panel to one terminal and releases it again', () => {
    useTestStore.getState().setPromptPaneLock('surf-panel', 'surf-a');
    expect(useTestStore.getState().promptPaneLocks['surf-panel']).toBe('surf-a');

    useTestStore.getState().setPromptPaneLock('surf-panel', null);
    expect(useTestStore.getState().promptPaneLocks).not.toHaveProperty('surf-panel');
  });

  /**
   * Both directions, because a lock names two surfaces and either can die first.
   * A lock surviving its TARGET is the nastier one: the panel then shows an empty
   * list while its own button insists it is following something.
   */
  it('drops a lock when the terminal it points at goes away', () => {
    useTestStore.getState().setPromptPaneLock('surf-panel', 'surf-a');
    useTestStore.getState().clearPromptsForSurface('surf-a');
    expect(useTestStore.getState().promptPaneLocks).not.toHaveProperty('surf-panel');
  });

  it('drops a lock when the panel holding it goes away', () => {
    useTestStore.getState().setPromptPaneLock('surf-panel', 'surf-a');
    useTestStore.getState().clearPromptsForSurface('surf-panel');
    expect(useTestStore.getState().promptPaneLocks).not.toHaveProperty('surf-panel');
  });

  it('leaves the locks held by other panels alone', () => {
    useTestStore.getState().setPromptPaneLock('surf-panel-1', 'surf-a');
    useTestStore.getState().setPromptPaneLock('surf-panel-2', 'surf-b');
    useTestStore.getState().clearPromptsForSurface('surf-a');
    expect(useTestStore.getState().promptPaneLocks).toEqual({ 'surf-panel-2': 'surf-b' });
  });

  /**
   * The early return in clearPromptsForSurface is an optimisation, and an
   * optimisation that skips the lock sweep is the bug it is trying to avoid.
   */
  it('still sweeps locks for a surface that recorded no prompts', () => {
    useTestStore.getState().setPromptPaneLock('surf-panel', 'surf-never-typed');
    useTestStore.getState().clearPromptsForSurface('surf-never-typed');
    expect(useTestStore.getState().promptPaneLocks).not.toHaveProperty('surf-panel');
  });

  it('leaves everything alone for a surface nothing refers to', () => {
    useTestStore.getState().recordPrompt(entry('surf-a', 1));
    useTestStore.getState().setPromptPaneLock('surf-panel', 'surf-a');
    const before = useTestStore.getState();

    useTestStore.getState().clearPromptsForSurface('surf-unrelated');

    expect(useTestStore.getState().prompts).toBe(before.prompts);
    expect(useTestStore.getState().promptPaneLocks).toBe(before.promptPaneLocks);
    expect(useTestStore.getState().pinnedPrompts).toBe(before.pinnedPrompts);
  });
});
