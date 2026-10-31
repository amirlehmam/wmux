// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { installWheelZoom } from '../../src/renderer/utils/wheel-zoom';

it('claims Ctrl+wheel before a terminal receives it and removes the listener on teardown', () => {
  const terminal = document.createElement('div');
  document.body.append(terminal);
  const forward = vi.fn();
  terminal.addEventListener('wheel', forward, true);
  const zoom = vi.fn();
  const dispose = installWheelZoom(document, zoom);
  const wheel = (ctrlKey: boolean, deltaY = -120) => {
    const event = new WheelEvent('wheel', { ctrlKey, deltaY, bubbles: true, cancelable: true });
    terminal.dispatchEvent(event);
    return event;
  };
  expect(wheel(true).defaultPrevented).toBe(true);
  expect(zoom).toHaveBeenCalledWith(-120);
  expect(forward).not.toHaveBeenCalled();
  expect(wheel(false).defaultPrevented).toBe(false);
  expect(forward).toHaveBeenCalledOnce();
  expect(wheel(true, 0).defaultPrevented).toBe(false);
  dispose();
  expect(wheel(true).defaultPrevented).toBe(false);
  expect(zoom).toHaveBeenCalledOnce();
  terminal.remove();
});
