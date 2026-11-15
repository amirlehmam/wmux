import { Notification, BrowserWindow } from 'electron';

export class NotificationManager {
  // Native toasts can outlive their JS wrappers, taking click listeners with them.
  private readonly activeToasts = new Set<Notification>();

  showToast(title: string, body: string, onClick?: () => void): void {
    const notif = new Notification({ title, body });
    this.activeToasts.add(notif);
    const release = (): void => { this.activeToasts.delete(notif); };
    notif.once('click', () => {
      release();
      onClick?.();
    });
    notif.once('close', release);
    notif.once('failed', release);
    try {
      notif.show();
    } catch (error) {
      release();
      throw error;
    }
  }

  flashTaskbar(window: BrowserWindow): void {
    if (!window.isFocused()) {
      window.flashFrame(true);
    }
  }

  stopFlash(window: BrowserWindow): void {
    window.flashFrame(false);
  }
}
