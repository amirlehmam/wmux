import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { detectScreen, isSafeRegexSource, sliceRegion } from '../../src/shared/detection/engine';
import { BUNDLED_MANIFESTS } from '../../src/shared/detection/manifests';
import { LIMITS, Manifest } from '../../src/shared/detection/types';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'detection');

/** A captured screen, as the renderer would hand it over. */
function screen(name: string): { lines: string[] } {
  const raw = fs.readFileSync(path.join(FIXTURES, `${name}.txt`), 'utf8');
  return { lines: raw.replace(/\n$/, '').split('\n') };
}

const read = (name: string, expected?: string | null) =>
  detectScreen(screen(name), BUNDLED_MANIFESTS, expected);

// ─── Against the real captures ───────────────────────────────────────────────

describe('detectScreen — Claude Code', () => {
  it('reads a working screen as working', () => {
    const out = read('claude-working');
    expect(out).toMatchObject({ agent: 'claude', state: 'working', ruleId: 'claude.working.spinner' });
    expect(out.evidence.join('\n')).toContain('Unravelling');
  });

  it('reads the default-mode working footer as working', () => {
    expect(read('claude-working-interrupt')).toMatchObject({ agent: 'claude', state: 'working' });
  });

  it('reads an empty prompt as idle', () => {
    expect(read('claude-idle')).toMatchObject({
      agent: 'claude', state: 'idle', ruleId: 'claude.idle.prompt',
    });
  });

  /**
   * The prompt box is on screen during a run too — the spinner sits ABOVE it.
   * If idle did not exclude the run markers, every working screen would also
   * satisfy the idle rule and the two would race on priority alone.
   */
  it('does not read a working screen as idle even though the prompt box is drawn', () => {
    const working = screen('claude-working');
    const idleRule = BUNDLED_MANIFESTS.find((m) => m.agent === 'claude')!
      .rules.find((r) => r.id === 'claude.idle.prompt')!;
    const onlyIdle: Manifest = {
      ...BUNDLED_MANIFESTS.find((m) => m.agent === 'claude')!,
      rules: [idleRule],
    };
    expect(detectScreen(working, [onlyIdle]).state).toBe('unknown');
  });

  it('recognises a permission prompt as blocked, over the top of the run chrome', () => {
    const out = detectScreen({
      lines: [
        '✻ Puzzling… (4s · ↓ 200 tokens)',
        '',
        'Bash command',
        '  rm -rf build',
        '',
        'Do you want to proceed?',
        '❯ 1. Yes',
        '  2. No, and tell Claude what to do differently',
        '',
        '  ⏵⏵ accept edits on (shift+tab to cycle)',
      ],
    }, BUNDLED_MANIFESTS);
    expect(out).toMatchObject({ agent: 'claude', state: 'blocked', ruleId: 'claude.blocked.permission' });
  });

  /**
   * The narrowness that matters. Claude quoting a previous prompt back at the
   * user must not put the pane in the "needs you" queue — wmux's blocked never
   * expires, so a false positive there is permanent until the user notices.
   */
  it('does not call it blocked when the question text appears with no answer list', () => {
    const out = detectScreen({
      lines: [
        '● Earlier I asked "Do you want to proceed?" and you said yes, so I',
        '  went ahead with the migration.',
        '',
        '> ',
        '  ⏵⏵ accept edits on (shift+tab to cycle)',
      ],
    }, BUNDLED_MANIFESTS);
    expect(out.state).not.toBe('blocked');
  });
});

describe('detectScreen — Codex', () => {
  it('identifies the composer and reads it as idle', () => {
    expect(read('codex-idle')).toMatchObject({
      agent: 'codex', state: 'idle', ruleId: 'codex.idle.composer',
    });
  });

  /**
   * Note the `'codex'` argument, and that it is load-bearing.
   *
   * This screen carries NO Codex chrome at all — the update menu is drawn
   * before the banner and covers the footer, so no signature can claim it. That
   * is not a gap in the manifest, it is a fact about the screen, and it is
   * precisely why detection sits on top of phase 2 rather than replacing it:
   * the pane is known to be Codex because `codex` was the command line, and
   * that knowledge is what makes this rule reachable at all.
   */
  it('reads the startup update menu as blocked, given identity from the command line', () => {
    expect(read('codex-blocked-update', 'codex')).toMatchObject({
      agent: 'codex', state: 'blocked', ruleId: 'codex.blocked.menu',
    });
  });

  it('cannot identify that same screen on its own — it shows no Codex chrome', () => {
    expect(read('codex-blocked-update')).toMatchObject({
      agent: null, reason: 'no-agent-signature',
    });
  });
});

describe('detectScreen — OpenCode', () => {
  it('identifies the composer and reads it as idle', () => {
    expect(read('opencode-idle')).toMatchObject({ agent: 'opencode', state: 'idle' });
  });
});

// ─── The fallbacks ───────────────────────────────────────────────────────────

describe('detectScreen — fallbacks', () => {
  it('claims nothing for a plain shell', () => {
    expect(read('plain-shell')).toMatchObject({
      agent: null, state: 'unknown', reason: 'no-agent-signature',
    });
  });

  it('reports an empty screen as such', () => {
    expect(detectScreen({ lines: ['', '   ', ''] }, BUNDLED_MANIFESTS)).toMatchObject({
      state: 'unknown', reason: 'empty-screen',
    });
  });

  /**
   * THE divergence from the prior art, which returns `idle` here and labels it
   * `default_known_agent_idle_fallback`. `idle` is a claim; a screen we failed
   * to parse has made none. Returning `unknown` is also what lets a future rule
   * fill the gap without anything downstream having believed a lie in the
   * meantime.
   */
  it('returns unknown — never idle — for a known agent whose screen matched no rule', () => {
    const out = detectScreen({
      lines: ['  ⏵⏵ accept edits on', 'something wmux has never seen'],
    }, BUNDLED_MANIFESTS);
    expect(out).toMatchObject({ agent: 'claude', state: 'unknown', reason: 'no-rule-matched' });
  });

  /**
   * An agent quoting another agent's UI must not be read with that agent's
   * rules. Identity from a command line is the more authoritative fact.
   */
  it('honours a known agent instead of whichever signature the screen shows', () => {
    const out = detectScreen({
      lines: ['Here is what codex prints:', '  ? for shortcuts', '  100% context left'],
    }, BUNDLED_MANIFESTS, 'claude');
    expect(out.agent).toBe('claude');
    expect(out.state).toBe('unknown');
  });

  it('runs a known agent\'s rules even when its chrome has scrolled off', () => {
    const out = detectScreen({ lines: ['✻ Thinking… (3s · ↓ 20 tokens)'] }, BUNDLED_MANIFESTS, 'claude');
    expect(out).toMatchObject({ agent: 'claude', state: 'working' });
  });
});

// ─── Regions ─────────────────────────────────────────────────────────────────

describe('sliceRegion', () => {
  const input = { lines: ['a', '', 'b', '   ', 'c'], title: '  Claude Code  ' };

  it('bottom_lines keeps blanks', () => {
    expect(sliceRegion(input, { id: 'bottom_lines', count: 3 })).toEqual(['b', '   ', 'c']);
  });

  it('bottom_non_empty_lines drops them — agent UIs pad heavily', () => {
    expect(sliceRegion(input, { id: 'bottom_non_empty_lines', count: 2 })).toEqual(['b', 'c']);
  });

  it('top_non_empty_lines reads from the other end', () => {
    expect(sliceRegion(input, { id: 'top_non_empty_lines', count: 2 })).toEqual(['a', 'b']);
  });

  it('osc_title yields the trimmed title, or nothing', () => {
    expect(sliceRegion(input, { id: 'osc_title' })).toEqual(['Claude Code']);
    expect(sliceRegion({ lines: [] }, { id: 'osc_title' })).toEqual([]);
  });

  it('clamps an over-large region request', () => {
    const many = { lines: Array.from({ length: 5_000 }, (_, i) => `line ${i}`) };
    expect(sliceRegion(many, { id: 'bottom_lines', count: 9_999 }).length).toBe(LIMITS.MAX_REGION_LINES);
    expect(sliceRegion(many, { id: 'whole_recent' }).length).toBe(LIMITS.MAX_REGION_LINES);
  });
});

// ─── Regex safety ────────────────────────────────────────────────────────────

/**
 * The prior art's complexity caps assume Rust's `regex` crate, which is
 * linear-time and cannot backtrack. JavaScript's RegExp backtracks
 * catastrophically, so the caps port but are not sufficient on their own.
 */
describe('isSafeRegexSource', () => {
  it('accepts the patterns the bundled manifests use', () => {
    for (const manifest of BUNDLED_MANIFESTS) {
      const sources = [
        ...manifest.signatures,
        ...manifest.rules.flatMap((r) => [...(r.all ?? []), ...(r.any ?? []), ...(r.none ?? [])]),
      ].filter((m) => m.kind === 'lineRegex').map((m) => m.value);

      for (const source of sources) {
        expect(isSafeRegexSource(source), `${manifest.agent}: ${source}`).toBe(true);
      }
    }
  });

  it('rejects a quantified group that contains a quantifier', () => {
    expect(isSafeRegexSource('(a+)+')).toBe(false);
    expect(isSafeRegexSource('(\\s*\\w*)*')).toBe(false);
    expect(isSafeRegexSource('^(x|y+)+$')).toBe(false);
    expect(isSafeRegexSource('(a{2,})*')).toBe(false);
  });

  it('accepts a quantified group with no inner quantifier', () => {
    expect(isSafeRegexSource('(abc)+')).toBe(true);
    expect(isSafeRegexSource('^(a|b)*$')).toBe(true);
  });

  it('is not fooled by a quantifier inside a character class or an escape', () => {
    expect(isSafeRegexSource('([+*])+')).toBe(true);
    expect(isSafeRegexSource('(\\+)+')).toBe(true);
  });

  it('rejects an over-long source', () => {
    expect(isSafeRegexSource('a'.repeat(LIMITS.MAX_MATCHER_CHARS + 1))).toBe(false);
  });

  it('an unsafe pattern makes its rule never fire, rather than throwing', () => {
    const hostile: Manifest = {
      agent: 'claude', version: 1,
      signatures: [{ kind: 'contains', value: 'MARKER' }],
      rules: [{
        id: 'hostile', state: 'blocked', priority: 9999,
        region: { id: 'whole_recent' },
        all: [{ kind: 'lineRegex', value: '^(a+)+$' }],
      }],
    };
    const out = detectScreen({ lines: ['MARKER', 'a'.repeat(40)] }, [hostile]);
    expect(out.state).toBe('unknown');
    expect(out.reason).toBe('no-rule-matched');
  });

  it('an invalid pattern likewise degrades instead of throwing', () => {
    const broken: Manifest = {
      agent: 'claude', version: 1,
      signatures: [{ kind: 'contains', value: 'MARKER' }],
      rules: [{
        id: 'broken', state: 'idle', priority: 1,
        region: { id: 'whole_recent' },
        all: [{ kind: 'lineRegex', value: '([unclosed' }],
      }],
    };
    expect(() => detectScreen({ lines: ['MARKER'] }, [broken])).not.toThrow();
    expect(detectScreen({ lines: ['MARKER'] }, [broken]).state).toBe('unknown');
  });

  it('caps the line length fed to a matcher', () => {
    const manifest: Manifest = {
      agent: 'claude', version: 1,
      signatures: [{ kind: 'contains', value: 'MARKER' }],
      rules: [{
        id: 'tail', state: 'idle', priority: 1,
        region: { id: 'whole_recent' },
        all: [{ kind: 'contains', value: 'NEEDLE' }],
      }],
    };
    // The needle sits past MAX_LINE_CHARS, so it is not seen — a wrapped paste
    // that long cannot be agent chrome.
    const line = `${'x'.repeat(LIMITS.MAX_LINE_CHARS + 10)}NEEDLE`;
    expect(detectScreen({ lines: ['MARKER', line] }, [manifest]).state).toBe('unknown');
  });
});

// ─── Rule hygiene, enforced rather than reviewed ─────────────────────────────

describe('bundled manifests', () => {
  const allRules = BUNDLED_MANIFESTS.flatMap((m) => m.rules.map((r) => ({ agent: m.agent, rule: r })));

  it('every rule id is unique and namespaced to its agent', () => {
    const seen = new Set<string>();
    for (const { agent, rule } of allRules) {
      expect(seen.has(rule.id), `duplicate ${rule.id}`).toBe(false);
      seen.add(rule.id);
      expect(rule.id.startsWith(`${agent}.`), `${rule.id} must start with "${agent}."`).toBe(true);
    }
  });

  /** A rule with no matchers would fire on every screen. */
  it('every rule has at least one positive matcher', () => {
    for (const { rule } of allRules) {
      expect((rule.all?.length ?? 0) + (rule.any?.length ?? 0), rule.id).toBeGreaterThan(0);
    }
  });

  it('blocked rules outrank working rules, which outrank idle rules', () => {
    for (const manifest of BUNDLED_MANIFESTS) {
      const top = (state: string) => Math.max(
        0, ...manifest.rules.filter((r) => r.state === state).map((r) => r.priority),
      );
      const blocked = top('blocked');
      const working = top('working');
      const idle = top('idle');
      if (blocked && working) expect(blocked, manifest.agent).toBeGreaterThan(working);
      if (working && idle) expect(working, manifest.agent).toBeGreaterThan(idle);
      if (blocked && idle) expect(blocked, manifest.agent).toBeGreaterThan(idle);
    }
  });

  it('stays inside the rule cap', () => {
    for (const manifest of BUNDLED_MANIFESTS) {
      expect(manifest.rules.length, manifest.agent).toBeLessThanOrEqual(LIMITS.MAX_RULES);
    }
  });

  it('every manifest can identify itself from a screen', () => {
    for (const manifest of BUNDLED_MANIFESTS) {
      expect(manifest.signatures.length, manifest.agent).toBeGreaterThan(0);
    }
  });
});

/**
 * The OSC title is a real input now, not a typed-but-never-filled field.
 *
 * wmux threw every OSC 0/2 away until phase 4 — `onTitleChange` had zero
 * occurrences in src/ — so a `region: { id: 'osc_title' }` rule could be written
 * and could never fire. These pin the path itself; no bundled manifest keys on
 * a title yet, because no agent's title has actually been captured under
 * ConPTY to key on.
 */
describe('detectScreen — OSC title as evidence', () => {
  const titleManifest: Manifest = {
    agent: 'claude',
    version: 1,
    signatures: [{ kind: 'contains', value: 'Claude Code', ignoreCase: true }],
    rules: [{
      id: 'claude.working.title',
      state: 'working',
      priority: 900,
      region: { id: 'osc_title' },
      all: [{ kind: 'contains', value: 'running', ignoreCase: true }],
    }],
  };

  it('identifies an agent from the title alone, with nothing on screen', () => {
    const out = detectScreen({ lines: ['$ '], title: '✳ Claude Code' }, [titleManifest]);
    expect(out.agent).toBe('claude');
  });

  it('fires a title-region rule', () => {
    const out = detectScreen(
      { lines: ['$ '], title: 'Claude Code — running' },
      [titleManifest],
    );
    expect(out).toMatchObject({ state: 'working', ruleId: 'claude.working.title' });
  });

  it('a title-region rule cannot be satisfied by matching screen text', () => {
    // "running" is on screen but NOT in the title — the region must be honoured.
    const out = detectScreen(
      { lines: ['Claude Code', 'running something'], title: 'Claude Code' },
      [titleManifest],
    );
    expect(out.state).toBe('unknown');
    expect(out.reason).toBe('no-rule-matched');
  });

  it('a screen with no content but a title is not treated as empty', () => {
    const out = detectScreen({ lines: [], title: 'Claude Code' }, [titleManifest]);
    expect(out.reason).not.toBe('empty-screen');
    expect(out.agent).toBe('claude');
  });

  it('no title is simply no evidence, never a crash', () => {
    expect(() => detectScreen({ lines: ['Claude Code'] }, [titleManifest])).not.toThrow();
    expect(detectScreen({ lines: ['Claude Code'], title: null }, [titleManifest]).state).toBe('unknown');
  });
});
