import { describe, it, expect } from 'vitest';
import { parsePromptMark } from '../../src/renderer/utils/osc133';

// The payloads here are the ones real emitters produce, not the ones the
// grammar suggests. wmux is on the receiving end of whatever the user runs —
// bash-preexec, Starship, oh-my-posh, iTerm2's own shell integration — and each
// spells the same mark slightly differently (issue #207).

describe('parsePromptMark', () => {
  it('parses the four bare marks', () => {
    expect(parsePromptMark('A')).toEqual({ kind: 'prompt-start', exitCode: null });
    expect(parsePromptMark('B')).toEqual({ kind: 'input-start', exitCode: null });
    expect(parsePromptMark('C')).toEqual({ kind: 'output-start', exitCode: null });
    expect(parsePromptMark('D')).toEqual({ kind: 'command-end', exitCode: null });
  });

  it('ignores parameters on A and C, which VS Code and bash-preexec both emit', () => {
    expect(parsePromptMark('A;k=i')).toEqual({ kind: 'prompt-start', exitCode: null });
    expect(parsePromptMark('A;cl=m;k=i')).toEqual({ kind: 'prompt-start', exitCode: null });
    expect(parsePromptMark('C;')).toEqual({ kind: 'output-start', exitCode: null });
  });

  it('reads an exit code off D', () => {
    expect(parsePromptMark('D;0')).toEqual({ kind: 'command-end', exitCode: 0 });
    expect(parsePromptMark('D;1')).toEqual({ kind: 'command-end', exitCode: 1 });
    expect(parsePromptMark('D;130')).toEqual({ kind: 'command-end', exitCode: 130 });
  });

  // The bug this pins: Number('') is 0. A shell that reports the boundary but
  // not the status would otherwise have every command read as a success.
  it('treats a missing or blank exit code as unknown, not as success', () => {
    expect(parsePromptMark('D')).toEqual({ kind: 'command-end', exitCode: null });
    expect(parsePromptMark('D;')).toEqual({ kind: 'command-end', exitCode: null });
    expect(parsePromptMark('D;  ')).toEqual({ kind: 'command-end', exitCode: null });
  });

  it('rejects a non-integer exit code rather than storing NaN', () => {
    expect(parsePromptMark('D;abc')).toEqual({ kind: 'command-end', exitCode: null });
    expect(parsePromptMark('D;1.5')).toEqual({ kind: 'command-end', exitCode: null });
  });

  // Declining is what lets the sequence carry on down xterm's handler chain to
  // whoever does understand it — the same rule the OSC 9 handler follows.
  it('declines vendor subtypes and anything that is not a mark', () => {
    expect(parsePromptMark('P;key=value')).toBeNull(); // iTerm2
    expect(parsePromptMark('L')).toBeNull();
    expect(parsePromptMark('')).toBeNull();
    expect(parsePromptMark(';')).toBeNull();
  });

  // A two-letter subtype must NOT be read as its first letter — slicing rather
  // than splitting would turn every unknown `A*` extension into a prompt start.
  it('does not mistake a longer subtype for a single-letter mark', () => {
    expect(parsePromptMark('As')).toBeNull();
    expect(parsePromptMark('Done')).toBeNull();
  });

  it('is case-sensitive, as the spec is', () => {
    expect(parsePromptMark('a')).toBeNull();
    expect(parsePromptMark('d;0')).toBeNull();
  });
});
