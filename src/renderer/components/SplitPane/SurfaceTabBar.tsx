import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { SurfaceRef, SurfaceId, PaneId, WorkspaceId, QuickLaunchProfile } from '../../../shared/types';
import { useStore } from '../../store';
import { IconAdd, IconSplit, IconSplitDown, IconClose, IconCaret } from './icons';

interface SurfaceTabBarProps {
  paneId: PaneId;
  workspaceShell?: string;
  surfaces: SurfaceRef[];
  activeSurfaceIndex: number;
  onSelect: (index: number) => void;
  onClose: (surfaceId: SurfaceId) => void;
  onNew: () => void;
  onNewTyped?: (type: 'terminal' | 'browser' | 'markdown') => void;
  /** Quick-launch profiles surfaced in the `+` caret dropdown (issue #32). */
  profiles?: QuickLaunchProfile[];
  onNewProfile?: (profile: QuickLaunchProfile) => void;
  onClosePane?: () => void;
  onSplitRight?: () => void;
  onSplitDown?: () => void;
  onDropSurface?: (sourcePaneId: PaneId, surfaceId: SurfaceId, targetPaneId: PaneId) => void;
  onReorderSurface?: (surfaceId: SurfaceId, newIndex: number) => void;
  isDragActive?: boolean;
  isFocused?: boolean;
}

function surfaceIcon(type: string, isAgent: boolean): string {
  if (isAgent) return '>_';
  switch (type) {
    case 'terminal': return '>';
    case 'browser': return '◎';
    case 'markdown': return '¶';
    case 'diff': return '±';
    default: return '○';
  }
}

function getShellLabel(shell?: string): string | null {
  if (!shell) return null;
  const normalized = shell.replace(/\\/g, '/').split('/').pop()?.toLowerCase() || shell.toLowerCase();
  if (normalized === 'pwsh.exe' || normalized === 'pwsh') return 'PowerShell';
  if (normalized === 'powershell.exe' || normalized === 'powershell') return 'Windows PowerShell';
  if (normalized === 'cmd.exe' || normalized === 'cmd') return 'Command Prompt';
  if (normalized === 'bash.exe' || normalized === 'bash') return 'Bash';
  if (normalized === 'zsh' || normalized === 'zsh.exe') return 'Zsh';
  if (normalized === 'wsl.exe' || normalized === 'wsl') return 'WSL';
  if (normalized === 'git-bash.exe') return 'Git Bash';
  return normalized.replace(/\.exe$/i, '').replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function surfaceLabel(surface: SurfaceRef, agentLabel?: string, workspaceShell?: string): string {
  if (surface.customTitle) return surface.customTitle;
  if (agentLabel) return agentLabel;
  switch (surface.type) {
    case 'terminal': return getShellLabel(surface.shell || workspaceShell) || 'Terminal';
    case 'browser': return 'Browser';
    case 'markdown': return 'Markdown';
    case 'diff': return 'Diff';
    default: return 'Tab';
  }
}

export default function SurfaceTabBar({
  paneId,
  workspaceShell,
  surfaces,
  activeSurfaceIndex,
  onSelect,
  onClose,
  onNew,
  onNewTyped,
  profiles,
  onNewProfile,
  onClosePane,
  onSplitRight,
  onSplitDown,
  onDropSurface,
  onReorderSurface,
  isDragActive,
  isFocused,
}: SurfaceTabBarProps) {
  const [draggingSurfaceId, setDraggingSurfaceId] = useState<SurfaceId | null>(null);
  const [insertIndex, setInsertIndex] = useState<number | null>(null);
  const [renamingId, setRenamingId] = useState<SurfaceId | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // Which control-cluster dropdown is open, and where to anchor it (issue #34).
  // Menus render through a portal to document.body so the tab bar's
  // `overflow: hidden` can no longer clip them (the old caret-dropdown bug).
  const [openMenu, setOpenMenu] = useState<'new' | 'layout' | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const newCaretRef = useRef<HTMLButtonElement>(null);
  const layoutCaretRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const agentMeta = useStore((state) => state.agentMeta);
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId);
  const renameSurface = useStore((state) => state.renameSurface);
  const getAgentMeta = (surfaceId: string) => agentMeta.get(surfaceId as any);

  // Start rename for the active surface
  const startRename = useCallback(() => {
    const activeSurface = surfaces[activeSurfaceIndex];
    if (!activeSurface) return;
    setRenamingId(activeSurface.id);
    setRenameValue(activeSurface.customTitle || '');
  }, [surfaces, activeSurfaceIndex]);

  // Commit rename
  const commitRename = useCallback(() => {
    if (renamingId && activeWorkspaceId) {
      renameSurface(activeWorkspaceId, paneId, renamingId, renameValue.trim());
    }
    setRenamingId(null);
    setRenameValue('');
  }, [renamingId, activeWorkspaceId, paneId, renameValue, renameSurface]);

  // Cancel rename
  const cancelRename = useCallback(() => {
    setRenamingId(null);
    setRenameValue('');
  }, []);

  // Listen for keyboard shortcut rename event (only when focused)
  useEffect(() => {
    if (!isFocused) return;
    const handler = () => startRename();
    document.addEventListener('wmux:rename-surface', handler);
    return () => document.removeEventListener('wmux:rename-surface', handler);
  }, [isFocused, startRename]);

  // Auto-focus rename input
  useEffect(() => {
    if (renamingId) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingId]);

  // Toggle a portalled dropdown, anchoring it to the trigger caret button.
  const toggleMenu = useCallback((menu: 'new' | 'layout', ref: React.RefObject<HTMLButtonElement | null>) => {
    if (openMenu === menu) { setOpenMenu(null); return; }
    const rect = ref.current?.getBoundingClientRect();
    if (rect) {
      setMenuPos({ top: rect.bottom + 2, right: Math.max(4, window.innerWidth - rect.right) });
    }
    setOpenMenu(menu);
  }, [openMenu]);

  // Close any open dropdown on outside click, Escape, or viewport change.
  // Clicks inside the menu or on either caret are ignored (the caret's own
  // onClick handles toggling).
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t)) return;
      if (newCaretRef.current?.contains(t)) return;
      if (layoutCaretRef.current?.contains(t)) return;
      setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenMenu(null); };
    const onViewportChange = () => setOpenMenu(null);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [openMenu]);

  const pickNew = useCallback((type: 'terminal' | 'browser' | 'markdown') => {
    setOpenMenu(null);
    if (onNewTyped) onNewTyped(type);
    else onNew();
  }, [onNewTyped, onNew]);

  const pickProfile = useCallback((profile: QuickLaunchProfile) => {
    setOpenMenu(null);
    onNewProfile?.(profile);
  }, [onNewProfile]);

  const pickSplit = useCallback((dir: 'right' | 'down') => {
    setOpenMenu(null);
    if (dir === 'right') onSplitRight?.();
    else onSplitDown?.();
  }, [onSplitRight, onSplitDown]);

  // Always show tab bar (even for 1 surface — like browser tabs)
  return (
    <div
      className="surface-tab-bar"
      role="tablist"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(e) => {
        e.preventDefault();
        const savedInsertIndex = insertIndex;
        setInsertIndex(null);
        setDraggingSurfaceId(null);
        document.body.classList.remove('wmux-dragging');
        const data = e.dataTransfer.getData('application/wmux-surface');
        if (!data) return;
        try {
          const { sourcePaneId, surfaceId } = JSON.parse(data);
          if (sourcePaneId === paneId && onReorderSurface && savedInsertIndex !== null) {
            const currentIndex = surfaces.findIndex(s => s.id === surfaceId);
            const adjustedIndex = savedInsertIndex > currentIndex ? savedInsertIndex - 1 : savedInsertIndex;
            if (adjustedIndex !== currentIndex) {
              onReorderSurface(surfaceId as SurfaceId, adjustedIndex);
            }
          } else if (sourcePaneId !== paneId && onDropSurface) {
            onDropSurface(sourcePaneId as PaneId, surfaceId as SurfaceId, paneId);
          }
        } catch {}
      }}
      onDragLeave={() => setInsertIndex(null)}
    >
      <div className="surface-tab-bar__tabs">
        {surfaces.map((surface, index) => {
          const isActive = index === activeSurfaceIndex;
          const agentMeta = getAgentMeta(surface.id);
          const isAgent = !!agentMeta;
          const isRenaming = renamingId === surface.id;
          return (
            <div
              key={surface.id}
              className={[
                'surface-tab',
                isActive ? 'surface-tab--active' : '',
                draggingSurfaceId === surface.id ? 'surface-tab--dragging' : '',
                insertIndex === index ? 'surface-tab--insert-before' : '',
                insertIndex === index + 1 && index === surfaces.length - 1 ? 'surface-tab--insert-after' : '',
                isAgent ? 'surface-tab--agent' : '',
              ].filter(Boolean).join(' ')}
              role="tab"
              aria-selected={isActive}
              onClick={() => onSelect(index)}
              onDoubleClick={() => {
                setRenamingId(surface.id);
                setRenameValue(surface.customTitle || '');
              }}
              draggable={!isRenaming}
              onDragStart={(e) => {
                e.dataTransfer.setData(
                  'application/wmux-surface',
                  JSON.stringify({ sourcePaneId: paneId, surfaceId: surface.id })
                );
                e.dataTransfer.effectAllowed = 'move';
                setDraggingSurfaceId(surface.id);
                document.body.classList.add('wmux-dragging');
              }}
              onDragEnd={() => {
                setDraggingSurfaceId(null);
                setInsertIndex(null);
                document.body.classList.remove('wmux-dragging');
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                const midpoint = rect.left + rect.width / 2;
                const newInsertIndex = e.clientX < midpoint ? index : index + 1;
                setInsertIndex(newInsertIndex);
              }}
            >
              <span className="surface-tab__icon">{surfaceIcon(surface.type, isAgent)}</span>
              {isRenaming ? (
                <input
                  ref={renameInputRef}
                  className="surface-tab__rename-input"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { commitRename(); e.stopPropagation(); }
                    if (e.key === 'Escape') { cancelRename(); e.stopPropagation(); }
                    e.stopPropagation();
                  }}
                  onBlur={commitRename}
                  onClick={(e) => e.stopPropagation()}
                  placeholder={surfaceLabel(surface, agentMeta?.label, workspaceShell)}
                />
              ) : (
                <span className="surface-tab__label">{surfaceLabel(surface, agentMeta?.label, workspaceShell)}</span>
              )}
              {surfaces.length > 1 && !isRenaming && (
                <button
                  className="surface-tab__close"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(surface.id);
                  }}
                  tabIndex={-1}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="surface-tab-bar__cluster">
        {/* New (split-button): main click = default terminal, caret = type/profile menu */}
        <div className="surface-tab-bar__group">
          <button
            className="surface-tab-bar__ctl surface-tab-bar__ctl--new"
            onClick={onNew}
            tabIndex={-1}
            title="New terminal tab (Ctrl+T)"
          >
            <IconAdd />
          </button>
          {onNewTyped && (
            <button
              ref={newCaretRef}
              className="surface-tab-bar__ctl surface-tab-bar__caret"
              onClick={() => toggleMenu('new', newCaretRef)}
              tabIndex={-1}
              aria-haspopup="menu"
              aria-expanded={openMenu === 'new'}
              title="New tab type…"
            >
              <IconCaret />
            </button>
          )}
        </div>

        {/* Layout (split-button): main click = split right, caret = right/down menu */}
        {onSplitRight && (
          <div className="surface-tab-bar__group">
            <button
              className="surface-tab-bar__ctl surface-tab-bar__ctl--layout"
              onClick={onSplitRight}
              tabIndex={-1}
              title="Split right (Ctrl+D)"
            >
              <IconSplit />
            </button>
            <button
              ref={layoutCaretRef}
              className="surface-tab-bar__ctl surface-tab-bar__caret"
              onClick={() => toggleMenu('layout', layoutCaretRef)}
              tabIndex={-1}
              aria-haspopup="menu"
              aria-expanded={openMenu === 'layout'}
              title="Split layout…"
            >
              <IconCaret />
            </button>
          </div>
        )}

        {/* Close pane */}
        {onClosePane && (
          <button
            className="surface-tab-bar__ctl surface-tab-bar__ctl--close"
            onClick={onClosePane}
            tabIndex={-1}
            title="Close pane"
          >
            <IconClose />
          </button>
        )}
      </div>

      {openMenu && menuPos && createPortal(
        <div
          ref={menuRef}
          className="surface-tab-menu"
          role="menu"
          style={{ position: 'fixed', top: menuPos.top, right: menuPos.right }}
        >
          {openMenu === 'new' ? (
            <>
              <button role="menuitem" onClick={() => pickNew('terminal')}>
                <span className="surface-tab-menu__icon">{surfaceIcon('terminal', false)}</span> Terminal
              </button>
              <button role="menuitem" onClick={() => pickNew('browser')}>
                <span className="surface-tab-menu__icon">{surfaceIcon('browser', false)}</span> Browser
              </button>
              <button role="menuitem" onClick={() => pickNew('markdown')}>
                <span className="surface-tab-menu__icon">{surfaceIcon('markdown', false)}</span> Markdown
              </button>
              {profiles && profiles.length > 0 && (
                <>
                  <div className="surface-tab-menu__sep" role="separator" />
                  {profiles.map((profile) => (
                    <button
                      key={profile.id}
                      role="menuitem"
                      className="surface-tab-menu__profile"
                      onClick={() => pickProfile(profile)}
                      title={profile.source === 'project' ? 'Project profile (.wmux.json)' : 'Global profile'}
                    >
                      <span className="surface-tab-menu__icon">
                        {profile.icon || surfaceIcon(profile.type, false)}
                      </span>
                      <span className="surface-tab-menu__profile-name">{profile.name}</span>
                      {profile.source === 'project' && (
                        <span className="surface-tab-menu__badge">project</span>
                      )}
                    </button>
                  ))}
                </>
              )}
            </>
          ) : (
            <>
              <button role="menuitem" onClick={() => pickSplit('right')}>
                <span className="surface-tab-menu__icon"><IconSplit size={15} /></span>
                Split right
                <span className="surface-tab-menu__kbd">Ctrl+D</span>
              </button>
              {onSplitDown && (
                <button role="menuitem" onClick={() => pickSplit('down')}>
                  <span className="surface-tab-menu__icon"><IconSplitDown size={15} /></span>
                  Split down
                  <span className="surface-tab-menu__kbd">Ctrl+Shift+D</span>
                </button>
              )}
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
