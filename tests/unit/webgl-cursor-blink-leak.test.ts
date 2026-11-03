import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// Issue #421: renderer memory climbed for as long as the user kept working.
// @xterm/addon-webgl 0.19.0 never disposes its cursor-blink manager
// (xtermjs/xterm.js#5818), so the 600 ms blink interval outlives the addon and
// keeps the WebGL renderer and the whole Terminal (scrollback included) alive.
// wmux detaches WebGL on every hide and close, so each one of those leaked a
// Terminal. The release path now stops the blink manager itself.
// ─────────────────────────────────────────────────────────────────────────────

interface FakeAddon {
  disposed: boolean;
  contextLoss?: () => void;
  _renderer?: { _cursorBlinkStateManager?: { clear: () => void } };
}

const addons: FakeAddon[] = [];
const events: string[] = [];

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    disposed = false;
    contextLoss?: () => void;
    _renderer = { _cursorBlinkStateManager: { clear: () => { events.push('blink cleared'); } } };
    constructor() { addons.push(this); }
    onContextLoss(cb: () => void): void { this.contextLoss = cb; }
    dispose(): void { this.disposed = true; events.push('addon disposed'); }
  },
}));

const { attachVisibleRenderer, getActiveWebglCount } = await import('../../src/renderer/utils/terminal-renderer');

function fakeTerminal() {
  return { loadAddon: () => {}, refresh: vi.fn(), rows: 24 } as unknown as import('@xterm/xterm').Terminal;
}

beforeEach(() => {
  addons.length = 0;
  events.length = 0;
});

describe('WebGL release stops the cursor-blink interval (#421)', () => {
  it('clears the blink manager before disposing the addon on hide/close', () => {
    const handle = attachVisibleRenderer(fakeTerminal());
    handle.dispose();
    expect(events).toEqual(['blink cleared', 'addon disposed']);
  });

  it('clears it on a context-loss downgrade too', () => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    attachVisibleRenderer(fakeTerminal());
    const before = getActiveWebglCount();
    addons[0].contextLoss!();
    expect(events).toEqual(['blink cleared', 'addon disposed']);
    expect(getActiveWebglCount()).toBe(before - 1);
    vi.unstubAllGlobals();
  });

  it('still disposes the addon when the private field is missing', () => {
    const handle = attachVisibleRenderer(fakeTerminal());
    delete addons[0]._renderer;
    handle.dispose();
    expect(events).toEqual(['addon disposed']);
  });

  it('still disposes the addon when clearing throws', () => {
    const handle = attachVisibleRenderer(fakeTerminal());
    addons[0]._renderer!._cursorBlinkStateManager = { clear: () => { throw new Error('boom'); } };
    handle.dispose();
    expect(addons[0].disposed).toBe(true);
  });
});

// The workaround reaches into addon internals. These pin it to the shipped
// build: the first fails if a new addon renames the fields (the workaround
// would silently stop working); the second fails once the addon registers the
// manager itself, at which point the workaround can be deleted.
describe('@xterm/addon-webgl internals the workaround relies on', () => {
  const lib = fs.readFileSync(
    path.join(__dirname, '../../node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs'),
    'utf8',
  );

  it('still has _renderer and _cursorBlinkStateManager', () => {
    expect(lib).toMatch(/\._renderer=this\._register\(/);
    expect(lib).toMatch(/_cursorBlinkStateManager\.clear\(\)/);
  });

  it('still leaves the blink manager unregistered (remove the workaround when this fails)', () => {
    expect(lib).toMatch(/_cursorBlinkStateManager=new /);
    expect(lib).not.toMatch(/_cursorBlinkStateManager=this\._register\(/);
  });
});
