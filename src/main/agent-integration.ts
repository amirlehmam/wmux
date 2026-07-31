/**
 * Consent gate for everything wmux writes outside its own directory (issue #132).
 *
 * wmux integrates with Claude Code and OpenCode by editing files in the user's
 * home: it appends a block to ~/.claude/CLAUDE.md and
 * ~/.config/opencode/AGENTS.md, registers four hooks in
 * ~/.claude/settings.json, points chrome-devtools-mcp at its own CDP proxy, and
 * installs the orchestrator plugin into Claude Code's plugin cache.
 *
 * All of that used to happen unconditionally on every launch, with no prompt and
 * no record of a decision — so deleting any of it was futile, because the next
 * launch simply put it back. As #132 put it, the app modifies global config
 * "without permission and/or warning". Idempotence and consent pull in opposite
 * directions, and the code only implemented the first.
 *
 * The fix is a decision stored in wmux's OWN settings file (%APPDATA%\wmux),
 * never in the files being written:
 *
 *   unset     nothing has been written yet; ask on first launch
 *   granted   apply the features that are switched on
 *   declined  write nothing, and take back anything a previous version wrote
 *
 * `declined` is deliberately sticky and re-asserted on every launch: a user who
 * says no once should not have to say it again after an update, and should not
 * have to hand-delete the leftovers either.
 */
import {
  ensureClaudeContext,
  ensureClaudeHooks,
  ensureChromeDevtoolsConfig,
  ensureOrchestratorPlugin,
  removeClaudeContext,
  removeClaudeHooks,
  removeChromeDevtoolsConfig,
  removeOrchestratorPlugin,
} from './claude-context';
import {
  ensureOpencodeContext,
  ensureOpencodePlugin,
  removeOpencodeContext,
  removeOpencodePlugin,
} from './opencode-context';
import { loadSettings, saveSetting } from './settings-store';

export type IntegrationDecision = 'unset' | 'granted' | 'declined';

/**
 * The four things wmux writes, split the way a user would reason about them
 * rather than the way the code is organised — each one is independently useful
 * and independently refusable.
 */
export type IntegrationFeature = 'instructions' | 'hooks' | 'orchestrator' | 'browserMcp';

export const INTEGRATION_FEATURES: IntegrationFeature[] = [
  'instructions',
  'hooks',
  'orchestrator',
  'browserMcp',
];

export interface IntegrationConsent {
  decision: IntegrationDecision;
  features: Record<IntegrationFeature, boolean>;
  decidedAt?: number;
}

const SETTINGS_KEY = 'agentIntegration';

/** Every feature on: what "yes" means, and what every pre-0.40 install already had. */
const ALL_ON: Record<IntegrationFeature, boolean> = {
  instructions: true,
  hooks: true,
  orchestrator: true,
  browserMcp: true,
};

export const DEFAULT_CONSENT: IntegrationConsent = { decision: 'unset', features: { ...ALL_ON } };

/**
 * Normalise whatever is on disk into a usable consent record.
 *
 * Anything unrecognised falls back to `unset` — i.e. to *asking* — rather than
 * to granting. A corrupted settings file must not be a silent yes on the user's
 * behalf, which is the whole complaint in #132.
 */
export function parseConsent(raw: unknown): IntegrationConsent {
  if (!raw || typeof raw !== 'object') return { decision: 'unset', features: { ...ALL_ON } };
  const obj = raw as Record<string, unknown>;
  const decision: IntegrationDecision =
    obj.decision === 'granted' || obj.decision === 'declined' ? obj.decision : 'unset';
  const storedFeatures = (obj.features ?? {}) as Record<string, unknown>;
  const features = { ...ALL_ON };
  for (const feature of INTEGRATION_FEATURES) {
    // Only an explicit `false` turns a feature off. A key added by a later
    // version is missing from an older record, and must default to the same
    // thing a fresh grant would give it, not to off.
    if (storedFeatures[feature] === false) features[feature] = false;
  }
  return {
    decision,
    features,
    decidedAt: typeof obj.decidedAt === 'number' ? obj.decidedAt : undefined,
  };
}

export function readConsent(): IntegrationConsent {
  return parseConsent(loadSettings()[SETTINGS_KEY]);
}

export function writeConsent(consent: IntegrationConsent): void {
  saveSetting(SETTINGS_KEY, consent);
}

/** Apply one feature, or take it back. Split out so `applyConsent` reads as a table. */
function applyFeature(feature: IntegrationFeature, enabled: boolean): void {
  switch (feature) {
    case 'instructions':
      if (enabled) { ensureClaudeContext(); ensureOpencodeContext(); }
      else { removeClaudeContext(); removeOpencodeContext(); }
      break;
    case 'hooks':
      if (enabled) ensureClaudeHooks();
      else removeClaudeHooks();
      break;
    case 'orchestrator':
      if (enabled) { ensureOrchestratorPlugin(); ensureOpencodePlugin(); }
      else { removeOrchestratorPlugin(); removeOpencodePlugin(); }
      break;
    case 'browserMcp':
      if (enabled) ensureChromeDevtoolsConfig();
      else removeChromeDevtoolsConfig();
      break;
  }
}

/**
 * Bring the user's agent config in line with their decision.
 *
 * `unset` writes nothing and removes nothing: the prompt has not been answered
 * yet, and touching either way would pre-empt it.
 *
 * Note that a `granted` decision still *removes* the features that are switched
 * off. Turning a feature off in Settings has to clean up after itself, or the
 * toggle only stops future writes and leaves the current ones in place — which
 * is the same "I deleted it and it came back" complaint one level down.
 */
export function applyConsent(consent: IntegrationConsent): void {
  if (consent.decision === 'unset') return;
  const granted = consent.decision === 'granted';
  for (const feature of INTEGRATION_FEATURES) {
    applyFeature(feature, granted && consent.features[feature]);
  }
}

/**
 * The first-run prompt. Returns the decision the user made, or `null` when
 * asking was not possible (no Electron, or a dialog that failed) — in which case
 * the caller leaves the decision `unset` and asks again next launch rather than
 * assuming an answer.
 *
 * Deliberately enumerates the exact paths. "wmux would like to integrate with
 * Claude Code" is not consent; naming the four files it will edit is.
 */
export async function promptForConsent(parent?: Electron.BrowserWindow): Promise<IntegrationDecision | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { dialog } = require('electron') as typeof import('electron');
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      buttons: ['Enable integration', 'Not now', 'Never'],
      defaultId: 0,
      cancelId: 1,
      title: 'wmux — agent integration',
      message: 'Let wmux set up Claude Code and OpenCode?',
      detail:
        'wmux can teach your coding agents to drive its browser panel, markdown views ' +
        'and sidebar status. Doing so edits files in your home directory:\n\n' +
        '  • ~/.claude/CLAUDE.md and ~/.config/opencode/AGENTS.md\n' +
        '      a wmux section, between markers, leaving your own text untouched\n' +
        '  • ~/.claude/settings.json\n' +
        '      four hooks that drive the sidebar and "needs you" notifications\n' +
        '  • ~/.claude/plugins/\n' +
        '      the wmux-orchestrator plugin\n' +
        '  • ~/.claude/settings.json\n' +
        '      chrome-devtools-mcp pointed at the browser panel instead of its own Chrome\n\n' +
        '"Not now" asks again next launch. "Never" writes nothing and removes anything ' +
        'a previous version added. You can change this any time, feature by feature, ' +
        'in Settings → General.',
      noLink: true,
    };
    // Parent it to the app window when there is one, so the question arrives
    // attached to the thing it is asking about rather than as a stray dialog.
    const result = parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    if (result.response === 0) return 'granted';
    if (result.response === 2) return 'declined';
    return null; // "Not now" — leave it unset and ask again next launch
  } catch (err) {
    console.warn('[wmux] Could not ask about agent integration:', err);
    return null;
  }
}

/**
 * Startup entry point: apply the standing decision, and ask for one if there
 * isn't any.
 *
 * The `unset` case is the interesting one. An install that predates this gate
 * already HAS every integration written — silently, which is the bug — so on
 * first launch of 0.40.0 there is no honest default. Asking is the answer, and
 * until it is answered nothing further is written; if the user says Never, the
 * removal path takes back what the older version put there.
 */
export async function initAgentIntegration(parent?: Electron.BrowserWindow): Promise<IntegrationConsent> {
  let consent = readConsent();
  if (consent.decision === 'unset') {
    const decision = await promptForConsent(parent);
    if (decision === null) return consent; // ask again next launch
    consent = { decision, features: { ...consent.features }, decidedAt: Date.now() };
    writeConsent(consent);
  }
  applyConsent(consent);
  return consent;
}

/**
 * Settings → General wrote a new decision: persist it and reconcile the files now.
 *
 * `features` is a *sparse* patch, not a whole record — the panel sends one
 * checkbox at a time. Typing it as `Partial<IntegrationConsent>` would say a
 * caller must supply all four, which is neither true nor what the UI does.
 */
export function updateConsent(partial: {
  decision?: IntegrationDecision;
  features?: Partial<Record<IntegrationFeature, boolean>>;
}): IntegrationConsent {
  const current = readConsent();
  const next: IntegrationConsent = {
    decision: partial.decision ?? current.decision,
    features: { ...current.features, ...(partial.features ?? {}) },
    decidedAt: Date.now(),
  };
  writeConsent(next);
  applyConsent(next);
  return next;
}
