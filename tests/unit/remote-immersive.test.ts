// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AttachScreen } from '../../src/renderer/remote/screens/AttachScreen';
import { createT } from '../../src/renderer/remote/i18n';
import type { WsClient } from '../../src/renderer/remote/ws-client';

vi.mock('../../src/renderer/remote/components/TermView', () => ({
  TermView: () => React.createElement('div', { 'data-testid': 'mirror' }),
}));
vi.mock('../../src/renderer/remote/components/Composer', () => ({
  Composer: () => React.createElement('textarea', { defaultValue: 'unsent draft' }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('hides chrome without remounting the mirror or losing a draft, and restores with Escape (#404)', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(React.createElement(AttachScreen, {
      client: {} as WsClient, s: 'surf-test', entry: undefined,
      status: 'ready', operator: true, maxText: 1000, fontScale: 1, dark: true, t: createT('en'),
      onBack: vi.fn(), onAnswer: vi.fn(), onError: vi.fn(),
    })));
    const mirror = host.querySelector('[data-testid="mirror"]');
    const draft = host.querySelector('textarea')!;
    draft.value = 'keep this text';
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Hide all controls"]')!.click());
    expect(host.querySelector('.rc-attach--immersive')).not.toBeNull();
    const restore = host.querySelector<HTMLButtonElement>('[aria-label="Show controls"]')!;
    expect(document.activeElement).toBe(restore);
    expect(host.querySelector('[data-testid="mirror"]')).toBe(mirror);
    act(() => restore.click());
    expect(host.querySelector('.rc-attach--immersive')).toBeNull();
    expect(host.querySelector('textarea')).toBe(draft);
    expect(draft.value).toBe('keep this text');
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Hide all controls"]')!.click());
    act(() => globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(host.querySelector('.rc-attach--immersive')).toBeNull();
  } finally { act(() => root.unmount()); host.remove(); }
});
