import { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '../../i18n';
import { renderMarkdown } from '../Markdown/markdown-utils';
import { openInWmuxBrowser } from '../../utils/open-in-browser';

/**
 * The Changelog tab (issue #211) — "a small dedicated menu to preview recent
 * releases and read each of them".
 *
 * A list of versions on the left, the selected release's notes on the right.
 * Main owns the fetching and the cache; this component owns which one is open.
 *
 * Two things here are deliberate rather than incidental:
 *
 * **The notes go through `renderMarkdown`, the same one MarkdownPane uses.**
 * That function is the security boundary — it is where DOMPurify runs — and
 * this content comes off the network, so it is the one place in wmux where
 * that matters most. Rendering it any other way, including "it's just our own
 * release notes", would be reintroducing the hole that function exists to
 * close.
 *
 * **Links open in wmux's own browser panel**, not by injecting an anchor that
 * navigates the settings window. A renderer that navigates away from the app
 * shell does not come back.
 */
interface ChangelogEntry {
  version: string;
  tag: string;
  name: string;
  publishedAt: string | null;
  url: string;
  body: string;
  prerelease: boolean;
}

interface ChangelogResult {
  entries: ChangelogEntry[];
  fetchedAt: number | null;
  stale: boolean;
  currentVersion: string;
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleDateString();
}

export default function ChangelogSettings() {
  const t = useT();
  const [result, setResult] = useState<ChangelogResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback((refresh: boolean) => {
    const api = (window as any).wmux?.changelog;
    if (!api?.get) { setLoading(false); return; }
    setLoading(true);
    api.get({ refresh })
      .then((res: ChangelogResult) => {
        setResult(res);
        // Only on the FIRST load. A Refresh must not throw the user back to the
        // newest release when they were three entries down reading one.
        setSelected((prev) => prev ?? res.entries[0]?.version ?? null);
      })
      .catch(() => setResult(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(false); }, [load]);

  const entries = result?.entries ?? [];
  const active = entries.find((e) => e.version === selected) ?? entries[0] ?? null;

  // Memoised on the BODY, not on the entry: re-parsing and re-sanitising a
  // 40k-character release note on every unrelated re-render is not free.
  const html = useMemo(() => (active ? renderMarkdown(active.body) : ''), [active?.body]);

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t('settings.changelog.title', 'Changelog')}</h3>
      <p className="settings-hint settings-hint--lead">
        {t('settings.changelog.hint', 'Release notes for recent versions of wmux, read from GitHub and cached so they stay readable offline.')}
      </p>

      <div className="settings-row">
        <button className="settings-button" onClick={() => load(true)} disabled={loading}>
          {loading ? t('settings.changelog.loading', 'Loading…') : t('settings.changelog.refresh', 'Refresh')}
        </button>
        {result?.stale && (
          <span className="settings-hint changelog__stale">
            {t('settings.changelog.offline', 'Showing the last copy — GitHub could not be reached.')}
          </span>
        )}
      </div>

      {!loading && entries.length === 0 && (
        <p className="settings-hint">
          {t('settings.changelog.empty', 'No release notes yet. Connect to the internet and press Refresh.')}
        </p>
      )}

      {entries.length > 0 && (
        <div className="changelog">
          <div className="changelog__list">
            {entries.map((e) => (
              <button
                key={e.version}
                className={`changelog__item ${active?.version === e.version ? 'changelog__item--active' : ''}`}
                onClick={() => setSelected(e.version)}
              >
                <span className="changelog__version">{e.tag}</span>
                <span className="changelog__date">{formatDate(e.publishedAt)}</span>
                {/* "You are here" — the reason to open this panel is usually to
                    find out what you just updated INTO. */}
                {result && e.version === result.currentVersion && (
                  <span className="changelog__badge">{t('settings.changelog.installed', 'installed')}</span>
                )}
                {e.prerelease && (
                  <span className="changelog__badge changelog__badge--pre">{t('settings.changelog.prerelease', 'pre')}</span>
                )}
              </button>
            ))}
          </div>

          <div className="changelog__notes">
            {active && (
              <>
                <div className="changelog__notes-head">
                  <h4>{active.name}</h4>
                  <button className="settings-button" onClick={() => openInWmuxBrowser(active.url)}>
                    {t('settings.changelog.openOnGithub', 'Open on GitHub')}
                  </button>
                </div>
                {active.body.trim()
                  ? <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
                  : <p className="settings-hint">{t('settings.changelog.noNotes', 'This release has no notes.')}</p>}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
