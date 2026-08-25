import { describe, it, expect } from 'vitest';
import { resolveAgentBrowserBinary, AGENT_BROWSER_NAMES } from '../../src/main/agent-browser-cli';

/** A fake filesystem probe: only the listed absolute paths "exist". */
function existsIn(paths: string[]) {
  return (p: string) => paths.includes(p.replace(/\\/g, '/'));
}

/**
 * Normalise a resolved path for comparison only.
 *
 * `path.join` runs against the HOST OS (these tests run on win32), so any
 * candidate built via `path.join` comes back with backslashes even when it
 * represents a posix location — exactly like `node-runtime.ts`, resolution is
 * only ever exercised for the machine it actually runs on. `existsIn` already
 * normalises on the lookup side; do the same here so the assertion still
 * proves the right directory and the right basename won, without caring which
 * separator style `path.join` happened to emit.
 */
function norm(p: string | null): string | null {
  return p === null ? null : p.replace(/\\/g, '/');
}

describe('resolveAgentBrowserBinary', () => {
  it('prefers an explicit configured path over everything else', () => {
    const found = resolveAgentBrowserBinary({
      configured: 'C:/tools/agent-browser.cmd',
      env: { APPDATA: 'C:/Users/x/AppData/Roaming' },
      platform: 'win32',
      exists: existsIn(['C:/tools/agent-browser.cmd', 'C:/Users/x/AppData/Roaming/npm/agent-browser.cmd']),
    });
    expect(norm(found)).toBe('C:/tools/agent-browser.cmd');
  });

  it('finds the npm global .cmd shim on Windows', () => {
    const found = resolveAgentBrowserBinary({
      env: { APPDATA: 'C:/Users/x/AppData/Roaming' },
      platform: 'win32',
      exists: existsIn(['C:/Users/x/AppData/Roaming/npm/agent-browser.cmd']),
    });
    expect(norm(found)).toBe('C:/Users/x/AppData/Roaming/npm/agent-browser.cmd');
  });

  it('finds the extensionless binary on posix', () => {
    const found = resolveAgentBrowserBinary({
      env: { HOME: '/home/x' },
      platform: 'linux',
      exists: existsIn(['/usr/local/bin/agent-browser']),
    });
    expect(norm(found)).toBe('/usr/local/bin/agent-browser');
  });

  it('returns null when nothing is installed', () => {
    const found = resolveAgentBrowserBinary({
      env: { APPDATA: 'C:/Users/x/AppData/Roaming' },
      platform: 'win32',
      exists: () => false,
    });
    expect(found).toBeNull();
  });

  it('ignores a configured path that does not exist', () => {
    const found = resolveAgentBrowserBinary({
      configured: 'C:/gone/agent-browser.cmd',
      env: {},
      platform: 'win32',
      exists: () => false,
    });
    expect(found).toBeNull();
  });

  it('prefers .cmd over .exe over bare on win32', () => {
    expect(AGENT_BROWSER_NAMES('win32')).toEqual(['agent-browser.cmd', 'agent-browser.exe', 'agent-browser']);
  });
});
