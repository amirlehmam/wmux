import { describe, it, expect, vi } from 'vitest';
import {
  SHIFT_ENTER_SEQUENCE,
  handleShiftEnter,
  isBareCtrlLetter,
  isLetterKey,
  isShiftEnter,
  type TerminalKeyEvent,
} from '../../src/renderer/hooks/terminal-keys';

function keyEvent(over: Partial<TerminalKeyEvent> = {}): TerminalKeyEvent & { preventDefault: ReturnType<typeof vi.fn> } {
  return {
    type: 'keydown',
    key: 'Enter',
    code: 'Enter',
    shiftKey: true,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
    ...over,
  } as any;
}

describe('Shift+Enter (issue #119)', () => {
  it('matches a plain Shift+Enter keydown', () => {
    expect(isShiftEnter(keyEvent())).toBe(true);
  });

  it('ignores keypress/keyup — xterm calls the handler for all three', () => {
    expect(isShiftEnter(keyEvent({ type: 'keypress' }))).toBe(false);
    expect(isShiftEnter(keyEvent({ type: 'keyup' }))).toBe(false);
  });

  it('leaves Enter, Ctrl+Shift+Enter and Alt+Shift+Enter alone', () => {
    expect(isShiftEnter(keyEvent({ shiftKey: false }))).toBe(false);
    // Ctrl+Shift+Enter is the zoom-pane shortcut and must reach the global handler.
    expect(isShiftEnter(keyEvent({ ctrlKey: true }))).toBe(false);
    expect(isShiftEnter(keyEvent({ altKey: true }))).toBe(false);
    expect(isShiftEnter(keyEvent({ metaKey: true }))).toBe(false);
    expect(isShiftEnter(keyEvent({ key: 'a' }))).toBe(false);
  });

  it('emits ESC+CR exactly once', () => {
    const emit = vi.fn();
    handleShiftEnter(keyEvent(), emit);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('\x1b\r');
    expect(SHIFT_ENTER_SEQUENCE).toBe('\x1b\r');
  });

  // The regression itself. Returning false makes xterm's _keyDown bail but does
  // NOT cancel the DOM event, so the browser still fires `keypress` and xterm's
  // _keyPress sends Enter's charCode 13 as a second, plain \r — the blank line
  // users saw after every Shift+Enter. Only preventDefault suppresses it.
  it('cancels the keydown so no keypress produces a second newline', () => {
    const event = keyEvent();
    handleShiftEnter(event, vi.fn());
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('tells xterm not to handle the key as well', () => {
    expect(handleShiftEnter(keyEvent(), vi.fn())).toBe(false);
  });
});

describe('isLetterKey — layout-independent letter matching', () => {
  it('matches the Latin letter the key produces', () => {
    expect(isLetterKey(keyEvent({ key: 'c', code: 'KeyC' }), 'c', 'KeyC')).toBe(true);
    expect(isLetterKey(keyEvent({ key: 'v', code: 'KeyV' }), 'v', 'KeyV')).toBe(true);
  });

  // The bug: on a Russian layout the C key produces U+0441, Cyrillic "es". It
  // looks identical to a Latin "c" and is a different character, so matching on
  // event.key alone never fires and the keystroke falls through to the PTY.
  it('matches Cyrillic, where the key produces с (U+0441) instead of c', () => {
    expect(isLetterKey(keyEvent({ key: '\u0441', code: 'KeyC' }), 'c', 'KeyC')).toBe(true);
    expect(isLetterKey(keyEvent({ key: 'м', code: 'KeyV' }), 'v', 'KeyV')).toBe(true);
  });

  it('matches Greek, and so every other non-Latin script, without listing them', () => {
    expect(isLetterKey(keyEvent({ key: 'ψ', code: 'KeyC' }), 'c', 'KeyC')).toBe(true);
  });

  // Dvorak moves C to the physical I key. The user presses the key that shows
  // C, so event.key is what has to decide here — matching event.code alone
  // would silently break every remapped Latin layout.
  it('follows the character on Dvorak, where C sits on a different physical key', () => {
    expect(isLetterKey(keyEvent({ key: 'c', code: 'KeyI' }), 'c', 'KeyC')).toBe(true);
  });

  it('ignores the physical key when it produces some other Latin letter', () => {
    // Physical KeyC on Dvorak produces 'j' — pressing it must not copy.
    expect(isLetterKey(keyEvent({ key: 'j', code: 'KeyC' }), 'c', 'KeyC')).toBe(false);
  });

  it('leaves unrelated keys alone', () => {
    expect(isLetterKey(keyEvent({ key: 'x', code: 'KeyX' }), 'c', 'KeyC')).toBe(false);
    expect(isLetterKey(keyEvent({ key: 'ч', code: 'KeyX' }), 'c', 'KeyC')).toBe(false);
  });

  // Case is not Shift: Caps Lock uppercases the letter with no Shift held.
  // Whether Shift is down is isBareCtrlLetter's question, asked of shiftKey.
  it('matches the letter in either case', () => {
    expect(isLetterKey(keyEvent({ key: 'C', code: 'KeyC' }), 'c', 'KeyC')).toBe(true);
    expect(isLetterKey(keyEvent({ key: 'V', code: 'KeyV' }), 'v', 'KeyV')).toBe(true);
  });

  it('still ignores another Latin letter on the physical key, in either case', () => {
    expect(isLetterKey(keyEvent({ key: 'J', code: 'KeyC' }), 'c', 'KeyC')).toBe(false);
  });
});

describe('isBareCtrlLetter — the terminal\'s own Ctrl+C / Ctrl+V (#453)', () => {
  const ctrl = (over: Partial<TerminalKeyEvent>) =>
    keyEvent({ shiftKey: false, ctrlKey: true, ...over });

  it('matches plain Ctrl+V', () => {
    expect(isBareCtrlLetter(ctrl({ key: 'v', code: 'KeyV' }), 'v', 'KeyV')).toBe(true);
  });

  // #453: with Caps Lock on, Ctrl+V arrives as key 'V'. The case test let it
  // fall through to xterm, which sent a raw ^V that Claude Code on Windows
  // ignores, so the paste typed nothing.
  it('matches Ctrl+V with Caps Lock on (key is "V", no Shift)', () => {
    expect(isBareCtrlLetter(ctrl({ key: 'V', code: 'KeyV' }), 'v', 'KeyV')).toBe(true);
  });

  // #453: with Caps Lock on, Ctrl+Shift+V arrives as key 'v'. The case test
  // took it for Ctrl+V and pasted, then the `paste` shortcut pasted again.
  it('leaves Ctrl+Shift+V to the paste shortcut with Caps Lock on (key is "v")', () => {
    expect(isBareCtrlLetter(ctrl({ key: 'v', code: 'KeyV', shiftKey: true }), 'v', 'KeyV')).toBe(false);
  });

  it('leaves Ctrl+Shift+V to the paste shortcut without Caps Lock (key is "V")', () => {
    expect(isBareCtrlLetter(ctrl({ key: 'V', code: 'KeyV', shiftKey: true }), 'v', 'KeyV')).toBe(false);
  });

  // The same double paste on a non-Latin layout: Shift+М is still not Latin,
  // so the physical-key fallback matched Ctrl+Shift+V.
  it('leaves Ctrl+Shift+V alone on a Cyrillic layout', () => {
    expect(isBareCtrlLetter(ctrl({ key: 'М', code: 'KeyV', shiftKey: true }), 'v', 'KeyV')).toBe(false);
    expect(isBareCtrlLetter(ctrl({ key: 'м', code: 'KeyV' }), 'v', 'KeyV')).toBe(true);
  });

  it('copies on Ctrl+C with Caps Lock on rather than sending ^C', () => {
    expect(isBareCtrlLetter(ctrl({ key: 'C', code: 'KeyC' }), 'c', 'KeyC')).toBe(true);
  });

  it('ignores Alt (AltGr on Windows), Meta, a missing Ctrl and non-keydown events', () => {
    expect(isBareCtrlLetter(ctrl({ key: 'v', code: 'KeyV', altKey: true }), 'v', 'KeyV')).toBe(false);
    expect(isBareCtrlLetter(ctrl({ key: 'v', code: 'KeyV', metaKey: true }), 'v', 'KeyV')).toBe(false);
    expect(isBareCtrlLetter(ctrl({ key: 'v', code: 'KeyV', ctrlKey: false }), 'v', 'KeyV')).toBe(false);
    expect(isBareCtrlLetter(ctrl({ key: 'v', code: 'KeyV', type: 'keyup' }), 'v', 'KeyV')).toBe(false);
  });
});
