/**
 * v2-bridge.ts — Table-driven V2 pipe handlers that simply forward to a renderer
 * `window.__wmux_*` bridge call and shape the reply. Extracted from index.ts's
 * dispatch switch so the switch stays maintainable; the behaviour (the exact JS
 * expression and response shape) is preserved verbatim per method.
 */
import { BrowserWindow } from 'electron';

type Respond = (result: any) => void;
type RespondError = (code: number, message: string) => void;

interface BridgeSpec {
  js: (params: any) => string;
  // Shape the renderer result into the RPC reply. Default: result ?? { ok: true }.
  shape?: (result: any) => any;
  // When there is no window: respond with this value instead of erroring. Used by
  // read-only "list" methods that should return an empty set rather than fail.
  emptyOnNoWindow?: any;
  // Error message when the renderer returns a falsy result (creation methods).
  requireResult?: string;
}

// caller surface id → the window that held it. `getAllWindows()` order is not
// a promise Electron makes, so two consecutive CLI calls could land on two
// different windows and report contradictory state (issue #141: `tree` and
// `list-surfaces` disagreed about which panes existed, and a scripted cleanup
// consequently found nothing to close and exited claiming success).
const callerWindows = new Map<string, number>();

/**
 * The window that owns the calling shell's surface, or the first one.
 *
 * Only probes when it has to: with a single window — the common case — the
 * answer is that window and no extra round-trip is spent.
 */
async function windowForCaller(caller: unknown): Promise<BrowserWindow | null> {
  const live = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  if (live.length <= 1) return live[0] ?? null;
  if (typeof caller !== 'string' || !caller) return BrowserWindow.getFocusedWindow() ?? live[0];

  const cachedId = callerWindows.get(caller);
  const cached = cachedId !== undefined ? live.find((w) => w.id === cachedId) : undefined;
  if (cached) return cached;

  for (const win of live) {
    try {
      const owns = await win.webContents.executeJavaScript(
        `window.__wmux_hasSurface?.(${S(caller)})`
      );
      if (owns) {
        callerWindows.set(caller, win.id);
        return win;
      }
    } catch { /* window went away mid-probe; try the next */ }
  }
  return BrowserWindow.getFocusedWindow() ?? live[0];
}

const S = (v: any) => JSON.stringify(v);

const SPECS: Record<string, BridgeSpec> = {
  'workspace.create': {
    js: (p) => `window.__wmux_createWorkspace?.(${S(p || {})})`,
    shape: (r) => r || { ok: true },
  },
  'workspace.close': {
    js: (p) => `window.__wmux_closeWorkspace?.(${S(p?.id || p?.workspaceId)})`,
  },
  'workspace.select': {
    js: (p) => `window.__wmux_selectWorkspace?.(${S(p?.id || p?.workspaceId)})`,
  },
  'workspace.rename': {
    js: (p) => `window.__wmux_renameWorkspace?.(${S(p?.id || p?.workspaceId)}, ${S(p?.title || '')})`,
  },
  'workspace.list': {
    js: () => `window.__wmux_listWorkspaces?.()`,
    shape: (r) => ({ workspaces: r || [] }),
    emptyOnNoWindow: { workspaces: [] },
  },
  'pane.split': {
    js: (p) => `window.__wmux_splitPane?.(${S(p || {})})`,
    requireResult: 'No active workspace or panes',
  },
  'pane.close': {
    js: (p) => `window.__wmux_closePane?.(${S(p?.id || p?.paneId)}, ${S(p?.workspaceId)})`,
  },
  'pane.list': {
    js: (p) => `window.__wmux_listPanes?.(${S(p?.workspaceId)})`,
    shape: (r) => ({ panes: r || [] }),
    emptyOnNoWindow: { panes: [] },
  },
  'layout.grid': {
    js: (p) => `window.__wmux_layoutGrid?.(${S(p || {})})`,
    requireResult: 'No active workspace or invalid anchor',
  },
  'system.tree': {
    js: (p) => `window.__wmux_getTree?.(${S(p?.workspaceId)})`,
    shape: (r) => ({ tree: r || null }),
    emptyOnNoWindow: { tree: null },
  },
  'surface.create': {
    js: (p) => `window.__wmux_createSurface?.(${S(p || {})})`,
    requireResult: 'No active workspace or panes',
  },
  'surface.close': {
    js: (p) => `window.__wmux_closeSurface?.(${S(p?.id || p?.surfaceId)}, ${S(p?.workspaceId)})`,
  },
  'surface.focus': {
    js: (p) => `window.__wmux_focusSurface?.(${S(p?.id || p?.surfaceId)}, ${S(p?.workspaceId)})`,
  },
  'surface.rename': {
    js: (p) => `window.__wmux_renameSurface?.(${S(p?.id || p?.surfaceId)}, ${S(p?.title || '')}, ${S(p?.workspaceId)})`,
  },
  'surface.list': {
    js: (p) => `window.__wmux_listSurfaces?.(${S(p?.workspaceId)}, ${S(p?.paneId)})`,
    shape: (r) => ({ surfaces: r || [] }),
    emptyOnNoWindow: { surfaces: [] },
  },
  'markdown.set_content': {
    // `title` is optional and only sets the tab label; without it every
    // CLI-pushed surface was labelled "Markdown", so several agent-pushed docs
    // in one pane were indistinguishable (issue #116). It does NOT make the
    // surface file-backed — pushed content stays pathless by design.
    js: (p) => `window.__wmux_setMarkdownContent?.(${S(p?.surfaceId || '')}, ${S(p?.markdown || '')}, ${S(p?.title || '')})`,
  },
  'markdown.get_content': {
    // Read the buffer back out, mirroring `read-screen` for terminals: it lets
    // an agent verify what it actually pushed, which is the only way to debug a
    // producer that emitted an escaped newline or an unclosed fence (#116).
    js: (p) => `window.__wmux_getMarkdownContent?.(${S(p?.surfaceId || '')})`,
    shape: (r) => r ?? { error: 'surface not found' },
  },
  'notification.list': {
    js: () => `window.__wmux_listNotifications?.()`,
    shape: (r) => ({ notifications: r || [] }),
    emptyOnNoWindow: { notifications: [] },
  },
};

function runBridge(spec: BridgeSpec, params: any, respond: Respond, respondError: RespondError): void {
  (async () => {
    try {
      const win = await windowForCaller(params?.caller);
      if (!win) {
        if (spec.emptyOnNoWindow !== undefined) { respond(spec.emptyOnNoWindow); return; }
        respondError(-32000, 'No window');
        return;
      }
      const result = await win.webContents.executeJavaScript(spec.js(params));
      if (spec.requireResult && !result) { respondError(-32000, spec.requireResult); return; }
      respond(spec.shape ? spec.shape(result) : (result ?? { ok: true }));
    } catch (err: any) {
      respondError(-32000, err.message);
    }
  })();
}

/** Handle a uniform bridge method. Returns false if `method` isn't one. */
export function handleBridgeV2(
  method: string,
  params: any,
  respond: Respond,
  respondError: RespondError,
): boolean {
  const spec = SPECS[method];
  if (!spec) return false;
  runBridge(spec, params, respond, respondError);
  return true;
}
