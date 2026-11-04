import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// The writers into the user's home are the boundary here, as in
// pi-integration-consent.test.ts: what is under test is which decision reaches
// the WSL hooks (#428), not the files (wsl-claude-hooks.test.ts covers those).
vi.mock('../../src/main/claude-context', () => ({
  ensureClaudeContext: vi.fn(), ensureClaudeHooks: vi.fn(), ensureChromeDevtoolsConfig: vi.fn(),
  removeClaudeContext: vi.fn(), removeClaudeHooks: vi.fn(), removeChromeDevtoolsConfig: vi.fn(),
  removeOrchestratorPlugin: vi.fn(),
}));
vi.mock('../../src/main/opencode-context', () => ({
  ensureOpencodeContext: vi.fn(), ensureOpencodePlugin: vi.fn(),
  removeOpencodeContext: vi.fn(), removeOpencodePlugin: vi.fn(),
}));
vi.mock('../../src/main/kiro-context', () => ({ ensureKiroContext: vi.fn(), removeKiroContext: vi.fn() }));
vi.mock('../../src/main/omp-context', () => ({
  ensureOmpContext: vi.fn(), removeOmpContext: vi.fn(), ensureOmpExtension: vi.fn(), removeOmpExtension: vi.fn(),
}));
vi.mock('../../src/main/grok-context', () => ({
  ensureGrokContext: vi.fn(), ensureGrokHooks: vi.fn(), removeGrokContext: vi.fn(), removeGrokHooks: vi.fn(),
}));
vi.mock('../../src/main/agy-context', () => ({ ensureAgyPlugin: vi.fn(), removeAgyPlugin: vi.fn() }));
vi.mock('../../src/main/qwen-context', () => ({
  ensureQwenContext: vi.fn(), ensureQwenHooks: vi.fn(), ensureQwenMcp: vi.fn(),
  removeQwenContext: vi.fn(), removeQwenHooks: vi.fn(), removeQwenMcp: vi.fn(),
}));
vi.mock('../../src/main/pi-context', () => ({
  ensurePiExtension: vi.fn(), removePiExtension: vi.fn(), removePiContext: vi.fn(),
}));
vi.mock('../../src/main/wsl-claude-hooks', () => ({ setWslClaudeHooksWanted: vi.fn() }));

import { applyConsent, INTEGRATION_CONSENT_DETAIL } from '../../src/main/agent-integration';
import { setWslClaudeHooksWanted } from '../../src/main/wsl-claude-hooks';

beforeEach(() => vi.clearAllMocks());

const features = (hooks: boolean) => ({ instructions: true, hooks, orchestrator: true, browserMcp: true });

describe('the consent gate drives the WSL hooks (#428)', () => {
  it('installs them only when hooks are granted', () => {
    applyConsent({ decision: 'granted', features: features(true) });
    expect(setWslClaudeHooksWanted).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('takes them back when hooks are switched off or the integration is declined', () => {
    applyConsent({ decision: 'granted', features: features(false) });
    expect(setWslClaudeHooksWanted).toHaveBeenLastCalledWith(false);
    applyConsent({ decision: 'declined', features: features(true) });
    expect(setWslClaudeHooksWanted).toHaveBeenLastCalledWith(false);
    expect(setWslClaudeHooksWanted).toHaveBeenCalledTimes(2);
  });

  it('does nothing either way while the question is unanswered', () => {
    applyConsent({ decision: 'unset', features: features(true) });
    expect(setWslClaudeHooksWanted).not.toHaveBeenCalled();
  });

  it('is disclosed in the dialog and beside the toggle', () => {
    expect(INTEGRATION_CONSENT_DETAIL).toContain('WSL distro');
    const panel = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/components/Settings/AgentIntegrationSettings.tsx'), 'utf-8',
    );
    expect(panel).toContain('running WSL distros');
  });

  it('is reached only through the gate: no other module sets it', () => {
    const mainDir = path.resolve(__dirname, '../../src/main');
    const callers = fs.readdirSync(mainDir)
      .filter((f) => f.endsWith('.ts') && f !== 'wsl-claude-hooks.ts')
      .filter((f) => fs.readFileSync(path.join(mainDir, f), 'utf-8').includes('setWslClaudeHooksWanted'));
    expect(callers).toEqual(['agent-integration.ts']);
  });
});
