/**
 * `workspace.set_indicator`: put, or with empty text clear, the pill beside a
 * workspace's name (`wmux set-indicator` / `clear-indicator`).
 *
 * Not a `v2-bridge.ts` entry: the bridge answers from ONE window (the caller's,
 * or the focused one), and an explicit `--workspace` may live in another
 * (#143). So every window is asked in turn, as `writeBrowserEngine` does, and
 * the first that holds the workspace answers.
 *
 * A miss is an error, never `{ ok: true }`. The commands exist for tools
 * outside wmux's own panes (a devcontainer, a launcher script), and such a
 * caller has no other way to learn that its call changed nothing.
 */

export interface IndicatorParams {
  workspaceId?: string;
  /** The calling shell's surface, added by the CLI from `WMUX_SURFACE_ID`. */
  caller?: string;
  /** Empty clears the indicator. */
  text: string;
  color?: string;
}

/** The -32602 message for bad params, or null. Runs before any window is asked. */
export function validateIndicatorParams(params: unknown): string | null {
  if (!params || typeof params !== 'object') return 'params must be an object';
  const p = params as Record<string, unknown>;
  if (typeof p.text !== 'string') return 'text must be a string (empty text clears the indicator)';
  for (const key of ['workspaceId', 'caller', 'color'] as const) {
    if (p[key] !== undefined && typeof p[key] !== 'string') return `${key} must be a string`;
  }
  if (!p.workspaceId && !p.caller) {
    return 'No workspace given: pass --workspace <id>, or run it inside a wmux pane';
  }
  return null;
}

/** The renderer expression. Every value is JSON-encoded: it reaches `executeJavaScript` as source. */
export function setIndicatorJs(p: IndicatorParams): string {
  const S = JSON.stringify;
  return `window.__wmux_setWorkspaceIndicator?.(${S(p.workspaceId ?? '')}, ${S(p.caller ?? '')}, `
    + `${S(p.text)}, ${S(p.color ?? '')}) ?? null`;
}

interface IndicatorWindow {
  isDestroyed(): boolean;
  webContents: { executeJavaScript(code: string): Promise<unknown> };
}

export async function handleSetIndicator(
  params: unknown,
  windows: readonly IndicatorWindow[],
  respond: (result: unknown) => void,
  respondError: (code: number, message: string) => void,
): Promise<void> {
  const invalid = validateIndicatorParams(params);
  if (invalid) {
    respondError(-32602, invalid);
    return;
  }
  const p = params as IndicatorParams;
  for (const win of windows) {
    if (win.isDestroyed()) continue;
    let result: unknown;
    try {
      result = await win.webContents.executeJavaScript(setIndicatorJs(p));
    } catch {
      continue; // reloading or torn down: this window doesn't have it
    }
    if (result) {
      respond(result);
      return;
    }
  }
  respondError(-32000, p.workspaceId
    ? `Workspace not found: ${p.workspaceId}`
    : 'The calling pane is not in any workspace (stale WMUX_SURFACE_ID?)');
}
