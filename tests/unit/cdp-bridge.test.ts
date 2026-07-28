import { describe, it, expect, vi } from 'vitest';

// Minimal fake webContents registry so we can exercise CDPBridge attach/detach
// without a real Electron runtime.
const fakeContents = new Map<number, any>();
function makeWc(id: number, respond?: (method: string, params: any) => any) {
  let attached = false;
  const sent: Array<{ method: string; params: any }> = [];
  const wc = {
    isDestroyed: () => false,
    sent,
    debugger: {
      isAttached: () => attached,
      attach: () => { attached = true; },
      detach: () => { attached = false; },
      sendCommand: async (method: string, params: any) => {
        sent.push({ method, params });
        return respond ? respond(method, params) : {};
      },
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
    const entry = (backendDOMNodeId: number) => ({ axNodeId: '5', backendDOMNodeId, role: 'button' });

    it('returns entry for valid ref', () => {
      const refMap = new Map([['@e1', entry(10)]]);
      expect(resolveRef(refMap, '@e1')).toEqual(entry(10));
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
      const refMap = new Map([['@e12', entry(10)]]);
      expect(resolveRef(refMap, 'e12')).toEqual(entry(10));
      expect(resolveRef(refMap, '@e12')).toEqual(entry(10));
      expect(resolveRef(refMap, '12')).toEqual(entry(10));
      expect(resolveRef(refMap, ' E12 ')).toEqual(entry(10));
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
        { nodeId: 1, role: { value: 'document' }, name: { value: 'Page' }, backendDOMNodeId: 11, childIds: [2] },
        { nodeId: 2, role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 12, childIds: [] },
      ]);
      expect(refCount).toBe(2);
      expect(resolveRef(refMap, 'e2')).toEqual({ axNodeId: '2', backendDOMNodeId: 12, role: 'button' });
    });
  });

  // Issue #123: `Accessibility.getFullAXTree` hands back AXNodes whose `nodeId`
  // is an accessibility-tree id (a STRING) and whose DOM handle lives in
  // `backendDOMNodeId`. Reading the non-existent `backendNodeId` and falling
  // back to `nodeId` put a string where DOM.getBoxModel / DOM.resolveNode
  // demand an integer, so CDP answered every click / type / fill / get-text
  // with a bare `Invalid parameters`.
  describe('DOM handles from AX nodes (issue #123)', () => {
    // Shaped exactly like the wire format, string ids included.
    const realWorldNodes = [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Example Domain' }, backendDOMNodeId: 4, childIds: ['2'] },
      { nodeId: '2', role: { value: 'heading' }, name: { value: 'Example Domain' }, backendDOMNodeId: 17, childIds: ['3'] },
      { nodeId: '3', role: { value: 'link' }, name: { value: 'Learn more' }, backendDOMNodeId: 23, childIds: [] },
    ];

    it('reads the DOM handle out of backendDOMNodeId, as an integer', () => {
      const { refMap } = buildAccessibilityTree(realWorldNodes);
      for (const ref of ['e1', 'e2', 'e3']) {
        const resolved = resolveRef(refMap, ref)!;
        expect(typeof resolved.backendDOMNodeId).toBe('number');
      }
      expect(resolveRef(refMap, 'e3')!.backendDOMNodeId).toBe(23);
    });

    it('never lets an AX string id leak out as a DOM handle', () => {
      const { refMap } = buildAccessibilityTree(realWorldNodes);
      for (const [, entry] of refMap) {
        expect(entry.backendDOMNodeId).not.toBe(entry.axNodeId);
        expect(typeof entry.backendDOMNodeId === 'number' || entry.backendDOMNodeId === null).toBe(true);
      }
    });

    it('marks an accessibility-only node as having no DOM handle instead of inventing one', () => {
      const { refMap } = buildAccessibilityTree([
        { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Page' }, childIds: [] },
      ]);
      expect(resolveRef(refMap, 'e1')!.backendDOMNodeId).toBeNull();
    });

    it('click sends an integer backendNodeId to DOM.getBoxModel', async () => {
      const wc = makeWc(42, (method) => {
        if (method === 'Accessibility.getFullAXTree') return { nodes: realWorldNodes };
        if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 100, 0, 100, 20, 0, 20] } };
        return {};
      });
      const bridge = new CDPBridge();
      bridge.attach(42);
      await bridge.snapshot(42);
      await bridge.click('e3', 42);

      const box = wc.sent.find((c) => c.method === 'DOM.getBoxModel')!;
      expect(box.params.backendNodeId).toBe(23);
      expect(Number.isInteger(box.params.backendNodeId)).toBe(true);
      // And the click actually landed at the box centre.
      const press = wc.sent.find((c) => c.params?.type === 'mousePressed')!;
      expect(press.params).toMatchObject({ x: 50, y: 10, button: 'left' });
    });

    it('says so plainly when a ref has no DOM element behind it', async () => {
      makeWc(43, (method) => {
        if (method === 'Accessibility.getFullAXTree') {
          return { nodes: [{ nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Page' }, childIds: [] }] };
        }
        return {};
      });
      const bridge = new CDPBridge();
      bridge.attach(43);
      await bridge.snapshot(43);
      await expect(bridge.click('e1', 43)).rejects.toThrow(/no_dom_node/);
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
