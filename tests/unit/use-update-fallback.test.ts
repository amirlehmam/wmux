import { describe, it, expect } from 'vitest';
import { fallbackReleaseUrl } from '../../src/renderer/hooks/useUpdate';

// The release page is the fallback whenever main answers `handled: false`.
// The renderer's own release info comes from the notify-only poller and can be
// missing (an update started from Help before it answered), so a fallback that
// only reads it opens nothing and the click looks dead (#3).
describe('fallbackReleaseUrl', () => {
  const cached = { version: '9.9.8', url: 'https://github.com/amirlehmam/wmux/releases/tag/v9.9.8' };
  const fromMain = 'https://github.com/amirlehmam/wmux/releases/tag/v9.9.9';

  it('prefers the page main names', () => {
    expect(fallbackReleaseUrl({ handled: false, reason: 'install_failed', url: fromMain }, cached)).toBe(fromMain);
  });

  it('opens something even when the poller never answered', () => {
    expect(fallbackReleaseUrl({ handled: false, reason: 'install_failed', url: fromMain }, null)).toBe(fromMain);
  });

  it('falls back to the cached release when main names none', () => {
    expect(fallbackReleaseUrl({ handled: false, reason: 'error' }, cached)).toBe(cached.url);
    expect(fallbackReleaseUrl(undefined, cached)).toBe(cached.url);
  });

  it('has nothing to open when neither knows a page', () => {
    expect(fallbackReleaseUrl({ handled: false, reason: 'error' }, null)).toBeNull();
  });
});
