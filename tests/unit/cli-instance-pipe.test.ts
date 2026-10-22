import { describe, it, expect } from 'vitest';
import { cliPipePath, sendKeyParams } from '../../src/cli/wmux';

// A CLI run outside a wmux pane against a side-by-side instance
// (`WMUX_INSTANCE=dev`) read that instance's token but dialled the INSTALLED
// wmux's pipe, so every privileged verb failed authentication there. The hook
// (wmux-hook.ts) already followed the instance; the CLI now does too.
describe('cliPipePath', () => {
  it('follows WMUX_INSTANCE the way shared/instance.ts names the pipe', () => {
    expect(cliPipePath({ WMUX_INSTANCE: 'dev' })).toBe('\\\\.\\pipe\\wmux-dev');
  });

  it('lets an explicit WMUX_PIPE win, as a pane spawned by wmux sets it', () => {
    expect(cliPipePath({ WMUX_PIPE: '\\\\.\\pipe\\custom', WMUX_INSTANCE: 'dev' })).toBe('\\\\.\\pipe\\custom');
  });

  it('is the installed pipe with no instance, or a blank one', () => {
    expect(cliPipePath({})).toBe('\\\\.\\pipe\\wmux');
    expect(cliPipePath({ WMUX_INSTANCE: '  ' })).toBe('\\\\.\\pipe\\wmux');
  });
});

// `send-key` took the key from a fixed position, so `send-key --surface X enter`
// sent the key "--surface" and failed with "unknown key name", while `send`
// accepted --surface anywhere.
describe('sendKeyParams', () => {
  it('reads the key whether --surface comes before or after it', () => {
    expect(sendKeyParams(['send-key', 'enter', '--surface', 'surf-a'])).toEqual(
      { key: 'enter', modifiers: [], surfaceId: 'surf-a' },
    );
    expect(sendKeyParams(['send-key', '--surface', 'surf-a', 'enter'])).toEqual(
      { key: 'enter', modifiers: [], surfaceId: 'surf-a' },
    );
  });

  it('reads modifiers anywhere and keeps their order fixed', () => {
    expect(sendKeyParams(['send-key', '--shift', 'tab', '--ctrl'])).toEqual(
      { key: 'tab', modifiers: ['ctrl', 'shift'] },
    );
  });

  it('falls back to the caller surface, and an explicit one wins', () => {
    expect(sendKeyParams(['send-key', 'esc'], 'surf-env')).toEqual({ key: 'esc', modifiers: [], surfaceId: 'surf-env' });
    expect(sendKeyParams(['send-key', 'esc', '--surface', 'surf-b'], 'surf-env').surfaceId).toBe('surf-b');
  });
});
