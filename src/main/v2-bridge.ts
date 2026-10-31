/**
 * v2-bridge.ts — Table-driven V2 pipe handlers that simply forward to a renderer
 * `window.__wmux_*` bridge call and shape the reply. Extracted from index.ts's
 * dispatch switch so the switch stays maintainable; the behaviour (the exact JS
 * expression and response shape) is preserved verbatim per method.
 */
import { BrowserWindow } from 'electron';
import { isValidBaseRef, isValidBranchName } from './git-worktree';
import { getExplorerRoot } from './explorer-roots';

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
  /**
   * Methods that act on "a workspace" with no id of their own to go by. They
   * fall back to the *active* workspace of whatever window they land on, which
   * is only the right answer when the caller happens to be looking at it — so
   * when we know where the calling shell lives, its workspace is the better
   * default (issue #143). Methods that take an explicit surface/pane id are
   * deliberately NOT scoped: the renderer resolves those ids window-wide.
   */
  callerScoped?: boolean;
  // Reject bad params before any window is looked up. Returns the -32602 message.
  validate?: (params: any) => string | null;
  // Fill in what only main knows, after validation and before the renderer
  // sees the params. Returns the params to send, or `{ error }` for -32602.
  prepare?: (params: any) => any;
}

/** Which window (by `BrowserWindow.id`) and workspace a call should be answered by. */
export interface CallerTarget<W> {
  win: W;
  /** Undefined when the caller's surface is unknown — the window's own active workspace stands. */
  workspaceId?: string;
}

/**
 * Resolve the calling shell's surface to the window AND workspace that hold it.
 *
 * Split out from the Electron plumbing (injected `live` / `focused` / `locate`)
 * so the resolution rules are unit-testable without a running app.
 *
 * Rules, in order:
 *   1. No caller id → the focused window, no workspace opinion. Unchanged.
 *   2. Probe windows for the surface, cached window first. First hit wins and
 *      supplies BOTH the window and the workspace.
 *   3. Surface unknown anywhere (stale `WMUX_SURFACE_ID`, closed pane) → fall
 *      back to the focused window, exactly as if no id had been passed.
 *
 * The cache is only a probe-ORDER hint, never the answer. It used to be
 * authoritative, so one wrong or outdated hit pinned that caller to that window
 * for the rest of the session — the "byte-stable across focus changes" wrong
 * result in issue #143. Re-probing costs one round-trip and lets a stale entry
 * heal itself on the very next call.
 */
export async function resolveCallerTarget<W>(
  caller: unknown,
  deps: {
    live: readonly W[];
    focused: () => W | null;
    keyOf: (win: W) => number;
    locate: (win: W, surfaceId: string) => Promise<{ workspaceId?: string | null } | null | undefined>;
    cache: Map<string, number>;
  },
): Promise<CallerTarget<W> | null> {
  const { live } = deps;
  if (live.length === 0) return null;
  const fallback = () => ({ win: live.length === 1 ? live[0] : (deps.focused() ?? live[0]) });
  if (typeof caller !== 'string' || !caller) return fallback();

  const cachedKey = deps.cache.get(caller);
  const cached = cachedKey === undefined ? undefined : live.find((w) => deps.keyOf(w) === cachedKey);
  const order = cached ? [cached, ...live.filter((w) => w !== cached)] : live;

  for (const win of order) {
    let found: { workspaceId?: string | null } | null | undefined;
    try {
      found = await deps.locate(win, caller);
    } catch {
      continue; // window went away mid-probe; try the next
    }
    if (found) {
      deps.cache.set(caller, deps.keyOf(win));
      return { win, workspaceId: found.workspaceId ?? undefined };
    }
  }
  deps.cache.delete(caller);
  return fallback();
}

const S = (v: any) => JSON.stringify(v);

/**
 * The `link.open` renderer expression.
 *
 * Exported so the escaping is testable: the URL reaches `executeJavaScript` as
 * source, so a quote or newline in it must be encoded, not concatenated raw.
 * A non-string becomes `""`, which `openLinkFromBridge` refuses.
 */
export function linkOpenJs(url: unknown): string {
  return `window.__wmux_openLink?.(${S(typeof url === 'string' ? url : '')})`;
}

/**
 * -32602 message for `workspace.create`'s worktree params (#366), or null.
 * The branch and the base both reach git's argv, so neither may look like an
 * option; git's own `check-ref-format` runs again when the worktree is made.
 */
export function validateWorkspaceCreateParams(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null;
  const p = params as Record<string, unknown>;
  if (p.worktree === undefined) {
    return p.base === undefined ? null : '--base is only valid with --worktree';
  }
  if (!isValidBranchName(p.worktree)) {
    return `Invalid worktree branch name: ${JSON.stringify(p.worktree)}`;
  }
  if (!isValidBaseRef(p.base)) return `Invalid base ref: ${JSON.stringify(p.base)}`;
  if (p.cwd !== undefined && typeof p.cwd !== 'string') return 'cwd must be a string';
  return null;
}

/**
 * The repository a pipe-created worktree branches from is the CALLER's
 * (#246): an explicit `cwd`, else the folder the calling surface last
 * reported. Never the focused workspace — that is somebody else's repo as
 * often as not, and a worktree made in the wrong one is a branch the user did
 * not ask for. With neither, the call is refused rather than guessed.
 */
export function prepareWorkspaceCreateParams(
  params: any,
  rootOf: (surfaceId: string) => { realRoot: string } | null = getExplorerRoot,
): any {
  if (!params || params.worktree === undefined || params.cwd) return params;
  const root = typeof params.caller === 'string' && params.caller ? rootOf(params.caller) : null;
  if (!root) return { error: 'Cannot tell which repository to branch from: pass --cwd <dir>' };
  return { ...params, cwd: root.realRoot };
}

// Same value as MAX_AGENT_CELLS in renderer/store/split-utils.ts; main's tsconfig does not include the renderer.
const MAX_LAYOUT_AGENT_CELLS = 16;

/**
 * -32602 message for `layout.agents` params (#255), or null when they are usable.
 * `layout.agents` splits only the anchor's pane, where `layout.grid` rebuilds the
 * whole workspace. Main answers this itself so a bad count never reaches a
 * renderer, which would have to guess at `count: null`. The ratio
 * is only checked for being a finite number: clamping to [0.2, 0.8] belongs to
 * `buildAgentLayout`, so an out-of-range ratio is not an error.
 */
export function validateLayoutAgentsParams(params: unknown): string | null {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return 'layout.agents params must be an object';
  }
  const p = params as Record<string, unknown>;
  if (!Number.isInteger(p.count) || (p.count as number) < 1 || (p.count as number) > MAX_LAYOUT_AGENT_CELLS) {
    return `count must be an integer from 1 to ${MAX_LAYOUT_AGENT_CELLS}`;
  }
  if (p.coordinatorRatio !== undefined
    && (typeof p.coordinatorRatio !== 'number' || !Number.isFinite(p.coordinatorRatio))) {
    return 'coordinatorRatio must be a finite number';
  }
  for (const key of ['type', 'anchorSurfaceId', 'anchorPaneId', 'workspaceId']) {
    if (p[key] !== undefined && typeof p[key] !== 'string') return `${key} must be a string`;
  }
  return null;
}

// caller surface id → the window that last held it. See resolveCallerTarget:
// this is a hint that reorders the probe, not a binding.
const callerWindows = new Map<string, number>();

function targetForCaller(caller: unknown): Promise<CallerTarget<BrowserWindow> | null> {
  return resolveCallerTarget(caller, {
    live: BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()),
    focused: () => BrowserWindow.getFocusedWindow(),
    keyOf: (w) => w.id,
    locate: (w, surfaceId) =>
      w.webContents.executeJavaScript(`window.__wmux_locateSurface?.(${S(surfaceId)})`),
    cache: callerWindows,
  });
}

const SPECS: Record<string, BridgeSpec> = {
  /**
   * A URL an agent or CLI asked wmux to open (`wmux open`).
   *
   * Deliberately not `callerScoped`: the window is resolved from the caller,
   * but `openInWmuxBrowser` uses that window's active workspace, exactly like a
   * terminal link click. `requireResult` catches an old renderer with no bridge
   * instead of silently answering ok.
   */
  'link.open': {
    js: (p) => linkOpenJs(p?.url),
    requireResult: 'Could not open the link',
  },
  'workspace.create': {
    validate: validateWorkspaceCreateParams,
    prepare: prepareWorkspaceCreateParams,
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
  // The caller's own workspace. `callerScoped` supplies the id from the
  // caller's surface; when that resolution misses (no WMUX_SURFACE_ID, or a
  // stale one from a closed pane) no id is injected, the renderer returns null
  // and `requireResult` turns that into an error + non-zero CLI exit. An
  // explicit miss rather than the focused workspace, so a caller can tell
  // "I don't know" from "it's this one".
  'workspace.current': {
    js: (p) => `window.__wmux_currentWorkspace?.(${S(p?.workspaceId)}, ${S(p?.caller)})`,
    requireResult: 'surface not found',
    callerScoped: true,
  },
  'pane.split': {
    js: (p) => `window.__wmux_splitPane?.(${S(p || {})})`,
    requireResult: 'No active workspace or panes',
    callerScoped: true,
  },
  'pane.close': {
    js: (p) => `window.__wmux_closePane?.(${S(p?.id || p?.paneId)}, ${S(p?.workspaceId)})`,
  },
  'pane.list': {
    js: (p) => `window.__wmux_listPanes?.(${S(p?.workspaceId)})`,
    shape: (r) => ({ panes: r || [] }),
    emptyOnNoWindow: { panes: [] },
    callerScoped: true,
  },
  'layout.grid': {
    js: (p) => `window.__wmux_layoutGrid?.(${S(p || {})})`,
    requireResult: 'No active workspace or invalid anchor',
    callerScoped: true,
  },
  // `validate` runs first, so the renderer can assume `params` is an object.
  'layout.agents': {
    js: (p) => `window.__wmux_layoutAgents?.(${S(p)})`,
    requireResult: 'No active workspace or invalid anchor',
    callerScoped: true,
    validate: validateLayoutAgentsParams,
  },
  'system.tree': {
    js: (p) => `window.__wmux_getTree?.(${S(p?.workspaceId)})`,
    shape: (r) => ({ tree: r || null }),
    emptyOnNoWindow: { tree: null },
    callerScoped: true,
  },
  'surface.create': {
    js: (p) => `window.__wmux_createSurface?.(${S(p || {})})`,
    requireResult: 'No active workspace or panes',
    callerScoped: true,
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
    callerScoped: true,
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
      const invalid = spec.validate?.(params);
      if (invalid) { respondError(-32602, invalid); return; }
      if (spec.prepare) {
        params = spec.prepare(params);
        if (typeof params?.error === 'string') { respondError(-32602, params.error); return; }
      }
      const target = await targetForCaller(params?.caller);
      if (!target) {
        if (spec.emptyOnNoWindow !== undefined) { respond(spec.emptyOnNoWindow); return; }
        respondError(-32000, 'No window');
        return;
      }
      // An explicit --workspace always wins; the caller's workspace is only a
      // default for the methods that would otherwise guess (issue #143).
      const scoped = spec.callerScoped && target.workspaceId && !params?.workspaceId
        ? { ...params, workspaceId: target.workspaceId }
        : params;
      const result = await target.win.webContents.executeJavaScript(spec.js(scoped));
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
