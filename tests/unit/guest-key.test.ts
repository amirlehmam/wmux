import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { guestKeyFromInput, type GuestInputLike } from '../../src/shared/guest-key';
import { forwardGuestKeys } from '../../src/main/webview-guest-keys';
import { IPC_CHANNELS } from '../../src/shared/types';

function input(over: Partial<GuestInputLike>): GuestInputLike {
  return { type: 'keyDown', key: 'w', code: 'KeyW', control: false, shift: false, alt: false, meta: false, isAutoRepeat: false, ...over };
}

describe('guestKeyFromInput', () => {
  it('forwards a Ctrl chord as a KeyboardEvent-shaped key', () => {
    expect(guestKeyFromInput(input({ control: true, shift: true, key: 'W' }))).toEqual({
      key: 'W', code: 'KeyW', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, repeat: false,
    });
  });

  it('forwards Alt and Meta chords and bare function keys', () => {
    expect(guestKeyFromInput(input({ alt: true }))).not.toBeNull();
    expect(guestKeyFromInput(input({ meta: true }))).not.toBeNull();
    expect(guestKeyFromInput(input({ key: 'F5', code: 'F5' }))).not.toBeNull();
    expect(guestKeyFromInput(input({ key: 'F12', code: 'F12' }))).not.toBeNull();
  });

  it('keeps plain typing in the page', () => {
    expect(guestKeyFromInput(input({}))).toBeNull();
    expect(guestKeyFromInput(input({ shift: true, key: 'W' }))).toBeNull();
    expect(guestKeyFromInput(input({ key: 'Enter', code: 'Enter' }))).toBeNull();
    expect(guestKeyFromInput(input({ key: 'Tab', code: 'Tab' }))).toBeNull();
  });

  it('ignores key-ups and IME composition', () => {
    expect(guestKeyFromInput(input({ type: 'keyUp', control: true }))).toBeNull();
    expect(guestKeyFromInput(input({ control: true, isComposing: true }))).toBeNull();
  });

  it('carries auto-repeat so the desktop can drop it', () => {
    expect(guestKeyFromInput(input({ control: true, isAutoRepeat: true }))?.repeat).toBe(true);
  });
});

describe('forwardGuestKeys', () => {
  function guest(type = 'webview', host: unknown = { isDestroyed: () => false, send: vi.fn() }) {
    return Object.assign(new EventEmitter(), { id: 7, getType: () => type, hostWebContents: host });
  }

  it('sends a guest chord to its host window without preventing it', () => {
    const g = guest();
    forwardGuestKeys(g as any);
    const event = { preventDefault: vi.fn() };
    g.emit('before-input-event', event, input({ control: true }));
    expect((g.hostWebContents as any).send).toHaveBeenCalledWith(
      IPC_CHANNELS.BROWSER_GUEST_KEY, 7, expect.objectContaining({ key: 'w', ctrlKey: true }),
    );
    // The page keeps every key; main has no bindings to judge it by.
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('sends nothing for plain typing', () => {
    const g = guest();
    forwardGuestKeys(g as any);
    g.emit('before-input-event', { preventDefault: vi.fn() }, input({}));
    expect((g.hostWebContents as any).send).not.toHaveBeenCalled();
  });

  it('survives a host that has gone', () => {
    const g = guest('webview', { isDestroyed: () => true, send: vi.fn() });
    forwardGuestKeys(g as any);
    expect(() => g.emit('before-input-event', {}, input({ control: true }))).not.toThrow();
    expect((g.hostWebContents as any).send).not.toHaveBeenCalled();
  });

  it('only listens on browser guests', () => {
    const w = guest('window');
    forwardGuestKeys(w as any);
    expect(w.listenerCount('before-input-event')).toBe(0);
  });
});
