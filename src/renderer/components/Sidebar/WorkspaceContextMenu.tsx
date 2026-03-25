import React, { useEffect, useRef, useState, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { WorkspaceInfo, WorkspaceId } from '../../../shared/types';

interface WorkspaceContextMenuProps {
  x: number;
  y: number;
  workspaceId: WorkspaceId;
  workspace: WorkspaceInfo;
  onClose: () => void;
  onPin: (id: WorkspaceId) => void;
  onRename: (id: WorkspaceId, title: string) => void;
  onSetColor: (id: WorkspaceId, color: string | null) => void;
  onMoveUp: (id: WorkspaceId) => void;
  onMoveDown: (id: WorkspaceId) => void;
  onMoveToTop: (id: WorkspaceId) => void;
  onCloseWorkspace: (id: WorkspaceId) => void;
  onCloseOthers: (id: WorkspaceId) => void;
  onMarkRead: (id: WorkspaceId) => void;
  onMarkUnread: (id: WorkspaceId) => void;
}

const COLOR_PRESETS: Array<{ label: string; value: string }> = [
  { label: 'Red', value: '#C0392B' },
  { label: 'Crimson', value: '#922B21' },
  { label: 'Orange', value: '#A04000' },
  { label: 'Amber', value: '#7D6608' },
  { label: 'Olive', value: '#4A5C18' },
  { label: 'Green', value: '#196F3D' },
  { label: 'Teal', value: '#006B6B' },
  { label: 'Aqua', value: '#0E6B8C' },
  { label: 'Blue', value: '#1565C0' },
  { label: 'Navy', value: '#1A5276' },
  { label: 'Indigo', value: '#283593' },
  { label: 'Purple', value: '#6A1B9A' },
  { label: 'Magenta', value: '#AD1457' },
  { label: 'Rose', value: '#880E4F' },
  { label: 'Brown', value: '#7B3F00' },
  { label: 'Charcoal', value: '#3E4B5E' },
];

export default function WorkspaceContextMenu({
  x,
  y,
  workspaceId,
  workspace,
  onClose,
  onPin,
  onRename,
  onSetColor,
  onMoveUp,
  onMoveDown,
  onMoveToTop,
  onCloseWorkspace,
  onCloseOthers,
  onMarkRead,
  onMarkUnread,
}: WorkspaceContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(workspace.title);
  const [showColorSubmenu, setShowColorSubmenu] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Close on outside click or Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleMouseDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [onClose]);

  // Auto-focus rename input when renaming
  useEffect(() => {
    if (renaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renaming]);

  // Clamp menu position so it doesn't go off-screen
  const viewW = window.innerWidth;
  const viewH = window.innerHeight;
  const menuW = 220;
  const menuH = 300; // approximate
  const clampedX = Math.min(x, viewW - menuW - 8);
  const clampedY = Math.min(y, viewH - menuH - 8);

  const handleRenameSubmit = useCallback(() => {
    const trimmed = renameValue.trim();
    if (trimmed) {
      onRename(workspaceId, trimmed);
    }
    setRenaming(false);
    onClose();
  }, [renameValue, workspaceId, onRename, onClose]);

  const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleRenameSubmit();
    if (e.key === 'Escape') {
      setRenaming(false);
      onClose();
    }
  };

  const item = (label: string, action: () => void, danger = false) => (
    <div
      className={`ctx-menu__item${danger ? ' ctx-menu__item--danger' : ''}`}
      onClick={() => { action(); onClose(); }}
      role="menuitem"
    >
      {label}
    </div>
  );

  const menu = (
    <div
      ref={menuRef}
      className="ctx-menu"
      style={{ left: clampedX, top: clampedY }}
      role="menu"
    >
      {/* Pin / Unpin */}
      {item(workspace.pinned ? 'Unpin Workspace' : 'Pin Workspace', () => onPin(workspaceId))}

      {/* Rename */}
      {renaming ? (
        <div className="ctx-menu__rename-row">
          <input
            ref={renameInputRef}
            className="ctx-menu__rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={handleRenameSubmit}
          />
        </div>
      ) : (
        <div
          className="ctx-menu__item"
          onClick={() => { setRenaming(true); setRenameValue(workspace.title); }}
          role="menuitem"
        >
          Rename Workspace…
        </div>
      )}

      <div className="ctx-menu__separator" />

      {/* Color submenu */}
      <div
        className="ctx-menu__item ctx-menu__item--has-sub"
        onMouseEnter={() => setShowColorSubmenu(true)}
        onMouseLeave={() => setShowColorSubmenu(false)}
        role="menuitem"
        aria-haspopup="true"
      >
        Workspace Color ▶
        {showColorSubmenu && (
          <div className="ctx-menu__submenu">
            <div
              className="ctx-menu__color-item ctx-menu__color-item--clear"
              onClick={() => { onSetColor(workspaceId, null); onClose(); }}
              role="menuitem"
            >
              Clear Color
            </div>
            <div className="ctx-menu__swatches">
              {COLOR_PRESETS.map((c) => (
                <div
                  key={c.value}
                  className="ctx-menu__swatch"
                  style={{ backgroundColor: c.value }}
                  title={c.label}
                  onClick={() => { onSetColor(workspaceId, c.value); onClose(); }}
                  role="menuitem"
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="ctx-menu__separator" />

      {/* Move */}
      {item('Move Up', () => onMoveUp(workspaceId))}
      {item('Move Down', () => onMoveDown(workspaceId))}
      {item('Move to Top', () => onMoveToTop(workspaceId))}

      <div className="ctx-menu__separator" />

      {/* Close */}
      {item('Close Workspace', () => onCloseWorkspace(workspaceId), true)}
      {item('Close Other Workspaces', () => onCloseOthers(workspaceId), true)}

      <div className="ctx-menu__separator" />

      {/* Mark read/unread */}
      {item('Mark as Read', () => onMarkRead(workspaceId))}
      {item('Mark as Unread', () => onMarkUnread(workspaceId))}
    </div>
  );

  return ReactDOM.createPortal(menu, document.body);
}
