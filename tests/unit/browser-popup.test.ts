import { describe, it, expect, vi } from 'vitest';
import { installPopupBridge, popupBridgeSource } from '../../src/renderer/components/Browser/popup-bridge';

// Issue #126: a `<webview>` without `allowpopups` discards window-open requests
// entirely — no popup, no navigation, no event anywhere — so every
// `target="_blank"` link in the browser panel was a dead click. The reported
// case was a "+ New" button that is literally `<a href="#new" target="_blank">`.

type Listener = (event: any) => void;

/** Minimal stand-in for the guest page's globals — no DOM environment needed. */
function makeScope(baseUrl = 'https://textarea.online/') {
  const listeners: Record<string, Array<{ fn: Listener; capture: boolean }>> = {};
  const scope: any = {
    URL,
    location: { href: baseUrl },
    open: vi.fn(() => 'native-popup'),
    document: {
      addEventListener: (type: string, fn: Listener, capture?: boolean) => {
        listeners[type] ||= [];
        listeners[type].push({ fn, capture: !!capture });
      },
    },
    // Test helper — dispatches to whatever the bridge registered.
    fire(type: string, event: any) {
      for (const l of listeners[type] || []) l.fn(event);
      return event;
    },
  };
  return scope;
}

function anchor(attrs: Record<string, string | null>) {
  const node: any = {
    getAttribute: (name: string) => (name in attrs ? attrs[name] : null),
    removeAttribute: vi.fn((name: string) => { attrs[name] = null; }),
  };
  node.closest = () => node;
  return node;
}

function clickEvent(target: any, overrides: Record<string, any> = {}) {
  return {
    target,
    button: 0,
    defaultPrevented: false,
    ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  };
}

describe('browser pane popup bridge (issue #126)', () => {
  it('turns a target=_blank click into a navigation instead of nothing', () => {
    const scope = makeScope();
    installPopupBridge(scope);

    const event = clickEvent(anchor({ href: '#new', target: '_blank' }));
    scope.fire('click', event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(scope.location.href).toBe('https://textarea.online/#new');
  });

  it('resolves relative and absolute hrefs against the current page', () => {
    const scope = makeScope('https://example.com/docs/intro');
    installPopupBridge(scope);

    scope.fire('click', clickEvent(anchor({ href: '../guide', target: '_blank' })));
    expect(scope.location.href).toBe('https://example.com/guide');

    scope.fire('click', clickEvent(anchor({ href: 'https://github.com/amirlehmam/wmux', target: '_new' })));
    expect(scope.location.href).toBe('https://github.com/amirlehmam/wmux');
  });

  it('leaves ordinary links alone', () => {
    const scope = makeScope();
    installPopupBridge(scope);

    const event = clickEvent(anchor({ href: '/plain' }));
    scope.fire('click', event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(scope.location.href).toBe('https://textarea.online/');
  });

  it('yields to a page that already handled the click', () => {
    const scope = makeScope();
    installPopupBridge(scope);

    const event = clickEvent(anchor({ href: '/x', target: '_blank' }), { defaultPrevented: true });
    scope.fire('click', event);

    expect(scope.location.href).toBe('https://textarea.online/');
  });

  it('ignores modified and non-primary clicks', () => {
    const scope = makeScope();
    installPopupBridge(scope);

    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      scope.fire('click', clickEvent(anchor({ href: '/x', target: '_blank' }), mod));
    }
    expect(scope.location.href).toBe('https://textarea.online/');
  });

  // Routing a non-http scheme into a same-frame navigation would hand a page a
  // click-triggered javascript:/data: execution it was otherwise denied.
  it('refuses to route anything that is not http(s)', () => {
    const scope = makeScope();
    installPopupBridge(scope);

    for (const href of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///C:/Windows/win.ini', 'chrome://settings']) {
      const event = clickEvent(anchor({ href, target: '_blank' }));
      scope.fire('click', event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(scope.location.href).toBe('https://textarea.online/');
  });

  it('drops target=_blank off a form so it submits in place', () => {
    const scope = makeScope();
    installPopupBridge(scope);

    const form = anchor({ target: '_blank', action: '/search' });
    scope.fire('submit', { target: form });
    expect(form.removeAttribute).toHaveBeenCalledWith('target');
  });

  it('routes window.open, and still returns null as blocked popups did', () => {
    const scope = makeScope();
    installPopupBridge(scope);

    expect(scope.open('/next')).toBeNull();
    expect(scope.location.href).toBe('https://textarea.online/next');
  });

  it('defers to the native window.open for anything it will not route', () => {
    const scope = makeScope();
    const native = scope.open;
    installPopupBridge(scope);

    expect(scope.open()).toBe('native-popup');
    expect(native).toHaveBeenCalled();
    expect(scope.location.href).toBe('https://textarea.online/');
  });

  it('installs once per document', () => {
    const scope = makeScope();
    installPopupBridge(scope);
    const afterFirst = scope.open;
    installPopupBridge(scope);
    expect(scope.open).toBe(afterFirst);
  });

  // The snippet is serialised into the guest page, so it must not close over
  // anything from module scope — a `__vite`/TS helper reference would throw
  // inside the webview and silently un-fix the bug.
  it('serialises to a self-contained snippet', () => {
    const source = popupBridgeSource();
    expect(source.startsWith('(function')).toBe(true);
    expect(source.endsWith('(window)')).toBe(true);
    expect(source).toContain('__wmuxPopupBridge');
    // Nothing module-scoped: no sibling export, no imports, and none of the
    // TS/bundler helper shims that a downlevelled construct would pull in.
    expect(source).not.toContain('popupBridgeSource');
    expect(source).not.toMatch(/\bimport\b|\brequire\(/);
    expect(source).not.toMatch(/__(vite|awaiter|spreadArray|assign|rest|generator)/);
  });
});
