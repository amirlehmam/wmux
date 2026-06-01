# OpenCode Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring wmux to full feature parity with OpenCode (live activity sidebar, auto-injected wmux instructions, tool/hook tracking, and orchestration of OpenCode worker agents) using OpenCode's official plugin API.

**Architecture:** A bundled `wmux.js` OpenCode plugin (auto-installed to `~/.config/opencode/plugin/`) translates OpenCode hooks/events into `wmux` CLI calls over the existing named pipe. A new agent-agnostic `agent.activity` pipe method feeds the SAME sidebar store/IPC that Claude uses, so the UI is unchanged. Instruction injection mirrors the existing Claude `CLAUDE.md` logic against `~/.config/opencode/AGENTS.md`. The orchestrator's worker launcher gains a `WMUX_AGENT_CMD` switch to spawn `opencode run` workers.

**Tech Stack:** TypeScript (Electron main + CLI), Vitest, plain-JS OpenCode plugin (no build/deps), Bash orchestrator scripts, Node `child_process`.

**Spec:** `docs/superpowers/specs/2026-06-01-opencode-compatibility-design.md`

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/main/claude-observer.ts` | Add `applyExternalActivity()` to merge externally-pushed activity into the shared map + broadcast | Modify |
| `src/main/index.ts` | Add `agent.activity` V2 pipe handler; call new ensure* fns at startup | Modify |
| `src/main/opencode-context.ts` | `ensureOpencodeContext()` (AGENTS.md inject) + `ensureOpencodePlugin()` (plugin install) | Create |
| `src/cli/wmux.ts` | Add `agent-activity` CLI verb | Modify |
| `resources/opencode-plugin/wmux.js` | The OpenCode plugin (hooks/events → wmux CLI) | Create |
| `resources/wmux-orchestrator/scripts/launch-agent.js` | Branch on `WMUX_AGENT_CMD` to launch `claude` or `opencode run` | Modify |
| `tests/unit/opencode-context.test.ts` | Unit tests for AGENTS.md marker logic + plugin install idempotency | Create |
| `tests/unit/agent-activity.test.ts` | Unit test for `applyExternalActivity` merge/broadcast | Create |

---

## Task 1: `applyExternalActivity()` in claude-observer

Lets an external producer (the OpenCode plugin via the pipe) push activity into the same per-surface map that drives the sidebar, then broadcast on the existing IPC channel. Reuses the existing `getOrCreate` and `broadcast` helpers (file-private today).

**Files:**
- Modify: `src/main/claude-observer.ts`
- Test: `tests/unit/agent-activity.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/agent-activity.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron BrowserWindow before importing the module under test
const sendMock = vi.fn();
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: sendMock } }],
  },
}));

import { applyExternalActivity, getActivity, clearActivity } from '../../src/main/claude-observer';
import { SurfaceId } from '../../src/shared/types';

describe('applyExternalActivity', () => {
  const surf = 'surf-test-1' as SurfaceId;
  beforeEach(() => { sendMock.mockClear(); clearActivity(surf); });

  it('merges partial activity and broadcasts on CLAUDE_ACTIVITY', () => {
    applyExternalActivity(surf, { lastTool: 'bash', isDone: false });
    const a = getActivity(surf);
    expect(a?.lastTool).toBe('bash');
    expect(a?.isDone).toBe(false);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('preserves prior fields when later partial omits them', () => {
    applyExternalActivity(surf, { lastTool: 'read', isDone: false });
    applyExternalActivity(surf, { isDone: true });
    const a = getActivity(surf);
    expect(a?.lastTool).toBe('read');
    expect(a?.isDone).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/agent-activity.test.ts`
Expected: FAIL — `applyExternalActivity is not exported` / not a function.

- [ ] **Step 3: Implement `applyExternalActivity`**

In `src/main/claude-observer.ts`, after the existing `clearActivity` function (around line 180), add:

```typescript
/**
 * Merge externally-sourced activity (e.g. pushed by the OpenCode plugin over
 * the pipe) into the shared per-surface map and broadcast it on the same
 * channel the sidebar already listens to. Agent-agnostic — Claude's own
 * observer and external producers converge here.
 */
export function applyExternalActivity(
  surfaceId: SurfaceId,
  partial: Partial<ClaudeActivity>,
): void {
  const activity = getOrCreate(surfaceId);
  if (partial.lastTool !== undefined) activity.lastTool = partial.lastTool;
  if (partial.activeSkill !== undefined) activity.activeSkill = partial.activeSkill;
  if (partial.isDone !== undefined) activity.isDone = partial.isDone;
  if (partial.agents !== undefined) activity.agents = partial.agents;
  activity.lastUpdate = Date.now();
  broadcast(surfaceId, activity);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/agent-activity.test.ts`
Expected: PASS (2 passing).

- [ ] **Step 5: Commit**

```bash
git add src/main/claude-observer.ts tests/unit/agent-activity.test.ts
git commit -m "feat(observer): add applyExternalActivity for agent-agnostic sidebar updates"
```

---

## Task 2: `agent.activity` pipe handler

Exposes the new activity producer over the V2 named pipe so the CLI (and thus the OpenCode plugin) can push activity.

**Files:**
- Modify: `src/main/index.ts` (import + new case near the `hook.event` case ~L927)

- [ ] **Step 1: Add the import**

At the top of `src/main/index.ts`, find the existing claude-observer usage. There is none imported in index.ts yet, so add:

```typescript
import { applyExternalActivity } from './claude-observer';
```

(Place it next to the other `./` main-process imports, e.g. just after the `./claude-context` import on line 15.)

- [ ] **Step 2: Add the `agent.activity` case**

In the V2 method `switch`, immediately before `case 'diff.refresh':` (currently ~L948), insert:

```typescript
      case 'agent.activity': {
        const p = request.params || {};
        const surfaceId = p.surfaceId as SurfaceId;
        if (!surfaceId) { respondError(-32602, 'surfaceId required'); break; }
        applyExternalActivity(surfaceId, {
          lastTool: p.tool ?? undefined,
          activeSkill: p.skill ?? undefined,
          isDone: typeof p.done === 'boolean' ? p.done : undefined,
        });
        respond({ ok: true });
        break;
      }
```

(`SurfaceId` is already imported in index.ts via `../shared/types`; confirm with `grep -n "SurfaceId" src/main/index.ts`. If not present, add it to that import.)

- [ ] **Step 3: Verify it compiles**

Run: `npm run build:main`
Expected: tsc completes with no errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(pipe): add agent.activity V2 method for external activity producers"
```

---

## Task 3: `agent-activity` CLI verb

Gives the plugin a stable command: `wmux agent-activity [--surface ID] [--tool T] [--skill S] [--done]`. Surface defaults to `$WMUX_SURFACE_ID`.

**Files:**
- Modify: `src/cli/wmux.ts` (new case before `default:` ~L356)

- [ ] **Step 1: Add the case**

In the `switch (command)` block of `src/cli/wmux.ts`, before `default:`, add:

```typescript
      case 'agent-activity': {
        const surfaceId = getFlag(args, '--surface') || process.env.WMUX_SURFACE_ID;
        if (!surfaceId) { console.error('agent-activity: --surface or WMUX_SURFACE_ID required'); process.exit(1); }
        const params: Record<string, any> = { surfaceId };
        const tool = getFlag(args, '--tool'); if (tool) params.tool = tool;
        const skill = getFlag(args, '--skill'); if (skill) params.skill = skill;
        if (args.includes('--done')) params.done = true;
        if (args.includes('--active')) params.done = false;
        await sendV2('agent.activity', params);
        break;
      }
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run build:main`
Expected: tsc completes with no errors (CLI is part of build:main).

- [ ] **Step 3: Manual smoke test against running wmux**

With wmux running, in a wmux pane shell run:

```bash
wmux agent-activity --surface "$WMUX_SURFACE_ID" --tool bash --active
```

Expected: command exits 0; the sidebar for that surface shows tool `bash` / active.

- [ ] **Step 4: Commit**

```bash
git add src/cli/wmux.ts
git commit -m "feat(cli): add agent-activity verb for pushing sidebar activity"
```

---

## Task 4: `opencode-context.ts` — AGENTS.md injection

Mirrors `ensureClaudeContext()` but targets `~/.config/opencode/AGENTS.md`, reusing the same wmux instructions source and the same marker block so user content is never clobbered.

**Files:**
- Create: `src/main/opencode-context.ts`
- Test: `tests/unit/opencode-context.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/opencode-context.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { injectWmuxBlock } from '../../src/main/opencode-context';

const START = '<!-- wmux:start';
const END = '<!-- wmux:end -->';
const BLOCK = `${START} v1 -->\nUse the wmux CLI.\n${END}`;

describe('injectWmuxBlock', () => {
  it('returns the block alone when existing is empty', () => {
    expect(injectWmuxBlock('', BLOCK)).toBe(BLOCK);
  });
  it('appends the block when no markers present', () => {
    const out = injectWmuxBlock('# My rules\n', BLOCK);
    expect(out.startsWith('# My rules')).toBe(true);
    expect(out.includes(BLOCK)).toBe(true);
  });
  it('replaces an existing block, preserving surrounding content', () => {
    const old = `top\n${START} v0 -->\nOLD\n${END}\nbottom`;
    const out = injectWmuxBlock(old, BLOCK);
    expect(out.includes('OLD')).toBe(false);
    expect(out.includes('top')).toBe(true);
    expect(out.includes('bottom')).toBe(true);
    expect(out.includes(BLOCK)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/opencode-context.test.ts`
Expected: FAIL — cannot find module / `injectWmuxBlock` not exported.

- [ ] **Step 3: Implement the pure function + ensure fns**

Create `src/main/opencode-context.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const START_MARKER = '<!-- wmux:start';
const END_MARKER = '<!-- wmux:end -->';

/** Pure: insert/replace the wmux block within existing content, preserving the rest. */
export function injectWmuxBlock(existing: string, wmuxBlock: string): string {
  if (existing.trim() === '') return wmuxBlock;
  const startIdx = existing.indexOf(START_MARKER);
  const endIdx = existing.indexOf(END_MARKER);
  if (startIdx === -1) {
    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    return existing + separator + wmuxBlock;
  }
  if (endIdx === -1) {
    return existing.substring(0, startIdx) + wmuxBlock;
  }
  const before = existing.substring(0, startIdx);
  const after = existing.substring(endIdx + END_MARKER.length);
  return before + wmuxBlock + after;
}

function getInstructionsPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'claude-instructions', 'claude-instructions.md');
    }
  } catch {}
  return path.join(__dirname, '../../resources/claude-instructions/claude-instructions.md');
}

function getAgentsMdPath(): string {
  return path.join(os.homedir(), '.config', 'opencode', 'AGENTS.md');
}

/** Ensures ~/.config/opencode/AGENTS.md contains the wmux block. */
export function ensureOpencodeContext(): void {
  try {
    const instructionsPath = getInstructionsPath();
    if (!fs.existsSync(instructionsPath)) {
      console.warn('[wmux] instructions source not found at', instructionsPath);
      return;
    }
    const wmuxBlock = fs.readFileSync(instructionsPath, 'utf-8');
    const agentsPath = getAgentsMdPath();
    const dir = path.dirname(agentsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const existing = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf-8') : '';
    const next = injectWmuxBlock(existing, wmuxBlock);
    if (next !== existing) {
      fs.writeFileSync(agentsPath, next, 'utf-8');
      console.log('[wmux] Updated wmux context in ~/.config/opencode/AGENTS.md');
    }
  } catch (err) {
    console.warn('[wmux] Failed to update OpenCode context:', err);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/opencode-context.test.ts`
Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add src/main/opencode-context.ts tests/unit/opencode-context.test.ts
git commit -m "feat(opencode): inject wmux instructions into ~/.config/opencode/AGENTS.md"
```

---

## Task 5: The OpenCode plugin file

Plain JS (no deps) translating OpenCode hooks/events into `wmux` CLI calls. No-op outside wmux.

**Files:**
- Create: `resources/opencode-plugin/wmux.js`

- [ ] **Step 1: Write the plugin**

Create `resources/opencode-plugin/wmux.js`:

```javascript
// wmux-plugin-version: 1
// wmux OpenCode plugin — bridges OpenCode hooks/events to the wmux sidebar.
// Auto-installed by wmux to ~/.config/opencode/plugin/wmux.js.
// No-ops entirely outside wmux (WMUX !== '1').
const { execFile } = require("node:child_process");

function wmux(args) {
  // Fire-and-forget; never block or throw into OpenCode.
  try {
    const cli = process.env.WMUX_CLI;
    const file = cli ? process.execPath : "wmux";
    const argv = cli ? [cli, ...args] : args;
    execFile(file, argv, { windowsHide: true }, () => {});
  } catch {}
}

export const WmuxPlugin = async () => {
  if (process.env.WMUX !== "1") return {};
  const surface = process.env.WMUX_SURFACE_ID;
  if (!surface) return {};

  return {
    "tool.execute.after": async (input) => {
      wmux(["hook", "--event", "PostToolUse", "--tool", String(input.tool || "")]);
      wmux(["agent-activity", "--surface", surface, "--tool", String(input.tool || ""), "--active"]);
    },
    "tool.execute.before": async (input) => {
      wmux(["agent-activity", "--surface", surface, "--tool", String(input.tool || ""), "--active"]);
    },
    event: async ({ event }) => {
      if (!event || !event.type) return;
      if (event.type === "session.idle") {
        wmux(["agent-activity", "--surface", surface, "--done"]);
      } else if (event.type === "session.error") {
        wmux(["agent-activity", "--surface", surface, "--done"]);
      } else if (event.type === "message.part.updated") {
        wmux(["agent-activity", "--surface", surface, "--active"]);
      }
    },
    "shell.env": async (input, output) => {
      output.env.WMUX = "1";
      output.env.WMUX_SURFACE_ID = surface;
      if (process.env.WMUX_PIPE) output.env.WMUX_PIPE = process.env.WMUX_PIPE;
      if (process.env.WMUX_CLI) output.env.WMUX_CLI = process.env.WMUX_CLI;
    },
  };
};
```

> Note on `WMUX_CLI`: wmux sets it to the absolute path of `wmux.js`. Running it as `node <wmux.js> ...` is the most reliable invocation inside the OpenCode (Bun) runtime; falling back to a bare `wmux` on PATH otherwise.

- [ ] **Step 2: Commit**

```bash
git add resources/opencode-plugin/wmux.js
git commit -m "feat(opencode): add wmux OpenCode plugin (hooks/events -> wmux CLI)"
```

---

## Task 6: `ensureOpencodePlugin()` install logic

Copies the bundled plugin to `~/.config/opencode/plugin/wmux.js`, overwriting only when the embedded version marker differs.

**Files:**
- Modify: `src/main/opencode-context.ts`
- Test: `tests/unit/opencode-context.test.ts` (add cases)

- [ ] **Step 1: Add failing tests**

Append to `tests/unit/opencode-context.test.ts`:

```typescript
import { pluginNeedsUpdate } from '../../src/main/opencode-context';

describe('pluginNeedsUpdate', () => {
  const srcV2 = '// wmux-plugin-version: 2\ncode';
  it('true when target missing', () => {
    expect(pluginNeedsUpdate(srcV2, null)).toBe(true);
  });
  it('false when version markers match', () => {
    expect(pluginNeedsUpdate(srcV2, '// wmux-plugin-version: 2\nDIFFERENT BODY')).toBe(false);
  });
  it('true when version markers differ', () => {
    expect(pluginNeedsUpdate(srcV2, '// wmux-plugin-version: 1\ncode')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/opencode-context.test.ts`
Expected: FAIL — `pluginNeedsUpdate` not exported.

- [ ] **Step 3: Implement**

Append to `src/main/opencode-context.ts`:

```typescript
const VERSION_RE = /wmux-plugin-version:\s*(\S+)/;

/** Pure: compare embedded version markers to decide whether to re-install. */
export function pluginNeedsUpdate(src: string, target: string | null): boolean {
  if (target === null) return true;
  const s = src.match(VERSION_RE)?.[1];
  const t = target.match(VERSION_RE)?.[1];
  return s !== t;
}

function getPluginSrcPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'opencode-plugin', 'wmux.js');
    }
  } catch {}
  return path.join(__dirname, '../../resources/opencode-plugin/wmux.js');
}

/** Installs/updates the wmux OpenCode plugin into ~/.config/opencode/plugin/. */
export function ensureOpencodePlugin(): void {
  try {
    const srcPath = getPluginSrcPath();
    if (!fs.existsSync(srcPath)) {
      console.warn('[wmux] opencode plugin source not found at', srcPath);
      return;
    }
    const src = fs.readFileSync(srcPath, 'utf-8');
    const destDir = path.join(os.homedir(), '.config', 'opencode', 'plugin');
    const dest = path.join(destDir, 'wmux.js');
    const target = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf-8') : null;
    if (!pluginNeedsUpdate(src, target)) return;
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(dest, src, 'utf-8');
    console.log('[wmux] Installed wmux OpenCode plugin to', dest);
  } catch (err) {
    console.warn('[wmux] Failed to install OpenCode plugin:', err);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/opencode-context.test.ts`
Expected: PASS (6 passing total).

- [ ] **Step 5: Commit**

```bash
git add src/main/opencode-context.ts tests/unit/opencode-context.test.ts
git commit -m "feat(opencode): auto-install wmux OpenCode plugin to ~/.config/opencode/plugin"
```

---

## Task 7: Wire ensure fns into startup

**Files:**
- Modify: `src/main/index.ts` (~L15 import, ~L172 call site)

- [ ] **Step 1: Add the import**

In `src/main/index.ts`, after line 15 (`import { ensureClaudeContext, ... } from './claude-context';`) add:

```typescript
import { ensureOpencodeContext, ensureOpencodePlugin } from './opencode-context';
```

- [ ] **Step 2: Add the calls**

After line 172 (`ensureOrchestratorPlugin();`) add:

```typescript
  ensureOpencodeContext();
  ensureOpencodePlugin();
```

- [ ] **Step 3: Verify build**

Run: `npm run build:main`
Expected: tsc completes, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(opencode): run OpenCode context + plugin install on startup"
```

---

## Task 8: Orchestrator — `WMUX_AGENT_CMD` worker switch

Lets `/wmux:orchestrate` spawn OpenCode workers. `launch-agent.js` branches on `WMUX_AGENT_CMD` (default `claude`).

**Files:**
- Modify: `resources/wmux-orchestrator/scripts/launch-agent.js`

- [ ] **Step 1: Implement the branch**

Replace the `try { execFileSync('claude', [...]) ... }` block at the bottom of `resources/wmux-orchestrator/scripts/launch-agent.js` with:

```javascript
const agentCmd = (process.env.WMUX_AGENT_CMD || 'claude').toLowerCase();

try {
  if (agentCmd === 'opencode') {
    // opencode run streams formatted progress; user can watch.
    // '--' stops flag parsing from consuming the prompt.
    execFileSync('opencode', ['run', '--', prompt], { stdio: 'inherit' });
  } else {
    // --dangerously-skip-permissions: auto-approve all tools (interactive mode)
    // '--' stops Commander.js variadic flags from consuming the prompt
    execFileSync('claude', [
      '--dangerously-skip-permissions',
      '--',
      prompt
    ], { stdio: 'inherit' });
  }
} catch (e) {
  process.exit(e.status || 1);
}
```

- [ ] **Step 2: Manual smoke test (non-wmux)**

Run: `WMUX_AGENT_CMD=opencode node resources/wmux-orchestrator/scripts/launch-agent.js <(echo "say hi")`
Expected: `opencode run` launches and responds (requires opencode configured). Ctrl-C to exit.

- [ ] **Step 3: Commit**

```bash
git add resources/wmux-orchestrator/scripts/launch-agent.js
git commit -m "feat(orchestrator): support opencode workers via WMUX_AGENT_CMD"
```

---

## Task 9: Full unit test run + lint

- [ ] **Step 1: Run all unit tests**

Run: `npm test`
Expected: all suites pass, including the two new files.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no new errors in changed files.

- [ ] **Step 3: Commit any fixes** (only if changes were needed)

```bash
git add -A && git commit -m "test: fix lint/test issues for OpenCode compatibility"
```

---

## Task 10: Live acceptance test in wmux

Primary acceptance per the spec. Requires the running wmux to load the new main/renderer build.

- [ ] **Step 1: Build main + renderer**

```bash
npm run build:main
npx vite build
```

- [ ] **Step 2: Hot-swap into running wmux (per CLAUDE.md release step 11)**

```bash
rm -rf .asar-staging build-out && mkdir -p .asar-staging build-out
cp -r dist .asar-staging/dist && cp package.json .asar-staging/package.json
( cd .asar-staging && npm install --omit=dev --ignore-scripts )
npx asar pack .asar-staging build-out/app.asar --unpack-dir "node_modules/node-pty/prebuilds"
cp build-out/app.asar resources/app.asar
rm -rf resources/app.asar.unpacked && cp -r build-out/app.asar.unpacked resources/app.asar.unpacked
```

Then restart wmux.

- [ ] **Step 3: Verify plugin + context were installed**

Run:
```bash
ls "$HOME/.config/opencode/plugin/wmux.js" && grep -c "wmux:start" "$HOME/.config/opencode/AGENTS.md"
```
Expected: file exists; grep ≥ 1.

- [ ] **Step 4: Verify activity sidebar + hooks live**

In a wmux pane, run `opencode`, then ask it to run a bash command (e.g. "list files with ls"). Observe:
- Sidebar shows tool activity for that surface while the tool runs.
- Sidebar flips to done/idle when OpenCode finishes (`session.idle`).

(If nothing appears: confirm `echo $WMUX_SURFACE_ID` is set in the pane, and `wmux agent-activity --tool test --active` updates the sidebar manually.)

- [ ] **Step 5: Verify orchestrated OpenCode worker**

From a Claude pane (or directly), trigger an orchestration with the env switch, e.g. set `WMUX_AGENT_CMD=opencode` and run `/wmux:orchestrate <small task>`. Confirm a new pane launches `opencode run` and a wave advances when that session goes idle.

- [ ] **Step 6: Report results**

Document what passed/failed. Do NOT claim success without observing steps 3–5. If anything fails, switch to systematic-debugging.

- [ ] **Step 7: Commit (no code expected; cleanup only)**

```bash
rm -rf .asar-staging build-out
```

---

## Self-Review

**Spec coverage:**
- Pillar 1 (plugin: activity+hooks+env) → Tasks 5, 6, 7. ✓
- Pillar 2 (activity into sidebar) → Tasks 1, 2, 3. ✓
- Pillar 3 (instruction injection) → Tasks 4, 7. ✓
- Pillar 4 (OpenCode workers) → Task 8. ✓
- Plugin dir `plugin/` (singular, verified) → Task 6 dest path. ✓
- Live verification → Task 10. ✓

**Placeholder scan:** No TBD/TODO; all code blocks complete.

**Type consistency:** `applyExternalActivity(surfaceId, Partial<ClaudeActivity>)` defined in Task 1 and called in Task 2 with the same shape. `injectWmuxBlock`/`pluginNeedsUpdate`/`ensureOpencodeContext`/`ensureOpencodePlugin` defined in Tasks 4/6, imported in Task 7 with matching names. CLI verb `agent-activity` defined in Task 3 matches plugin calls in Task 5. `WMUX_AGENT_CMD` in Task 8 matches spec.

**Note for executor:** `ClaudeActivity` already has optional `agents`/`activeSkill`/`lastTool` and required `isDone` — `Partial<ClaudeActivity>` is valid. Confirm `respondError` and `respond` helpers exist in index.ts scope (they do — used throughout the switch).
