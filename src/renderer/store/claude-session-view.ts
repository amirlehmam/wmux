import { SplitNode, SurfaceId, PaneId } from '../../shared/types';

/** One sidebar hook-activity entry — written by App.tsx from Claude Code hook events. */
export interface HookActivityEntry {
  lastTool: string;
  toolCount: number;
  lastSeen: number;
}

/** Observer shape (subset of ClaudeActivity from src/main/claude-observer.ts). */
interface ObserverActivity {
  agents: Array<{ name: string; toolUses: number; tokens: string; done: boolean }>;
  activeSkill: string | null;
  lastTool: string | null;
  lastUpdate: number;
  isDone: boolean;
}

/** How long a hook/observer signal counts as "actively working" (ms). */
export const SESSION_ACTIVITY_TTL_MS = 5000;

/** One Claude Code session (= one surface where Claude ran) inside a workspace. */
export interface ClaudeSessionView {
  surfaceId: SurfaceId;
  paneId: PaneId;
  /** Folder name of the pane's cwd — distinguishes sessions at a glance. */
  label: string;
  working: boolean;
  /** Raw tool name while working, null when idle or unknown. */
  tool: string | null;
  skill: string | null;
}

export interface WorkspaceSessionsView {
  /** Tree order — stable across renders. */
  sessions: ClaudeSessionView[];
  /** Number of sessions currently working. */
  working: number;
}

interface SurfaceEntry {
  surfaceId: SurfaceId;
  paneId: PaneId;
  currentCwd?: string;
}

function collectTerminalSurfaces(tree: SplitNode, out: SurfaceEntry[]): void {
  if (tree.type === 'leaf') {
    for (const s of tree.surfaces) {
      out.push({ surfaceId: s.id, paneId: tree.paneId, currentCwd: (s as { currentCwd?: string }).currentCwd });
    }
    return;
  }
  collectTerminalSurfaces(tree.children[0], out);
  collectTerminalSurfaces(tree.children[1], out);
}

function cwdBasename(cwd: string | undefined): string | null {
  if (!cwd) return null;
  let normalized = cwd.replace(/\\/g, '/');
  let end = normalized.length;
  while (end > 0 && normalized[end - 1] === '/') end--;
  normalized = normalized.slice(0, end);
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return base || null;
}

/**
 * Per-surface Claude session states of one workspace. A surface is a session
 * as soon as EITHER a hook event or observer activity was ever recorded for it
 * — entries never expire (a stale entry just reads as idle), mirroring the
 * intentional keep-forever semantics of hookActivity in App.tsx: "was active
 * but stopped" (idle) must stay distinguishable from "plain shell command"
 * (no session), or the row falls back to the shell's perpetual "Running".
 */
export function claudeSessionsForWorkspace(
  splitTree: SplitNode,
  claudeActivity: Record<string, ObserverActivity | undefined>,
  hookActivity: Record<string, HookActivityEntry | undefined>,
  now: number,
): WorkspaceSessionsView {
  const surfaces: SurfaceEntry[] = [];
  collectTerminalSurfaces(splitTree, surfaces);

  const sessions: ClaudeSessionView[] = [];
  let working = 0;

  for (const { surfaceId, paneId, currentCwd } of surfaces) {
    const hook = hookActivity[surfaceId];
    const observed = claudeActivity[surfaceId];
    if (!hook && !observed) continue;

    const hookFresh = !!hook && now - hook.lastSeen < SESSION_ACTIVITY_TTL_MS;
    const obsFresh = !!observed && !observed.isDone && !!observed.lastTool
      && now - observed.lastUpdate < SESSION_ACTIVITY_TTL_MS;
    const isWorking = hookFresh || obsFresh;

    let tool: string | null = null;
    if (obsFresh) tool = observed.lastTool;
    else if (hookFresh && hook.lastTool) tool = hook.lastTool;

    sessions.push({
      surfaceId,
      paneId,
      label: cwdBasename(currentCwd) ?? 'Claude',
      working: isWorking,
      tool,
      skill: observed?.activeSkill ?? null,
    });
    if (isWorking) working++;
  }

  return { sessions, working };
}
