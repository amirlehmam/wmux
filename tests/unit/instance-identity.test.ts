// ─── Per-instance identity (WMUX_INSTANCE) ───────────────────────────────────
// The pipe and the APPDATA dir were already suffixed so a dev build can run
// beside an installed one. The AppUserModelId was not, and that gap was not
// cosmetic: Windows maps an AUMID to exactly one executable, so a dev build
// sharing `com.wmux.app` repoints it at its own electron.exe and the INSTALLED
// app's taskbar button starts reading "Electron" with the dev binary's icon —
// and the user's pinned button, which is keyed on that id, is orphaned. These
// pin all three identities together so they cannot drift apart again.

import { describe, it, expect, afterEach } from 'vitest';
import { getPipePath, getAppDataDir, getAppUserModelId } from '../../src/shared/instance';

const original = process.env.WMUX_INSTANCE;
afterEach(() => {
  if (original === undefined) delete process.env.WMUX_INSTANCE;
  else process.env.WMUX_INSTANCE = original;
});

describe('getAppUserModelId', () => {
  it('is the bare production id when no instance is set', () => {
    delete process.env.WMUX_INSTANCE;
    expect(getAppUserModelId()).toBe('com.wmux.app');
  });

  it('must equal electron-builder appId in the default case', () => {
    // The installer registers shortcuts under electron-builder's `appId`. If
    // these ever diverge, every pinned button breaks for ordinary users — the
    // exact failure this module is meant to prevent, aimed at the wrong people.
    delete process.env.WMUX_INSTANCE;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const builder = require('../../electron-builder.json');
    expect(getAppUserModelId()).toBe(builder.appId);
  });

  it('suffixes for a named instance, so a dev build cannot seize the install', () => {
    process.env.WMUX_INSTANCE = 'dev';
    expect(getAppUserModelId()).toBe('com.wmux.app-dev');
    expect(getAppUserModelId()).not.toBe('com.wmux.app');
  });

  it('suffixes in lockstep with the pipe and the APPDATA dir', () => {
    process.env.WMUX_INSTANCE = 'dev';
    expect(getPipePath()).toContain('-dev');
    expect(getAppDataDir()).toContain('-dev');
    expect(getAppUserModelId()).toContain('-dev');
  });

  it('ignores whitespace-only values like the other identities do', () => {
    process.env.WMUX_INSTANCE = '   ';
    expect(getAppUserModelId()).toBe('com.wmux.app');
    expect(getPipePath()).toBe(getPipePath()); // same rule, no suffix
  });
});
