import React, { useEffect, useRef, useState } from 'react';
import { PaneId, SplitNode, SurfaceId } from '../../../shared/types';
import TerminalPane from '../Terminal/TerminalPane';
import NotificationRing from '../Terminal/NotificationRing';
import { useStore } from '../../store';
import '../../styles/splitpane.css';
import '../../styles/terminal.css';

interface PaneWrapperProps {
  paneId: PaneId;
  leaf: SplitNode & { type: 'leaf' };
  isFocused: boolean;
}

export default function PaneWrapper({ leaf, isFocused }: PaneWrapperProps) {
  const activeSurface = leaf.surfaces[leaf.activeSurfaceIndex];

  const notifications = useStore((s) => s.notifications);
  const markRead = useStore((s) => s.markRead);

  const surfaceIds = leaf.surfaces.map((s) => s.id);

  const hasUnread = notifications.some(
    (n) => !n.read && surfaceIds.includes(n.surfaceId as SurfaceId),
  );

  // Track "just fired" state for flash animation
  const [justFired, setJustFired] = useState(false);
  const prevUnreadCount = useRef(
    notifications.filter((n) => !n.read && surfaceIds.includes(n.surfaceId as SurfaceId)).length,
  );

  useEffect(() => {
    const currentCount = notifications.filter(
      (n) => !n.read && surfaceIds.includes(n.surfaceId as SurfaceId),
    ).length;

    if (currentCount > prevUnreadCount.current) {
      setJustFired(true);
      const timer = setTimeout(() => setJustFired(false), 950);
      prevUnreadCount.current = currentCount;
      return () => clearTimeout(timer);
    }

    prevUnreadCount.current = currentCount;
  }, [notifications, surfaceIds]);

  // When pane receives focus, mark all surfaces as read
  useEffect(() => {
    if (isFocused && hasUnread) {
      for (const surfaceId of surfaceIds) {
        markRead(surfaceId as SurfaceId);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused]);

  const renderSurface = () => {
    if (!activeSurface) return null;
    switch (activeSurface.type) {
      case 'terminal':
        return <TerminalPane focused={isFocused} />;
      // browser and markdown surfaces are handled in later tasks
      default:
        return null;
    }
  };

  return (
    <div className="pane-wrapper">
      {renderSurface()}
      <NotificationRing visible={hasUnread} flashing={justFired} />
      <div
        className="pane-wrapper__unfocused-overlay"
        style={{ opacity: isFocused ? 0 : 1 }}
      />
    </div>
  );
}
