/**
 * `detect.*` pipe methods, routed off the main V2 switch.
 *
 * Split out for the same reason agent-state-rpc.ts is: that switch is at its
 * complexity ceiling, and a family of methods that share a module belongs
 * beside it rather than inside a case label.
 */
import { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../shared/types';
import { explainFile, explainSurface, reloadManifests } from './detection-store';

type Respond = (result: unknown) => void;
type RespondError = (code: number, message: string) => void;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Handle a `detect.*` method. Returns false for anything this module does not
 * own, so the caller keeps routing.
 */
export function handleDetectionV2(
  method: string,
  params: any,
  respond: Respond,
  respondError: RespondError,
): boolean {
  /**
   * Why does this pane read the way it does?
   *
   * Two modes, and the offline one is the reason this exists: `--file` replays
   * a captured screen through the same engine with no running detection and no
   * agent installed. That is how a rule regression gets debugged from a
   * `wmux read-screen` capture committed to a fixture — and it is how the
   * bundled Codex and OpenCode manifests were written, on a machine where
   * neither agent could reach a working turn.
   */
  if (method === 'detect.explain') {
    const file = str(params?.file);
    if (file) {
      respond(explainFile(file, str(params?.agent) || undefined));
      return true;
    }

    const surfaceId = str(params?.surfaceId);
    if (!surfaceId) {
      respondError(-32602, 'detect.explain needs --surface <id> or --file <path>');
      return true;
    }
    respond(explainSurface(surfaceId));
    return true;
  }

  /** Re-read %APPDATA%\wmux\agent-detection after editing an override. */
  if (method === 'detect.reload') {
    const { manifests, warnings } = reloadManifests();
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.AGENT_DETECTION_MANIFESTS, { manifests, warnings });
      }
    });
    respond({ ok: true, agents: manifests.map((m) => m.agent), warnings });
    return true;
  }

  return false;
}
