import { describe, it, expect } from 'vitest';
import { isPinned, panClip, pinClip, reclip, UNCLIPPED } from '../../src/renderer/remote/vertical-clip';
import { canSubmit, composerLabel, initialComposer } from '../../src/renderer/remote/composer-state';
import { PRIMARY } from '../../src/renderer/remote/components/KeyBar';
import { controlsToggleKey } from '../../src/renderer/remote/screens/AttachScreen';

// Issue #265. The mirror keeps the desktop's rows and picks its font from the
// width, so the grid can be taller than the phone's box — and the box clipped
// the BOTTOM rows, where an agent keeps its input line. Measured in a real
// xterm 6 (60x40 at 13 px in a 355 px box): the last row's bottom sat 249 px
// below the box, and `scrollTop = scrollHeight - clientHeight` put it flush.
describe('vertical clip: the window over a grid taller than its box (#265)', () => {
  it('starts on the bottom rows the moment there is overflow', () => {
    expect(reclip(UNCLIPPED, 249)).toEqual({ offset: 249, max: 249 });
  });

  it('stays pinned when the box shrinks (the phone keyboard opens)', () => {
    const pinned = reclip(UNCLIPPED, 249);
    expect(reclip(pinned, 520)).toEqual({ offset: 520, max: 520 });
  });

  it('keeps a window the user dragged up where they left it', () => {
    const raised = { offset: 100, max: 249 };
    expect(reclip(raised, 520)).toEqual({ offset: 100, max: 520 });
    // ...unless the grid no longer overflows that far.
    expect(reclip(raised, 60)).toEqual({ offset: 60, max: 60 });
  });

  it('a grid that fits is never offset, whatever the DOM reports', () => {
    for (const max of [0, -4, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(reclip({ offset: 80, max: 80 }, max)).toEqual({ offset: 0, max: 0 });
    }
  });

  it('towards older content: the window slides up first, the rest goes to the scrollback', () => {
    const s = { offset: 100, max: 249 };
    expect(panClip(s, -40, true)).toEqual({ state: { offset: 60, max: 249 }, rest: 0 });
    expect(panClip(s, -130, true)).toEqual({ state: { offset: 0, max: 249 }, rest: -30 });
  });

  it('towards newer content: the scrollback returns to its bottom before the window moves', () => {
    const s = { offset: 100, max: 249 };
    const held = panClip(s, 50, false);
    expect(held.state).toBe(s);
    expect(held.rest).toBe(50);
    expect(panClip(s, 50, true)).toEqual({ state: { offset: 150, max: 249 }, rest: 0 });
    expect(panClip(s, 500, true).state).toEqual({ offset: 249, max: 249 });
  });

  it('with no overflow the whole delta is the scrollback\'s, unchanged', () => {
    const r = panClip(UNCLIPPED, -33, true);
    expect(r.state).toBe(UNCLIPPED);
    expect(r.rest).toBe(-33);
  });

  it('pinned is the bottom, with a pixel of rounding slack', () => {
    expect(isPinned({ offset: 248.4, max: 249 })).toBe(true);
    expect(isPinned({ offset: 200, max: 249 })).toBe(false);
    expect(pinClip({ offset: 3, max: 249 })).toEqual({ offset: 249, max: 249 });
  });
});

describe('the keys can be put away, the question cannot (#265)', () => {
  it('names the action the button will take', () => {
    expect(controlsToggleKey(true)).toBe('attach.hideKeys');
    expect(controlsToggleKey(false)).toBe('attach.showKeys');
  });
});

// Issue #266. A blocked agent showing an arrow-key menu: the composer button
// read "Insert" and was disabled (empty box), and Enter was the eighth key of
// a row that shows seven. The reporter confirmed menus by pressing Tab twice,
// which only worked because it knocked the agent out of `blocked`.
describe('a blocked agent with an empty box (#266)', () => {
  it('turns the composer button into Enter instead of a disabled Insert', () => {
    const empty = initialComposer('');
    expect(composerLabel(empty, true)).toBe('enter');
    // Still not a SUBMIT: the button is routed to the key bar's Enter, with its arming.
    expect(canSubmit(empty, true)).toBe(false);
  });

  it('is Insert again as soon as there is text, and Send when not blocked', () => {
    expect(composerLabel(initialComposer('yes'), true)).toBe('insert');
    expect(composerLabel(initialComposer(''), false)).toBe('send');
    expect(composerLabel({ ...initialComposer(''), phase: 'sending' }, true)).toBe('sending');
  });

  it('keeps Up, Down and Enter inside the part of the key row a 320 px phone shows', () => {
    const keys = PRIMARY.map((d) => d.key);
    // 320 px screen: 16 px stack padding, 48 px for the pinned ⋯ and its gap,
    // 24 px fade. Esc is 44+ px wide; the arrows and Enter are 44 px, 4 px gaps.
    const visible = keys.slice(0, 4);
    expect(visible).toEqual(['esc', 'up', 'down', 'enter']);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(11);
  });
});
