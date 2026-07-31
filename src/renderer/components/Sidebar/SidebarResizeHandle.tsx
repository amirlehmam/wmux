import React, { useCallback } from 'react';
import { createResizeDrag } from './resize-drag';

interface SidebarResizeHandleProps {
  onWidthChange: (delta: number) => void;
}

export default function SidebarResizeHandle({ onWidthChange }: SidebarResizeHandleProps) {
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      // Coalesced to one width update per frame — see resize-drag.ts for why a
      // raw mousemove handler is expensive here.
      const drag = createResizeDrag(e.clientX, onWidthChange);

      const onMouseMove = (ev: MouseEvent) => drag.move(ev.clientX);

      const onMouseUp = () => {
        drag.stop();
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    },
    [onWidthChange],
  );

  return (
    <div
      className="sidebar-resize-handle"
      onMouseDown={handleMouseDown}
    />
  );
}
