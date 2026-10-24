import type { SplitNode, WorkspaceInfo } from '../../../shared/types';
import type { AgentIdentitySnapshot, DeclaredAgentSnapshot } from '../../store/agent-rollup';
import { stripStatusGlyph } from '../../store/osc-title-slice';

/**
 * The window title a workspace's terminals announce, for its sidebar name. Every
 * pane's SHOWN tab is considered, in split-tree order, and only if it is a
 * terminal with a title. Among those, the first whose surface has an agent wins;
 * with none, the first overall does.
 *
 * Agent first because the name exists for agent sessions (#343): in a
 * `[bash | claude]` workspace the shell's own `MINGW64:/c/repo` would otherwise
 * beat the conversation title Claude sets in the pane beside it.
 *
 * "Has an agent" is `hasAgentLookup`: an identity wmux holds for the surface,
 * or an agent session its hooks reported there — never the agent's declared or
 * detected STATE, which changes every turn. Both last from the agent's start
 * until it exits or ends its session, so the name does not flip back to the
 * shell while the agent is idle or between turns. After that, the pane is an
 * ordinary shell again and the rule falls back.
 *
 * Tree order rather than the focused pane: focus is App-local state that only
 * exists for the active workspace, and a name that changed every time the user
 * clicked between panes would be harder to find in the sidebar, not easier.
 * Hidden tabs are skipped for the same reason the tab bar shows only one per pane.
 */
function pickTerminalTitle(
  node: SplitNode,
  oscTitleFor: (surfaceId: string) => string | undefined,
  hasAgent: (surfaceId: string) => boolean,
): { title: string; agent: boolean } | undefined {
  if (node.type === 'branch') {
    const first = pickTerminalTitle(node.children[0], oscTitleFor, hasAgent);
    if (first?.agent) return first;
    const second = pickTerminalTitle(node.children[1], oscTitleFor, hasAgent);
    return second?.agent ? second : first ?? second;
  }
  const surface = node.surfaces[node.activeSurfaceIndex];
  // Only a terminal has a program that can set a title; see getSurfaceLabel.
  if (surface?.type !== 'terminal') return undefined;
  // Without the agent's status glyph, so a spinner frame keeps the name, and a
  // title that is only a glyph counts as none.
  const title = stripStatusGlyph(oscTitleFor(surface.id) ?? '');
  return title ? { title, agent: hasAgent(surface.id) } : undefined;
}

/**
 * What the sidebar calls a workspace. A name somebody chose always wins; a name
 * wmux picked gives way to the window title the workspace's program sets, the
 * same rank the tab label gives it (#221).
 *
 * @param oscTitleFor Returns undefined when the feature is off or the surface
 *   has no title, which is what makes this fall through to the stored name.
 * @param hasAgent Whether a surface has an agent (`hasAgentLookup`); omitted,
 *   no pane is preferred and the first titled one in tree order wins.
 */
export function getWorkspaceLabel(
  workspace: Pick<WorkspaceInfo, 'title' | 'titleIsDefault' | 'splitTree'>,
  oscTitleFor: (surfaceId: string) => string | undefined,
  hasAgent: (surfaceId: string) => boolean = () => false,
): string {
  if (!workspace.titleIsDefault) return workspace.title;
  return pickTerminalTitle(workspace.splitTree, oscTitleFor, hasAgent)?.title ?? workspace.title;
}

/** The two store maps `hasAgentLookup` reads, narrowed to the fields it needs. */
export interface AgentPresence {
  agentIdentities: Readonly<Record<string, Pick<AgentIdentitySnapshot, 'kind'>>>;
  agentStates: Readonly<Record<string, Pick<DeclaredAgentSnapshot, 'sessionId'>>>;
}

/**
 * The `hasAgent` getWorkspaceLabel takes: the one definition of "this pane has
 * an agent" for the workspace name. Either signal is enough.
 *
 * - `agentIdentities` — main's identity for the surface: the pane's own shell
 *   spec, a `report_command` (which both shell integrations send for `ssh`
 *   only), or a process probe (which sweeps only while ssh detection is
 *   awake). So a `claude` typed into an ordinary pane usually has none.
 * - `agentStates[id].sessionId` — the session its hooks reported. Every Claude
 *   Code (and Qwen) hook but SessionEnd carries `session_id`, and main records
 *   it from SessionStart on; `report-session` sets it for the other agents.
 *   Main clears it only by forgetting the pane — SessionEnd, the PTY exiting,
 *   `release-agent` — and every report in between carries it unchanged, so it
 *   holds through working, idle and blocked alike. The `state` beside it is no
 *   substitute: it changes every turn, and reads `unknown` both for a forgotten
 *   pane and for a live one whose working claim outlived its trust window.
 */
export function hasAgentLookup({ agentIdentities, agentStates }: AgentPresence): (surfaceId: string) => boolean {
  return (surfaceId) => Boolean(agentIdentities[surfaceId]?.kind || agentStates[surfaceId]?.sessionId);
}
