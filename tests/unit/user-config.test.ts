import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadUserConfig, resetConfigWarnings } from '../../src/main/user-config';

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

  it('maps remote upload booleans and warns about invalid values', () => {
    tmpPath = writeTmp(`
      [remote]
      upload-on-paste = false
      upload-on-drop = "sometimes"
    `);
    const out = loadUserConfig(tmpPath);
    expect(out.remote).toEqual({ uploadOnPaste: false });
    expect(out.errors.some((e) => e.includes('remote.upload-on-drop'))).toBe(true);
  });

  // Issue #146 — `[keys]` remaps: the config file is the plugin-shaped ask,
  // answered without a plugin runtime.
  it('parses the [keys] section into validated remaps', () => {
    tmpPath = writeTmp(`
      [keys]
      "ctrl+k" = "<C-k><Delete>"
      "ctrl+alt+r" = "clear<CR>"
    `);
    const out = loadUserConfig(tmpPath);
    expect(out.errors).toEqual([]);
    expect(out.keys).toHaveLength(2);
    expect(out.keys?.[0]).toEqual({
      chord: { key: 'k', ctrl: true, shift: false, alt: false },
      send: '\x0b\x1b[3~',
      source: 'ctrl+k',
    });
    expect(out.keys?.[1].send).toBe('clear\r');
  });

  it('reports a bad remap without dropping the good ones', () => {
    tmpPath = writeTmp(`
      [keys]
      "ctrl+j" = "<Nope>"
      "ctrl+k" = "<Delete>"
    `);
    const out = loadUserConfig(tmpPath);
    expect(out.keys?.map((k) => k.source)).toEqual(['ctrl+k']);
    expect(out.errors?.some((e) => e.includes('unknown key <Nope>'))).toBe(true);
  });

  it('leaves keys undefined when the section is absent', () => {
    tmpPath = writeTmp(`
      [terminal]
      font-size = 13
    `);
    expect(loadUserConfig(tmpPath).keys).toBeUndefined();
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

/**
 * A read or parse failure discards the WHOLE file — every [terminal], [keys],
 * [browser] and [appearance] section reverts to its default. That used to happen
 * in silence: one stray character and the user's entire config stopped applying,
 * with nothing in any log to say so.
 */
describe('loadUserConfig diagnostics', () => {
  let tmpPath: string | null = null;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetConfigWarnings();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpPath) {
      try { fs.rmSync(path.dirname(tmpPath), { recursive: true, force: true }); } catch { /* noop */ }
      tmpPath = null;
    }
  });

  it('warns, naming the file, when a syntax error discards the config', () => {
    tmpPath = writeTmp('[terminal\nfont-size = 13\n');
    const out = loadUserConfig(tmpPath);
    expect(out.errors.length).toBeGreaterThan(0);
    expect(out.terminal).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0].join(' ')).toContain(tmpPath);
  });

  it('warns once per problem, however often the file is read', () => {
    // loadUserConfig runs on every startup and every `reload-config`; without
    // dedupe one bad file would fill the log.
    tmpPath = writeTmp('[terminal\n');
    for (let i = 0; i < 10; i++) loadUserConfig(tmpPath);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reports the file afresh after resetConfigWarnings', () => {
    // What `wmux reload-config` calls: the user is iterating on the file and
    // needs to see whether their edit fixed it.
    tmpPath = writeTmp('[terminal\n');
    loadUserConfig(tmpPath);
    resetConfigWarnings();
    loadUserConfig(tmpPath);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('says nothing about a config that parses', () => {
    tmpPath = writeTmp('[terminal]\nfont-size = 13\n');
    expect(loadUserConfig(tmpPath).errors).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns about a section-level mistake without discarding the rest', () => {
    // A mapping error is not fatal — the good sections still apply — but it is
    // still the reason a setting "did nothing", so it has to be said out loud.
    tmpPath = writeTmp('[appearance]\nui-theme = "purple"\n\n[terminal]\nfont-size = 13\n');
    const out = loadUserConfig(tmpPath);
    expect(out.terminal?.fontSize).toBe(13);
    expect(out.errors.length).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
