import { StateCreator } from 'zustand';
import { SurfaceId } from '../../shared/types';

export interface AgentMeta {
  agentId: string;
  label: string;
  status?: 'running' | 'exited';
  exitCode?: number;
}

export interface AgentSlice {
  agentMeta: Map<SurfaceId, AgentMeta>;
  setAgentMeta: (surfaceId: SurfaceId, meta: AgentMeta) => void;
  removeAgentMeta: (surfaceId: SurfaceId) => void;
  getAgentMeta: (surfaceId: SurfaceId) => AgentMeta | undefined;
}

export const createAgentSlice: StateCreator<AgentSlice, [], [], AgentSlice> = (set, get) => ({
  agentMeta: new Map(),
  setAgentMeta(surfaceId: SurfaceId, meta: AgentMeta): void {
    set((state) => {
      const newMap = new Map(state.agentMeta);
      newMap.set(surfaceId, meta);
      return { agentMeta: newMap };
    });
  },
  removeAgentMeta(surfaceId: SurfaceId): void {
    set((state) => {
      const newMap = new Map(state.agentMeta);
      newMap.delete(surfaceId);
      return { agentMeta: newMap };
    });
  },
  getAgentMeta(surfaceId: SurfaceId): AgentMeta | undefined {
    return get().agentMeta.get(surfaceId);
  },
});
