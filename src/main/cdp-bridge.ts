import { webContents } from 'electron';
import { CDPSnapshot } from '../shared/types';

interface RefEntry {
  nodeId: number;
  backendNodeId: number;
}

const SKIP_ROLES = new Set([
  'generic', 'none', 'presentation', 'InlineTextBox', 'LineBreak',
]);

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
    refMap.set(ref, { nodeId: node.nodeId, backendNodeId: node.backendNodeId || node.nodeId });

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

export function resolveRef(refMap: Map<string, RefEntry>, ref: string): RefEntry | null {
  return refMap.get(ref) ?? null;
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

  async click(ref: string, wcId?: number): Promise<void> {
    const target = this.resolveTarget(wcId);
    const entry = resolveRef(target.refMap, ref);
    if (!entry) throw new Error('ref_not_found');
    const { model } = await this.sendCommand(target, 'DOM.getBoxModel', { backendNodeId: entry.backendNodeId });
    const content = model.content;
    const x = (content[0] + content[2] + content[4] + content[6]) / 4;
    const y = (content[1] + content[3] + content[5] + content[7]) / 4;
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
    const entry = resolveRef(target.refMap, ref);
    if (!entry) throw new Error('ref_not_found');
    const { object } = await this.sendCommand(target, 'DOM.resolveNode', { backendNodeId: entry.backendNodeId });
    await this.sendCommand(target, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function(v) { this.value = v; this.dispatchEvent(new Event('input', {bubbles:true})); }`,
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
      const entry = resolveRef(target.refMap, ref);
      if (!entry) throw new Error('ref_not_found');
      const { object } = await this.sendCommand(target, 'DOM.resolveNode', { backendNodeId: entry.backendNodeId });
      const result = await this.sendCommand(target, 'Runtime.callFunctionOn', {
        objectId: object.objectId, functionDeclaration: 'function() { return this.innerText || this.textContent || ""; }', returnByValue: true,
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
