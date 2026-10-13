/**
 * Declared agent state (issue #128), held in the store rather than in App.tsx.
 *
 * It used to live in a `useState` in App.tsx and reach the sidebar by being
 * passed down twice (App → Sidebar → WorkspaceRow). That worked for rendering
 * a row and for nothing else: keyboard shortcuts, the command palette and the
 * titlebar all run outside that subtree, so a "jump to the pane that needs you"
 * action structurally could not see which pane that was. Moving the map here is
 * the prerequisite for every consumer that is not a workspace row.
 *
 * Kept as a plain object rather than a Map because it is fed by a delta channel
 * whose payloads are already plain snapshots, and because a new object identity
 * per update is what makes the `useMemo`s downstream recompute.
 */
import { StateCreator } from 'zustand';
import { SurfaceId } from '../../shared/types';
import type { DeclaredAgentSnapshot, AgentIdentitySnapshot } from './agent-rollup';
import type { DetectionResult } from '../../shared/detection/types';
import { withIdleSince } from './agent-rollup';

/** The AGENT_STATE payload, which carries its own surfaceId. */
export interface AgentStatePayload extends DeclaredAgentSnapshot {
  surfaceId: SurfaceId;
}

/** The AGENT_IDENTITY payload. Kind only — never the command line behind it. */
export interface AgentIdentityPayload extends AgentIdentitySnapshot {
  surfaceId: SurfaceId;
}

export interface AgentStateSlice {
  /**
   * surfaceId → last declared snapshot.
   *
   * Entries are NEVER pruned here, deliberately: main's own record map is
   * pruned only by a 256-entry LRU and nothing announces a closed surface, so
   * any pruning done here would be a guess. Consumers must instead read this
   * map THROUGH the live split trees — see rollupAgents in agent-rollup.ts,
   * which is why that function takes the workspace list and not this map alone.
   */
  agentStates: Record<string, AgentStatePayload>;
  /** Apply one delta from the AGENT_STATE channel. */
  setAgentState: (payload: AgentStatePayload) => void;
  /** Seed the whole map — used once per window, at mount (see agentState.list). */
  replaceAgentStates: (payloads: AgentStatePayload[]) => void;

  /** surfaceId → which agent runs there. Same delta-channel caveats as above. */
  agentIdentities: Record<string, AgentIdentitySnapshot>;
  setAgentIdentity: (payload: AgentIdentityPayload) => void;
  replaceAgentIdentities: (payloads: AgentIdentityPayload[]) => void;

  /**
   * surfaceId → what the pane's SCREEN says, kept strictly apart from what the
   * agent DECLARED (invariant 5 of the detection design).
   *
   * They are never merged here. A consumer merges them at render time, so an
   * operator running `wmux agent-state` can still tell a reported block from a
   * seen one — and so a detected state can never be mistaken for a claim the
   * agent made.
   */
  agentDetections: Record<string, DetectionResult>;
  setAgentDetection: (surfaceId: string, result: DetectionResult | null) => void;
  clearAgentDetections: () => void;
}

export const createAgentStateSlice: StateCreator<AgentStateSlice, [], [], AgentStateSlice> = (set) => ({
  agentStates: {},

  setAgentState(payload: AgentStatePayload): void {
    if (!payload?.surfaceId) return;
    set((state) => ({
      agentStates: {
        ...state.agentStates,
        // Stamps when this idle period began — see withIdleSince.
        [payload.surfaceId]: withIdleSince(state.agentStates[payload.surfaceId], payload, Date.now()),
      },
    }));
  },

  replaceAgentStates(payloads: AgentStatePayload[]): void {
    set((state) => {
      const next: Record<string, AgentStatePayload> = {};
      const now = Date.now();
      for (const p of payloads ?? []) {
        // Seeded against what is already held, so a re-seed does not restart an
        // idle period that a stored question was observed in.
        if (p?.surfaceId) next[p.surfaceId] = withIdleSince(state.agentStates[p.surfaceId], p, now);
      }
      return { agentStates: next };
    });
  },

  agentIdentities: {},

  setAgentIdentity(payload: AgentIdentityPayload): void {
    if (!payload?.surfaceId) return;
    set((state) => {
      // A null kind is main saying "this pane is no longer an agent" — drop the
      // entry rather than storing a tombstone the rollup would have to skip.
      if (!payload.kind) {
        if (!(payload.surfaceId in state.agentIdentities)) return state;
        const next = { ...state.agentIdentities };
        delete next[payload.surfaceId];
        return { agentIdentities: next };
      }
      return {
        agentIdentities: {
          ...state.agentIdentities,
          [payload.surfaceId]: { kind: payload.kind, source: payload.source },
        },
      };
    });
  },

  replaceAgentIdentities(payloads: AgentIdentityPayload[]): void {
    const next: Record<string, AgentIdentitySnapshot> = {};
    for (const p of payloads ?? []) {
      if (p?.surfaceId && p.kind) next[p.surfaceId] = { kind: p.kind, source: p.source };
    }
    set({ agentIdentities: next });
  },

  agentDetections: {},

  setAgentDetection(surfaceId: string, result: DetectionResult | null): void {
    set((state) => {
      const previous = state.agentDetections[surfaceId];

      if (!result) {
        if (!previous) return state;
        const next = { ...state.agentDetections };
        delete next[surfaceId];
        return { agentDetections: next };
      }

      // The loop re-scans several times a second. Returning the same object for
      // an unchanged verdict is what keeps every downstream useMemo from
      // recomputing at that rate (issue #141's lesson, one layer up).
      // `observedAt` is part of the identity: the loop re-publishes an
      // otherwise identical question only to renew that stamp.
      if (previous
        && previous.state === result.state
        && previous.agent === result.agent
        && previous.ruleId === result.ruleId
        && previous.observedAt === result.observedAt) {
        return state;
      }

      return { agentDetections: { ...state.agentDetections, [surfaceId]: result } };
    });
  },

  clearAgentDetections(): void {
    set((state) => (Object.keys(state.agentDetections).length === 0 ? state : { agentDetections: {} }));
  },
});
