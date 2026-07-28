import { describe, it, expect, vi } from 'vitest';

// Minimal fake webContents registry so we can exercise CDPBridge attach/detach
// without a real Electron runtime.
const fakeContents = new Map<number, any>();
function makeWc(id: number) {
  let attached = false;
  const wc = {
    isDestroyed: () => false,
    debugger: {
      isAttached: () => attached,
      attach: () => { attached = true; },
      detach: () => { attached = false; },
    },
  };
  fakeContents.set(id, wc);
  return wc;
}
vi.mock('electron', () => ({
  webContents: { fromId: (id: number) => fakeContents.get(id) },
}));

import { buildAccessibilityTree, resolveRef, normalizeRef, CDPBridge } from '../../src/main/cdp-bridge';

describe('CDP Bridge', () => {
  describe('buildAccessibilityTree', () => {
    it('formats AX nodes with refs', () => {
      const nodes = [
        { nodeId: 1, role: { value: 'document' }, name: { value: 'My Page' }, childIds: [2, 3] },
        { nodeId: 2, role: { value: 'button' }, name: { value: 'Submit' }, childIds: [] },
        { nodeId: 3, role: { value: 'textbox' }, name: { value: 'Email' }, value: { value: '' }, childIds: [] },
      ];
      const result = buildAccessibilityTree(nodes);
      expect(result.tree).toContain('@e1: document "My Page"');
      expect(result.tree).toContain('@e2: button "Submit"');
      expect(result.tree).toContain('@e3: textbox "Email"');
      expect(result.refCount).toBe(3);
    });

    it('skips generic nodes without ARIA roles', () => {
      const nodes = [
        { nodeId: 1, role: { value: 'document' }, name: { value: '' }, childIds: [2] },
        { nodeId: 2, role: { value: 'generic' }, name: { value: '' }, childIds: [3] },
        { nodeId: 3, role: { value: 'button' }, name: { value: 'OK' }, childIds: [] },
      ];
      const result = buildAccessibilityTree(nodes);
      expect(result.tree).not.toContain('generic');
      expect(result.tree).toContain('button "OK"');
    });
  });

  describe('resolveRef', () => {
    it('returns entry for valid ref', () => {
      const refMap = new Map([['@e1', { nodeId: 5, backendNodeId: 10 }]]);
      expect(resolveRef(refMap, '@e1')).toEqual({ nodeId: 5, backendNodeId: 10 });
    });

    it('returns null for invalid ref', () => {
      expect(resolveRef(new Map(), '@e99')).toBeNull();
    });

    // Issue #121: the map is keyed with the display form `@eN`, but the CLI,
    // the orchestrator reference and every doc example pass the bare `eN` — so
    // click / type / fill / get_text / wait ALL failed with ref_not_found on
    // refs a snapshot had just minted. Both spellings must resolve; the bare
    // form stays the documented one because PowerShell eats a leading `@`.
    it('resolves the bare ref the CLI actually sends', () => {
      const refMap = new Map([['@e12', { nodeId: 5, backendNodeId: 10 }]]);
      expect(resolveRef(refMap, 'e12')).toEqual({ nodeId: 5, backendNodeId: 10 });
      expect(resolveRef(refMap, '@e12')).toEqual({ nodeId: 5, backendNodeId: 10 });
      expect(resolveRef(refMap, '12')).toEqual({ nodeId: 5, backendNodeId: 10 });
      expect(resolveRef(refMap, ' E12 ')).toEqual({ nodeId: 5, backendNodeId: 10 });
    });

    it('normalizes every accepted spelling onto the snapshot key', () => {
      expect(normalizeRef('e7')).toBe('@e7');
      expect(normalizeRef('@e7')).toBe('@e7');
      expect(normalizeRef('7')).toBe('@e7');
      expect(normalizeRef(7)).toBe('@e7');
      // Leading zeros are a spelling of the same ref, not a different one.
      expect(normalizeRef('e007')).toBe('@e7');
    });

    it('rejects things that are not refs rather than guessing', () => {
      expect(normalizeRef('')).toBeNull();
      expect(normalizeRef('button')).toBeNull();
      expect(normalizeRef('e1x')).toBeNull();
      expect(normalizeRef('@@e1')).toBeNull();
      expect(normalizeRef(undefined)).toBeNull();
      // A tree never mints @e0, so accepting it would only mask a caller bug.
      expect(normalizeRef(0)).toBeNull();
    });

    it('resolves refs a real snapshot produced, in the form the CLI sends', () => {
      const { refMap, refCount } = buildAccessibilityTree([
        { nodeId: 1, role: { value: 'document' }, name: { value: 'Page' }, childIds: [2] },
        { nodeId: 2, role: { value: 'button' }, name: { value: 'Submit' }, childIds: [] },
      ]);
      expect(refCount).toBe(2);
      expect(resolveRef(refMap, 'e2')).toEqual({ nodeId: 2, backendNodeId: 2 });
    });
  });

  describe('ownership-aware detach (issue #27)', () => {
    it('ignores detach from a pane that does not own the attachment', () => {
      makeWc(1);
      makeWc(2);
      const bridge = new CDPBridge();
      bridge.attach(1);
      expect(bridge.attachedWebContentsId).toBe(1);

      // A different pane (wcId 2) unmounting must not tear down pane 1's CDP.
      bridge.detach(2);
      expect(bridge.attachedWebContentsId).toBe(1);
      expect(bridge.isAttached).toBe(true);
    });

    it('detaches when the owning pane requests it', () => {
      makeWc(1);
      const bridge = new CDPBridge();
      bridge.attach(1);
      bridge.detach(1);
      expect(bridge.attachedWebContentsId).toBeNull();
      expect(bridge.isAttached).toBe(false);
    });

    it('detaches unconditionally when no wcId is given', () => {
      makeWc(1);
      const bridge = new CDPBridge();
      bridge.attach(1);
      bridge.detach();
      expect(bridge.attachedWebContentsId).toBeNull();
    });
  });
});
