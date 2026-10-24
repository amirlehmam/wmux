import { describe, expect, it } from 'vitest';
import {
  MAX_OSC_TITLE_CHARS,
  MAX_OSC_TITLE_SURFACES,
  normalizeOscTitle,
  evictOscTitles,
  stripStatusGlyph,
  createOscTitleSlice,
  type OscTitleEntry,
} from '../../src/renderer/store/osc-title-slice';

describe('normalizeOscTitle', () => {
  it('keeps an ordinary title verbatim', () => {
    expect(normalizeOscTitle('Fix issue #221')).toBe('Fix issue #221');
  });

  it('answers empty for anything that is not a string', () => {
    // The value arrives from xterm's OSC parser, whose input is whatever the
    // pane's program wrote. Nothing downstream may have to null-check.
    expect(normalizeOscTitle(undefined)).toBe('');
    expect(normalizeOscTitle(null)).toBe('');
    expect(normalizeOscTitle(42 as unknown as string)).toBe('');
  });

  it('flattens a multi-line title onto one line', () => {
    // A tab is one line high. A title carrying a newline used to be stored
    // whole and would render as a tab whose text simply stopped.
    expect(normalizeOscTitle('build\nfailed')).toBe('build failed');
    expect(normalizeOscTitle('a\r\n\tb')).toBe('a b');
  });

  it('strips control characters rather than rendering them', () => {
    expect(normalizeOscTitle('cla\u0007ude\u001b')).toBe('claude');
  });

  it('strips bidi overrides, which can reorder the whole tab strip', () => {
    // U+202E flips the rendering direction of everything after it, including
    // the tabs drawn to its right. A pane's program must not be able to do
    // that to chrome the user did not ask it to write.
    expect(normalizeOscTitle('safe\u202Eevil')).toBe('safeevil');
    expect(normalizeOscTitle('\u2066iso\u2069late')).toBe('isolate');
  });

  it('collapses runs of whitespace and trims', () => {
    expect(normalizeOscTitle('   npm    run   build  ')).toBe('npm run build');
  });

  it('caps the length', () => {
    const long = 'x'.repeat(MAX_OSC_TITLE_CHARS + 50);
    expect(normalizeOscTitle(long)).toHaveLength(MAX_OSC_TITLE_CHARS);
  });

  it('answers empty for a title that is nothing but control characters', () => {
    // An empty result is the signal to CLEAR the surface's title, so a program
    // that blanks its title returns the tab to its cwd label.
    expect(normalizeOscTitle('\u0007\u001b  ')).toBe('');
  });
});

describe('evictOscTitles', () => {
  const entry = (title: string, at: number) => ({ title, at });

  it('leaves a map inside the budget alone', () => {
    const map = { a: entry('A', 1), b: entry('B', 2) };
    expect(evictOscTitles(map)).toBe(map);
  });

  it('drops the least recently written surfaces first', () => {
    const map: Record<string, { title: string; at: number }> = {};
    for (let i = 0; i < MAX_OSC_TITLE_SURFACES + 3; i++) map[`s${i}`] = entry(`T${i}`, i);
    const kept = evictOscTitles(map);
    expect(Object.keys(kept)).toHaveLength(MAX_OSC_TITLE_SURFACES);
    expect(kept.s0).toBeUndefined();
    expect(kept.s2).toBeUndefined();
    expect(kept.s3).toBeDefined();
  });
});

describe('the store setter', () => {
  // A miniature of what zustand's `set` does, so the slice's own short-circuit
  // is observable: returning the SAME state object is what makes a repeated
  // title cost no re-render, and that is the whole reason the tab bar can
  // subscribe to this map at all.
  function harness() {
    let state: { oscTitles: Record<string, OscTitleEntry> } = { oscTitles: {} };
    let writes = 0;
    const set = (fn: (s: any) => any) => {
      const next = fn(state);
      if (next === state) return;
      writes++;
      state = { ...state, ...next };
    };
    const slice = createOscTitleSlice(set as any, (() => state) as any, {} as any);
    return { slice, get: () => state, writes: () => writes };
  }

  it('records a title', () => {
    const h = harness();
    h.slice.setOscTitle('surf-1', 'Fix issue #221');
    expect(h.get().oscTitles['surf-1'].title).toBe('Fix issue #221');
    expect(h.writes()).toBe(1);
  });

  it('does not re-write an unchanged title', () => {
    // Several shells re-emit the same window title on every prompt.
    const h = harness();
    h.slice.setOscTitle('surf-1', 'building');
    h.slice.setOscTitle('surf-1', 'building');
    h.slice.setOscTitle('surf-1', '  building  ');
    expect(h.writes()).toBe(1);
  });

  it('clears on an empty title, so the tab returns to its cwd label', () => {
    const h = harness();
    h.slice.setOscTitle('surf-1', 'building');
    h.slice.setOscTitle('surf-1', '');
    expect(h.get().oscTitles['surf-1']).toBeUndefined();
    expect(h.writes()).toBe(2);
  });

  it('does not write when clearing a surface that has no title', () => {
    const h = harness();
    h.slice.setOscTitle('surf-1', '');
    h.slice.clearOscTitle('surf-1');
    expect(h.writes()).toBe(0);
  });

  it('ignores a surface with no id', () => {
    const h = harness();
    h.slice.setOscTitle('', 'anything');
    expect(h.writes()).toBe(0);
  });

  it('forgets a surface on clearOscTitle', () => {
    const h = harness();
    h.slice.setOscTitle('surf-1', 'building');
    h.slice.clearOscTitle('surf-1');
    expect(h.get().oscTitles['surf-1']).toBeUndefined();
  });
});

describe('stripStatusGlyph', () => {
  it('drops the status glyph an agent puts in front of its title', () => {
    // Claude Code: `✳` while idle, `◐ ◑ ◒ ◓` while working, braille frames in
    // older builds. Recorded: `◐ Claude Code` … `✳ Hello greeting reply`.
    for (const glyph of ['✳', '◐', '◑', '◒', '◓', '⠋', '⠙', '⠹']) {
      expect(stripStatusGlyph(`${glyph} Hello greeting reply`)).toBe('Hello greeting reply');
    }
  });

  it('drops ONE short run of symbols, and only when a space follows it', () => {
    expect(stripStatusGlyph('✳️ Fix login')).toBe('Fix login');
    expect(stripStatusGlyph('✳ ◐ Fix login')).toBe('◐ Fix login');
    expect(stripStatusGlyph('****** Fix login')).toBe('****** Fix login');
  });

  it('leaves a title that starts with a letter or a digit alone', () => {
    for (const title of ['MINGW64:/c/repo', 'user@host: ~', '(1) Inbox', '~/dev/wmux', 'Fix issue #221', '1. step']) {
      expect(stripStatusGlyph(title)).toBe(title);
    }
  });

  it('answers empty for a title that is only a glyph', () => {
    expect(stripStatusGlyph('✳')).toBe('');
    expect(stripStatusGlyph('⠋')).toBe('');
    expect(stripStatusGlyph('')).toBe('');
  });
});
