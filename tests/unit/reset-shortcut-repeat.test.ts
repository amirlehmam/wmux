// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PaneId } from '../../src/shared/types';
import { useKeyboardShortcuts } from '../../src/renderer/hooks/useKeyboardShortcuts';
import { useStore } from '../../src/renderer/store';
import { createLeaf } from '../../src/renderer/store/split-utils';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Issue #357: a reset that keeps the alternate screen arms a second press to
 * force it. Holding the chord makes Windows auto-repeat the keydown well inside
 * that window, so a held Ctrl+Shift+R used to force a LIVE program off its
 * screen — #347 again. A repeat is not a second press.
 */
function Probe({ paneId }: { paneId: PaneId }) {
  useKeyboardShortcuts(paneId);
  return null;
}

let root: Root;
let host: HTMLDivElement;
let resets: string[];
const onReset = (e: Event) => { resets.push((e as CustomEvent<{ surfaceId: string }>).detail.surfaceId); };

function pressReset(repeat: boolean): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'R', code: 'KeyR', ctrlKey: true, shiftKey: true, repeat, bubbles: true, cancelable: true,
  });
  act(() => { document.body.dispatchEvent(event); });
  return event;
}

beforeEach(() => {
  resets = [];
  document.addEventListener('wmux:reset-terminal', onReset);
  useStore.setState({ language: 'en', workspaces: [], activeWorkspaceId: null });
  const leaf = createLeaf();
  useStore.getState().createWorkspace({ title: 'ws', shell: 'pwsh', splitTree: leaf });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(Probe, { paneId: leaf.paneId })));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.removeEventListener('wmux:reset-terminal', onReset);
});

describe('Reset terminal state shortcut and key auto-repeat (issue #357)', () => {
  it('a fresh press resets the focused terminal', () => {
    const tree = useStore.getState().workspaces[0].splitTree;
    pressReset(false);
    expect(tree.type).toBe('leaf');
    expect(resets).toEqual(tree.type === 'leaf' ? [tree.surfaces[0].id] : []);
  });

  it('auto-repeat keydowns from a held chord do not reset again', () => {
    pressReset(false);
    pressReset(true);
    pressReset(true);
    expect(resets).toHaveLength(1);
  });

  it('a repeat is still claimed, so the chord never reaches anything else', () => {
    expect(pressReset(true).defaultPrevented).toBe(true);
  });

  it('releasing and pressing again is a second press', () => {
    pressReset(false);
    pressReset(true);
    pressReset(false);
    expect(resets).toHaveLength(2);
  });
});
