/**
 * v2-browser.ts — Per-caller browser routing for V2 pipe handlers (issue #62).
 *
 * Each distinct caller (an agent's terminal surface, identified by its
 * WMUX_SURFACE_ID and sent as `params.caller`) is bound to its OWN browser
 * surface, created in that caller's workspace. The CDPBridge tracks every
 * attached browser independently, so concurrent agents no longer share — and
 * clobber — a single browser window. With no caller (manual human use) we fall
 * back to the legacy shared browser.
 */
import { BrowserWindow } from 'electron';
import { cdpBridge } from './ipc-handlers';

type Respond = (result: any) => void;
type RespondError = (code: number, message: string) => void;

function firstWindow(): BrowserWindow | null {
  const win = BrowserWindow.getAllWindows()[0];
  return win && !win.isDestroyed() ? win : null;
}

/**
 * Auto-create a shared browser panel if none exists, then wait for CDP to
 * attach. Legacy single-browser path used when a command has no caller context.
 */
async function ensureBrowserPanel(): Promise<boolean> {
  if (cdpBridge.isAttached) return true;
  const win = firstWindow();
  if (!win) return false;
  await win.webContents.executeJavaScript(
    `window.__wmux_splitPane?.({ direction: 'horizontal', type: 'browser' })`,
  );
  const deadline = Date.now() + 5000;
  while (!cdpBridge.isAttached && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return cdpBridge.isAttached;
}

// caller terminal surface → its own browser surface. boundBrowserSurfaces tracks
// which browser surfaces are already owned so a second agent never adopts the
// first agent's browser.
const callerBrowserSurface = new Map<string, string>();
const boundBrowserSurfaces = new Set<string>();

async function pollSurfaceWcId(surfaceId: string, timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const wcId = cdpBridge.wcIdForSurface(surfaceId);
    if (wcId !== null) return wcId;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cdpBridge.wcIdForSurface(surfaceId);
}

async function legacyWcId(): Promise<number | null> {
  return (await ensureBrowserPanel()) ? cdpBridge.attachedWebContentsId : null;
}

/**
 * Resolve which browser webContents a command should run against, creating /
 * binding a per-caller browser surface as needed. Returns the wcId, or null if
 * no browser could be readied.
 */
async function resolveBrowserWcId(caller?: string): Promise<number | null> {
  const win = firstWindow();
  if (!win) return null;
  if (!caller) return legacyWcId();

  // Reuse this caller's already-bound browser if it's still live.
  const bound = callerBrowserSurface.get(caller);
  if (bound) {
    const wcId = cdpBridge.wcIdForSurface(bound);
    if (wcId !== null) return wcId;
    callerBrowserSurface.delete(caller);
    boundBrowserSurfaces.delete(bound);
  }

  const workspaceId: string | null = await win.webContents.executeJavaScript(
    `window.__wmux_getWorkspaceIdForSurface?.(${JSON.stringify(caller)}) ?? null`,
  );
  if (!workspaceId) return legacyWcId();

  // Adopt an existing unowned browser surface in the workspace (e.g. one the user
  // opened manually); otherwise spawn a fresh browser pane in that workspace.
  const existing: string[] = await win.webContents.executeJavaScript(
    `window.__wmux_listBrowserSurfaces?.(${JSON.stringify(workspaceId)}) ?? []`,
  );
  let browserSurfaceId = existing.find((id) => !boundBrowserSurfaces.has(id)) ?? null;
  if (!browserSurfaceId) {
    const created = await win.webContents.executeJavaScript(
      `window.__wmux_splitPane?.({ direction: 'horizontal', type: 'browser', workspaceId: ${JSON.stringify(workspaceId)} }) ?? null`,
    );
    browserSurfaceId = created?.surfaceId ?? null;
  }
  if (!browserSurfaceId) return legacyWcId();

  callerBrowserSurface.set(caller, browserSurfaceId);
  boundBrowserSurfaces.add(browserSurfaceId);
  return pollSurfaceWcId(browserSurfaceId, 5000);
}

// Run a single browser verb against an already-resolved target. Shared by the
// single-command and batch paths so there's one source of truth (and no deeply
// nested handler maps).
async function runBrowserCommand(method: string, params: any, wcId: number): Promise<any> {
  switch (method) {
    case 'browser.navigate':
      await cdpBridge.navigate(params?.url, params?.timeout, wcId);
      return { ok: true };
    case 'browser.snapshot':
      return cdpBridge.snapshot(wcId);
    case 'browser.click':
      await cdpBridge.click(params?.ref, wcId);
      return { ok: true };
    case 'browser.type':
      await cdpBridge.type(params?.ref, params?.text, wcId);
      return { ok: true };
    case 'browser.fill':
      await cdpBridge.fill(params?.ref, params?.value, wcId);
      return { ok: true };
    case 'browser.screenshot':
      return { data: await cdpBridge.screenshot(params?.fullPage, wcId) };
    case 'browser.get_text':
      return { text: await cdpBridge.getText(params?.ref, wcId) };
    case 'browser.eval':
      return { result: await cdpBridge.evaluate(params?.js, wcId) };
    case 'browser.wait':
      await cdpBridge.wait(params?.ref, params?.timeout, wcId);
      return { ok: true };
    default:
      throw Object.assign(new Error(`Unknown: ${method}`), { rpcCode: -32601 });
  }
}

async function handleBrowserBatch(params: any, respond: Respond, respondError: RespondError): Promise<void> {
  const wcId = await resolveBrowserWcId(params?.caller);
  if (wcId === null) { respondError(-32000, 'Could not open browser panel'); return; }
  const results: any[] = [];
  for (const cmd of params?.commands || []) {
    try {
      results.push({ result: await runBrowserCommand(cmd.method, cmd.params, wcId) });
    } catch (err: any) {
      results.push({ error: { code: err.rpcCode ?? -32000, message: err.message } });
      break;
    }
  }
  respond({ results });
}

/** Entry point: handle any `browser.*` V2 method. */
export function handleBrowserV2(
  method: string,
  params: any,
  respond: Respond,
  respondError: RespondError,
): void {
  (async () => {
    if (method === 'browser.batch') {
      await handleBrowserBatch(params, respond, respondError);
      return;
    }
    const wcId = await resolveBrowserWcId(params?.caller);
    if (wcId === null) { respondError(-32000, 'Could not open browser panel'); return; }
    respond(await runBrowserCommand(method, params, wcId));
  })().catch((err: any) => respondError(-32000, err.message));
}
