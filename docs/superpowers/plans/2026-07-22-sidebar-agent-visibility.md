# Sidebar Agent & Workflow Visibility — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show per-agent detail (name, tool uses, tokens, done) as compact auto-collapsing sub-lines under each workspace row in the sidebar.

**Architecture:** The main-process observer (`claude-observer.ts`) keeps providing rich per-agent data parsed from Claude Code output; Claude Code hooks (`Stop`, new `SubagentStop`) provide lifecycle truth and force convergence. A pure renderer selector (`agent-view.ts`) merges observer agents with wmux-spawned agents (`agent-slice`) into one capped display list rendered by `WorkspaceRow`.

**Tech Stack:** TypeScript, React 19, Zustand, Vitest. Spec: `docs/superpowers/specs/2026-07-22-sidebar-agent-visibility-design.md`.

**Conventions that apply to every task:** run commands from the repo root; the sonar PostToolUse hook blocks edits with sonarjs findings — fix inline, never suppress. Never launch the Electron app to test (collides with the live instance).

---

### Task 1: Observer — modern markers, agent cap, lifecycle functions

**Files:**
- Modify: `src/main/claude-observer.ts`
- Test: `tests/unit/claude-observer.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/claude-observer.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMock = vi.fn();
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: sendMock } }],
  },
}));

import {
  observePtyData, getActivity, clearActivity,
  markSubagentStop, markAllAgentsDone,
} from '../../src/main/claude-observer';
import { SurfaceId } from '../../src/shared/types';

const surf = 'surf-obs-1' as SurfaceId;

describe('observer agent parsing', () => {
  beforeEach(() => { sendMock.mockClear(); clearActivity(surf); });

  it('parses agent detail lines into the agents array', () => {
    observePtyData(surf, 'Running 3 agents\n├─ review:bugs · 12 tool uses · 45k tokens\n├─ review:perf · 8 tool uses · 30.2k tokens\n');
    const a = getActivity(surf)!;
    expect(a.agents).toHaveLength(2);
    expect(a.agents[0]).toMatchObject({ name: 'review:bugs', toolUses: 12, tokens: '45k' });
  });

  it('recognizes the ⏺ tool marker (current Claude Code UI) as well as ●', () => {
    observePtyData(surf, '⏺ Bash(ls -la)\n');
    expect(getActivity(surf)!.lastTool).toBe('Bash');
    clearActivity(surf);
    observePtyData(surf, '● Grep(pattern)\n');
    expect(getActivity(surf)!.lastTool).toBe('Grep');
  });

  it('caps tracked agents at 32', () => {
    for (let i = 0; i < 40; i++) {
      observePtyData(surf, `├─ agent-${i} · 1 tool use · 1k tokens\n`);
    }
    expect(getActivity(surf)!.agents.length).toBeLessThanOrEqual(32);
  });
});

describe('hook-driven lifecycle', () => {
  beforeEach(() => { sendMock.mockClear(); clearActivity(surf); });

  it('markSubagentStop marks the most recent non-done agent done and broadcasts', () => {
    observePtyData(surf, '├─ alpha · 2 tool uses · 3k tokens\n├─ beta · 1 tool use · 1k tokens\n');
    sendMock.mockClear();
    markSubagentStop(surf);
    const a = getActivity(surf)!;
    expect(a.agents.map(x => x.done)).toEqual([false, true]);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('markSubagentStop on a surface with no agents is a safe no-op', () => {
    markSubagentStop(surf);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('markAllAgentsDone finishes every agent and sets isDone', () => {
    observePtyData(surf, '├─ alpha · 2 tool uses · 3k tokens\n├─ beta · 1 tool use · 1k tokens\n');
    markAllAgentsDone(surf);
    const a = getActivity(surf)!;
    expect(a.agents.every(x => x.done)).toBe(true);
    expect(a.isDone).toBe(true);
  });

  it('markAllAgentsDone on an untracked surface does not create an entry', () => {
    markAllAgentsDone(surf);
    expect(getActivity(surf)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/claude-observer.test.ts`
Expected: FAIL — `markSubagentStop` / `markAllAgentsDone` not exported; `⏺` test fails.

- [ ] **Step 3: Implement in `src/main/claude-observer.ts`**

Change the two marker patterns in `PATTERNS` (keep all other patterns as-is):

```ts
  // "● Bash(...)" (pre-2026 UI) or "⏺ Bash(...)" (current UI)
  toolUse: /[●⏺]\s*(Bash|Read|Write|Edit|Grep|Glob|Agent|WebSearch|WebFetch)\s*\(/,
  mcpTool: /[●⏺]\s*plugin:([^:]+):([^\s]+)/,
```

In `observePtyData`, inside the agent-detail branch, cap the array (add after the `activity.agents.push(...)` line):

```ts
        // Cap so malformed or hostile output can't grow the array unbounded.
        if (activity.agents.length > 32) activity.agents.shift();
```

Add the two lifecycle functions after `clearActivity` (before `applyExternalActivity`):

```ts
/**
 * SubagentStop hook: one subagent finished. The hook payload carries no agent
 * name, so mark the MOST RECENT still-running agent — Claude Code reports
 * agent completions in reverse start order often enough that this converges,
 * and markAllAgentsDone (Stop) is the backstop for any mismatch.
 */
export function markSubagentStop(surfaceId: SurfaceId): void {
  const activity = activities.get(surfaceId);
  if (!activity) return;
  for (let i = activity.agents.length - 1; i >= 0; i--) {
    if (!activity.agents[i].done) {
      activity.agents[i].done = true;
      activity.lastUpdate = Date.now();
      broadcast(surfaceId, activity);
      return;
    }
  }
}

/**
 * Stop hook: the whole turn is over — no agent can still be running. This is
 * the lifecycle truth that guarantees the sidebar never shows ghost agents
 * even if output parsing drifted (same failure class as issue #81).
 */
export function markAllAgentsDone(surfaceId: SurfaceId): void {
  const activity = activities.get(surfaceId);
  if (!activity) return;
  activity.agents.forEach(a => { a.done = true; });
  activity.isDone = true;
  activity.lastTool = null;
  activity.lastUpdate = Date.now();
  broadcast(surfaceId, activity);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/claude-observer.test.ts` — Expected: PASS.
Run: `npm test` — Expected: all pass (no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/main/claude-observer.ts tests/unit/claude-observer.test.ts
git commit -m "feat(observer): modern tool markers, agent cap, hook-driven agent lifecycle"
```

---

### Task 2: Hook plumbing — SubagentStop end-to-end

**Files:**
- Modify: `src/main/claude-context.ts` (applyWmuxHooks, ~line 121-159)
- Modify: `src/main/index.ts` (`case 'hook.event'`, ~line 789)
- Test: `tests/unit/claude-hooks.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to the existing describe block in `tests/unit/claude-hooks.test.ts` (match the file's existing style — it already tests `applyWmuxHooks(settings, hookScript)`):

```ts
  it('adds a SubagentStop hook entry alongside Notification and Stop', () => {
    const result = applyWmuxHooks({}, '/abs/wmux-hook.js');
    const entries = result.hooks.SubagentStop;
    expect(entries).toHaveLength(1);
    expect(entries[0].hooks[0].command).toContain('--event SubagentStop');
  });

  it('replaces a prior wmux SubagentStop entry instead of duplicating it', () => {
    const once = applyWmuxHooks({}, '/abs/wmux-hook.js');
    const twice = applyWmuxHooks(once, '/abs/wmux-hook.js');
    expect(twice.hooks.SubagentStop).toHaveLength(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/claude-hooks.test.ts` — Expected: FAIL (`hooks.SubagentStop` undefined).

- [ ] **Step 3: Implement**

In `src/main/claude-context.ts`, `applyWmuxHooks`, after the `next.hooks.Stop = [...]` block add:

```ts
  // SubagentStop — one parallel subagent finished (drives sidebar agent lines).
  next.hooks.SubagentStop = [
    ...stripWmux(next.hooks.SubagentStop),
    { hooks: [{ type: 'command', command: makeEventCmd('SubagentStop') }] },
  ];
```

In `src/main/index.ts`, extend the import from `./claude-observer` (it already imports from there — add the two new names) and extend `case 'hook.event'`. After the existing `BrowserWindow.getAllWindows().forEach(...)` forward and before the Edit/Write diff block, add:

```ts
        // Lifecycle truth for sidebar agent lines: hooks, not output parsing,
        // decide when agents are finished (spec 2026-07-22, issue #81 class).
        const sid = request.params.surfaceId as SurfaceId | undefined;
        if (sid) {
          if (request.params.event === 'SubagentStop') markSubagentStop(sid);
          else if (request.params.event === 'Stop') markAllAgentsDone(sid);
        }
```

(`wmux-hook.js` needs no change: `--event SubagentStop` flows through its generic `--event` path, and it already attaches `WMUX_SURFACE_ID`.)

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/unit/claude-hooks.test.ts` — Expected: PASS.
Run: `npm run build:main` — Expected: clean tsc.
Run: `npm test` — Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/claude-context.ts src/main/index.ts tests/unit/claude-hooks.test.ts
git commit -m "feat(hooks): SubagentStop hook wired to observer agent lifecycle"
```

---

### Task 3: `agent-view.ts` — unified, capped display list + linger helper

**Files:**
- Create: `src/renderer/store/agent-view.ts`
- Test: `tests/unit/agent-view.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/agent-view.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { agentsForWorkspace, resolveAgentLinger, WorkspaceAgent } from '../../src/renderer/store/agent-view';
import { SplitNode, SurfaceId, PaneId } from '../../src/shared/types';

const leaf = (paneId: string, surfaceIds: string[]): SplitNode => ({
  type: 'leaf',
  paneId: paneId as PaneId,
  surfaces: surfaceIds.map(id => ({ id, type: 'terminal' } as any)),
  activeSurfaceIndex: 0,
} as SplitNode);

const NOW = 1_000_000;
const obs = (agents: any[], lastUpdate = NOW) => ({ agents, activeSkill: null, lastTool: null, lastUpdate, isDone: false });

describe('agentsForWorkspace', () => {
  it('maps observer agents of the workspace surfaces', () => {
    const tree = leaf('pane-1', ['surf-a']);
    const out = agentsForWorkspace(tree, { 'surf-a': obs([{ name: 'review:bugs', toolUses: 12, tokens: '45k', done: false }]) }, new Map(), NOW);
    expect(out).toEqual([{ key: 'surf-a:review:bugs', name: 'review:bugs', detail: '⚒12 · 45k', done: false }]);
  });

  it('merges wmux-spawned agents with their paneId and ✓ when exited', () => {
    const tree = leaf('pane-1', ['surf-a', 'surf-b']);
    const meta = new Map([
      ['surf-b' as SurfaceId, { agentId: 'ag-1', label: 'worker-1', status: 'exited' as const }],
    ]);
    const out = agentsForWorkspace(tree, {}, meta, NOW);
    expect(out).toEqual([{ key: 'wmux:surf-b', name: 'worker-1', detail: '✓', done: true, paneId: 'pane-1' }]);
  });

  it('ignores observer data older than 5 minutes (TTL)', () => {
    const tree = leaf('pane-1', ['surf-a']);
    const out = agentsForWorkspace(tree, { 'surf-a': obs([{ name: 'x', toolUses: 1, tokens: '1k', done: false }], NOW - 301_000) }, new Map(), NOW);
    expect(out).toEqual([]);
  });

  it('ignores surfaces that belong to other workspaces', () => {
    const tree = leaf('pane-1', ['surf-a']);
    const out = agentsForWorkspace(tree, { 'surf-other': obs([{ name: 'x', toolUses: 1, tokens: '1k', done: false }]) }, new Map(), NOW);
    expect(out).toEqual([]);
  });

  it('sorts running agents before done ones', () => {
    const tree = leaf('pane-1', ['surf-a']);
    const out = agentsForWorkspace(tree, { 'surf-a': obs([
      { name: 'a', toolUses: 1, tokens: '1k', done: true },
      { name: 'b', toolUses: 2, tokens: '2k', done: false },
    ]) }, new Map(), NOW);
    expect(out.map(x => x.name)).toEqual(['b', 'a']);
  });

  it('caps at 4 lines: 3 agents + a summary of the rest', () => {
    const agents = Array.from({ length: 8 }, (_, i) => ({ name: `ag-${i}`, toolUses: 2, tokens: '1k', done: false }));
    const tree = leaf('pane-1', ['surf-a']);
    const out = agentsForWorkspace(tree, { 'surf-a': obs(agents) }, new Map(), NOW);
    expect(out).toHaveLength(4);
    expect(out[3]).toMatchObject({ key: '__more', name: '+5 more', detail: '⚒10' });
  });
});

describe('resolveAgentLinger', () => {
  it('visible while any agent runs, resets doneAt', () => {
    expect(resolveAgentLinger(false, 123, NOW)).toEqual({ visible: true, doneAt: null });
  });
  it('stamps doneAt on first all-done observation and stays visible', () => {
    expect(resolveAgentLinger(true, null, NOW)).toEqual({ visible: true, doneAt: NOW });
  });
  it('collapses 10s after all agents finished', () => {
    expect(resolveAgentLinger(true, NOW - 9_000, NOW).visible).toBe(true);
    expect(resolveAgentLinger(true, NOW - 10_001, NOW).visible).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/agent-view.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/renderer/store/agent-view.ts`**

```ts
import { SplitNode, SurfaceId, PaneId } from '../../shared/types';
import { AgentMeta } from './agent-slice';

/** One display line under a workspace row. */
export interface WorkspaceAgent {
  key: string;
  name: string;
  detail: string;
  done: boolean;
  /** Set only for wmux-spawned agents that own a pane — makes the line clickable. */
  paneId?: PaneId;
}

/** Observer agent shape (subset of ClaudeActivity from src/main/claude-observer.ts). */
interface ObserverActivity {
  agents: Array<{ name: string; toolUses: number; tokens: string; done: boolean }>;
  lastUpdate: number;
}

const OBSERVER_TTL_MS = 5 * 60 * 1000; // stale observer data never renders (ghost guard)
const MAX_LINES = 4;
export const AGENT_LINGER_MS = 10_000;

function collectSurfacePanes(tree: SplitNode, out: Array<{ surfaceId: string; paneId: PaneId }>): void {
  if (tree.type === 'leaf') {
    for (const s of tree.surfaces) out.push({ surfaceId: s.id, paneId: tree.paneId });
    return;
  }
  collectSurfacePanes(tree.children[0], out);
  collectSurfacePanes(tree.children[1], out);
}

/**
 * Merge observer-parsed subagents and wmux-spawned agents of one workspace
 * into a single display list, running first, capped at MAX_LINES (3 agents +
 * one "+N more" summary when overflowing).
 */
export function agentsForWorkspace(
  splitTree: SplitNode,
  claudeActivity: Record<string, ObserverActivity | undefined>,
  agentMeta: Map<SurfaceId, AgentMeta>,
  now: number,
): WorkspaceAgent[] {
  const pairs: Array<{ surfaceId: string; paneId: PaneId }> = [];
  collectSurfacePanes(splitTree, pairs);

  const merged: WorkspaceAgent[] = [];
  for (const { surfaceId, paneId } of pairs) {
    const activity = claudeActivity[surfaceId];
    if (activity && now - activity.lastUpdate <= OBSERVER_TTL_MS) {
      for (const a of activity.agents) {
        merged.push({
          key: `${surfaceId}:${a.name}`,
          name: a.name,
          detail: a.done ? '✓' : `⚒${a.toolUses} · ${a.tokens}`,
          done: a.done,
        });
      }
    }
    const meta = agentMeta.get(surfaceId as SurfaceId);
    if (meta) {
      const done = meta.status === 'exited';
      merged.push({ key: `wmux:${surfaceId}`, name: meta.label, detail: done ? '✓' : '', done, paneId });
    }
  }

  // Stable partition: running agents first, done ones after.
  const ordered = [...merged.filter(a => !a.done), ...merged.filter(a => a.done)];
  if (ordered.length <= MAX_LINES) return ordered;

  const shown = ordered.slice(0, MAX_LINES - 1);
  const hidden = ordered.slice(MAX_LINES - 1);
  const hiddenTools = hidden.reduce((sum, a) => {
    const m = /⚒(\d+)/.exec(a.detail);
    return sum + (m ? parseInt(m[1], 10) : 0);
  }, 0);
  shown.push({ key: '__more', name: `+${hidden.length} more`, detail: hiddenTools > 0 ? `⚒${hiddenTools}` : '', done: hidden.every(a => a.done) });
  return shown;
}

/**
 * Linger state machine: agent lines stay visible while anything runs, then
 * linger AGENT_LINGER_MS after everything finished so the ✓s are seen, then
 * collapse. Pure — the caller stores doneAt and supplies the clock.
 */
export function resolveAgentLinger(
  allDone: boolean,
  prevDoneAt: number | null,
  now: number,
): { visible: boolean; doneAt: number | null } {
  if (!allDone) return { visible: true, doneAt: null };
  const doneAt = prevDoneAt ?? now;
  return { visible: now - doneAt <= AGENT_LINGER_MS, doneAt };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/agent-view.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/store/agent-view.ts tests/unit/agent-view.test.ts
git commit -m "feat(sidebar): unified capped agent display list + linger helper"
```

---

### Task 4: WorkspaceRow UI + CSS + click-to-focus

**Files:**
- Modify: `src/renderer/components/Sidebar/WorkspaceRow.tsx`
- Modify: `src/renderer/components/Sidebar/Sidebar.tsx` (prop pass-through, ~line 29 and ~line 291)
- Modify: `src/renderer/App.tsx` (callback, Sidebar usage ~line 893)
- Modify: `src/renderer/styles/sidebar.css`

No new unit test (pure logic was tested in Task 3; the row is presentational). Manual verification in Task 5.

- [ ] **Step 1: Render agent lines in `WorkspaceRow.tsx`**

Add imports at the top:

```ts
import { agentsForWorkspace, resolveAgentLinger, WorkspaceAgent } from '../../store/agent-view';
import { PaneId } from '../../../shared/types';
```

Add to `WorkspaceRowProps`:

```ts
  onFocusAgentPane?: (paneId: PaneId) => void;
```

(and destructure `onFocusAgentPane` in the component parameters).

Inside the component, after the `wsActivity` memo (~line 119), add:

```ts
  // ── Unified agent list (observer subagents + wmux-spawned agents) ──
  const agentMeta = useStore((state) => state.agentMeta);
  const doneAtRef = useRef<number | null>(null);
  const wsAgents = useMemo<WorkspaceAgent[]>(() => {
    const now = Date.now();
    const list = agentsForWorkspace(workspace.splitTree, claudeActivity ?? {}, agentMeta, now);
    if (list.length === 0) { doneAtRef.current = null; return []; }
    const linger = resolveAgentLinger(list.every(a => a.done), doneAtRef.current, now);
    doneAtRef.current = linger.doneAt;
    return linger.visible ? list : [];
  }, [workspace.splitTree, claudeActivity, agentMeta, tick]);
  const runningAgentCount = wsAgents.filter(a => !a.done && a.key !== '__more').length;
```

In the `statusText` memo, insert between Priority 0 (statusOverride) and Priority 1 (currentToolLabel):

```ts
    // Priority 0.5: agents are running — show the orchestration summary
    if (runningAgentCount > 0) {
      return `Orchestrating · ${wsAgents.filter(a => a.key !== '__more').length} agents`;
    }
```

and add `runningAgentCount, wsAgents` to that memo's dependency array. In the `statusClass` memo, insert after the statusOverride branch: `if (runningAgentCount > 0) return 'workspace-row__status--working';` (add the same two deps).

In the JSX, directly after the status `<div>` (line `{statusText}</div>`), add:

```tsx
      {/* Agent sub-lines — only while agents run (+10s linger with ✓) */}
      {wsAgents.length > 0 && (
        <div className="workspace-row__agents">
          {wsAgents.map((agent, i) => (
            <div
              key={agent.key}
              className={[
                'workspace-row__agent',
                agent.done ? 'workspace-row__agent--done' : '',
                agent.paneId ? 'workspace-row__agent--clickable' : '',
              ].filter(Boolean).join(' ')}
              onClick={agent.paneId ? (e) => {
                e.stopPropagation();
                onSelect();
                onFocusAgentPane?.(agent.paneId!);
              } : undefined}
            >
              <span className="workspace-row__agent-glyph">{i === wsAgents.length - 1 ? '└' : '├'}</span>
              {!agent.done && <span className="workspace-row__agent-dot" />}
              <span className="workspace-row__agent-name">{agent.name}</span>
              <span className="workspace-row__agent-detail">{agent.detail}</span>
            </div>
          ))}
        </div>
      )}
```

- [ ] **Step 2: Thread the callback through `Sidebar.tsx` and `App.tsx`**

`Sidebar.tsx`: add `onFocusAgentPane?: (wsId: WorkspaceId, paneId: PaneId) => void;` to `SidebarProps` (~line 29), destructure it (~line 47), and pass to the row (~line 291): `onFocusAgentPane={(paneId) => onFocusAgentPane?.(ws.id, paneId)}`. Import `PaneId` from `'../../../shared/types'` if not present.

`App.tsx`: on the `<Sidebar ...>` element (~line 893), add:

```tsx
            onFocusAgentPane={(wsId, paneId) => {
              selectWorkspace(wsId);
              setFocusedPaneId(paneId);
            }}
```

- [ ] **Step 3: CSS in `src/renderer/styles/sidebar.css`**

Append after the `.workspace-row__status` rules (~line 210):

```css
/* ── Agent sub-lines (spec 2026-07-22) ── */
.workspace-row__agents {
  overflow: hidden;
  margin: 1px 0 2px 6px;
  animation: agent-lines-in 160ms ease-out;
}
@keyframes agent-lines-in {
  from { max-height: 0; opacity: 0; }
  to { max-height: 72px; opacity: 1; }
}
.workspace-row__agent {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  line-height: 16px;
  color: var(--text-secondary, #9aa0a6);
  white-space: nowrap;
}
.workspace-row__agent--clickable { cursor: pointer; }
.workspace-row__agent--clickable:hover .workspace-row__agent-name { text-decoration: underline; }
.workspace-row__agent-glyph { opacity: 0.5; }
.workspace-row__agent-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #e8a33d;
  animation: state-dot-pulse 1.2s ease-in-out infinite;
  flex-shrink: 0;
}
.workspace-row__agent-name {
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 1;
}
.workspace-row__agent-detail {
  margin-left: auto;
  flex-shrink: 0;
  opacity: 0.8;
  font-variant-numeric: tabular-nums;
}
.workspace-row__agent--done { opacity: 0.55; }
.workspace-row__agent--done .workspace-row__agent-detail { color: #4caf50; opacity: 1; }
```

Note: `state-dot-pulse` — check the existing pulsing keyframe name used by `.workspace-row__state-dot--running` in this file and reuse it; if it differs (e.g. `dot-pulse`), use that name instead of `state-dot-pulse`.

- [ ] **Step 4: Build + full tests**

Run: `npm run build:main && npx vite build` — Expected: clean.
Run: `npm test` — Expected: all pass.
Run: `npx eslint src/renderer/components/Sidebar/WorkspaceRow.tsx src/renderer/components/Sidebar/Sidebar.tsx src/renderer/store/agent-view.ts` — Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/Sidebar/WorkspaceRow.tsx src/renderer/components/Sidebar/Sidebar.tsx src/renderer/App.tsx src/renderer/styles/sidebar.css
git commit -m "feat(sidebar): per-agent sub-lines with auto-collapse under workspace rows"
```

---

### Task 5: Verification & wrap-up

- [ ] **Step 1: Full suite + builds**

Run: `npm test && npm run build:main && npx vite build` — Expected: everything green.

- [ ] **Step 2: Live check (no app launch — use the running instance)**

The owner tests live. Simulate observer input is not possible from outside; instead verify the data path: fire `echo '{}' | node "C:/Users/aeont/AppData/Local/Programs/wmux/resources/cli/wmux-hook.js" --event SubagentStop` and confirm no error. Real visual verification happens after the owner installs the next release (or hot-swaps the asar per CLAUDE.md step 11).

- [ ] **Step 3: Ask the owner** whether to release now (bump + tag → CI) or batch with other changes.
