import { webContents } from 'electron';
import { CDPSnapshot } from '../shared/types';

interface RefEntry {
  /** `AXNode.nodeId` — an accessibility-tree id (a *string*), not a DOM node id. */
  axNodeId: string;
  /** `AXNode.backendDOMNodeId` — the integer DOM handle every DOM.* call needs.
   *  Null for accessibility-only nodes that back no DOM element. */
  backendDOMNodeId: number | null;
  /** Role, kept only so ref errors can say what the ref pointed at. */
  role: string;
}

const SKIP_ROLES = new Set([
  'generic', 'none', 'presentation', 'InlineTextBox', 'LineBreak',
]);

/**
 * Pull the DOM handle off an AX node.
 *
 * `Accessibility.getFullAXTree` returns `AXNode`s whose `nodeId` is an
 * `AXNodeId` — a *string* keyed to the accessibility tree — and whose DOM
 * handle is a separate integer under `backendDOMNodeId`. We used to read
 * `node.backendNodeId` (a field AXNode does not have) and fall back to
 * `node.nodeId`, so every ref carried an AX string where `DOM.getBoxModel` /
 * `DOM.resolveNode` require an integer. CDP rejected it as a bare
 * `Invalid parameters`, breaking click / type / fill / get-text (issue #123).
 * The bug predates #121 — it was simply unreachable while every ref lookup
 * failed with `ref_not_found` first.
 *
 * `backendNodeId` stays accepted as an alias so protocol dumps and callers
 * that hand-build node lists keep working.
 */
function backendDomIdOf(node: any): number | null {
  const raw = node?.backendDOMNodeId ?? node?.backendNodeId ?? node?.nodeId;
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null;
}

export function buildAccessibilityTree(
  nodes: any[],
): CDPSnapshot & { refMap: Map<string, RefEntry> } {
  const refMap = new Map<string, RefEntry>();
  let refCounter = 0;
  const nodeMap = new Map<number, any>();
  for (const node of nodes) nodeMap.set(node.nodeId, node);

  const lines: string[] = [];

  function walk(nodeId: number, depth: number): void {
    const node = nodeMap.get(nodeId);
    if (!node) return;
    const role = node.role?.value || '';
    const name = node.name?.value || '';
    const value = node.value?.value;

    if (SKIP_ROLES.has(role) && !name) {
      for (const childId of node.childIds || []) walk(childId, depth);
      return;
    }

    refCounter++;
    const ref = `@e${refCounter}`;
    refMap.set(ref, {
      axNodeId: String(node.nodeId),
      backendDOMNodeId: backendDomIdOf(node),
      role,
    });

    const indent = '  '.repeat(depth);
    let line = `${indent}${ref}: ${role}`;
    if (name) line += ` "${name}"`;
    if (value !== undefined && value !== '') line += ` value="${value}"`;
    lines.push(line);

    for (const childId of node.childIds || []) walk(childId, depth + 1);
  }

  if (nodes.length > 0) walk(nodes[0].nodeId, 0);

  return { tree: lines.join('\n'), refCount: refCounter, refMap };
}

/**
 * Canonical key form for the ref map: `@e<n>`, matching what the snapshot tree
 * prints. Everything else a caller might plausibly send is folded onto it.
 *
 * Refs used to be looked up verbatim, so only the exact `@e12` matched — while
 * the CLI, the orchestrator reference and every doc example pass the bare `e12`.
 * The result was that *every* ref-consuming command (`click`, `type`, `fill`,
 * `get_text`, `wait`) failed with `ref_not_found` immediately after a snapshot
 * that had just minted that very ref (issue #121). And `@e12` isn't a usable
 * workaround from PowerShell, where a leading `@` is the splatting operator and
 * the argument is mangled before wmux sees it — which is exactly why the docs
 * told callers to drop it. Both spellings (and a bare number) now resolve.
 */
export function normalizeRef(ref: unknown): string | null {
  if (typeof ref === 'number' && Number.isInteger(ref) && ref > 0) return `@e${ref}`;
  if (typeof ref !== 'string') return null;
  const match = /^\s*@?e?(\d+)\s*$/i.exec(ref);
  return match ? `@e${Number(match[1])}` : null;
}

export function resolveRef(refMap: Map<string, RefEntry>, ref: string): RefEntry | null {
  const key = normalizeRef(ref);
  return key ? refMap.get(key) ?? null : null;
}

// One attached browser webContents. Each agent/caller gets its own target so
// concurrent browser sessions don't share a ref map or clobber each other's
// page (issue #62).
interface CDPTarget {
  wcId: number;
  surfaceId: string | null;
  workspaceId: string | null;
  refMap: Map<string, RefEntry>;
}

export class CDPBridge {
  // Keyed by webContents id. A single shared singleton used to mean a second
  // browser pane stole the connection from the first (issue #62) — now every
  // attached browser is tracked independently and commands are routed by wcId.
  private targets = new Map<number, CDPTarget>();
  // Most-recently attached target. Used as the default when a command arrives
  // without an explicit wcId, preserving the old single-browser behaviour for
  // manual (human-driven) use and legacy callers.
  private lastWcId: number | null = null;

  attach(wcId: number, surfaceId?: string | null, workspaceId?: string | null): void {
    try {
      const wc = webContents.fromId(wcId);
      if (wc && !wc.debugger.isAttached()) {
        wc.debugger.attach('1.3');
      }
    } catch (err) {
      console.error('[cdp-bridge] Failed to attach:', err);
      return;
    }
    const existing = this.targets.get(wcId);
    this.targets.set(wcId, {
      wcId,
      surfaceId: surfaceId ?? existing?.surfaceId ?? null,
      workspaceId: workspaceId ?? existing?.workspaceId ?? null,
      refMap: existing?.refMap ?? new Map<string, RefEntry>(),
    });
    this.lastWcId = wcId;
  }

  // Detach a specific webContents. A closing BrowserPane only tears down its OWN
  // connection, never another still-open pane's (issues #27, #62).
  detach(wcId?: number): void {
    const target = wcId ?? this.lastWcId;
    if (target === null) return;
    try {
      const wc = webContents.fromId(target);
      if (wc?.debugger.isAttached()) wc.debugger.detach();
    } catch {}
    this.targets.delete(target);
    if (this.lastWcId === target) {
      const remaining = [...this.targets.keys()];
      this.lastWcId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    }
  }

  get attachedWebContentsId(): number | null {
    return this.lastWcId;
  }

  get isAttached(): boolean {
    return this.lastWcId !== null && this.targets.has(this.lastWcId);
  }

  hasTarget(wcId: number): boolean {
    return this.targets.has(wcId);
  }

  // Find a live browser attached for a given workspace (issue #62 routing).
  wcIdForWorkspace(workspaceId: string): number | null {
    for (const target of this.targets.values()) {
      if (target.workspaceId === workspaceId) return target.wcId;
    }
    return null;
  }

  wcIdForSurface(surfaceId: string): number | null {
    for (const target of this.targets.values()) {
      if (target.surfaceId === surfaceId) return target.wcId;
    }
    return null;
  }

  // Resolve which target a command runs against: the explicit wcId when it's a
  // live target, otherwise the most-recently attached one.
  private resolveTarget(wcId?: number): CDPTarget {
    const id = wcId !== undefined && this.targets.has(wcId) ? wcId : this.lastWcId;
    if (id === null) throw new Error('browser_not_open');
    const target = this.targets.get(id);
    if (!target) throw new Error('browser_not_open');
    return target;
  }

  private getDebugger(target: CDPTarget) {
    let wc;
    try { wc = webContents.fromId(target.wcId); } catch { throw new Error('browser_not_open'); }
    if (!wc || wc.isDestroyed() || !wc.debugger.isAttached()) throw new Error('browser_not_open');
    return wc.debugger;
  }

  private async sendCommand(target: CDPTarget, method: string, params?: any): Promise<any> {
    return this.getDebugger(target).sendCommand(method, params);
  }

  async navigate(url: string, timeout = 30000, wcId?: number): Promise<void> {
    const target = this.resolveTarget(wcId);
    let wc;
    try { wc = webContents.fromId(target.wcId); } catch { throw new Error('browser_not_open'); }
    if (!wc || wc.isDestroyed()) throw new Error('browser_not_open');
    const loadPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { wc?.removeListener('did-finish-load', onFinish); reject(new Error('timeout')); }, timeout);
      const onFinish = () => { clearTimeout(timer); resolve(); };
      wc?.once('did-finish-load', onFinish);
    });
    await this.sendCommand(target, 'Page.navigate', { url });
    await loadPromise;
  }

  async snapshot(wcId?: number): Promise<CDPSnapshot> {
    const target = this.resolveTarget(wcId);
    const result = await this.sendCommand(target, 'Accessibility.getFullAXTree');
    const { tree, refCount, refMap } = buildAccessibilityTree(result.nodes || []);
    target.refMap = refMap;
    return { tree, refCount };
  }

  /**
   * Resolve a ref or fail with a message that says what went wrong. The bare
   * `ref_not_found` sent people hunting connection lifetimes and timing (issue
   * #121) when the real answers are "you never snapshotted this browser" or
   * "that ref is past the end of the tree".
   */
  private requireRef(target: CDPTarget, ref: string): RefEntry {
    const entry = resolveRef(target.refMap, ref);
    if (entry) return entry;
    if (normalizeRef(ref) === null) {
      throw new Error(`ref_not_found: "${ref}" is not a ref — expected e12 or @e12`);
    }
    if (target.refMap.size === 0) {
      throw new Error('ref_not_found: no snapshot yet for this browser — run browser.snapshot first');
    }
    throw new Error(`ref_not_found: ${ref} — the last snapshot of this browser has @e1..@e${target.refMap.size}`);
  }

  /**
   * The DOM handle behind a ref. An accessibility-only node (no backing
   * element) is a real, if rare, outcome — say so instead of handing CDP an
   * id it will reject as `Invalid parameters` (issue #123).
   */
  private requireDomNode(target: CDPTarget, ref: string): number {
    const entry = this.requireRef(target, ref);
    if (entry.backendDOMNodeId === null) {
      throw new Error(
        `no_dom_node: ${normalizeRef(ref)} (${entry.role || 'unknown role'}) is an accessibility-only node with no DOM element — pick a ref that maps to one`,
      );
    }
    return entry.backendDOMNodeId;
  }

  private async resolveObjectId(target: CDPTarget, backendNodeId: number): Promise<string> {
    const { object } = await this.sendCommand(target, 'DOM.resolveNode', { backendNodeId });
    if (!object?.objectId) throw new Error('node_unresolvable: the element is no longer in the page');
    return object.objectId;
  }

  /**
   * Viewport centre of an element. `DOM.getBoxModel` is exact but throws for
   * anything with no layout box (display:none, an off-screen detached node, a
   * text node in some engines), so fall back to a scroll-into-view +
   * `getBoundingClientRect()` in page context.
   */
  private async centerOf(target: CDPTarget, backendNodeId: number): Promise<{ x: number; y: number }> {
    try {
      const { model } = await this.sendCommand(target, 'DOM.getBoxModel', { backendNodeId });
      const c = model?.content;
      if (Array.isArray(c) && c.length >= 8) {
        return { x: (c[0] + c[2] + c[4] + c[6]) / 4, y: (c[1] + c[3] + c[5] + c[7]) / 4 };
      }
    } catch {
      // fall through to the layout-independent path
    }
    const objectId = await this.resolveObjectId(target, backendNodeId);
    const { result } = await this.sendCommand(target, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() {
        const el = this.nodeType === 3 ? this.parentElement : this;
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) return null;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }`,
      returnByValue: true,
    });
    if (!result?.value) throw new Error('not_clickable: the element has no visible box on the page');
    return result.value;
  }

  async click(ref: string, wcId?: number): Promise<void> {
    const target = this.resolveTarget(wcId);
    const backendNodeId = this.requireDomNode(target, ref);
    const { x, y } = await this.centerOf(target, backendNodeId);
    await this.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  async type(ref: string, text: string, wcId?: number): Promise<void> {
    const target = this.resolveTarget(wcId);
    await this.click(ref, target.wcId);
    for (const char of text) {
      await this.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyDown', text: char });
      await this.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', text: char });
    }
  }

  async fill(ref: string, value: string, wcId?: number): Promise<void> {
    const target = this.resolveTarget(wcId);
    const backendNodeId = this.requireDomNode(target, ref);
    const objectId = await this.resolveObjectId(target, backendNodeId);
    await this.sendCommand(target, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function(v) {
        this.value = v;
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }`,
      arguments: [{ value }],
    });
  }

  async screenshot(fullPage = false, wcId?: number): Promise<string> {
    const target = this.resolveTarget(wcId);
    const params: any = { format: 'png' };
    if (fullPage) {
      // Chromium ≥M141 prefers cssContentSize; contentSize is deprecated but
      // still emitted. Prefer the modern field, fall back for older engines.
      const metrics = await this.sendCommand(target, 'Page.getLayoutMetrics');
      const contentSize = metrics.cssContentSize ?? metrics.contentSize;
      params.clip = { x: 0, y: 0, width: contentSize.width, height: contentSize.height, scale: 1 };
    }
    const { data } = await this.sendCommand(target, 'Page.captureScreenshot', params);
    return data;
  }

  async getText(ref?: string, wcId?: number): Promise<string> {
    const target = this.resolveTarget(wcId);
    if (ref) {
      const backendNodeId = this.requireDomNode(target, ref);
      const objectId = await this.resolveObjectId(target, backendNodeId);
      const result = await this.sendCommand(target, 'Runtime.callFunctionOn', {
        objectId, functionDeclaration: 'function() { return this.innerText || this.textContent || ""; }', returnByValue: true,
      });
      return result.result.value || '';
    }
    const result = await this.sendCommand(target, 'Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
    return result.result.value || '';
  }

  async evaluate(js: string, wcId?: number): Promise<any> {
    const target = this.resolveTarget(wcId);
    const result = await this.sendCommand(target, 'Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'eval error');
    return result.result.value;
  }

  async wait(ref?: string, timeout = 10000, wcId?: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (ref) {
        const target = this.resolveTarget(wcId);
        await this.snapshot(target.wcId);
        if (resolveRef(target.refMap, ref)) return;
      } else {
        await new Promise((r) => setTimeout(r, 200));
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('timeout');
  }
}
