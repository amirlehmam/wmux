import { describe, it, expect } from 'vitest';
import { resolveAgentBrowserBinary, AGENT_BROWSER_NAMES, platformBinaryName } from '../../src/main/agent-browser-cli';

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

describe('platformBinaryName', () => {
  it('names the npm package\'s native win32/x64 binary', () => {
    expect(platformBinaryName('win32', 'x64')).toBe('agent-browser-win32-x64.exe');
  });

  it('names the npm package\'s native darwin/arm64 binary (no extension)', () => {
    expect(platformBinaryName('darwin', 'arm64')).toBe('agent-browser-darwin-arm64');
  });
});

describe('resolveAgentBrowserBinary', () => {
  it('prefers an explicit configured path over everything else', () => {
    const found = resolveAgentBrowserBinary({
      configured: 'C:/tools/agent-browser.cmd',
      env: { APPDATA: 'C:/Users/x/AppData/Roaming' },
      platform: 'win32',
      arch: 'x64',
      exists: existsIn(['C:/tools/agent-browser.cmd', 'C:/Users/x/AppData/Roaming/npm/agent-browser.cmd']),
    });
    expect(norm(found)).toBe('C:/tools/agent-browser.cmd');
  });

  it("finds the npm package's native binary in the npm global root", () => {
    const npmPkgBinary = 'C:/Users/x/AppData/Roaming/npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe';
    const found = resolveAgentBrowserBinary({
      env: { APPDATA: 'C:/Users/x/AppData/Roaming' },
      platform: 'win32',
      arch: 'x64',
      exists: existsIn([npmPkgBinary]),
    });
    expect(norm(found)).toBe(npmPkgBinary);
  });

  it('prefers the npm package native binary over a bare shim/binary on PATH', () => {
    const npmPkgBinary = 'C:/Users/x/AppData/Roaming/npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe';
    const onPath = 'C:/somewhere/on/path/agent-browser.exe';
    const found = resolveAgentBrowserBinary({
      env: { APPDATA: 'C:/Users/x/AppData/Roaming', PATH: 'C:/somewhere/on/path' },
      platform: 'win32',
      arch: 'x64',
      exists: existsIn([npmPkgBinary, onPath]),
    });
    expect(norm(found)).toBe(npmPkgBinary);
  });

  it('finds a bare extensionless binary on posix', () => {
    const found = resolveAgentBrowserBinary({
      env: { HOME: '/home/x' },
      platform: 'linux',
      arch: 'x64',
      exists: existsIn(['/usr/local/bin/agent-browser']),
    });
    expect(norm(found)).toBe('/usr/local/bin/agent-browser');
  });

  it('returns null when nothing is installed', () => {
    const found = resolveAgentBrowserBinary({
      env: { APPDATA: 'C:/Users/x/AppData/Roaming' },
      platform: 'win32',
      arch: 'x64',
      exists: () => false,
    });
    expect(found).toBeNull();
  });

  it('ignores a configured path that does not exist', () => {
    const found = resolveAgentBrowserBinary({
      configured: 'C:/gone/agent-browser.cmd',
      env: {},
      platform: 'win32',
      arch: 'x64',
      exists: () => false,
    });
    expect(found).toBeNull();
  });

  it('does not resolve a lone .cmd shim (EINVAL regression guard)', () => {
    // Node throws a synchronous EINVAL spawning a .bat/.cmd without
    // shell: true (CVE-2024-27980) — see AGENT_BROWSER_NAMES's header comment.
    // A .cmd sitting alone (no npm-package native binary present) must never
    // be treated as a resolvable candidate.
    const found = resolveAgentBrowserBinary({
      env: { APPDATA: 'C:/Users/x/AppData/Roaming' },
      platform: 'win32',
      arch: 'x64',
      exists: existsIn(['C:/Users/x/AppData/Roaming/npm/agent-browser.cmd']),
    });
    expect(found).toBeNull();
  });

  it('names only the native .exe on win32 — no .cmd, no extensionless', () => {
    expect(AGENT_BROWSER_NAMES('win32')).toEqual(['agent-browser.exe']);
  });
});
