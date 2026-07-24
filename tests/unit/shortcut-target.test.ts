import { describe, it, expect } from 'vitest';
import {
  GLOBAL_IN_EDITOR,
  isEditableTarget,
  EditableTargetLike,
} from '../../src/renderer/hooks/shortcut-target';
import { DEFAULT_SHORTCUTS } from '../../src/renderer/store/settings-slice';

// The editable-focus guard (issue #116): global shortcuts must defer to real
// text fields, without accidentally treating a focused terminal as one.

function target(
  tagName: string,
  options: { insideXterm?: boolean; contentEditable?: boolean } = {},
): EditableTargetLike {
  return {
    tagName,
    isContentEditable: !!options.contentEditable,
    closest: (selector: string) => (options.insideXterm && selector === '.xterm' ? {} : null),
  };
}

describe('isEditableTarget', () => {
  it('treats real text fields as editors', () => {
    expect(isEditableTarget(target('INPUT'))).toBe(true);
    expect(isEditableTarget(target('TEXTAREA'))).toBe(true);
    expect(isEditableTarget(target('SELECT'))).toBe(true);
    expect(isEditableTarget(target('DIV', { contentEditable: true }))).toBe(true);
  });

  it('does not treat ordinary elements as editors', () => {
    expect(isEditableTarget(target('DIV'))).toBe(false);
    expect(isEditableTarget(target('BUTTON'))).toBe(false);
  });

  // The regression this guard is most likely to cause: xterm.js focuses a
  // <textarea class="xterm-helper-textarea">, so a bare tag check would classify
  // every focused terminal as an editor and kill the whole shortcut set.
  it("does NOT treat xterm's helper textarea as an editor", () => {
    expect(isEditableTarget(target('TEXTAREA', { insideXterm: true }))).toBe(false);
  });

  it('is false for a missing target', () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(undefined)).toBe(false);
  });

  it('tolerates a target without closest()', () => {
    expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true);
  });
});

describe('GLOBAL_IN_EDITOR', () => {
  it('only names actions that actually exist', () => {
    for (const action of GLOBAL_IN_EDITOR) {
      expect(DEFAULT_SHORTCUTS).toHaveProperty(action);
    }
  });

  // Anything text-editing-adjacent must NOT be in the allowlist, or it would
  // fire while the user is typing.
  it('excludes the text-editing and terminal actions', () => {
    for (const action of ['copy', 'paste', 'find', 'copyMode', 'toggleMarkdownSource'] as const) {
      expect(GLOBAL_IN_EDITOR.has(action)).toBe(false);
    }
  });
});

describe('toggleMarkdownSource binding (issue #116)', () => {
  it('is bound to Ctrl+Shift+E', () => {
    expect(DEFAULT_SHORTCUTS.toggleMarkdownSource).toEqual({ key: 'e', ctrl: true, shift: true });
  });

  it('does not collide with any other default binding', () => {
    const serialize = (b: { key: string; ctrl?: boolean; shift?: boolean; alt?: boolean }) =>
      `${b.ctrl ? 'C-' : ''}${b.shift ? 'S-' : ''}${b.alt ? 'A-' : ''}${b.key.toLowerCase()}`;
    const target = serialize(DEFAULT_SHORTCUTS.toggleMarkdownSource);
    const clashes = Object.entries(DEFAULT_SHORTCUTS)
      .filter(([action, binding]) => action !== 'toggleMarkdownSource' && serialize(binding) === target)
      .map(([action]) => action);
    expect(clashes).toEqual([]);
  });
});
