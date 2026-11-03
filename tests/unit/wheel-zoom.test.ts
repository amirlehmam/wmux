// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { installWheelZoom, nextPaneZoom, paneFontSize, paneIdAt } from '../../src/renderer/utils/wheel-zoom';

it('zooms a terminal through its font size, never below a readable floor (#420)', () => {
  expect(paneFontSize(13, 1)).toBe(13);
  expect(paneFontSize(13, undefined)).toBe(13);
  expect(paneFontSize(13, 1.2)).toBe(16);
  expect(paneFontSize(13, 0.5)).toBe(7);
  expect(paneFontSize(8, 0.5)).toBe(6);
});

it('finds the pane a wheel event happened over (#420)', () => {
  const pane = document.createElement('div');
  pane.setAttribute('data-pane-id', 'pane-1');
  const inner = document.createElement('span');
  pane.append(inner);
  document.body.append(pane);
  expect(paneIdAt(inner)).toBe('pane-1');
  expect(paneIdAt(document.body)).toBeNull();
  expect(paneIdAt(null)).toBeNull();
  pane.remove();
});

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
  expect(zoom).toHaveBeenCalledWith(-120, terminal);
  expect(forward).not.toHaveBeenCalled();
  expect(wheel(false).defaultPrevented).toBe(false);
  expect(forward).toHaveBeenCalledOnce();
  expect(wheel(true, 0).defaultPrevented).toBe(false);
  dispose();
  expect(wheel(true).defaultPrevented).toBe(false);
  expect(zoom).toHaveBeenCalledOnce();
  terminal.remove();
});

it('steps pane zoom independently and clamps its range', () => {
  expect(nextPaneZoom(1, -120)).toBe(1.1);
  expect(nextPaneZoom(1.1, 120)).toBe(1);
  expect(nextPaneZoom(2, -120)).toBe(2);
  expect(nextPaneZoom(0.5, 120)).toBe(0.5);
});

it('routes Ctrl+Shift+wheel to the window zoom callback', () => {
  const pane = vi.fn();
  const window = vi.fn();
  const dispose = installWheelZoom(document, pane, window);
  const event = new WheelEvent('wheel', { ctrlKey: true, shiftKey: true, deltaY: -120, cancelable: true });
  document.dispatchEvent(event);
  expect(window).toHaveBeenCalledWith(-120);
  expect(pane).not.toHaveBeenCalled();
  dispose();
});
