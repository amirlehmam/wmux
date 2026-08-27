import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import {
  createPromptSlice,
  normalizePromptText,
  promptSummary,
  nextPromptSeq,
  MAX_PROMPT_TEXT,
  MAX_PROMPTS_PER_SURFACE,
  MAX_TRACKED_SURFACES,
  type PromptSlice,
  type PromptEntry,
} from '../../src/renderer/store/prompt-slice';

const useTestStore = create<PromptSlice>()((...args) => ({ ...createPromptSlice(...args) }));

let clock = 1_000_000;
const entry = (surfaceId: string, seq: number, over: Partial<PromptEntry> = {}): PromptEntry => ({
  id: `${surfaceId}:${seq}`,
  surfaceId,
  seq,
  text: `prompt ${seq}`,
  source: 'agent',
  at: clock++,
  line: 10 + seq,
  rows: 1,
  ...over,
});

beforeEach(() => {
  clock = 1_000_000;
  useTestStore.setState({ prompts: {}, promptOutlineSurface: null, pinnedPrompts: {} });
});

describe('normalizePromptText', () => {
  it('caps length so a pasted file cannot be held per pane', () => {
    expect(normalizePromptText('x'.repeat(MAX_PROMPT_TEXT + 500))).toHaveLength(MAX_PROMPT_TEXT);
  });

  it('normalises CRLF before slicing, so the cap is not spent on carriage returns', () => {
    expect(normalizePromptText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('answers empty for anything that is not a string', () => {
    expect(normalizePromptText(undefined)).toBe('');
    expect(normalizePromptText(null)).toBe('');
    expect(normalizePromptText(42)).toBe('');
  });
});

describe('promptSummary', () => {
  it('takes the first NON-EMPTY line', () => {
    expect(promptSummary('\n\n   \nreal content\nmore')).toBe('real content');
  });

  it('ellipsises past the limit', () => {
    expect(promptSummary('abcdefghij', 5)).toBe('abcd…');
  });

  it('answers empty for an all-blank prompt rather than throwing', () => {
    expect(promptSummary('   \n\t\n')).toBe('');
  });
});

describe('nextPromptSeq', () => {
  it('starts at 1 and continues from the newest entry', () => {
    expect(nextPromptSeq(undefined)).toBe(1);
    expect(nextPromptSeq([])).toBe(1);
    expect(nextPromptSeq([entry('s', 1), entry('s', 7)])).toBe(8);
  });
});

describe('recordPrompt', () => {
  it('appends per surface, keeping surfaces independent', () => {
    useTestStore.getState().recordPrompt(entry('surf-a', 1));
    useTestStore.getState().recordPrompt(entry('surf-b', 1));
    useTestStore.getState().recordPrompt(entry('surf-a', 2));
    expect(useTestStore.getState().prompts['surf-a'].map((e) => e.seq)).toEqual([1, 2]);
    expect(useTestStore.getState().prompts['surf-b'].map((e) => e.seq)).toEqual([1]);
  });

  it('evicts the oldest prompts past the per-surface cap', () => {
    for (let i = 1; i <= MAX_PROMPTS_PER_SURFACE + 5; i++) {
      useTestStore.getState().recordPrompt(entry('surf-a', i));
    }
    const list = useTestStore.getState().prompts['surf-a'];
    expect(list).toHaveLength(MAX_PROMPTS_PER_SURFACE);
    expect(list[0].seq).toBe(6);
    expect(list[list.length - 1].seq).toBe(MAX_PROMPTS_PER_SURFACE + 5);
  });

  // The teardown path is best-effort — a crashed renderer reaches none of it —
  // so the map has to bound itself the way surfaceBufferCache does.
  it('drops the least-recently-written surfaces past the surface cap', () => {
    for (let i = 0; i < MAX_TRACKED_SURFACES + 3; i++) {
      useTestStore.getState().recordPrompt(entry(`surf-${i}`, 1));
    }
    const tracked = Object.keys(useTestStore.getState().prompts);
    expect(tracked).toHaveLength(MAX_TRACKED_SURFACES);
    expect(tracked).not.toContain('surf-0');
    expect(tracked).toContain(`surf-${MAX_TRACKED_SURFACES + 2}`);
  });
});

describe('updatePrompt', () => {
  it('patches an entry in place', () => {
    useTestStore.getState().recordPrompt(entry('surf-a', 1, { line: null }));
    useTestStore.getState().updatePrompt('surf-a', 'surf-a:1', { line: 42, text: 'refined' });
    expect(useTestStore.getState().prompts['surf-a'][0]).toMatchObject({ line: 42, text: 'refined' });
  });

  it('is a no-op for an unknown surface or id', () => {
    useTestStore.getState().recordPrompt(entry('surf-a', 1));
    const before = useTestStore.getState().prompts;
    useTestStore.getState().updatePrompt('surf-z', 'surf-z:1', { line: 9 });
    useTestStore.getState().updatePrompt('surf-a', 'surf-a:99', { line: 9 });
    expect(useTestStore.getState().prompts).toBe(before);
  });

  // A hand-pin holds its OWN copy so it can outlive eviction — which is exactly
  // why it would otherwise keep a stale line and jump to the wrong place.
  it('keeps a hand-pinned copy of the same entry in sync', () => {
    const e = entry('surf-a', 1, { line: null });
    useTestStore.getState().recordPrompt(e);
    useTestStore.getState().setPinnedPrompt('surf-a', e);
    useTestStore.getState().updatePrompt('surf-a', 'surf-a:1', { line: 77 });
    expect(useTestStore.getState().pinnedPrompts['surf-a']?.line).toBe(77);
  });

  // The case the pin exists FOR. `pinnedPrompts` keeps its own copy so a pin can
  // outlive eviction from the ring — so "the ring no longer has it" is exactly
  // when the pin most needs correcting, not a reason to skip it.
  it('patches a hand-pinned entry that has been evicted from the ring', () => {
    const pinnedEntry = entry('surf-a', 1);
    useTestStore.getState().setPinnedPrompt('surf-a', pinnedEntry);
    for (let i = 2; i <= MAX_PROMPTS_PER_SURFACE + 2; i++) {
      useTestStore.getState().recordPrompt(entry('surf-a', i));
    }
    expect(useTestStore.getState().prompts['surf-a'].some((e) => e.id === 'surf-a:1')).toBe(false);

    useTestStore.getState().updatePrompt('surf-a', 'surf-a:1', { line: null });
    expect(useTestStore.getState().pinnedPrompts['surf-a']?.line).toBeNull();
  });

  it('leaves a pin pointing at a DIFFERENT entry alone', () => {
    const first = entry('surf-a', 1);
    const second = entry('surf-a', 2);
    useTestStore.getState().recordPrompt(first);
    useTestStore.getState().recordPrompt(second);
    useTestStore.getState().setPinnedPrompt('surf-a', first);
    useTestStore.getState().updatePrompt('surf-a', 'surf-a:2', { line: 77 });
    expect(useTestStore.getState().pinnedPrompts['surf-a']?.line).toBe(first.line);
  });
});

describe('clearPromptsForSurface', () => {
  it('drops prompts, the pin, and an outline open on that surface', () => {
    useTestStore.getState().recordPrompt(entry('surf-a', 1));
    useTestStore.getState().setPinnedPrompt('surf-a', entry('surf-a', 1));
    useTestStore.getState().setPromptOutlineSurface('surf-a');
    useTestStore.getState().clearPromptsForSurface('surf-a');
    expect(useTestStore.getState().prompts['surf-a']).toBeUndefined();
    expect(useTestStore.getState().pinnedPrompts['surf-a']).toBeUndefined();
    expect(useTestStore.getState().promptOutlineSurface).toBeNull();
  });

  it('leaves an outline open on ANOTHER surface alone', () => {
    useTestStore.getState().recordPrompt(entry('surf-a', 1));
    useTestStore.getState().setPromptOutlineSurface('surf-b');
    useTestStore.getState().clearPromptsForSurface('surf-a');
    expect(useTestStore.getState().promptOutlineSurface).toBe('surf-b');
  });

  it('does not churn state for a surface it never knew', () => {
    const before = useTestStore.getState().prompts;
    useTestStore.getState().clearPromptsForSurface('surf-never');
    expect(useTestStore.getState().prompts).toBe(before);
  });
});
