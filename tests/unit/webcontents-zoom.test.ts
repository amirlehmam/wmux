import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { installPageZoom } from '../../src/main/webcontents-zoom';

function contents(type: string, factor = 1) {
  return Object.assign(new EventEmitter(), {
    getType: () => type,
    getZoomFactor: () => factor,
    setZoomFactor: vi.fn((next: number) => { factor = next; }),
  });
}

it('applies bounded native zoom to a guest webview', () => {
  const guest = contents('webview', 2);
  installPageZoom(guest as any);
  guest.emit('zoom-changed', {}, 'in');
  expect(guest.setZoomFactor).toHaveBeenLastCalledWith(2);
  guest.emit('zoom-changed', {}, 'out');
  expect(guest.setZoomFactor).toHaveBeenLastCalledWith(1.9);
});

it('leaves host zoom to WINDOW_ZOOM even when Electron emits a native event too', () => {
  const host = contents('window');
  installPageZoom(host as any);
  host.emit('zoom-changed', {}, 'in');
  expect(host.setZoomFactor).not.toHaveBeenCalled();
});
