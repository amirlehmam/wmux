import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Issue #137: after an update that changes the artwork, the taskbar button, the
 * pinned shortcut and the Start-menu entry keep drawing the icon of the version
 * they replaced, because Windows caches shell icons per path and wmux installs
 * to the same path every time.
 *
 * ## Why this test exists
 *
 * #137 was closed, and the fix stopped working without anyone noticing. It ran
 * `ie4uinit.exe -show` and `-ClearIconCache` from `customInstall`, which cannot
 * work: iconcache_*.db is memory-mapped by the running explorer.exe and only
 * flushed on shutdown, so no external process can invalidate it. Measured on a
 * machine that had just taken 1.5.1 — the installer ran both spellings at 11:57
 * and at 12:00 every cache file still carried the previous day's timestamp.
 *
 * That is the same failure shape as the install-scope fix next door: still valid
 * NSIS, still compiling, connected to nothing, silent for releases. So the guard
 * is the same — assert the mechanism is present and still reachable.
 *
 * What this does NOT claim: that the icon is definitely refreshed. A pinned
 * taskbar button's bitmap lives in the taskband store keyed on the
 * AppUserModelId, and only an Explorer restart or an unpin/repin clears it.
 * SHChangeNotify covers Explorer, the desktop and the Start menu; the pinned
 * case is left to heal at the next sign-out.
 */
describe('installer refreshes shell icons after an artwork change (issue #137)', () => {
  const repoRoot = path.join(__dirname, '../..');
  const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

  const installerNsh = read('build/installer.nsh');
  const installSection = read('node_modules/app-builder-lib/templates/nsis/installSection.nsh');

  describe('wmux side', () => {
    it('defines customInstall', () => {
      expect(installerNsh).toMatch(/!macro\s+customInstall\b/);
    });

    it('notifies the shell via SHChangeNotify rather than relying on ie4uinit alone', () => {
      expect(installerNsh).toMatch(/System::Call\s+'shell32::SHChangeNotify/);
    });

    it('passes SHCNE_ASSOCCHANGED (0x08000000) as the event id', () => {
      // The whole point of the call. A different event id notifies the shell
      // about something that is not "icons may have changed", and the refresh
      // silently stops happening again.
      expect(installerNsh).toMatch(/SHChangeNotify\(i\s+0x08000000\s*,/i);
    });

    it('keeps the notification inside customInstall, not stranded elsewhere', () => {
      const macro = /!macro\s+customInstall\b([\s\S]*?)!macroend/.exec(installerNsh);
      expect(macro).not.toBeNull();
      expect(macro![1]).toMatch(/SHChangeNotify/);
    });
  });

  describe('electron-builder side', () => {
    it('still inserts customInstall from installSection.nsh', () => {
      // If a template rename drops this, the macro above is dead code and the
      // icon goes stale again with nothing failing.
      expect(installSection).toMatch(/!ifmacrodef\s+customInstall\b/);
      expect(installSection).toMatch(/!insertmacro\s+customInstall\b/);
    });
  });
});
