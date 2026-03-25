import { describe, it, expect } from 'vitest';
import { getDefaultTheme } from '../../src/main/theme-loader';
import {
  parseGhosttyConfigString,
  parseWindowsTerminalSettingsJson,
} from '../../src/main/config-loader';

// ---------------------------------------------------------------------------
// getDefaultTheme
// ---------------------------------------------------------------------------

describe('getDefaultTheme', () => {
  it('returns a ThemeConfig with all required fields', () => {
    const theme = getDefaultTheme();
    expect(theme.name).toBe('Monokai');
    expect(theme.background).toBe('#272822');
    expect(theme.foreground).toBe('#fdfff1');
    expect(theme.cursor).toBeTruthy();
    expect(theme.selectionBackground).toBeTruthy();
    expect(Array.isArray(theme.palette)).toBe(true);
    expect(theme.palette).toHaveLength(16);
    expect(theme.fontFamily).toBe('Cascadia Mono');
    expect(theme.fontSize).toBe(13);
    expect(theme.backgroundOpacity).toBe(1.0);
  });

  it('all palette entries are non-empty strings starting with #', () => {
    const { palette } = getDefaultTheme();
    for (const color of palette) {
      expect(color).toBeTruthy();
      expect(color.startsWith('#')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// parseGhosttyConfigString
// ---------------------------------------------------------------------------

describe('parseGhosttyConfigString', () => {
  it('extracts font-family, background, and foreground from key=value text', () => {
    const text = `
# Ghostty config
font-family = FiraCode Nerd Font
font-size = 14
background = #1e1e2e
foreground = #cdd6f4
cursor-color = #f5e0dc
`;
    const theme = parseGhosttyConfigString(text);
    expect(theme).not.toBeNull();
    expect(theme!.fontFamily).toBe('FiraCode Nerd Font');
    expect(theme!.fontSize).toBe(14);
    expect(theme!.background).toBe('#1e1e2e');
    expect(theme!.foreground).toBe('#cdd6f4');
    expect(theme!.cursor).toBe('#f5e0dc');
  });

  it('ignores comment lines and blank lines', () => {
    const text = `
# This is a comment

background = #282828
# foreground = #should-be-ignored
foreground = #ebdbb2
`;
    const theme = parseGhosttyConfigString(text);
    expect(theme).not.toBeNull();
    expect(theme!.background).toBe('#282828');
    expect(theme!.foreground).toBe('#ebdbb2');
  });

  it('parses palette entries correctly', () => {
    const text = `
background = #000000
foreground = #ffffff
palette = 0=#1d1f21
palette = 1=#cc6666
palette = 2=#b5bd68
palette = 7=#c5c8c6
palette = 15=#ffffff
`;
    const theme = parseGhosttyConfigString(text);
    expect(theme).not.toBeNull();
    expect(theme!.palette[0]).toBe('#1d1f21');
    expect(theme!.palette[1]).toBe('#cc6666');
    expect(theme!.palette[2]).toBe('#b5bd68');
    expect(theme!.palette[7]).toBe('#c5c8c6');
    expect(theme!.palette[15]).toBe('#ffffff');
  });

  it('handles bare hex colors without leading #', () => {
    const text = `
background = 272822
foreground = fdfff1
`;
    const theme = parseGhosttyConfigString(text);
    expect(theme).not.toBeNull();
    expect(theme!.background).toBe('#272822');
    expect(theme!.foreground).toBe('#fdfff1');
  });

  it('extracts selection-background and selection-foreground', () => {
    const text = `
background = #1e1e2e
foreground = #cdd6f4
selection-background = #585b70
selection-foreground = #cdd6f4
`;
    const theme = parseGhosttyConfigString(text);
    expect(theme).not.toBeNull();
    expect(theme!.selectionBackground).toBe('#585b70');
    expect(theme!.selectionForeground).toBe('#cdd6f4');
  });

  it('uses theme map to resolve a named theme', () => {
    const baseTheme = getDefaultTheme();
    const themeMap = new Map([['Monokai', baseTheme]]);

    const text = `
theme = Monokai
font-family = JetBrains Mono
`;
    const theme = parseGhosttyConfigString(text, themeMap);
    expect(theme).not.toBeNull();
    // Background should come from the Monokai theme
    expect(theme!.background).toBe('#272822');
    // Font override from config
    expect(theme!.fontFamily).toBe('JetBrains Mono');
  });
});

// ---------------------------------------------------------------------------
// parseWindowsTerminalSettingsJson
// ---------------------------------------------------------------------------

describe('parseWindowsTerminalSettingsJson', () => {
  const mockSettings = {
    defaultProfile: '{61c54bbd-c2c6-5271-96e7-009a87ff44bf}',
    profiles: {
      list: [
        {
          guid: '{61c54bbd-c2c6-5271-96e7-009a87ff44bf}',
          name: 'Windows PowerShell',
          font: { face: 'Cascadia Code', size: 12 },
          colorScheme: 'One Half Dark',
        },
      ],
    },
    schemes: [
      {
        name: 'One Half Dark',
        background: '#282C34',
        foreground: '#DCDFE4',
        cursorColor: '#FFFFFF',
        selectionBackground: '#474E5D',
        black: '#282C34',
        red: '#E06C75',
        green: '#98C379',
        yellow: '#E5C07B',
        blue: '#61AFEF',
        purple: '#C678DD',
        cyan: '#56B6C2',
        white: '#DCDFE4',
        brightBlack: '#5A6374',
        brightRed: '#E06C75',
        brightGreen: '#98C379',
        brightYellow: '#E5C07B',
        brightBlue: '#61AFEF',
        brightPurple: '#C678DD',
        brightCyan: '#56B6C2',
        brightWhite: '#DCDFE4',
      },
    ],
  };

  it('extracts background and foreground from the matching scheme', () => {
    const theme = parseWindowsTerminalSettingsJson(mockSettings);
    expect(theme).not.toBeNull();
    expect(theme!.background).toBe('#282C34');
    expect(theme!.foreground).toBe('#DCDFE4');
  });

  it('extracts font face and size from the default profile', () => {
    const theme = parseWindowsTerminalSettingsJson(mockSettings);
    expect(theme).not.toBeNull();
    expect(theme!.fontFamily).toBe('Cascadia Code');
    expect(theme!.fontSize).toBe(12);
  });

  it('maps named ANSI colors to palette correctly', () => {
    const theme = parseWindowsTerminalSettingsJson(mockSettings);
    expect(theme).not.toBeNull();
    expect(theme!.palette[0]).toBe('#282C34'); // black
    expect(theme!.palette[1]).toBe('#E06C75'); // red
    expect(theme!.palette[2]).toBe('#98C379'); // green
    expect(theme!.palette[4]).toBe('#61AFEF'); // blue
    expect(theme!.palette[15]).toBe('#DCDFE4'); // brightWhite
  });

  it('uses numbered color keys (color0–color15) when present', () => {
    const settings = {
      profiles: { list: [{ guid: '{aaa}', colorScheme: 'Test' }] },
      defaultProfile: '{aaa}',
      schemes: [
        {
          name: 'Test',
          background: '#000000',
          foreground: '#ffffff',
          color0: '#111111',
          color1: '#222222',
          color15: '#eeeeee',
        },
      ],
    };
    const theme = parseWindowsTerminalSettingsJson(settings);
    expect(theme).not.toBeNull();
    expect(theme!.palette[0]).toBe('#111111');
    expect(theme!.palette[1]).toBe('#222222');
    expect(theme!.palette[15]).toBe('#eeeeee');
  });

  it('falls back to first profile when defaultProfile guid does not match', () => {
    const settings = {
      defaultProfile: '{does-not-exist}',
      profiles: {
        list: [
          {
            guid: '{first-profile}',
            colorScheme: 'Campbell',
            font: { face: 'Consolas', size: 11 },
          },
        ],
      },
      schemes: [
        {
          name: 'Campbell',
          background: '#0C0C0C',
          foreground: '#CCCCCC',
        },
      ],
    };
    const theme = parseWindowsTerminalSettingsJson(settings);
    expect(theme).not.toBeNull();
    expect(theme!.background).toBe('#0C0C0C');
    expect(theme!.fontFamily).toBe('Consolas');
  });

  it('returns null gracefully for empty/invalid settings', () => {
    // Empty settings should not throw and should return a ThemeConfig (with defaults)
    // or null — either is acceptable, but it must not throw.
    expect(() => parseWindowsTerminalSettingsJson({})).not.toThrow();
  });
});
