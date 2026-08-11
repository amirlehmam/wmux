import { describe, it, expect } from 'vitest';
import { keyDismissesAttention } from '../../src/renderer/components/SplitPane/attention-dismiss';

describe('keyDismissesAttention', () => {
  it('ordinary typing dismisses the ring', () => {
    for (const key of ['a', 'Z', '1', ' ', 'Enter', 'Backspace', 'ArrowDown', 'F5', 'Escape']) {
      expect(keyDismissesAttention(key)).toBe(true);
    }
  });

  it('a bare modifier does not', () => {
    // The first half of a chord is not engagement with the pane. Several of
    // those chords are the user LEAVING it (Ctrl+Alt+arrow switches panes), so
    // dismissing on the modifier's own keydown clears the ring a beat before
    // the user's attention actually arrives.
    for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock']) {
      expect(keyDismissesAttention(key)).toBe(false);
    }
  });

  it('the terminating key of a chord still does — it was typed into this pane', () => {
    // Ctrl+C arrives as two events: 'Control' (ignored above) then 'c'.
    expect(keyDismissesAttention('c')).toBe(true);
  });

  it('an empty key is not an interaction', () => {
    expect(keyDismissesAttention('')).toBe(false);
  });
});
