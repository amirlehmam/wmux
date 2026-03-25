import { describe, it, expect } from 'vitest';
import { distributeAgents } from '../../src/main/agent-manager';

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
});
