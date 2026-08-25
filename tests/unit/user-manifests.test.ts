import { describe, it, expect } from 'vitest';
import { parseUserManifest, mergeManifests } from '../../src/main/user-manifests';
import { BUNDLED_MANIFESTS } from '../../src/shared/detection/manifests';
import { LIMITS, Manifest } from '../../src/shared/detection/types';

const valid = {
  agent: 'claude',
  version: 7,
  signatures: [{ kind: 'contains', value: 'MY CHROME' }],
  rules: [{
    id: 'mine.blocked',
    state: 'blocked',
    priority: 900,
    region: { id: 'bottom_non_empty_lines', count: 8 },
    all: [{ kind: 'contains', value: 'Approve this?' }],
  }],
};

describe('parseUserManifest', () => {
  it('accepts a well-formed override', () => {
    const { manifest, errors } = parseUserManifest(valid);
    expect(errors).toEqual([]);
    expect(manifest).toMatchObject({ agent: 'claude', version: 7 });
    expect(manifest!.rules[0].id).toBe('mine.blocked');
  });

  /**
   * The one rule that is a security decision rather than a validation.
   *
   * Every bundled regex is written by a maintainer and pinned by a fixture; a
   * hand-edited one is neither, and JavaScript's RegExp backtracks
   * catastrophically where the Rust engine the prior art uses cannot. The
   * detection loop runs several times a second over every pane, so the override
   * path gets only the matcher kinds that cannot backtrack at all.
   */
  it('refuses lineRegex from a user override', () => {
    const { manifest } = parseUserManifest({
      ...valid,
      rules: [{ ...valid.rules[0], all: [{ kind: 'lineRegex', value: '^ok$' }] }],
    });
    expect(manifest).toBeNull();
  });

  it('allows lineRegex only when the caller explicitly opts in', () => {
    const { manifest } = parseUserManifest({
      ...valid,
      rules: [{ ...valid.rules[0], all: [{ kind: 'lineRegex', value: '^ok$' }] }],
    }, { allowRegex: true });
    expect(manifest?.rules[0].all?.[0].kind).toBe('lineRegex');
  });

  it('rejects a catastrophic pattern even with regex allowed', () => {
    const { manifest } = parseUserManifest({
      ...valid,
      rules: [{ ...valid.rules[0], all: [{ kind: 'lineRegex', value: '(a+)+' }] }],
    }, { allowRegex: true });
    expect(manifest).toBeNull();
  });

  it('rejects an unknown agent — an override cannot invent a kind', () => {
    const { manifest, errors } = parseUserManifest({ ...valid, agent: 'notanagent' });
    expect(manifest).toBeNull();
    expect(errors.join(' ')).toContain('unknown agent');
  });

  it('rejects a rule with no positive matcher — it would fire on every screen', () => {
    const { manifest } = parseUserManifest({
      ...valid,
      rules: [{ ...valid.rules[0], all: undefined, any: undefined, none: [{ kind: 'contains', value: 'x' }] }],
    });
    expect(manifest).toBeNull();
  });

  it('rejects an unknown region and an unknown state', () => {
    expect(parseUserManifest({
      ...valid, rules: [{ ...valid.rules[0], region: { id: 'nowhere' } }],
    }).manifest).toBeNull();
    expect(parseUserManifest({
      ...valid, rules: [{ ...valid.rules[0], state: 'confused' }],
    }).manifest).toBeNull();
  });

  it('rejects an over-long matcher', () => {
    const { manifest } = parseUserManifest({
      ...valid,
      rules: [{ ...valid.rules[0], all: [{ kind: 'contains', value: 'x'.repeat(LIMITS.MAX_MATCHER_CHARS + 1) }] }],
    });
    expect(manifest).toBeNull();
  });

  it('caps the rule count', () => {
    const many = Array.from({ length: LIMITS.MAX_RULES + 50 }, (_, i) => ({ ...valid.rules[0], id: `r${i}` }));
    const { manifest } = parseUserManifest({ ...valid, rules: many });
    expect(manifest!.rules.length).toBe(LIMITS.MAX_RULES);
  });

  it('never throws on garbage', () => {
    for (const junk of [null, 42, 'text', [], {}, { agent: 'claude' }]) {
      expect(() => parseUserManifest(junk)).not.toThrow();
      expect(parseUserManifest(junk).manifest).toBeNull();
    }
  });

  it('reports why it refused, so a silent override is debuggable', () => {
    const { errors } = parseUserManifest({ ...valid, signatures: [] });
    expect(errors.join(' ')).toContain('signatures');
    expect(errors.join(' ')).toContain('falling back');
  });
});

describe('mergeManifests', () => {
  const override: Manifest = {
    agent: 'claude', version: 99,
    signatures: [{ kind: 'contains', value: 'X' }],
    rules: [{ id: 'claude.x', state: 'idle', priority: 1, region: { id: 'whole_recent' }, all: [{ kind: 'contains', value: 'X' }] }],
  };

  /**
   * Replace, not merge. A partial merge leaves the user guessing which of their
   * rules competes with which of ours, and "my file did not take effect" is the
   * one failure mode a hotfix path cannot afford.
   */
  it('an override replaces the bundled manifest for its agent entirely', () => {
    const merged = mergeManifests(BUNDLED_MANIFESTS, [override]);
    const claude = merged.find((m) => m.agent === 'claude')!;
    expect(claude.version).toBe(99);
    expect(claude.rules).toHaveLength(1);
  });

  it('leaves other agents untouched', () => {
    const merged = mergeManifests(BUNDLED_MANIFESTS, [override]);
    expect(merged.find((m) => m.agent === 'codex')).toBe(BUNDLED_MANIFESTS.find((m) => m.agent === 'codex'));
    expect(merged).toHaveLength(BUNDLED_MANIFESTS.length);
  });

  it('adds an agent that has no bundled manifest', () => {
    const merged = mergeManifests(BUNDLED_MANIFESTS, [{ ...override, agent: 'aider' }]);
    expect(merged).toHaveLength(BUNDLED_MANIFESTS.length + 1);
  });

  it('with no overrides, the bundled set passes through unchanged', () => {
    expect(mergeManifests(BUNDLED_MANIFESTS, [])).toEqual(BUNDLED_MANIFESTS);
  });
});
