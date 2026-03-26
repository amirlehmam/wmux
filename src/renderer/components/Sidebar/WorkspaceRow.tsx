import React, { useState, useRef, useMemo } from 'react';
import { WorkspaceInfo, SplitNode } from '../../../shared/types';
import UnreadBadge from './UnreadBadge';
import PrStatusIcon from './PrStatusIcon';

function getAllSurfaceIds(tree: SplitNode): string[] {
  if (tree.type === 'leaf') return tree.surfaces.map(s => s.id);
  return [...getAllSurfaceIds(tree.children[0]), ...getAllSurfaceIds(tree.children[1])];
}

interface WorkspaceRowProps {
  workspace: WorkspaceInfo;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename?: (newTitle: string) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  // Drag-and-drop
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  isDragOver?: boolean;
  agentCount?: number;
  hookActivity?: { agents: number; tools: number; lastSeen: number };
  claudeActivity?: Record<string, any>;
}

export default function WorkspaceRow({
  workspace,
  isActive,
  onSelect,
  onClose,
  onRename,
  onContextMenu,
  draggable = false,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isDragOver = false,
  agentCount = 0,
  hookActivity,
  claudeActivity,
}: WorkspaceRowProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(workspace.title);
  const rowRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Support custom color: override the active background if set
  const activeBackground = workspace.customColor ?? '#0091FF';
  const customColorTint = workspace.customColor
    ? `${workspace.customColor}0D` // ~5% opacity
    : undefined;

  // Find Claude activity for this workspace's surfaces
  const wsActivity = useMemo(() => {
    if (!claudeActivity) return null;
    const surfaceIds = getAllSurfaceIds(workspace.splitTree);
    for (const sid of surfaceIds) {
      if (claudeActivity[sid]) return claudeActivity[sid];
    }
    return null;
  }, [claudeActivity, workspace.splitTree]);

  const rowStyle: React.CSSProperties = isActive
    ? { backgroundColor: activeBackground }
    : customColorTint
    ? { backgroundColor: customColorTint }
    : {};

  const portsStr = workspace.ports && workspace.ports.length > 0
    ? workspace.ports.map((p) => `:${p}`).join(', ')
    : null;

  return (
    <div
      ref={rowRef}
      className={[
        'workspace-row',
        isActive ? 'workspace-row--active' : '',
        isDragOver ? 'workspace-row--drag-over' : '',
      ].filter(Boolean).join(' ')}
      style={rowStyle}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      {/* Left rail indicator — always rendered; CSS controls opacity */}
      <span className="workspace-row__rail" />

      {/* Title row */}
      <div className="workspace-row__header">
        <span
          className={`workspace-row__state-dot${
            workspace.shellState === 'running' ? ' workspace-row__state-dot--running' :
            workspace.shellState === 'interrupted' ? ' workspace-row__state-dot--interrupted' :
            workspace.shellState === 'idle' ? ' workspace-row__state-dot--idle' : ''
          }`}
          title={workspace.shellState === 'running' ? 'Working...' : workspace.shellState === 'interrupted' ? 'Interrupted' : workspace.shellState === 'idle' ? 'Done' : ''}
        />
        {isRenaming ? (
          <input
            ref={renameInputRef}
            className="workspace-row__rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={() => {
              if (renameValue.trim() && renameValue !== workspace.title) {
                onRename?.(renameValue.trim());
              }
              setIsRenaming(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (renameValue.trim() && renameValue !== workspace.title) {
                  onRename?.(renameValue.trim());
                }
                setIsRenaming(false);
              }
              if (e.key === 'Escape') {
                setRenameValue(workspace.title);
                setIsRenaming(false);
              }
              e.stopPropagation();
            }}
            onClick={(e) => e.stopPropagation()}
            autoFocus
          />
        ) : (
          <span
            className="workspace-row__title"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setRenameValue(workspace.title);
              setIsRenaming(true);
            }}
          >
            {workspace.title}
          </span>
        )}

        {workspace.unreadCount > 0 && (
          <UnreadBadge count={workspace.unreadCount} isSelected={isActive} />
        )}

        <button
          className="workspace-row__close"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title="Close workspace"
        >
          ✕
        </button>
      </div>

      {/* Metadata section */}
      {(workspace.notificationText ||
        workspace.gitBranch ||
        workspace.cwd ||
        workspace.prNumber != null ||
        portsStr ||
        agentCount > 0 ||
        hookActivity ||
        wsActivity) && (
        <div className="workspace-row__metadata">
          {/* Notification text */}
          {workspace.notificationText && (
            <div className="workspace-row__notification">
              {workspace.notificationText}
            </div>
          )}

          {/* PR info */}
          {workspace.prNumber != null && (
            <div className="workspace-row__pr">
              {workspace.prStatus != null && (
                <PrStatusIcon status={workspace.prStatus} size={12} />
              )}
              <span className="workspace-row__pr-number">
                #{workspace.prNumber}
              </span>
              {workspace.prStatus != null && (
                <span className="workspace-row__pr-status">
                  {workspace.prStatus}
                </span>
              )}
            </div>
          )}

          {/* Git branch */}
          {workspace.gitBranch && (
            <div className="workspace-row__meta-line">
              {workspace.gitDirty ? '* ' : ''}{workspace.gitBranch}
            </div>
          )}

          {/* Working directory */}
          {workspace.cwd && (
            <div className="workspace-row__meta-line">
              {workspace.cwd}
            </div>
          )}

          {/* Ports */}
          {portsStr && (
            <div className="workspace-row__meta-line">
              {portsStr}
            </div>
          )}

          {/* Agent count */}
          {agentCount > 0 && (
            <div className="workspace-row__meta-line workspace-row__agents">
              {agentCount} agent{agentCount !== 1 ? 's' : ''}
            </div>
          )}

          {/* Claude activity (parsed from terminal output) */}
          {wsActivity && wsActivity.agents && wsActivity.agents.length > 0 && (
            <div className="workspace-row__claude-activity">
              {wsActivity.agents.map((agent: any, i: number) => (
                <div key={i} className="workspace-row__agent-line">
                  <span className={`workspace-row__agent-dot ${agent.done ? 'workspace-row__agent-dot--done' : 'workspace-row__agent-dot--working'}`} />
                  <span className="workspace-row__agent-name">{agent.name}</span>
                  <span className="workspace-row__agent-tokens">{agent.tokens}tok</span>
                </div>
              ))}
            </div>
          )}
          {wsActivity?.activeSkill && (
            <div className="workspace-row__meta-line workspace-row__skill">
              {wsActivity.activeSkill}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
