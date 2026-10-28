import { describe, it, expect } from 'vitest';
import { buildContextLine, shortenCwd, sidebarDetails } from '../../src/renderer/components/Sidebar/context-line';
import { DEFAULT_SIDEBAR_PREFS } from '../../src/renderer/store/settings-slice';

/**
 * #279: the workspace row's context line.
 *
 * Settings → Sidebar showed six "detail" toggles that nothing under Sidebar/
 * read, and every drive root was shortened to `~` — `L:\repos\ai` rendered as
 * `~/repos/ai`, as if the repo lived in the home directory.
 */

const ALL = sidebarDetails(DEFAULT_SIDEBAR_PREFS);
const HOME = 'C:\\Users\\amir';

describe('shortenCwd — `~` means the home directory and nothing else', () => {
  it.each([
    ['the home directory itself', 'C:\\Users\\amir', '~'],
    ['a folder under home', 'C:\\Users\\amir\\dev\\wmux', '~/dev/wmux'],
    ['home with a different case (NTFS is case-insensitive)', 'c:\\users\\AMIR\\dev', '~/dev'],
    ['another drive keeps its letter (the #279 report)', 'L:\\repos\\ai\\ai-coding-crash-course', 'L:/repos/ai/ai-coding-crash-course'],
    ['C: outside home keeps its letter', 'C:\\src\\wmux', 'C:/src/wmux'],
    ['a sibling whose name only STARTS with the home name', 'C:\\Users\\amir2\\dev', 'C:/Users/amir2/dev'],
    ['a WSL home', '/home/richard/repos/ai', '~/repos/ai'],
    ['WSL root\'s home', '/root/x', '~/x'],
    ['a POSIX path outside any home', '/mnt/l/repos', '/mnt/l/repos'],
    ['a WSL UNC path', '\\\\wsl.localhost\\Ubuntu-24.04\\home\\user\\apps', '/home/user/apps'],
    ['a legacy WSL UNC path', '\\\\wsl$\\Ubuntu\\mnt\\c\\src', '/mnt/c/src'],
    ['a WSL distro root', '\\\\wsl.localhost\\Ubuntu', '/'],
    ['another UNC server keeps its prefix', '\\\\server\\share\\src', '//server/share/src'],
  ])('%s', (_name, cwd, expected) => {
    expect(shortenCwd(cwd, HOME)).toBe(expected);
  });

  it('a home with a trailing separator still matches', () => {
    expect(shortenCwd('C:\\Users\\amir\\dev', 'C:\\Users\\amir\\')).toBe('~/dev');
  });

  it('with no home known, a drive-rooted Windows path is never shortened', () => {
    expect(shortenCwd('C:\\Users\\amir\\dev')).toBe('C:/Users/amir/dev');
  });
});

describe('sidebarDetails — every toggle is read, and "Hide all" wins', () => {
  it('the defaults show everything', () => {
    expect(ALL).toEqual({ gitBranch: true, workingDir: true, pr: true, ports: true, notificationMessage: true });
  });

  it('hideAllDetails turns every line off whatever the individual toggles say', () => {
    const d = sidebarDetails({ ...DEFAULT_SIDEBAR_PREFS, hideAllDetails: true });
    expect(Object.values(d).every((v) => v === false)).toBe(true);
  });

  it.each([
    ['showGitBranch', 'gitBranch'],
    ['showWorkingDir', 'workingDir'],
    ['showPR', 'pr'],
    ['showPorts', 'ports'],
    ['showNotificationMessage', 'notificationMessage'],
  ] as const)('%s off hides only %s', (pref, key) => {
    const d = sidebarDetails({ ...DEFAULT_SIDEBAR_PREFS, [pref]: false });
    expect(d[key]).toBe(false);
    expect(Object.entries(d).filter(([k]) => k !== key).every(([, v]) => v)).toBe(true);
  });
});

describe('buildContextLine', () => {
  const ws = { gitBranch: 'main', gitDirty: true, cwd: 'L:\\repos\\ai', ports: [3000, 5173] };

  it('joins branch, cwd and ports', () => {
    expect(buildContextLine(ws, ALL, HOME)).toBe('main* · L:/repos/ai · :3000 :5173');
  });

  it('a toggled-off part is left out', () => {
    expect(buildContextLine(ws, { ...ALL, gitBranch: false }, HOME)).toBe('L:/repos/ai · :3000 :5173');
    expect(buildContextLine(ws, { ...ALL, workingDir: false, ports: false }, HOME)).toBe('main*');
  });

  it('nothing known or nothing enabled is null, so the row draws no empty line', () => {
    expect(buildContextLine({}, ALL, HOME)).toBeNull();
    expect(buildContextLine(ws, sidebarDetails({ ...DEFAULT_SIDEBAR_PREFS, hideAllDetails: true }), HOME)).toBeNull();
    expect(buildContextLine({ ports: [] }, ALL, HOME)).toBeNull();
  });
});
