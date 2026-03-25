import React, { useState, useRef } from 'react';
import { WorkspaceInfo } from '../../../shared/types';
import UnreadBadge from './UnreadBadge';
import PrStatusIcon from './PrStatusIcon';

interface WorkspaceRowProps {
  workspace: WorkspaceInfo;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  // Drag-and-drop
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  isDragOver?: boolean;
}

export default function WorkspaceRow({
  workspace,
  isActive,
  onSelect,
  onClose,
  onContextMenu,
  draggable = false,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isDragOver = false,
}: WorkspaceRowProps) {
  const [isHovered, setIsHovered] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  const railColor = workspace.customColor ?? '#0091FF';

  // Row background tint if custom color
  const customColorTint = workspace.customColor
    ? `${workspace.customColor}0D` // 5% opacity (0x0D ≈ 5%)
    : undefined;

  const rowBg = isActive
    ? workspace.customColor ?? '#0091FF'
    : isHovered
    ? 'rgba(255,255,255,0.05)'
    : customColorTint ?? 'transparent';

  const metaOpacity = 0.75;
  const metaColor = isActive
    ? `rgba(255,255,255,${metaOpacity})`
    : `rgba(255,255,255,${metaOpacity * 0.7})`;

  const titleColor = isActive ? '#ffffff' : '#fdfff1';

  const portsStr = workspace.ports && workspace.ports.length > 0
    ? workspace.ports.map((p) => `:${p}`).join(', ')
    : null;

  return (
    <div
      ref={rowRef}
      className={`workspace-row${isActive ? ' workspace-row--active' : ''}${isDragOver ? ' workspace-row--dragover' : ''}`}
      style={{ position: 'relative', cursor: 'pointer' }}
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
      {/* Left rail indicator */}
      {isActive && (
        <span
          className="workspace-row__rail"
          style={{ backgroundColor: railColor }}
        />
      )}

      {/* Inner padding div */}
      <div
        className="workspace-row__inner"
        style={{ backgroundColor: rowBg }}
      >
        {/* Title row */}
        <div className="workspace-row__title-row">
          <span
            className="workspace-row__title"
            style={{ color: titleColor }}
          >
            {workspace.title}
          </span>

          <div className="workspace-row__title-right">
            {workspace.unreadCount > 0 && (
              <UnreadBadge count={workspace.unreadCount} isSelected={isActive} />
            )}

            {isHovered && (
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
            )}
          </div>
        </div>

        {/* Notification text */}
        {workspace.notificationText && (
          <div
            className="workspace-row__meta workspace-row__notification"
            style={{ color: metaColor }}
          >
            {workspace.notificationText}
          </div>
        )}

        {/* Git branch */}
        {workspace.gitBranch && (
          <div
            className="workspace-row__meta workspace-row__mono"
            style={{ color: metaColor }}
          >
            {workspace.gitDirty ? '* ' : ''}{workspace.gitBranch}
          </div>
        )}

        {/* Working directory */}
        {workspace.cwd && (
          <div
            className="workspace-row__meta workspace-row__mono"
            style={{ color: metaColor }}
          >
            {workspace.cwd}
          </div>
        )}

        {/* PR info */}
        {workspace.prNumber != null && workspace.prStatus != null && (
          <div
            className="workspace-row__meta workspace-row__pr"
            style={{ color: metaColor, display: 'flex', alignItems: 'center', gap: 4 }}
          >
            <PrStatusIcon status={workspace.prStatus} size={12} />
            #{workspace.prNumber} {workspace.prStatus}
          </div>
        )}
        {workspace.prNumber != null && workspace.prStatus == null && (
          <div
            className="workspace-row__meta workspace-row__pr"
            style={{ color: metaColor }}
          >
            #{workspace.prNumber}
          </div>
        )}

        {/* Ports */}
        {portsStr && (
          <div
            className="workspace-row__meta workspace-row__mono"
            style={{ color: metaColor }}
          >
            {portsStr}
          </div>
        )}
      </div>
    </div>
  );
}
