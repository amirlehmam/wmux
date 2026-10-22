/**
 * The roster the remote console is allowed to see (#254).
 *
 * `window.__wmux_remoteRoster()` hands main the sidebar's own agent rollup, so
 * the phone inherits every rule already settled there (#235, #253) instead of
 * re-deriving agent state a second way. But the roster entry carries more than
 * a phone should: `metadata` (model, token counts), `detectedState`, `paneId`,
 * `identitySource`, and each declared choice's `key`/`text` — the exact bytes
 * `answer_agent` would type into the PTY. Those payloads stay in main
 * (`deliverAnswer` looks them up by id); the wire only ever needs an id to send
 * back and a label to show.
 *
 * So this is an explicit field-by-field COPY, never a spread or a delete: a
 * field added to AgentRosterEntry later does not reach the network until
 * someone adds it here on purpose. Main validates the result again anyway —
 * it arrives through `executeJavaScript` and is trusted no further than that.
 */
import type { RemoteRosterSource } from '../../shared/remote-console-config';
import type { AgentRosterEntry } from '../store/agent-rollup';

/** A declared choice may carry `isDefault`; AgentChoiceView does not type it. */
type ChoiceLike = { id: string; label: string; isDefault?: unknown };

export function toRemoteRosterSource(entry: AgentRosterEntry): RemoteRosterSource {
  // The phone protocol's state set is closed (RemoteRosterSource.state) and a
  // question is not on it. A question only ever refines a DECLARED idle, so it
  // goes back to being that idle, and the phone sees the pane exactly as it did
  // before question detection existed. Not `unknown`: main's roster marks a
  // turn done on working -> idle, and a turn that ended on a question lost its
  // "done" toast. Never `blocked`, which would arm the phone's answer path for
  // something that has no declared choices.
  const asked = entry.state === 'question';
  return {
    surfaceId: entry.surfaceId,
    workspaceId: entry.workspaceId,
    workspaceTitle: entry.workspaceTitle,
    label: entry.label,
    kind: entry.kind,
    state: entry.state === 'question' ? 'idle' : entry.state,
    stateSource: asked ? 'declared' : entry.stateSource,
    blockedReason: entry.blockedReason,
    choices: (entry.choices as ChoiceLike[]).map((c) =>
      c.isDefault === true ? { id: c.id, label: c.label, isDefault: true } : { id: c.id, label: c.label },
    ),
    answerPending: entry.answerPending,
    dwellMs: entry.dwellMs,
  };
}
