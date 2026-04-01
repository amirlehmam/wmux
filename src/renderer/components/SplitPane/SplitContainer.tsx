import React, { useCallback } from 'react';
import { SplitNode, PaneId, WorkspaceId } from '../../../shared/types';
import PaneWrapper from './PaneWrapper';
import SplitDivider from './SplitDivider';
import '../../styles/splitpane.css';

/** Get all pane IDs from a subtree — used as stable React key */
function getTreeKey(node: SplitNode): string {
  if (node.type === 'leaf') return node.paneId;
  return `${getTreeKey(node.children[0])}_${getTreeKey(node.children[1])}`;
}

function getFirstPaneId(n: SplitNode): PaneId {
  if (n.type === 'leaf') return n.paneId;
  return getFirstPaneId(n.children[0]);
}

interface SplitContainerProps {
  node: SplitNode;
  workspaceId: WorkspaceId;
  focusedPaneId: PaneId | null;
  onRatioChange?: (leftPaneId: PaneId, rightPaneId: PaneId, ratio: number) => void;
  onPaneFocus: (paneId: PaneId) => void;
}

export default function SplitContainer({
  node,
  workspaceId,
  focusedPaneId,
  onRatioChange,
  onPaneFocus,
}: SplitContainerProps) {
  if (node.type === 'leaf') {
    return (
      <div
        className="split-child"
        style={{ width: '100%', height: '100%' }}
        onClick={() => onPaneFocus(node.paneId)}
      >
        <PaneWrapper
          key={node.paneId}
          paneId={node.paneId}
          workspaceId={workspaceId}
          leaf={node}
          isFocused={focusedPaneId === node.paneId}
        />
      </div>
    );
  }

  // Branch node
  const { direction, ratio, children } = node;
  const [leftChild, rightChild] = children;

  const leftPaneId = getFirstPaneId(leftChild);
  const rightPaneId = getFirstPaneId(rightChild);

  const handleDividerRatioChange = useCallback(
    (delta: number) => {
      if (!onRatioChange) return;
      const newRatio = Math.min(0.9, Math.max(0.1, ratio + delta));
      onRatioChange(leftPaneId, rightPaneId, newRatio);
    },
    [ratio, leftPaneId, rightPaneId, onRatioChange],
  );

  const handleDividerDoubleClick = useCallback(() => {
    onRatioChange?.(leftPaneId, rightPaneId, 0.5);
  }, [leftPaneId, rightPaneId, onRatioChange]);

  return (
    <div className={`split-container split-container--${direction}`}>
      <div className="split-child" style={{ flex: ratio }} key={getTreeKey(leftChild)}>
        <SplitContainer
          node={leftChild}
          workspaceId={workspaceId}
          focusedPaneId={focusedPaneId}
          onRatioChange={onRatioChange}
          onPaneFocus={onPaneFocus}
        />
      </div>

      <SplitDivider
        direction={direction}
        onRatioChange={handleDividerRatioChange}
        onDoubleClick={handleDividerDoubleClick}
      />

      <div className="split-child" style={{ flex: 1 - ratio }} key={getTreeKey(rightChild)}>
        <SplitContainer
          node={rightChild}
          workspaceId={workspaceId}
          focusedPaneId={focusedPaneId}
          onRatioChange={onRatioChange}
          onPaneFocus={onPaneFocus}
        />
      </div>
    </div>
  );
}
