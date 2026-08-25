/**
 * Flash the taskbar button when an agent starts waiting on the user.
 *
 * Lives in App rather than in the roster banner, which was the obvious home and
 * the wrong one: the banner is inside the sidebar, so collapsing the sidebar
 * (Ctrl+B) would unmount it and silently turn the alert off. The alert has to
 * outlive every piece of UI it reports on.
 *
 * Driven by store changes, not by a timer: blocked state only moves when a
 * report or a detection lands, and both re-render.
 */
import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { rollupAgents } from '../store/agent-rollup';
import { blockedAlertTransition } from '../store/blocked-alert';

export function useBlockedAlert(enabled: boolean): void {
  const workspaces = useStore((s) => s.workspaces);
  const agentStates = useStore((s) => s.agentStates);
  const agentDetections = useStore((s) => s.agentDetections);
  const previous = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled) {
      // Turning the pref off mid-flash must stop the flash, not just stop
      // future ones — the taskbar would otherwise blink until the user clicks.
      if (previous.current.size > 0) window.wmux?.window?.flash?.(false);
      previous.current = new Set();
      return;
    }

    const { blocked } = rollupAgents(workspaces, agentStates, Date.now(), {}, agentDetections);
    const next = new Set(blocked.map((entry) => entry.surfaceId as string));
    const transition = blockedAlertTransition(previous.current, next);
    previous.current = next;

    if (transition === 'flash') window.wmux?.window?.flash?.(true);
    else if (transition === 'clear') window.wmux?.window?.flash?.(false);
  }, [enabled, workspaces, agentStates, agentDetections]);
}
