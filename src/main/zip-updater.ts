import { app, net } from 'electron';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fetchLatestRelease, compareVersions, type GithubReleaseAsset } from './update-checker';

// ── Portable zip in-place update ────────────────────────────────────────────
// wmux's README install is "extract the win-x64 zip anywhere and run
// wmux.exe". That layout has no NSIS uninstaller, so electron-updater's
// NsisUpdater cannot replace it: a zip listed in latest.yml downloads and
// then quitAndInstall() no-ops (issue #96, endless "update ready" loop),
// and a setup.exe listed there would install a *second* copy under
// %LOCALAPPDATA% while leaving the zip extract untouched.
//
// This path is the in-app equivalent of a user downloading the zip, killing
// wmux, and copying over the folder. It is user-initiated only — there is
// no unattended download. The titlebar badge / Help button click is the
// consent; the same confirmation dialog as the NSIS path still fires
// before the swap.
//
// Apply cannot overwrite a running wmux.exe, so after the zip is extracted
// we write a tiny cmd helper, detach it, and quit. The helper waits for
// this PID to exit, robocopies the payload over the install root, strips
// Mark of the Web, and relaunches.
//
// No extra runtime downloads (no curl, no npm unzip, no Invoke-WebRequest):
//   download — Electron net.request (Chromium). Always present in a packaged build.
//   extract  — %SystemRoot%\System32\tar.exe (Windows 10 1803+, which Electron 43
//              already requires), then Windows PowerShell Expand-Archive.
//   apply    — cmd.exe + robocopy/tasklist/timeout/findstr, all via System32.
//   MOTW     — Unblock-File is best-effort; a missing PowerShell does not block relaunch.

const UNINSTALLER_NAME = 'Uninstall wmux.exe';

export function isPortableZipInstall(installRoot: string): boolean {
  if (!installRoot) return false;
  let root: string;
  try {
    root = path.resolve(installRoot);
  } catch {
    return false;
  }
  if (!fs.existsSync(root)) return false;
  try {
    if (!fs.statSync(root).isDirectory()) return false;
  } catch {
    return false;
  }
  if (!fs.existsSync(path.join(root, 'wmux.exe'))) return false;
  return !fs.existsSync(path.join(root, UNINSTALLER_NAME));
}

export function pickZipAsset(assets: GithubReleaseAsset[] | undefined | null): GithubReleaseAsset | null {
  if (!assets || assets.length === 0) return null;
  const zips = assets.filter((a) => typeof a?.name === 'string' && /\.zip$/i.test(a.name));
  const winX64 = zips.filter((a) => /win-x64/i.test(a.name));
  if (winX64.length > 0) return winX64[0];
  // Never fall back to a source-looking archive (no "win" marker at all).
  const winish = zips.filter((a) => /win/i.test(a.name) && !/arm/i.test(a.name));
  return winish[0] ?? null;
}

export function findPayloadRoot(extractDir: string): string {
  const direct = path.join(extractDir, 'wmux.exe');
  if (fs.existsSync(direct)) return extractDir;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(extractDir, { withFileTypes: true });
  } catch {
    throw new Error('extracted update is empty or unreadable');
  }
  const dirs = entries.filter((e) => e.isDirectory());
  for (const dir of dirs) {
    const candidate = path.join(extractDir, dir.name, 'wmux.exe');
    if (fs.existsSync(candidate)) return path.join(extractDir, dir.name);
  }
  throw new Error('zip does not contain wmux.exe');
}

export interface StagedZipUpdate {
  version: string;
  extractDir: string;
  installDir: string;
  exePath: string;
}

export function buildApplyUpdateCmd(): string {
  // Arguments: %1 = pid to wait for, %2 = payload dir, %3 = install dir, %4 = exe to relaunch.
  // Keep this free of caller-supplied paths so a hostile extract cannot
  // rewrite the helper; everything variable arrives as arguments.
  return [
    '@echo off',
    'setlocal EnableExtensions',
    'set "SYS=%SystemRoot%\\System32"',
    'set "PID=%~1"',
    'set "SRC=%~2"',
    'set "DST=%~3"',
    'set "EXE=%~4"',
    'if not defined PID exit /b 1',
    'if not exist "%SRC%\\wmux.exe" exit /b 1',
    ':wait',
    '"%SYS%\\timeout.exe" /t 1 /nobreak >nul',
    '"%SYS%\\tasklist.exe" /FI "PID eq %PID%" 2>nul | "%SYS%\\findstr.exe" /I /C:" %PID% " >nul',
    'if not errorlevel 1 goto wait',
    '"%SYS%\\timeout.exe" /t 2 /nobreak >nul',
    '"%SYS%\\robocopy.exe" "%SRC%" "%DST%" /E /IS /IT /R:5 /W:1 /NFL /NDL /NJH /NJS /NC /NS',
    'if %ERRORLEVEL% GEQ 8 goto relaunch',
    // MOTW strip is best-effort: a constrained PowerShell must not block relaunch.
    'if exist "%SYS%\\WindowsPowerShell\\v1.0\\powershell.exe" "%SYS%\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -Command "Get-ChildItem -LiteralPath $env:DST -Recurse -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue" >nul 2>&1',
    // The relaunch is unconditional, including after a failed copy. wmux has
    // already quit by the time this runs, so bailing out here is the one
    // outcome the user cannot recover from without finding wmux.exe by hand.
    // A robocopy failure (install root not writable, a leftover child still
    // holding a DLL past /R:5) usually leaves the old build in place, so
    // %EXE% still starts — on the old version, which beats not starting.
    ':relaunch',
    'start "" "%EXE%"',
    'rmdir /s /q "%SRC%"',
    'del "%~f0"',
  ].join('\r\n');
}

function system32(name: string): string {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name);
}

function runHidden(file: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(file)} timed out`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim();
      const suffix = detail ? `: ${detail}` : '';
      reject(new Error(`${path.basename(file)} exited ${code}${suffix}`));
    });
  });
}

export async function extractZip(zipPath: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  const tar = system32('tar.exe');
  if (fs.existsSync(tar)) {
    try {
      await runHidden(tar, ['-xf', zipPath, '-C', destDir], 10 * 60 * 1000);
      return;
    } catch (err) {
      console.warn('[updater] tar extract failed, falling back to Expand-Archive:', err);
    }
  }
  const ps = system32('WindowsPowerShell\\v1.0\\powershell.exe');
  if (!fs.existsSync(ps)) {
    throw new Error('could not extract update (tar.exe failed and Windows PowerShell is missing)');
  }
  await runHidden(ps, [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
  ], 15 * 60 * 1000);
}

/** fs.unlink needs a callback; a partial download that will not delete is not actionable. */
function discardPartial(dest: string): void {
  fs.unlink(dest, () => undefined);
}

/**
 * Integrity gate for a finished download. Returns the rejection reason, or
 * null when the payload matches what the GitHub API advertised. Kept out of
 * the stream callbacks so the nesting there stays readable.
 */
function verifyDownload(
  downloaded: number,
  hash: crypto.Hash,
  opts: { expectedSize?: number; expectedSha256?: string },
): Error | null {
  if (opts.expectedSize && opts.expectedSize > 0 && downloaded !== opts.expectedSize) {
    return new Error(`download size mismatch: got ${downloaded}, expected ${opts.expectedSize}`);
  }
  if (opts.expectedSha256) {
    const got = hash.digest('hex');
    if (got.toLowerCase() !== opts.expectedSha256.toLowerCase()) {
      return new Error('download sha256 mismatch');
    }
  }
  return null;
}

export async function downloadToFile(
  url: string,
  dest: string,
  opts: { expectedSize?: number; expectedSha256?: string; onProgress?: (percent: number) => void } = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = net.request({ method: 'GET', url, redirect: 'follow' });
    req.setHeader('User-Agent', `wmux/${app.getVersion()}`);
    req.setHeader('Accept', 'application/octet-stream');
    req.on('response', (res) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        res.on('data', () => {});
        res.on('end', () => reject(new Error(`download failed: HTTP ${status}`)));
        return;
      }
      const headerLen = Number(res.headers['content-length'] || 0);
      const total = headerLen > 0 ? headerLen : (opts.expectedSize ?? 0);
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(dest);
      let downloaded = 0;
      let lastPct = -1;
      const fail = (err: Error) => {
        out.destroy();
        discardPartial(dest);
        reject(err);
      };
      const finish = () => {
        const err = verifyDownload(downloaded, hash, opts);
        if (err) {
          discardPartial(dest);
          reject(err);
          return;
        }
        resolve();
      };
      res.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        downloaded += chunk.length;
        out.write(chunk);
        if (total > 0 && opts.onProgress) {
          const pct = Math.min(100, Math.round((downloaded * 100) / total));
          if (pct !== lastPct) {
            lastPct = pct;
            opts.onProgress(pct);
          }
        }
      });
      res.on('end', () => out.end(finish));
      res.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
      out.on('error', (err) => fail(err));
    });
    req.on('error', reject);
    req.end();
  });
}

function sha256FromDigest(digest: string | undefined): string | undefined {
  if (!digest) return undefined;
  const m = /^sha256:([a-fA-F0-9]{64})$/.exec(digest.trim());
  return m ? m[1] : undefined;
}

export interface PortableZipTarget {
  version: string;
  asset: GithubReleaseAsset;
}

export async function resolvePortableZipTarget(): Promise<PortableZipTarget> {
  const release = await fetchLatestRelease();
  if (!release || release.draft || release.prerelease) {
    throw Object.assign(new Error('no_update'), { code: 'NO_UPDATE' });
  }
  const version = (release.tag_name || '').replace(/^v/, '');
  if (!version || compareVersions(version, app.getVersion()) <= 0) {
    throw Object.assign(new Error('no_update'), { code: 'NO_UPDATE' });
  }
  const asset = pickZipAsset(release.assets);
  if (!asset?.browser_download_url) {
    throw Object.assign(new Error('no zip asset in latest release'), { code: 'NO_ZIP_ASSET' });
  }
  return { version, asset };
}

export async function runPortableZipUpdate(opts: {
  target: PortableZipTarget;
  onProgress: (percent: number) => void;
}): Promise<StagedZipUpdate> {
  const exePath = app.getPath('exe');
  const installDir = path.dirname(exePath);
  if (!isPortableZipInstall(installDir)) {
    throw new Error('not a portable zip install');
  }

  const { version, asset } = opts.target;
  const stamp = `wmux-update-${version}-${process.pid}`;
  const zipPath = path.join(os.tmpdir(), `${stamp}.zip`);
  const extractDir = path.join(os.tmpdir(), stamp);
  if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    await downloadToFile(asset.browser_download_url, zipPath, {
      expectedSize: asset.size > 0 ? asset.size : undefined,
      expectedSha256: sha256FromDigest(asset.digest),
      onProgress: opts.onProgress,
    });
    await extractZip(zipPath, extractDir);
    const payload = findPayloadRoot(extractDir);
    fs.unlink(zipPath, () => {});
    return { version, extractDir: payload, installDir, exePath };
  } catch (err) {
    fs.rm(extractDir, { recursive: true, force: true }, () => {});
    fs.unlink(zipPath, () => {});
    throw err;
  }
}

export function applyStagedPortableUpdate(staged: StagedZipUpdate): void {
  const helper = path.join(os.tmpdir(), `wmux-apply-update-${process.pid}.cmd`);
  fs.writeFileSync(helper, buildApplyUpdateCmd(), 'utf8');
  const cmd = process.env.ComSpec || system32('cmd.exe');
  const child = spawn(cmd, [
    '/d', '/c', helper,
    String(process.pid),
    staged.extractDir,
    staged.installDir,
    staged.exePath,
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  app.quit();
}
