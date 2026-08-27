import { describe, it, expect } from 'vitest';
import { emptyPromptNote, promptTruncationNote } from '../../src/cli/wmux';

/**
 * `wmux prompts` printing nothing is an answer, and it used to be the same
 * answer to different questions (issue #207).
 *
 * A caller that sees "No prompts recorded" has no way to tell a pane that has
 * not been asked anything yet from a prompt log that is switched off and never
 * will record anything — and the two want opposite next moves (wait; go turn it
 * on). Same for a capped reply: silence about the cap reads as "that is all
 * there is". The third case, an id naming no surface, never reaches these
 * helpers at all — the server rejects it and `main` prints `Error: ...` and
 * exits non-zero, which is what every other command does with a bad id.
 */
describe('wmux prompts — empty and truncated output (issue #207)', () => {
  it('distinguishes a disabled log from a pane with nothing recorded', () => {
    const nothingYet = emptyPromptNote(true, ' for surf-1');
    const switchedOff = emptyPromptNote(false, ' for surf-1');
    expect(nothingYet).not.toBe(switchedOff);
    expect(nothingYet).toContain('No prompts recorded');
    // The disabled line has to say where to change it, or it is only half an
    // answer — "off" with no way to act on it.
    expect(switchedOff).toContain('off');
    expect(switchedOff).toContain('Settings');
    // Both still name the pane the caller asked about.
    expect(nothingYet).toContain('surf-1');
    expect(switchedOff).toContain('surf-1');
  });

  it('drops the scope when reporting on every pane at once', () => {
    expect(emptyPromptNote(true, '')).toBe('No prompts recorded');
    expect(emptyPromptNote(false, '')).not.toContain(' for ');
  });

  it('says nothing when the reply was not capped', () => {
    expect(promptTruncationNote({ truncated: false, limit: 20 }, true)).toBeNull();
    expect(promptTruncationNote({}, false)).toBeNull();
    expect(promptTruncationNote(undefined, false)).toBeNull();
  });

  it('names the cap the server actually applied, and how to raise it', () => {
    const note = promptTruncationNote({ truncated: true, limit: 20 }, true);
    expect(note).toContain('20 per pane');
    expect(note).toContain('--limit');
  });

  it('omits the per-pane cap on the targeted form, which has no default', () => {
    // The targeted form only truncates because the caller passed --limit, so
    // echoing a number back at them would be telling them what they just said.
    const note = promptTruncationNote({ truncated: true }, false);
    expect(note).toContain('--limit');
    expect(note).not.toContain('per pane');
  });
});
