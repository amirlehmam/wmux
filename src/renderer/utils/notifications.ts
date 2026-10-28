import type { SurfaceId, WorkspaceId } from '../../shared/types';
import type { NotificationSlice } from '../store/notification-slice';

/** Keep history and attention effects consistent with the focus at arrival. */
export function fireNotification(
  surfaceId: string,
  workspaceId: WorkspaceId | null,
  text: string,
  addNotification: NotificationSlice['addNotification'],
  title = 'wmux',
): void {
  // Pipe and hook events are broadcast; only the surface's owning window alerts.
  if (surfaceId && !workspaceId) return;
  if (workspaceId) {
    const notification = addNotification({ surfaceId: (surfaceId || '') as SurfaceId, workspaceId, text });
    if (notification.read) return;
  }
  window.wmux?.notification?.fire({ surfaceId: surfaceId || '', text, title });
}
