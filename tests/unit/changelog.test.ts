import { describe, it, expect, vi } from 'vitest';

// changelog.ts imports `electron` for `app`/`net`; only the pure mapper is
// under test here, so the module is stubbed rather than the test being skipped.
vi.mock('electron', () => ({
  app: { getVersion: () => '2.8.0' },
  net: { request: () => { throw new Error('not used in these tests'); } },
}));

const { toChangelogEntries, CHANGELOG_LIMIT } = await import('../../src/main/changelog');

// ─────────────────────────────────────────────────────────────────────────────
// Issue #211 — release notes in the app.
//
// Everything that can be wrong about a changelog lives in this mapper: drafts
// that must not appear, a `body` that is null rather than absent, a `name` that
// is empty on a release published from a bare tag, and ORDER — the API returns
// releases by creation date, which stops being version order the moment a patch
// for an older line ships after a newer minor.
// ─────────────────────────────────────────────────────────────────────────────

const release = (over: Record<string, unknown> = {}) => ({
  tag_name: 'v2.7.0',
  name: 'v2.7.0',
  html_url: 'https://github.com/amirlehmam/wmux/releases/tag/v2.7.0',
  body: '## Fixed\n- a thing',
  published_at: '2026-08-29T03:36:00Z',
  draft: false,
  prerelease: false,
  ...over,
});

describe('toChangelogEntries', () => {
  it('maps a release onto what the panel shows', () => {
    expect(toChangelogEntries([release()])).toEqual([{
      version: '2.7.0',            // no leading v, so it compares to app.getVersion()
      tag: 'v2.7.0',
      name: 'v2.7.0',
      publishedAt: '2026-08-29T03:36:00Z',
      url: 'https://github.com/amirlehmam/wmux/releases/tag/v2.7.0',
      body: '## Fixed\n- a thing',
      prerelease: false,
    }]);
  });

  it('sorts by VERSION, not by the order the API returned', () => {
    // A 2.6.1 patch published after 2.7.0 comes back first from the API and
    // must not appear above it in the list.
    const out = toChangelogEntries([
      release({ tag_name: 'v2.6.1' }),
      release({ tag_name: 'v2.7.0' }),
      release({ tag_name: 'v2.10.0' }),
      release({ tag_name: 'v2.9.0' }),
    ]);
    expect(out.map((e) => e.tag)).toEqual(['v2.10.0', 'v2.9.0', 'v2.7.0', 'v2.6.1']);
  });

  it('drops drafts but keeps prereleases, labelled', () => {
    const out = toChangelogEntries([
      release({ tag_name: 'v3.0.0-rc1', prerelease: true }),
      release({ tag_name: 'v2.9.9', draft: true }),
    ]);
    expect(out.map((e) => e.tag)).toEqual(['v3.0.0-rc1']);
    expect(out[0].prerelease).toBe(true);
  });

  it('falls back to the tag when the release has no title', () => {
    // Most of wmux's releases are published from a bare tag, so `name` is the
    // empty string rather than absent — which `??` would happily keep.
    expect(toChangelogEntries([release({ name: '' })])[0].name).toBe('v2.7.0');
    expect(toChangelogEntries([release({ name: '   ' })])[0].name).toBe('v2.7.0');
    expect(toChangelogEntries([release({ name: undefined })])[0].name).toBe('v2.7.0');
  });

  it('turns a null body into an empty string, not the text "null"', () => {
    expect(toChangelogEntries([release({ body: null })])[0].body).toBe('');
  });

  it('caps one pathological release rather than shipping it whole to the renderer', () => {
    const body = toChangelogEntries([release({ body: 'x'.repeat(200_000) })])[0].body;
    expect(body.length).toBeLessThanOrEqual(40_000);
  });

  it('limits how many releases come back', () => {
    const many = Array.from({ length: 60 }, (_, i) => release({ tag_name: `v1.0.${i}` }));
    expect(toChangelogEntries(many)).toHaveLength(CHANGELOG_LIMIT);
  });

  it('answers with an empty list for anything that is not an array of releases', () => {
    // The API answers with an OBJECT on an error (`{message, documentation_url}`),
    // and a rate-limited wmux must show "nothing yet", not throw inside Settings.
    expect(toChangelogEntries(null)).toEqual([]);
    expect(toChangelogEntries({ message: 'API rate limit exceeded' })).toEqual([]);
    expect(toChangelogEntries([null, undefined, {}, { tag_name: 5 }])).toEqual([]);
  });
});
