// wmux-plugin-version: 4
// Omp factories are rebound per session, but share this module in one process.
// Track session ancestry too: running agents need not have an async job record.
import { execFile } from 'node:child_process';

const surfaceSessions = new Map();

function descendsFrom(sessions, agent, parentId) {
  if (sessions.get(agent.id)?.rootId === parentId) return true;
  const visited = new Set();
  for (let id = agent.parentId; id && !visited.has(id); id = sessions.get(id)?.ctx.agent.parentId) {
    if (id === parentId) return true;
    visited.add(id);
  }
  return false;
}

export default function wmuxExtension(omp) {
  const surface = process.env.WMUX_SURFACE_ID;
  const cli = process.env.WMUX_CLI;
  const runtime = process.env.WMUX_NODE;
  if (process.env.WMUX !== '1' || !surface || !cli || !runtime) return;

  let queue = Promise.resolve();
  let lastState = null;
  let lastReportAt = 0;
  let timer;
  let closed = false;
  const prompts = new Set();
  const reportedChildren = new Map();
  let sessions = surfaceSessions.get(surface);
  if (!sessions) {
    sessions = new Map();
    surfaceSessions.set(surface, sessions);
  }
  let lastReportedSessionFile = null;
  let reportingSessionFile = null;

  function reportSession(ctx) {
    if (closed || ctx.agent?.kind !== 'main') return;
    const sm = ctx.sessionManager;
    if (!sm) return;
    if (typeof sm.isSessionOnDisk === 'function' && !sm.isSessionOnDisk()) {
      if (lastReportedSessionFile !== null) {
        lastReportedSessionFile = null;
        send(['report-session', '', '--provider', 'omp']);
      }
      return;
    }
    const sessionFile = sm.getSessionFile?.();
    if (!sessionFile || sessionFile === lastReportedSessionFile || sessionFile === reportingSessionFile) return;
    reportingSessionFile = sessionFile;
    const args = ['report-session', sessionFile, '--provider', 'omp'];
    return send(args, (error) => {
      reportingSessionFile = null;
      if (!error) {
        lastReportedSessionFile = sessionFile;
      }
    });
  }

  // One ordered queue: a slow working report cannot arrive after idle. Use the
  // injected runtime, never omp.exe (which cannot execute a CLI JavaScript file).
  function send(args, onDone) {
    queue = queue.then(() => {
      let resolve;
      const promise = new Promise(r => { resolve = r; });
      try {
        execFile(runtime, [cli, ...args, '--surface', surface], {
          windowsHide: true,
          timeout: 2000,
          env: process.env.WMUX_NODE_ELECTRON === '1'
            ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
            : process.env,
        }, (error) => {
          if (error) lastState = null;
          onDone?.(error);
          resolve();
        });
      } catch (err) {
        lastState = null;
        onDone?.(err);
        resolve();
      }
      return promise;
    });
    return queue;
  }

  // Fast direct invocation for shutdown: does not wait behind queued messages,
  // avoiding the 2-second omp session_shutdown deadline constraint.
  function sendDirect(args) {
    return new Promise(resolve => {
      try {
        execFile(runtime, [cli, ...args, '--surface', surface], {
          windowsHide: true,
          timeout: 1500,
          env: process.env.WMUX_NODE_ELECTRON === '1'
            ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
            : process.env,
        }, () => resolve());
      } catch {
        resolve();
      }
    });
  }

  function report(ctx, starting = false) {
    if (closed) return;
    if (ctx.agent?.kind !== 'main') {
      for (const record of sessions.values()) {
        if (record.ctx.agent.kind === 'main' && descendsFrom(sessions, ctx.agent, record.ctx.agent.id)) {
          return record.publish();
        }
      }
      return;
    }
    let busy = starting || !ctx.isIdle()
      || (ctx.getAsyncJobSnapshot?.()?.running.length ?? 0) > 0
      || ctx.hasPendingMessages();
    if (!busy) {
      for (const record of sessions.values()) {
        if (!descendsFrom(sessions, record.ctx.agent, ctx.agent.id)) continue;
        if (record.starting || !record.ctx.isIdle()
          || (record.ctx.getAsyncJobSnapshot?.()?.running.length ?? 0) > 0
          || record.ctx.hasPendingMessages()) {
          busy = true;
          break;
        }
      }
    }
    const activeChildren = new Set();
    for (const record of sessions.values()) {
      if (record.ctx.agent.kind !== 'sub'
        || !descendsFrom(sessions, record.ctx.agent, ctx.agent.id)) continue;
      const child = record.ctx.agent;
      const running = record.starting || !record.ctx.isIdle()
        || (record.ctx.getAsyncJobSnapshot?.()?.running.length ?? 0) > 0
        || record.ctx.hasPendingMessages();
      if (!running) continue;
      activeChildren.add(child.id);
      const previous = reportedChildren.get(child.id);
      if (previous?.running && Date.now() - previous.at < 30_000) continue;
      reportedChildren.set(child.id, { running: true, at: Date.now() });
      send(['report-subagent', child.id, '--name', child.id, '--detail', child.name]);
    }
    for (const [id, previous] of reportedChildren) {
      if (!previous.running || activeChildren.has(id)) continue;
      reportedChildren.set(id, { running: false, at: Date.now() });
      send(['report-subagent', id, '--done']);
    }
    const blocked = prompts.size > 0;
    const state = blocked ? 'blocked' : busy ? 'working' : 'idle';
    const now = Date.now();
    // Refresh long tool runs before wmux's declaration trust window expires.
    if (state === lastState && now - lastReportAt < 30_000) return queue;
    lastState = state;
    lastReportAt = now;
    return send(['report-agent', '--run-depth', busy ? '1' : '0',
      ...(blocked ? ['--blocked', 'Waiting for your response'] : ['--unblocked'])]);
  }

  omp.on('session_start', (_event, ctx) => {
    if (!ctx.agent) return;
    closed = false;
    const rootId = ctx.agent.kind === 'main' ? ctx.agent.id
      : sessions.get(ctx.agent.parentId)?.rootId ?? ctx.agent.parentId;
    sessions.set(ctx.agent.id, { ctx, rootId, starting: false, publish: () => report(ctx) });
    if (ctx.agent.kind === 'main') {
      reportSession(ctx);
      timer = ctx.setInterval(() => report(ctx), 1000);
    }
    return report(ctx);
  });
  omp.on('agent_start', (_event, ctx) => {
    const record = sessions.get(ctx.agent?.id);
    if (record) record.starting = true;
    return report(ctx, true);
  });
  for (const event of ['agent_end', 'turn_start', 'turn_end']) {
    omp.on(event, (_event, ctx) => {
      if (event === 'agent_end') {
        const record = sessions.get(ctx.agent?.id);
        if (record) record.starting = false;
      }
      if (event === 'turn_end' && ctx.agent?.kind === 'main') {
        reportSession(ctx);
      }
      return report(ctx);
    });
  }

  for (const event of ['session_switch', 'session_branch']) {
    omp.on(event, (_event, ctx) => {
      if (ctx.agent?.kind === 'main') {
        reportSession(ctx);
      }
      return report(ctx);
    });
  }

  // Omp does not expose pi's ui_prompt_start/ui_prompt_end. Its approval and
  // plan-review events, plus the native ask tool's lifetime, name real waits.
  for (const [start, end, key] of [
    ['tool_approval_requested', 'tool_approval_resolved', 'toolCallId'],
    ['plan_review_requested', 'plan_review_resolved', 'reviewId'],
  ]) {
    omp.on(start, (event, ctx) => {
      if (ctx.agent?.kind !== 'main') return;
      prompts.add(`${start}:${event[key]}`);
      return report(ctx);
    });
    omp.on(end, (event, ctx) => {
      if (ctx.agent?.kind !== 'main') return;
      prompts.delete(`${start}:${event[key]}`);
      return report(ctx);
    });
  }
  omp.on('tool_execution_start', (event, ctx) => {
    if (ctx.agent?.kind !== 'main' || event.toolName !== 'ask') return;
    prompts.add(`ask:${event.toolCallId}`);
    return report(ctx);
  });
  omp.on('tool_execution_end', (event, ctx) => {
    if (ctx.agent?.kind !== 'main') return;
    prompts.delete(`ask:${event.toolCallId}`);
    return report(ctx);
  });
  omp.on('session_shutdown', (_event, ctx) => {
    sessions.delete(ctx.agent?.id);
    if (ctx.agent?.kind !== 'main') return report(ctx);
    for (const [id, previous] of reportedChildren) {
      if (previous.running) send(['report-subagent', id, '--done']);
    }
    reportedChildren.clear();
    sessions.clear();
    surfaceSessions.delete(surface);
    closed = true;
    if (timer !== undefined) ctx.clearTimer(timer);
    prompts.clear();
    lastReportedSessionFile = null;
    reportingSessionFile = null;
    return sendDirect(['release-agent', '--provider', 'omp']);
  });
}
