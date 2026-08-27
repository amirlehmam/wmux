import { create } from 'zustand';
import { WorkspaceSlice, createWorkspaceSlice } from './workspace-slice';
import { SettingsSlice, createSettingsSlice } from './settings-slice';
import { NotificationSlice, createNotificationSlice } from './notification-slice';
import { SurfaceSlice, createSurfaceSlice } from './surface-slice';
import { AgentSlice, createAgentSlice } from './agent-slice';
import { OrchestrationSlice, createOrchestrationSlice } from './orchestration-slice';
import { ProgressSlice, createProgressSlice } from './progress-slice';
import { AgentStateSlice, createAgentStateSlice } from './agent-state-slice';
import { PromptSlice, createPromptSlice } from './prompt-slice';

export type WmuxStore = WorkspaceSlice & SettingsSlice & NotificationSlice & SurfaceSlice & AgentSlice & OrchestrationSlice & ProgressSlice & AgentStateSlice & PromptSlice;

export const useStore = create<WmuxStore>()((...args) => ({
  ...createWorkspaceSlice(...args),
  ...createSettingsSlice(...args),
  ...createNotificationSlice(...args),
  ...createSurfaceSlice(...args),
  ...createAgentSlice(...args),
  ...createOrchestrationSlice(...args),
  ...createProgressSlice(...args),
  ...createAgentStateSlice(...args),
  ...createPromptSlice(...args),
}));
