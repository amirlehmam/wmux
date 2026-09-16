import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { IconCaret } from '../SplitPane/icons';

/**
 * Where the layout menu goes: ABOVE the split-button, growing upward, because
 * the button sits at the very bottom of the window and there is nothing below
 * it to open into. `bottom` pins the menu's lower edge just over the anchor, so
 * its height never has to be known to place it; `maxHeight` stops it at the top
 * of the window, and the list scrolls inside that.
 */
export function upwardMenuPosition(
  anchor: Pick<DOMRect, 'left' | 'top' | 'width'>,
  viewportHeight: number,
  gap = 4,
  margin = 8,
): { left: number; bottom: number; minWidth: number; maxHeight: number } {
  return {
    left: anchor.left,
    bottom: viewportHeight - anchor.top + gap,
    minWidth: anchor.width,
    maxHeight: Math.max(0, anchor.top - gap - margin),
  };
}

interface NewWorkspaceButtonProps {
  /** `+`: a workspace from the default layout, exactly as before. */
  onCreate: () => void;
  onCreateFromLayout: (layoutId: string) => void;
  onManageLayouts: () => void;
}

/**
 * The sidebar `+` as a split-button: `+` still creates from the default, the
 * caret lists every saved layout. Same shape and close rules as the tab bar's
 * split-buttons (SurfaceTabBar), so it behaves the way users already know.
 */
export default function NewWorkspaceButton({ onCreate, onCreateFromLayout, onManageLayouts }: NewWorkspaceButtonProps) {
  const t = useT();
  // Read from the store rather than passed in, so a layout renamed or deleted in
  // Settings while the menu is open shows up in it immediately.
  const savedLayouts = useStore((s) => s.savedLayouts);
  const saveCurrentLayoutAsPreset = useStore((s) => s.saveCurrentLayoutAsPreset);

  const [pos, setPos] = useState<ReturnType<typeof upwardMenuPosition> | null>(null);
  const open = pos !== null;
  const groupRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setPos(null), []);

  const toggle = useCallback(() => {
    if (open) { setPos(null); return; }
    // Anchored on the whole group, not the caret, so the menu lines up with `+ │ ▴`.
    const rect = groupRef.current?.getBoundingClientRect();
    if (rect) setPos(upwardMenuPosition(rect, window.innerHeight));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      // The caret's own onClick toggles; closing here too would reopen it.
      if (caretRef.current?.contains(target)) return;
      setPos(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPos(null); };
    const onResize = () => setPos(null);
    // Unlike the tab bar's menus, this one can scroll itself (a long list
    // capped at the window height), and that scroll must not close it.
    const onScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setPos(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  const pickLayout = (layoutId: string) => {
    close();
    onCreateFromLayout(layoutId);
  };

  const saveCurrent = () => {
    close();
    const id = saveCurrentLayoutAsPreset(
      t('settings.workspacePanel.newLayoutName', 'Layout {n}').replace('{n}', String(savedLayouts.length + 1)),
    );
    // Same as the palette command: a silent no-op would look like it worked.
    if (!id) {
      (window as any).wmux?.notification?.fire({
        surfaceId: '',
        text: t('palette.saveCurrentLayoutFailed', 'No active workspace to save as a layout.'),
        title: 'wmux',
      });
    }
  };

  const manage = () => {
    close();
    onManageLayouts();
  };

  return (
    <div ref={groupRef} className="sidebar__new-group">
      <button className="sidebar__new-btn" onClick={onCreate} title={t('sidebar.newWorkspace', 'New workspace')}>
        +
      </button>
      <button
        ref={caretRef}
        className={`sidebar__new-caret${open ? '' : ' sidebar__new-caret--closed'}`}
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('sidebar.newWorkspaceFromLayout', 'New workspace from layout…')}
      >
        <IconCaret />
      </button>

      {pos && createPortal(
        <div
          ref={menuRef}
          className="surface-tab-menu surface-tab-menu--up"
          role="menu"
          style={{ position: 'fixed', left: pos.left, bottom: pos.bottom, minWidth: pos.minWidth, maxHeight: pos.maxHeight }}
        >
          {savedLayouts.length > 0 ? (
            savedLayouts.map((layout) => (
              <button key={layout.id} role="menuitem" onClick={() => pickLayout(layout.id)}>
                <span className="surface-tab-menu__profile-name">
                  {layout.name.trim() || t('sidebar.layoutMenu.untitled', 'Untitled layout')}
                </span>
              </button>
            ))
          ) : (
            <div className="surface-tab-menu__hint">{t('sidebar.layoutMenu.empty', 'No saved layouts yet')}</div>
          )}
          <div className="surface-tab-menu__sep" role="separator" />
          <button role="menuitem" onClick={saveCurrent}>
            {t('palette.saveCurrentLayout', 'Save current layout as new preset')}
          </button>
          <button role="menuitem" onClick={manage}>
            {t('sidebar.layoutMenu.manage', 'Manage layouts…')}
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
