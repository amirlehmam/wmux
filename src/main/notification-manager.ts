import { Notification, BrowserWindow } from 'electron';

export class NotificationManager {
  showToast(title: string, body: string, onClick?: () => void): void {
    const notif = new Notification({ title, body });
    if (onClick) notif.on('click', onClick);
    notif.show();
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
