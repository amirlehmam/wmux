import { describe, it, expect, vi } from 'vitest';
import { distributeAgents, AgentManager } from '../../src/main/agent-manager';

describe('Agent Manager', () => {
  describe('distributeAgents', () => {
    it('distributes evenly across panes', () => {
      const panes = [
        { paneId: 'pane-1', tabCount: 1 },
        { paneId: 'pane-2', tabCount: 1 },
        { paneId: 'pane-3', tabCount: 1 },
      ];
      const result = distributeAgents(3, panes);
      expect(result).toEqual(['pane-1', 'pane-2', 'pane-3']);
    });

    it('fills least-loaded panes first', () => {
      const panes = [
        { paneId: 'pane-1', tabCount: 3 },
        { paneId: 'pane-2', tabCount: 1 },
        { paneId: 'pane-3', tabCount: 2 },
      ];
      const result = distributeAgents(3, panes);
      expect(result).toEqual(['pane-2', 'pane-3', 'pane-1']);
    });

    it('round-robins when more agents than panes', () => {
      const panes = [
        { paneId: 'pane-1', tabCount: 1 },
        { paneId: 'pane-2', tabCount: 1 },
      ];
      const result = distributeAgents(5, panes);
      expect(result.length).toBe(5);
      expect(result.filter((p) => p === 'pane-1').length).toBe(3);
      expect(result.filter((p) => p === 'pane-2').length).toBe(2);
    });

    it('handles single pane', () => {
      const panes = [{ paneId: 'pane-1', tabCount: 0 }];
      const result = distributeAgents(4, panes);
      expect(result).toEqual(['pane-1', 'pane-1', 'pane-1', 'pane-1']);
    });
  });

  describe('exit broadcast (setOnAgentExit)', () => {
    /** Minimal PtyManager stand-in that captures the PTY exit callback per surface. */
    function fakePtyManager() {
      const exitCallbacks = new Map<string, (code: number) => void>();
      let nextId = 0;
      return {
        exitCallbacks,
        create: vi.fn(() => ({ id: `surf-${++nextId}` })),
        onData: vi.fn(() => () => {}),
        onExit: vi.fn((id: string, cb: (code: number) => void) => { exitCallbacks.set(id, cb); }),
        getPid: vi.fn(() => 1234),
        has: vi.fn(() => true),
        write: vi.fn(),
        kill: vi.fn(),
      };
    }

    function spawnOne(pty: ReturnType<typeof fakePtyManager>) {
      const manager = new AgentManager(pty as any);
      const onAgentExit = vi.fn();
      manager.setOnAgentExit(onAgentExit);
      const { agentId, surfaceId } = manager.spawn({
        cmd: 'echo hi', label: 'worker-1', paneId: 'pane-1' as any, workspaceId: 'ws-1' as any,
      });
      return { manager, onAgentExit, agentId, surfaceId };
    }

    it('invokes the exit listener with type/surface info when the PTY exits', () => {
      const pty = fakePtyManager();
      const { onAgentExit, agentId, surfaceId } = spawnOne(pty);

      expect(onAgentExit).not.toHaveBeenCalled();
      pty.exitCallbacks.get(surfaceId)!(0);

      expect(onAgentExit).toHaveBeenCalledTimes(1);
      expect(onAgentExit.mock.calls[0][0]).toMatchObject({
        agentId, surfaceId, status: 'exited', exitCode: 0,
      });
    });

    it('kill() notifies once; a later PTY exit does not duplicate the broadcast', () => {
      const pty = fakePtyManager();
      const { manager, onAgentExit, agentId, surfaceId } = spawnOne(pty);

      expect(manager.kill(agentId)).toBe(true);
      expect(pty.kill).toHaveBeenCalledWith(surfaceId);
      expect(onAgentExit).toHaveBeenCalledTimes(1);
      expect(onAgentExit.mock.calls[0][0]).toMatchObject({ surfaceId, status: 'exited', exitCode: -1 });

      // The killed PTY's real exit event arrives afterwards — must be a no-op.
      pty.exitCallbacks.get(surfaceId)!(1);
      expect(onAgentExit).toHaveBeenCalledTimes(1);
    });
  });
});
