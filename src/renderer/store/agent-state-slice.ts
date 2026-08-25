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
}

export const createAgentStateSlice: StateCreator<AgentStateSlice, [], [], AgentStateSlice> = (set) => ({
  agentStates: {},

  setAgentState(payload: AgentStatePayload): void {
    if (!payload?.surfaceId) return;
    set((state) => ({
      agentStates: { ...state.agentStates, [payload.surfaceId]: payload },
    }));
  },

  replaceAgentStates(payloads: AgentStatePayload[]): void {
    const next: Record<string, AgentStatePayload> = {};
    for (const p of payloads ?? []) {
      if (p?.surfaceId) next[p.surfaceId] = p;
    }
    set({ agentStates: next });
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
});
