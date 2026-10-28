import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { applyConsent } from '../../src/main/agent-integration';
import { ensurePiExtension, removePiContext, removePiExtension } from '../../src/main/pi-context';

beforeEach(() => vi.clearAllMocks());

describe('Pi instruction and hook consent', () => {
  it.each([
    { instructions: true, hooks: true },
    { instructions: true, hooks: false },
    { instructions: false, hooks: true },
    { instructions: false, hooks: false },
  ])('reconciles one extension for %j', (features) => {
    applyConsent({ decision: 'granted', features: { ...features, orchestrator: false, browserMcp: false } });
    if (features.instructions || features.hooks) {
      expect(ensurePiExtension).toHaveBeenCalledExactlyOnceWith(features);
      expect(removePiExtension).not.toHaveBeenCalled();
    } else {
      expect(ensurePiExtension).not.toHaveBeenCalled();
      expect(removePiExtension).toHaveBeenCalledOnce();
    }
    expect(removePiContext).toHaveBeenCalledOnce();
  });

  it.each(['unset', 'declined'] as const)('respects the overall %s decision', (decision) => {
    applyConsent({ decision, features: { instructions: true, hooks: true, orchestrator: false, browserMcp: false } });
    expect(ensurePiExtension).not.toHaveBeenCalled();
    expect(removePiExtension).toHaveBeenCalledTimes(decision === 'declined' ? 1 : 0);
    expect(removePiContext).toHaveBeenCalledTimes(decision === 'declined' ? 1 : 0);
  });
});
