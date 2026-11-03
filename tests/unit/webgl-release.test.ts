import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it, expect, vi } from 'vitest';
import type { WebglAddon } from '@xterm/addon-webgl';
import { disposeWebglAddon } from '../../src/renderer/utils/webgl-release';

function fakeAddon(opts: { lost?: boolean; throwOnDispose?: boolean } = {}) {
  const order: string[] = [];
  const loseContext = vi.fn(() => order.push('loseContext'));
  const gl = {
    isContextLost: () => opts.lost ?? false,
    getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext } : null),
  };
  const canvas = { width: 1407, height: 1290 };
  const addon = {
    _renderer: { _gl: gl, _canvas: canvas },
    dispose: vi.fn(() => {
      order.push('dispose');
      if (opts.throwOnDispose) throw new Error('already disposed');
    }),
  };
  return { addon: addon as unknown as WebglAddon, raw: addon, canvas, loseContext, order };
}

describe('disposeWebglAddon (#421)', () => {
  it('loses the context and drops the backing store after disposing the addon', () => {
    const { addon, canvas, loseContext, order } = fakeAddon();
    disposeWebglAddon(addon);
    expect(loseContext).toHaveBeenCalledTimes(1);
    expect(canvas).toEqual({ width: 0, height: 0 });
    // After dispose: the renderer's own context-lost listener must be gone
    // first, or losing the context on purpose reads as a GPU failure.
    expect(order).toEqual(['dispose', 'loseContext']);
  });

  it('does not lose an already-lost context again, but still frees the canvas', () => {
    const { addon, canvas, loseContext } = fakeAddon({ lost: true });
    disposeWebglAddon(addon);
    expect(loseContext).not.toHaveBeenCalled();
    expect(canvas).toEqual({ width: 0, height: 0 });
  });

  it('still releases when dispose throws, and never throws itself', () => {
    const { addon, canvas, loseContext } = fakeAddon({ throwOnDispose: true });
    expect(() => disposeWebglAddon(addon)).not.toThrow();
    expect(loseContext).toHaveBeenCalledTimes(1);
    expect(canvas.width).toBe(0);
  });

  it('tolerates an addon whose internals changed shape', () => {
    const dispose = vi.fn();
    expect(() => disposeWebglAddon({ dispose } as unknown as WebglAddon)).not.toThrow();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('matches the private fields of the shipped addon-webgl', () => {
    // The helper reads `_renderer._gl` and `_renderer._canvas`; an addon
    // upgrade that renames them would silently bring the leak back.
    const require = createRequire(import.meta.url);
    const map = JSON.parse(readFileSync(require.resolve('@xterm/addon-webgl/lib/addon-webgl.js.map'), 'utf-8')) as {
      sources: string[]; sourcesContent: string[];
    };
    const src = (name: string) => map.sourcesContent[map.sources.findIndex((s) => s.endsWith(name))];
    expect(src('/WebglAddon.ts')).toMatch(/this\._renderer = /);
    expect(src('/WebglRenderer.ts')).toMatch(/this\._canvas = /);
    expect(src('/WebglRenderer.ts')).toMatch(/this\._gl = this\._canvas\.getContext\('webgl2'/);
  });
});
