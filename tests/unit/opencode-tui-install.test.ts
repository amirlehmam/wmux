import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  installOpencodeTui,
  isWmuxTuiFile,
  opencodeConfigDir,
  opencodePluginSourceDir,
  removeOpencodeTui,
  tuiNeedsUpdate,
  TUI_PLUGIN_VERSION_RE,
} from '../../src/cli/opencode-tui-install';
import { PLUGIN_VERSION_RE, pluginNeedsUpdate } from '../../src/main/agent-plugin-file';

/**
 * Issue #310 — installing the CLI-side (TUI) half from INSIDE the environment
 * that will host the TUI (WSL distro, devcontainer, native Windows), because
 * that is the only place `$HOME`/`$XDG_CONFIG_HOME` and the shipped files are
 * both reachable.
 */
describe('opencodeConfigDir (#310)', () => {
  it('honours an absolute XDG_CONFIG_HOME', () => {
    expect(opencodeConfigDir({ XDG_CONFIG_HOME: '/xdg' }, '/home/u')).toBe(path.join('/xdg', 'opencode'));
  });

  it('ignores a relative or blank XDG_CONFIG_HOME — the spec requires absolute', () => {
    expect(opencodeConfigDir({ XDG_CONFIG_HOME: 'relative' }, '/home/u')).toBe(path.join('/home/u', '.config', 'opencode'));
    expect(opencodeConfigDir({ XDG_CONFIG_HOME: '  ' }, '/home/u')).toBe(path.join('/home/u', '.config', 'opencode'));
  });

  it('falls back to ~/.config like the server-side installer', () => {
    expect(opencodeConfigDir({}, '/home/u')).toBe(path.join('/home/u', '.config', 'opencode'));
  });
});

describe('opencodePluginSourceDir (#310)', () => {
  const packaged = path.join('/app', 'resources', 'opencode-plugin');
  const dev = path.join('/repo', 'resources', 'opencode-plugin');

  it('reads the packaged layout next to resources/cli', () => {
    expect(opencodePluginSourceDir('/app/resources/cli', (p) => p === packaged)).toBe(packaged);
  });

  it('falls back to the repo layout from dist/cli', () => {
    expect(opencodePluginSourceDir('/repo/dist/cli', (p) => p === dev)).toBe(dev);
  });

  it('reports null rather than inventing a path', () => {
    expect(opencodePluginSourceDir('/nowhere/cli', () => false)).toBeNull();
  });
});

describe('markers (#310)', () => {
  it('uses the SAME marker rule as agent-plugin-file — two answers to "is this ours?" is the bug', () => {
    expect(TUI_PLUGIN_VERSION_RE.source).toBe(PLUGIN_VERSION_RE.source);
  });

  it('agrees with pluginNeedsUpdate on the cases that matter', () => {
    const cases: Array<[string, string | null]> = [
      ['// wmux-plugin-version: 1\nbody', null],
      ['// wmux-plugin-version: 1\nbody', '// wmux-plugin-version: 1\ndifferent'],
      ['// wmux-plugin-version: 1\nbody', '// wmux-plugin-version: 0\nbody'],
      ['// wmux-plugin-version: 1\nbody', 'no marker'],
      ['no marker', '// wmux-plugin-version: 1\nbody'],
    ];
    for (const [src, target] of cases) {
      expect(tuiNeedsUpdate(src, target)).toBe(pluginNeedsUpdate(src, target));
    }
  });

  it('recognises only marker-bearing files as ours', () => {
    expect(isWmuxTuiFile('// wmux-plugin-version: 1\nx')).toBe(true);
    expect(isWmuxTuiFile('export default { id: "mine" }')).toBe(false);
  });
});

describe('install and remove (#310)', () => {
  let tmp: string;
  let sourceDir: string;
  let configDir: string;
  const ENTRY = 'wmux-plugin-version: 1';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-opencode-tui-'));
    sourceDir = path.join(tmp, 'resources', 'opencode-plugin');
    configDir = path.join(tmp, 'home', '.config', 'opencode');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'wmux-tui.js'), `// wmux-plugin-version: 1\nexport default {}\n`);
    fs.writeFileSync(path.join(sourceDir, 'wmux-tui-core.js'), `export const core = 1;\n`);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const targetDir = () => path.join(configDir, 'plugins', 'wmux-cli');
  const entry = () => path.join(targetDir(), 'tui.js');
  const core = () => path.join(targetDir(), 'core.js');

  it('installs both files at the verified discovery path', () => {
    const result = installOpencodeTui({ sourceDir, configDir });
    expect(result).toEqual({ status: 'installed', dir: targetDir(), version: '1' });
    expect(fs.readFileSync(entry(), 'utf-8')).toContain(ENTRY);
    expect(fs.readFileSync(core(), 'utf-8')).toContain('core = 1');
  });

  it('is idempotent while the marker is current', () => {
    installOpencodeTui({ sourceDir, configDir });
    const before = fs.statSync(entry()).mtimeMs;
    const again = installOpencodeTui({ sourceDir, configDir });
    expect(again.status).toBe('current');
    expect(fs.statSync(entry()).mtimeMs).toBe(before);
  });

  it('reinstalls when the shipped marker moves', () => {
    installOpencodeTui({ sourceDir, configDir });
    fs.writeFileSync(path.join(sourceDir, 'wmux-tui.js'), `// wmux-plugin-version: 2\nexport default {}\n`);
    const result = installOpencodeTui({ sourceDir, configDir });
    expect(result.status).toBe('installed');
    expect(result.version).toBe('2');
  });

  it('replaces an unmarked copy at our own path, like the server-side installer', () => {
    fs.mkdirSync(targetDir(), { recursive: true });
    fs.writeFileSync(entry(), 'my own thing\n');
    const result = installOpencodeTui({ sourceDir, configDir });
    expect(result.status).toBe('installed');
    expect(fs.readFileSync(entry(), 'utf-8')).toContain(ENTRY);
  });

  it('removes ours, and the directory when nothing else is in it', () => {
    installOpencodeTui({ sourceDir, configDir });
    expect(removeOpencodeTui({ configDir })).toEqual({ status: 'removed', dir: targetDir() });
    expect(fs.existsSync(targetDir())).toBe(false);
  });

  it('leaves a directory the user put other files in', () => {
    installOpencodeTui({ sourceDir, configDir });
    fs.writeFileSync(path.join(targetDir(), 'notes.md'), 'mine');
    removeOpencodeTui({ configDir });
    expect(fs.existsSync(entry())).toBe(false);
    expect(fs.existsSync(path.join(targetDir(), 'notes.md'))).toBe(true);
  });

  it('refuses to delete a tui.js that carries no marker', () => {
    fs.mkdirSync(targetDir(), { recursive: true });
    fs.writeFileSync(entry(), 'export default { id: "mine" }');
    expect(removeOpencodeTui({ configDir })).toEqual({ status: 'foreign', dir: targetDir() });
    expect(fs.existsSync(entry())).toBe(true);
  });

  it('says absent, not removed, when nothing is installed', () => {
    expect(removeOpencodeTui({ configDir })).toEqual({ status: 'absent', dir: targetDir() });
  });
});

describe('the shipped entry file (#310)', () => {
  const entryPath = path.resolve(__dirname, '../../resources/opencode-plugin/wmux-tui.js');
  const corePath = path.resolve(__dirname, '../../resources/opencode-plugin/wmux-tui-core.js');
  const src = fs.readFileSync(entryPath, 'utf-8');
  const coreSrc = fs.readFileSync(corePath, 'utf-8');

  it('carries a version marker, or installed copies never update', () => {
    // v4 → v5 is the startup session seed: without the bump every installed
    // TUI half keeps missing a conversation that becomes current while the
    // TUI is still mounting.
    expect(src).toMatch(/wmux-plugin-version:\s*5/);
  });

  it('is a v2 CLI plugin definition and the only export', () => {
    expect(src).toContain('export default Plugin.define(');
    expect(src.match(/^export\s/gm)?.length).toBe(1);
    expect(src).toContain('from "@opencode/plugin/tui"');
  });

  it('seeds the startup route so a session that appears late is still reported', () => {
    expect(src).toContain('createSessionSeeder');
    expect(src).toContain('seeder.start()');
    expect(src).toContain('seeder.stop()');
  });

  it('releases only on a real exit — a plugin reload must keep the handle', () => {
    expect(src).toContain('releaseOnExit');
    expect(src).toContain('callWmuxSync');
    expect(src).toContain('process.once("exit"');
    expect(src).not.toContain('reporter.dispose()');
  });

  it('subscribes to the v2 prompt-admission event', () => {
    expect(src).toContain('session.inbox.enqueued');
  });

  it('subscribes to session.deleted so a dead handle is never restored', () => {
    expect(src).toContain('session.deleted');
  });

  it('re-reads the route when the user switches to an existing session', () => {
    expect(src).toContain('session.viewed');
  });

  it('falls back to a single open tab when the router has no session', () => {
    expect(src).toContain('routeFromTabs');
  });

  it('subscribes to the execution events that drive working/idle', () => {
    for (const type of [
      'session.execution.started',
      'session.execution.succeeded',
      'session.execution.failed',
      'session.execution.interrupted',
    ]) {
      expect(src).toContain(type);
    }
  });

  it('subscribes to every blocked-state event the reporter understands', () => {
    for (const type of [
      'permission.asked',
      'permission.replied',
      'form.created',
      'form.replied',
      'form.cancelled',
      'session.execution.interrupted',
      'session.execution.failed',
    ]) {
      expect(src).toContain(type);
    }
  });

  it('delegates to the core by a relative import the installed layout resolves', () => {
    expect(src).toContain('from "./core.js"');
  });

  it('never logs to the console — OpenCode\'s TUI owns it (#190)', () => {
    expect(src).not.toMatch(/console\.(error|log|warn)\s*\(/);
    expect(coreSrc).not.toMatch(/console\.(error|log|warn)\s*\(/);
  });

  it('the core imports node builtins only, so wmux\'s suite can load it', () => {
    const specifiers = [...coreSrc.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]);
    expect(specifiers.every((s) => s.startsWith('node:'))).toBe(true);
  });
});
