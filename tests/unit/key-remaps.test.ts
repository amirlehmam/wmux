import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setKeyRemaps, getKeyRemaps, remapKey, applyKeyRemap } from '../../src/renderer/key-remaps';
import { parseKeyRemaps } from '../../src/shared/key-sequence';

function keyEvent(key: string, mods: Partial<{ ctrl: boolean; shift: boolean; alt: boolean }> = {}) {
  return {
    type: 'keydown',
    key,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    metaKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

describe('key-remaps (issue #146)', () => {
  beforeEach(() => setKeyRemaps([]));

  it('starts empty so an unconfigured terminal behaves exactly as before', () => {
    expect(getKeyRemaps()).toEqual([]);
    expect(remapKey(keyEvent('k', { ctrl: true }))).toBeNull();
  });

  it('resolves a configured chord to its bytes', () => {
    setKeyRemaps(parseKeyRemaps({ 'ctrl+k': '<C-k><Delete>' }));
    expect(remapKey(keyEvent('k', { ctrl: true }))).toBe('\x0b\x1b[3~');
    expect(remapKey(keyEvent('k'))).toBeNull();
  });

  // `wmux reload-config` must be able to REMOVE bindings, not just add them —
  // the same idempotence the [browser] section has.
  it('replaces the whole list, so deleting [keys] really unbinds', () => {
    setKeyRemaps(parseKeyRemaps({ 'ctrl+k': '<Delete>' }));
    setKeyRemaps(undefined);
    expect(remapKey(keyEvent('k', { ctrl: true }))).toBeNull();
  });
});

describe('applyKeyRemap', () => {
  beforeEach(() => setKeyRemaps(parseKeyRemaps({ 'ctrl+k': '<C-k><Delete>', 'ctrl+q': '' })));

  it('emits the sequence and cancels the event', () => {
    const emit = vi.fn();
    const event = keyEvent('k', { ctrl: true });

    expect(applyKeyRemap(event, emit)).toBe(true);
    expect(emit).toHaveBeenCalledWith('\x0b\x1b[3~');
    // preventDefault stops the duplicate keypress (the issue #119 failure mode);
    // stopPropagation stops the document-level shortcut layer also firing.
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it('swallows the key for an empty binding — handled, but nothing sent', () => {
    const emit = vi.fn();
    const event = keyEvent('q', { ctrl: true });

    expect(applyKeyRemap(event, emit)).toBe(true);
    expect(emit).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('leaves unmapped keys entirely alone', () => {
    const emit = vi.fn();
    const event = keyEvent('c', { ctrl: true });

    expect(applyKeyRemap(event, emit)).toBe(false);
    expect(emit).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });

  it('ignores keyup, so a remap fires once per press', () => {
    const emit = vi.fn();
    expect(applyKeyRemap({ ...keyEvent('k', { ctrl: true }), type: 'keyup' }, emit)).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
});
