// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('scopes the filter to initial and replacement terminal image layers', () => {
  const style = document.createElement('style');
  style.textContent = readFileSync(join(__dirname, '../../src/renderer/styles/terminal.css'), 'utf8');
  document.head.append(style);
  const host = document.createElement('div');
  host.className = 'terminal-pane__container';
  host.innerHTML = '<div class="xterm-screen"><canvas></canvas></div>';
  document.body.append(host);
  const outside = document.createElement('canvas');
  outside.className = 'xterm-image-layer';
  document.body.append(outside);

  try {
    const screen = host.querySelector('.xterm-screen')!;
    const text = screen.querySelector('canvas')!;
    // Model lazy image-layer creation and recreation after renderer swaps.
    // These assertions cover CSS matching, not GPU compositing.
    const image = document.createElement('canvas');
    image.className = 'xterm-image-layer';
    screen.append(image);
    expect(getComputedStyle(image).filter).toBe('opacity(1)');
    const replacement = image.cloneNode() as HTMLCanvasElement;
    image.replaceWith(replacement);
    expect(getComputedStyle(replacement).filter).toBe('opacity(1)');
    expect(getComputedStyle(text).filter).not.toBe('opacity(1)');
    expect(getComputedStyle(outside).filter).not.toBe('opacity(1)');
  } finally {
    host.remove();
    outside.remove();
    style.remove();
  }
});
