import { describe, it, expect } from 'vitest';
import {
  parseChord,
  matchesChord,
  renderSequence,
  parseKeyRemaps,
  findKeyRemap,
} from '../../src/shared/key-sequence';

const ev = (key: string, mods: Partial<{ ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }> = {}) => ({
  key,
  ctrlKey: !!mods.ctrl,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
  metaKey: !!mods.meta,
});

describe('parseChord (issue #146)', () => {
  it('parses the settings spelling', () => {
    expect(parseChord('ctrl+k')).toEqual({ key: 'k', ctrl: true, shift: false, alt: false });
    expect(parseChord('ctrl+shift+p')).toEqual({ key: 'p', ctrl: true, shift: true, alt: false });
    expect(parseChord('alt+Delete')).toEqual({ key: 'Delete', ctrl: false, shift: false, alt: true });
  });

  it('parses the vim spelling, with or without brackets', () => {
    expect(parseChord('<C-k>')).toEqual({ key: 'k', ctrl: true, shift: false, alt: false });
    expect(parseChord('C-S-Tab')).toEqual({ key: 'Tab', ctrl: true, shift: true, alt: false });
    expect(parseChord('<M-x>')).toEqual({ key: 'x', ctrl: false, shift: false, alt: true });
  });

  it('normalizes key aliases to KeyboardEvent.key values', () => {
    expect(parseChord('ctrl+up')?.key).toBe('ArrowUp');
    expect(parseChord('ctrl+pgdn')?.key).toBe('PageDown');
    expect(parseChord('ctrl+cr')?.key).toBe('Enter');
    expect(parseChord('ctrl+space')?.key).toBe(' ');
    expect(parseChord('f5')?.key).toBe('F5');
  });

  it('keeps a literal + as a key rather than eating it as a separator', () => {
    expect(parseChord('ctrl++')).toEqual({ key: '+', ctrl: true, shift: false, alt: false });
  });

  it('rejects names it cannot match against a DOM event', () => {
    expect(parseChord('ctrl+banana')).toBeNull();
    expect(parseChord('')).toBeNull();
  });
});

describe('matchesChord', () => {
  const ctrlK = parseChord('ctrl+k')!;

  it('matches the exact modifier set only', () => {
    expect(matchesChord(ev('k', { ctrl: true }), ctrlK)).toBe(true);
    // Ctrl+Shift+K may be bound to something else — a ctrl+k remap must not steal it.
    expect(matchesChord(ev('K', { ctrl: true, shift: true }), ctrlK)).toBe(false);
    expect(matchesChord(ev('k'), ctrlK)).toBe(false);
  });

  it('folds case for single-character keys', () => {
    expect(matchesChord(ev('K', { ctrl: true }), ctrlK)).toBe(true);
  });

  it('never matches when Meta/Win is held', () => {
    expect(matchesChord(ev('k', { ctrl: true, meta: true }), ctrlK)).toBe(false);
  });
});

describe('renderSequence', () => {
  it('renders the reported use case: kill-line then DEL (issue #112/#146)', () => {
    expect(renderSequence('<C-k><Delete>')).toEqual({ sequence: '\x0b\x1b[3~', errors: [] });
  });

  it('sends text outside <> literally', () => {
    expect(renderSequence('clear<CR>').sequence).toBe('clear\r');
    expect(renderSequence('hello').sequence).toBe('hello');
  });

  it('maps named keys to their xterm sequences', () => {
    expect(renderSequence('<Up>').sequence).toBe('\x1b[A');
    expect(renderSequence('<Home><End>').sequence).toBe('\x1b[H\x1b[F');
    expect(renderSequence('<F5>').sequence).toBe('\x1b[15~');
    expect(renderSequence('<Esc>').sequence).toBe('\x1b');
    expect(renderSequence('<BS>').sequence).toBe('\x7f');
  });

  it('encodes Alt as an ESC prefix and Shift+Tab as CSI Z', () => {
    expect(renderSequence('<A-b>').sequence).toBe('\x1bb');
    expect(renderSequence('<S-Tab>').sequence).toBe('\x1b[Z');
  });

  it('renders control bytes for Ctrl+letter and Ctrl+punctuation', () => {
    expect(renderSequence('<C-c>').sequence).toBe('\x03');
    expect(renderSequence('<C-u>').sequence).toBe('\x15');
    expect(renderSequence('<C-[>').sequence).toBe('\x1b');
  });

  it('escapes a literal < through <lt>', () => {
    expect(renderSequence('<lt>tag').sequence).toBe('<tag');
  });

  it('reports an unknown token instead of typing it as text', () => {
    const result = renderSequence('<Dlete>');
    expect(result.errors).toEqual(['unknown key <Dlete>']);
    expect(result.sequence).toBe('');
  });

  it('reports an unterminated <', () => {
    expect(renderSequence('a<C-k').errors[0]).toMatch(/unterminated/);
  });

  it('renders the empty string as a no-op sequence (swallow the key)', () => {
    expect(renderSequence('')).toEqual({ sequence: '', errors: [] });
  });
});

describe('parseKeyRemaps', () => {
  it('builds remaps from a [keys] table', () => {
    const errors: string[] = [];
    const remaps = parseKeyRemaps({ 'ctrl+k': '<C-k><Delete>', 'ctrl+alt+r': 'clear<CR>' }, errors);
    expect(errors).toEqual([]);
    expect(remaps).toHaveLength(2);
    expect(remaps[0]).toEqual({
      chord: { key: 'k', ctrl: true, shift: false, alt: false },
      send: '\x0b\x1b[3~',
      source: 'ctrl+k',
    });
  });

  it('skips a bad entry but keeps the good ones', () => {
    const errors: string[] = [];
    const remaps = parseKeyRemaps(
      { 'ctrl+banana': '<CR>', 'ctrl+j': '<Nope>', 'ctrl+k': '<Delete>', 'ctrl+l': 42 as any },
      errors,
    );
    expect(remaps.map((r) => r.source)).toEqual(['ctrl+k']);
    expect(errors).toHaveLength(3);
    expect(errors.join('\n')).toContain('keys."ctrl+banana"');
    expect(errors.join('\n')).toContain('unknown key <Nope>');
    expect(errors.join('\n')).toContain('expected a string');
  });
});

describe('findKeyRemap', () => {
  const remaps = parseKeyRemaps({ 'ctrl+k': '<C-k><Delete>', 'alt+left': '<Home>' });

  it('finds the matching remap and ignores unrelated keys', () => {
    expect(findKeyRemap(ev('k', { ctrl: true }), remaps)?.send).toBe('\x0b\x1b[3~');
    expect(findKeyRemap(ev('ArrowLeft', { alt: true }), remaps)?.send).toBe('\x1b[H');
    expect(findKeyRemap(ev('k'), remaps)).toBeNull();
    expect(findKeyRemap(ev('c', { ctrl: true }), remaps)).toBeNull();
  });

  it('returns null for an empty remap list — the common case, so it must be cheap', () => {
    expect(findKeyRemap(ev('k', { ctrl: true }), [])).toBeNull();
  });
});
