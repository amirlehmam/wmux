import { useState, useEffect } from 'react';
import { useT } from '../../i18n';
import type { TranslationKey } from '../../i18n';

/**
 * Settings → General → Agent integration (issue #132).
 *
 * wmux writes into ~/.claude and ~/.config/opencode so coding agents can drive
 * its browser panel, markdown views and sidebar. It used to do that silently on
 * every launch, which made deleting any of it pointless — the next launch put it
 * straight back. This panel is the "you can change your mind" half of the fix:
 * the first-launch dialog asks, and this is where the answer lives afterwards.
 *
 * State is read back from the main process rather than mirrored locally, for the
 * same reason the Explorer context-menu toggle above it does: the user can edit
 * or delete those files by hand at any moment, and a checkbox that confidently
 * reflects a cached preference rather than the disk is worse than no checkbox.
 */

type Feature = 'instructions' | 'hooks' | 'orchestrator' | 'browserMcp';

interface Consent {
  decision: 'unset' | 'granted' | 'declined';
  features: Record<Feature, boolean>;
}

/** What this panel sends back: a decision, or a single flipped checkbox. */
interface ConsentPatch {
  decision?: Consent['decision'];
  features?: Partial<Record<Feature, boolean>>;
}

const FEATURES: Array<{ key: Feature; labelKey: TranslationKey; labelFallback: string; pathHint: string }> = [
  {
    key: 'instructions',
    labelKey: 'settings.integration.instructions',
    labelFallback: 'Agent instructions',
    pathHint: '~/.claude/CLAUDE.md · ~/.config/opencode/AGENTS.md',
  },
  {
    key: 'hooks',
    labelKey: 'settings.integration.hooks',
    labelFallback: 'Status hooks',
    pathHint: '~/.claude/settings.json',
  },
  {
    key: 'orchestrator',
    labelKey: 'settings.integration.orchestrator',
    labelFallback: 'Orchestrator plugin',
    pathHint: '~/.claude/plugins/ · ~/.config/opencode/plugin/',
  },
  {
    key: 'browserMcp',
    labelKey: 'settings.integration.browserMcp',
    labelFallback: 'Browser panel for MCP',
    pathHint: '~/.claude/settings.json',
  },
];

export default function AgentIntegrationSettings() {
  const t = useT();
  const [consent, setConsent] = useState<Consent | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.wmux?.integration?.get?.()
      .then((c: unknown) => { if (!cancelled) setConsent(c as Consent); })
      .catch(() => { /* main unreachable — leave the panel in its loading state */ });
    return () => { cancelled = true; };
  }, []);

  // Trust what main reports back over what was requested: applying a change also
  // adds or removes files, and a partial failure must leave the checkboxes
  // showing what actually happened.
  const push = async (partial: ConsentPatch) => {
    setBusy(true);
    try {
      const next = await window.wmux?.integration?.set?.(partial);
      if (next) setConsent(next as Consent);
    } catch {
      /* leave the previous state visible rather than inventing one */
    } finally {
      setBusy(false);
    }
  };

  const enabled = consent?.decision === 'granted';

  return (
    <>
      <div className="settings-divider" />
      <h3 className="settings-section-title">
        {t('settings.integration.section', 'Agent integration')}
      </h3>

      <div className="settings-row">
        <label className="settings-label">
          {t('settings.integration.enable', 'Let wmux configure Claude Code and OpenCode')}
        </label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={enabled}
          disabled={busy || consent === null}
          onChange={(e) => push({ decision: e.target.checked ? 'granted' : 'declined' })}
        />
      </div>

      <p className="settings-hint">
        {t(
          'settings.integration.hint',
          'wmux edits files in your home directory so coding agents can drive its browser panel, markdown views and sidebar status. Turning something off here also removes what it wrote.',
        )}
      </p>

      {FEATURES.map((f) => (
        <div className="settings-row" key={f.key}>
          <label className="settings-label">
            {t(f.labelKey, f.labelFallback)}
            <span className="settings-hint" style={{ display: 'block', opacity: 0.65 }}>{f.pathHint}</span>
          </label>
          <input
            type="checkbox"
            className="settings-toggle"
            checked={!!consent?.features?.[f.key] && enabled}
            // Sub-features of an integration that is off are not merely
            // unchecked, they are meaningless — disable them rather than let
            // one be ticked while nothing it controls can run.
            disabled={busy || !enabled}
            onChange={(e) => push({ features: { [f.key]: e.target.checked } })}
          />
        </div>
      ))}
    </>
  );
}
