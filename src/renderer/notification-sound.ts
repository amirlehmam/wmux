import { useStore } from './store';
import notificationSoundUrl from './assets/notification.wav';
import chimeUrl from './assets/sounds/chime.wav';
import pingUrl from './assets/sounds/ping.wav';
import marimbaUrl from './assets/sounds/marimba.wav';
import popUrl from './assets/sounds/pop.wav';
import type { TranslationKey } from './i18n/core';

// Built-in notification sounds (issue #39). 'default' is the original chime;
// the rest are short synthesized CC0 tones. Custom files are resolved separately.
export const NOTIFICATION_SOUNDS: Record<string, string> = {
  default: notificationSoundUrl,
  chime: chimeUrl,
  ping: pingUrl,
  marimba: marimbaUrl,
  pop: popUrl,
};

export const NOTIFICATION_SOUND_LABELS: Array<{ value: string; labelKey: TranslationKey; fallback: string }> = [
  { value: 'default', labelKey: 'notificationSound.default', fallback: 'Default' },
  { value: 'chime', labelKey: 'notificationSound.chime', fallback: 'Chime' },
  { value: 'ping', labelKey: 'notificationSound.ping', fallback: 'Ping' },
  { value: 'marimba', labelKey: 'notificationSound.marimba', fallback: 'Marimba' },
  { value: 'pop', labelKey: 'notificationSound.pop', fallback: 'Pop' },
  { value: 'custom', labelKey: 'notificationSound.custom', fallback: 'Custom file' },
  { value: 'none', labelKey: 'notificationSound.none', fallback: 'None' },
];

// One reusable <audio> element per sound. Re-seeking to 0 lets rapid back-to-back
// notifications retrigger the chime without allocating a new decoder each time.
const audioEls = new Map<string, HTMLAudioElement>();
let customSoundUrl: string | null = null;
let customSoundRevision = 0;

function getAudio(name: string): HTMLAudioElement | null {
  const url = name === 'custom' ? customSoundUrl : NOTIFICATION_SOUNDS[name];
  if (!url) return null;
  let el = audioEls.get(name);
  if (!el) {
    el = new Audio(url);
    el.volume = 0.45;
    audioEls.set(name, el);
  }
  return el;
}

export function setCustomNotificationSound(url: string | null): void {
  customSoundRevision += 1;
  audioEls.get('custom')?.pause();
  audioEls.delete('custom');
  customSoundUrl = url;
}

/** Play a specific sound by name regardless of the user's saved preference
 *  (used by the settings preview button). No-op for 'none'/unknown. */
export function previewNotificationSound(name: string): void {
  if (name === 'none') return;
  try {
    const el = getAudio(name);
    if (!el) return;
    el.currentTime = 0;
    el.play().catch(() => {});
  } catch {
    // Decode/playback failure is non-fatal.
  }
}

/**
 * Play the user's chosen notification chime, unless `notificationPrefs.sound`
 * is 'none'. Fixes issue #32 (the Sound setting was never wired to playback)
 * and issue #39 (multiple selectable sounds).
 */
export function playNotificationSound(): void {
  const sound = useStore.getState().notificationPrefs.sound;
  if (sound === 'none') return;
  previewNotificationSound(sound);
}

/**
 * Subscribe to the main process' `notification:play-sound` signal, fired once
 * for every notification (toast/flash/ring) so the chime stays in sync with
 * them. Called once at renderer startup.
 */
export function initNotificationSound(): void {
  const prefs = useStore.getState().notificationPrefs;
  if (prefs.customSoundExtension) {
    const request = window.wmux?.notification?.getCustomSoundDataUrl?.(prefs.customSoundExtension);
    if (request) {
      const revision = customSoundRevision;
      void request.then((url: string | null) => {
        if (revision === customSoundRevision) setCustomNotificationSound(url);
      }).catch(() => {
        if (revision === customSoundRevision) setCustomNotificationSound(null);
      });
    }
  }
  window.wmux?.notification?.onPlaySound?.(playNotificationSound);
}
