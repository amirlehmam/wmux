import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeCaptureArgs } from '../../src/main/agent-browser-capture';

const DENSITY = '--force-device-scale-factor=2';
let home: string;
let userConfig: string;
let explicitConfig: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wmux-agent-capture-'));
  mkdirSync(join(home, '.agent-browser'));
  userConfig = join(home, '.agent-browser', 'config.json');
  explicitConfig = join(home, 'explicit.json');
  writeFileSync(userConfig, JSON.stringify({ args: '--user-flag' }));
  writeFileSync(explicitConfig, JSON.stringify({ args: '--explicit-flag' }));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe('native capture launch args', () => {
  it('does not override environment flags, including commas and newlines', () => {
    const args = ' --disable-features=One,Two\n--force-device-scale-factor=1\n--user-agent=custom value ';
    expect(nativeCaptureArgs({ AGENT_BROWSER_ARGS: args, AGENT_BROWSER_CONFIG: explicitConfig }, home)).toEqual([]);
  });

  it('treats an explicitly empty environment args value as overriding both configs', () => {
    expect(nativeCaptureArgs({ AGENT_BROWSER_ARGS: '', AGENT_BROWSER_CONFIG: explicitConfig }, home)).toEqual([]);
  });

  it('preserves trusted home configuration args', () => {
    const args = '--disable-features=One,Two\n--user-agent=custom value';
    writeFileSync(userConfig, JSON.stringify({ args }));
    expect(nativeCaptureArgs({}, home)).toEqual([]);
  });

  it('uses explicit configuration instead of home configuration without changing the environment', () => {
    const env = { AGENT_BROWSER_CONFIG: explicitConfig };
    expect(nativeCaptureArgs(env, home)).toEqual([]);
    expect(env).toEqual({ AGENT_BROWSER_CONFIG: explicitConfig });
  });

  it.each(['', 'missing.json'])('does not fall back to home args when explicit config is %j', (file) => {
    expect(nativeCaptureArgs({ AGENT_BROWSER_CONFIG: file ? join(home, file) : '' }, home))
      .toEqual(['--args', DENSITY]);
  });

  it.each(['{bad json', 'null', '{"args": ["--not-a-string"]}', '{}'])('leaves native validation of unusable config intact: %s', (content) => {
    writeFileSync(explicitConfig, content);
    expect(nativeCaptureArgs({ AGENT_BROWSER_CONFIG: explicitConfig }, home)).toEqual(['--args', DENSITY]);
  });

  it('never promotes automatic project Chrome args even when there is no home config', () => {
    const project = join(home, 'project');
    mkdirSync(project);
    writeFileSync(join(project, 'agent-browser.json'), JSON.stringify({ args: '--untrusted-project-flag' }));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(project);
    expect(nativeCaptureArgs({}, home)).toEqual([]);
    rmSync(userConfig);
    expect(nativeCaptureArgs({}, home)).toEqual(['--args', DENSITY]);
    expect(cwd).not.toHaveBeenCalled();
  });
});
