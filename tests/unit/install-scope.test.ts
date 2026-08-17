import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Issue #167 (and the second half of #158): an update must land in the
 * installation it replaces.
 *
 * ## Why this needs a test at all
 *
 * The fix is six lines of NSIS in `build/installer.nsh`, and nothing in the
 * repo executes it. It is compiled by electron-builder in CI and only observable
 * by running a real installer over a real prior install — which is exactly the
 * kind of verification that does not happen on a patch release. So the failure
 * mode is not "the fix breaks", it is "the fix quietly stops being connected to
 * anything" and nobody notices for six versions.
 *
 * It hangs off three facts in electron-builder's own NSIS templates, none of
 * which wmux controls and all of which move on a dependency bump:
 *
 *   1. `initMultiUser` populates $hasPerMachineInstallation /
 *      $hasPerUserInstallation from the registry, in .onInit, before any page.
 *   2. `multiUserUi.nsh` zeroes the two force flags and then inserts
 *      `customInstallMode` — the seam the fix plugs into.
 *   3. Setting either flag makes the install-mode page Abort.
 *
 * If a template rename breaks any of them, the macro is still valid NSIS, still
 * compiles, and does nothing. These assertions turn that into a failing build.
 *
 * `npm test` gates the tag (see .github/workflows/release.yml), so this runs
 * before anything ships.
 */
describe('NSIS install scope is pinned on update (issue #167)', () => {
  const repoRoot = path.join(__dirname, '../..');
  const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

  const templates = 'node_modules/app-builder-lib/templates/nsis';
  const installerNsh = read('build/installer.nsh');
  const multiUserUi = read(`${templates}/multiUserUi.nsh`);
  const assistedInstaller = read(`${templates}/assistedInstaller.nsh`);

  describe('wmux side', () => {
    it('defines customInstallMode', () => {
      expect(installerNsh).toMatch(/!macro\s+customInstallMode/);
    });

    it('forces machine scope when only a per-machine install exists', () => {
      expect(installerNsh).toMatch(/StrCpy\s+\$isForceMachineInstall\s+"1"/);
    });

    it('forces user scope when only a per-user install exists', () => {
      expect(installerNsh).toMatch(/StrCpy\s+\$isForceCurrentInstall\s+"1"/);
    });

    it('reads both presence flags, so neither branch can fire on a first install', () => {
      // The narrowness IS the fix: with neither installation present, or with
      // both, the page must still be shown rather than guessed at.
      expect(installerNsh).toContain('$hasPerMachineInstallation');
      expect(installerNsh).toContain('$hasPerUserInstallation');
    });

    it('does not define the macro for the uninstaller', () => {
      // The uninstaller has its own single-installation skip in the same
      // function, and populates the variables on a different path.
      expect(installerNsh).toMatch(/!ifndef\s+BUILD_UNINSTALLER/);
    });

    it('is still wired into the build', () => {
      const config = JSON.parse(read('electron-builder.json'));
      expect(config.nsis.include).toBe('build/installer.nsh');
      // A one-click installer has no install-mode page, so the macro would be
      // dead code rather than a fix.
      expect(config.nsis.oneClick).toBe(false);
    });
  });

  describe('the electron-builder seam it plugs into', () => {
    it('still inserts customInstallMode from the install-mode page function', () => {
      expect(multiUserUi).toMatch(/!insertmacro\s+customInstallMode/);
    });

    it('still zeroes the force flags immediately before inserting it', () => {
      // Order matters: if the reset moved after the insertion, the macro's
      // writes would be thrown away on every run.
      const reset = multiUserUi.indexOf('StrCpy $isForceCurrentInstall "0"');
      const insert = multiUserUi.search(/!insertmacro\s+customInstallMode/);
      expect(reset).toBeGreaterThan(-1);
      expect(insert).toBeGreaterThan(reset);
    });

    it('still aborts the page when either flag is set', () => {
      // The Abort is what actually skips the page. Without it the macro would
      // pick a default and still let the user override it — the current bug.
      // Bounded to the region between the insertion point and the
      // uninstaller-only branch that follows it. `BUILD_UNINSTALLER` also
      // appears near the top of the file, so the end anchor has to be searched
      // forward from the insertion — not from 0.
      const insert = multiUserUi.search(/!insertmacro\s+customInstallMode/);
      const forceBlock = multiUserUi.slice(insert, multiUserUi.indexOf('BUILD_UNINSTALLER', insert));
      expect(forceBlock).not.toBe('');
      expect(forceBlock).toContain('$isForceMachineInstall == "1"');
      expect(forceBlock).toContain('$isForceCurrentInstall == "1"');
      expect(forceBlock).toContain('Abort');
    });

    it('still resolves the existing scope from the registry before any page runs', () => {
      // Fact 1: the answer the page was overwriting.
      expect(assistedInstaller).toMatch(
        /ReadRegStr\s+\$perMachineInstallationFolder\s+HKLM\s+"\$\{INSTALL_REGISTRY_KEY\}"\s+InstallLocation/,
      );
      expect(assistedInstaller).toMatch(
        /ReadRegStr\s+\$perUserInstallationFolder\s+HKCU\s+"\$\{INSTALL_REGISTRY_KEY\}"\s+InstallLocation/,
      );
    });

    it('still folds /allusers and /currentuser into the same two variables', () => {
      // The documented escape hatch for a deliberate scope change has to keep
      // working, or pinning the scope would strand anyone who wants to move.
      expect(assistedInstaller).toContain('"/allusers"');
      expect(assistedInstaller).toContain('"/currentuser"');
    });

    it('still leaves the install-mode page unguarded by skipPageIfUpdated', () => {
      // The asymmetry this fix works around. If electron-builder ever guards
      // the page itself, this macro becomes redundant and should be removed
      // rather than left to rot — that is what this assertion is for.
      const modePage = assistedInstaller.search(/!insertmacro\s+PAGE_INSTALL_MODE/);
      const dirPage = assistedInstaller.search(/!insertmacro\s+MUI_PAGE_DIRECTORY/);
      const between = assistedInstaller.slice(0, modePage);
      expect(modePage).toBeGreaterThan(-1);
      expect(dirPage).toBeGreaterThan(modePage);
      // No skipPageIfUpdated attached to the mode page (the one before the
      // directory page belongs to the license page).
      const lastGuardBeforeMode = between.lastIndexOf('skipPageIfUpdated');
      const licensePage = between.search(/!insertmacro\s+licensePage/);
      expect(lastGuardBeforeMode).toBeLessThan(licensePage);
    });
  });
});
