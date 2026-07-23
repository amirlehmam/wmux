import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadUserConfig } from '../../src/main/user-config';

function writeTmp(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cfg-'));
  const p = path.join(dir, 'config.toml');
  fs.writeFileSync(p, contents, 'utf-8');
  return p;
}

describe('loadUserConfig', () => {
  let tmpPath: string | null = null;

  afterEach(() => {
    if (tmpPath) {
      try { fs.rmSync(path.dirname(tmpPath), { recursive: true, force: true }); } catch { /* noop */ }
      tmpPath = null;
    }
  });

  it('returns empty config when the file is missing', () => {
    const out = loadUserConfig(path.join(os.tmpdir(), 'does-not-exist-' + Date.now()));
    expect(out.terminal).toBeUndefined();
    expect(out.errors).toEqual([]);
  });

  it('maps the TOML shape from issue #4 onto TerminalPrefs', () => {
    tmpPath = writeTmp(`
      [terminal]
      font-family = "Cascadia Mono"
      font-size = 14
      cursor-style = "underline"
      cursor-blink = false
      scrollback-lines = 20000

      [terminal.colors]
      default = "Dracula"

      [terminal.colors.schemes.prod]
      background = "#2b0b0b"
      foreground = "#ffdddd"
      cursor     = "#ff5555"

      [terminal.colors.schemes.dev]
      background = "#0b1f0b"
      foreground = "#ccffcc"
      palette = ["#000", "#ff5555"]
    `);
    const out = loadUserConfig(tmpPath);
    expect(out.errors).toEqual([]);
    expect(out.terminal?.fontFamily).toBe('Cascadia Mono');
    expect(out.terminal?.fontSize).toBe(14);
    expect(out.terminal?.cursorStyle).toBe('underline');
    expect(out.terminal?.cursorBlink).toBe(false);
    expect(out.terminal?.scrollbackLines).toBe(20000);
    expect(out.terminal?.theme).toBe('Dracula');
    expect(out.terminal?.userColorSchemes?.prod).toEqual({
      background: '#2b0b0b',
      foreground: '#ffdddd',
      cursor: '#ff5555',
    });
    expect(out.terminal?.userColorSchemes?.dev).toEqual({
      background: '#0b1f0b',
      foreground: '#ccffcc',
      palette: ['#000', '#ff5555'],
    });
  });

  it('accepts camelCase keys as aliases for kebab-case', () => {
    tmpPath = writeTmp(`
      [terminal]
      fontFamily = "Hack"
      fontSize = 12
      cursorStyle = "bar"
      cursorBlink = true
      scrollbackLines = 5000
    `);
    const out = loadUserConfig(tmpPath);
    expect(out.terminal).toEqual({
      fontFamily: 'Hack',
      fontSize: 12,
      cursorStyle: 'bar',
      cursorBlink: true,
      scrollbackLines: 5000,
    });
  });

  it('rejects an invalid cursor-style but keeps other keys', () => {
    tmpPath = writeTmp(`
      [terminal]
      cursor-style = "wobble"
      font-size = 13
    `);
    const out = loadUserConfig(tmpPath);
    expect(out.terminal?.fontSize).toBe(13);
    expect(out.terminal?.cursorStyle).toBeUndefined();
    expect(out.errors?.some((e) => e.includes('cursor-style'))).toBe(true);
  });

  it('maps the [browser] section: dev-ports + auto-open', () => {
    tmpPath = writeTmp(`
      [browser]
      dev-ports = [8501, 4321, 9000]
      auto-open = false
    `);
    const out = loadUserConfig(tmpPath);
    expect(out.errors).toEqual([]);
    expect(out.browser?.devPorts).toEqual([8501, 4321, 9000]);
    expect(out.browser?.autoOpen).toBe(false);
  });

  it('accepts camelCase browser keys and drops out-of-range ports', () => {
    tmpPath = writeTmp(`
      [browser]
      devPorts = [3000, 70000, 0, 5173]
      autoOpen = true
    `);
    const out = loadUserConfig(tmpPath);
    expect(out.browser?.devPorts).toEqual([3000, 5173]);
    expect(out.browser?.autoOpen).toBe(true);
    expect(out.errors?.some((e) => e.includes('dev-ports'))).toBe(true);
  });

  it('leaves browser undefined when the section is absent', () => {
    tmpPath = writeTmp(`
      [terminal]
      font-size = 13
    `);
    const out = loadUserConfig(tmpPath);
    expect(out.browser).toBeUndefined();
  });

  it('clamps palette to 16 entries', () => {
    const big = Array.from({ length: 20 }, (_, i) => `"#0000${(i % 16).toString(16)}0"`).join(',');
    tmpPath = writeTmp(`
      [terminal.colors.schemes.big]
      background = "#000000"
      palette = [${big}]
    `);
    const out = loadUserConfig(tmpPath);
    expect(out.terminal?.userColorSchemes?.big?.palette?.length).toBe(16);
  });
});
