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
// this PID to exit, robocopies the payload over the install root, and
// relaunches.
//
// That helper is VISIBLE, and it says what it is. `detached: true` implies
// DETACHED_PROCESS, and Windows ignores CREATE_NO_WINDOW next to it, so the
// `windowsHide: true` on the spawn below buys nothing: cmd.exe allocates a
// console of its own (measured — a detached spawn adds a conhost.exe, an
// otherwise identical non-detached one does not). A user reported the result
// as an empty console titled `findstr.exe /I /C:" <pid> "`, with no way to
// tell whether it wanted input or wanted closing. Hiding it is the wrong fix
// twice over: dropping `detached` risks the helper dying with wmux, which is
// the one failure the user cannot recover from (wmux has already quit), and a
// hidden detached script that overwrites an unsigned exe and relaunches it is
// the dropper shape #3 is about. So the window states its purpose instead.
//
// The helper does NOT strip Mark of the Web, and that step must not be
// reintroduced (#3).
// There is nothing to strip: net.request + createWriteStream write no
// :Zone.Identifier stream, so neither the zip nor its extracted payload has
// one, and executables under the install dir are already unblocked in-process
// by stripMotw() in index.ts on every launch. A hidden PowerShell recursively
// running Unblock-File is, on the other hand, a MOTW-bypass pattern (MITRE
// T1553.005) and the strongest behavioural-AV signal the helper used to emit.
//
// No extra runtime downloads (no curl, no npm unzip, no Invoke-WebRequest):
//   download — Electron net.request (Chromium). Always present in a packaged build.
//   extract  — %SystemRoot%\System32\tar.exe (Windows 10 1803+, which Electron 43
//              already requires), then Windows PowerShell Expand-Archive.
//   apply    — cmd.exe + robocopy/tasklist/waitfor/findstr, all via System32.

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

// ── Update leftovers in %TEMP% (#3) ─────────────────────────────────────────
// Every name the update flow creates in os.tmpdir() is built here, and the
// sweep parses names with the inverse of these same builders, so what is
// created and what may be removed cannot drift apart. All three names carry
// the PID of the wmux that downloaded and applied the update.

export function updateStampName(version: string, pid: number): string {
  return `wmux-update-${version}-${pid}`;
}

export function updateZipName(version: string, pid: number): string {
  return `${updateStampName(version, pid)}.zip`;
}

export function updateHelperName(pid: number): string {
  return `wmux-apply-update-${pid}.cmd`;
}

export type UpdateLeftoverKind = 'helper' | 'extract-dir' | 'zip';

const LEFTOVER_PATTERNS: ReadonlyArray<{ kind: UpdateLeftoverKind; re: RegExp }> = [
  { kind: 'helper', re: /^wmux-apply-update-(\d+)\.cmd$/ },
  { kind: 'zip', re: /^wmux-update-[0-9A-Za-z.+-]+-(\d+)\.zip$/ },
  { kind: 'extract-dir', re: /^wmux-update-[0-9A-Za-z.+-]+-(\d+)$/ },
];

const MAX_PID = 0xffffffff;

/**
 * Which update leftover a %TEMP% entry name is, and the PID it carries — or
 * null for anything else. Anchored and case-sensitive. A version containing a
 * character outside the pattern is simply never swept: a pattern that is too
 * narrow keeps a file, it never removes one.
 */
export function classifyUpdateLeftover(name: string): { kind: UpdateLeftoverKind; pid: number } | null {
  for (const { kind, re } of LEFTOVER_PATTERNS) {
    const m = re.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    // String round trip rejects leading zeros and anything past 2^53, where
    // Number() has already rounded the digits into some other PID.
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > MAX_PID || String(pid) !== m[1]) return null;
    return { kind, pid };
  }
  return null;
}

/**
 * Whether a process with this PID exists. Signal 0 sends nothing, it only
 * tests. Only ESRCH means "gone"; EPERM means it exists and belongs to someone
 * else, and every other failure is an answer we cannot trust — all of those
 * read as alive, so the caller keeps whatever it was about to remove.
 */
export function isPidAlive(
  pid: number,
  kill: (pid: number, signal: number) => void = (p, s) => { process.kill(p, s); },
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}

/** How long after startup the sweep runs; see the call site in index.ts. */
export const UPDATE_SWEEP_DELAY_MS = 60_000;
const UPDATE_LEFTOVER_MAX_AGE_MS = 60 * 60 * 1000;

export interface SweepDeps {
  now: () => number;
  isPidAlive: (pid: number) => boolean;
  maxAgeMs: number;
}

export interface SweepResult {
  removed: string[];
  failed: { name: string; code: string }[];
}

interface LeftoverEntry {
  name: string;
  full: string;
  kind: UpdateLeftoverKind;
  pid: number;
  stat: fs.Stats | null;
}

/** Age check that treats a negative or unreadable age as fresh. */
function isOlderThan(stat: fs.Stats, now: number, maxAgeMs: number): boolean {
  return now - stat.mtimeMs > maxAgeMs;
}

/**
 * Removes update leftovers from `tmpDir`. Every rule fails towards keeping:
 *
 *   - a fresh entry (mtime within maxAgeMs, or in the future) may belong to a
 *     helper that is still running — cmd reads a batch file line by line, so
 *     deleting it mid-run skips its own `rmdir`;
 *   - a zip or extract dir whose PID has a fresh helper beside it is kept
 *     whatever its own age: after "Later" the payload can be days old by the
 *     time a helper starts copying from it, and only the helper's mtime is set
 *     at apply time;
 *   - a live PID may be a running wmux holding the payload as a staged update;
 *   - symlinks and junctions are never followed or removed, and an entry whose
 *     type does not match its name is left alone.
 *
 * A failed remove is recorded and the sweep carries on.
 */
export async function sweepUpdateLeftovers(tmpDir: string, deps: Partial<SweepDeps> = {}): Promise<SweepResult> {
  const now = (deps.now ?? Date.now)();
  const alive = deps.isPidAlive ?? ((pid: number) => isPidAlive(pid));
  const maxAgeMs = deps.maxAgeMs ?? UPDATE_LEFTOVER_MAX_AGE_MS;
  const result: SweepResult = { removed: [], failed: [] };

  // Pass 1: collect matching entries and the PIDs a fresh helper protects.
  // opendir iterates, so a %TEMP% with tens of thousands of entries is never
  // held in memory — only the handful that match.
  const entries: LeftoverEntry[] = [];
  const protectedPids = new Set<number>();
  for await (const dirent of await fs.promises.opendir(tmpDir)) {
    const leftover = classifyUpdateLeftover(dirent.name);
    if (!leftover) continue;
    const full = path.join(tmpDir, dirent.name);
    const stat = await fs.promises.lstat(full).catch(() => null);
    if (leftover.kind === 'helper' && (!stat || !isOlderThan(stat, now, maxAgeMs))) {
      protectedPids.add(leftover.pid);
    }
    entries.push({ name: dirent.name, full, ...leftover, stat });
  }

  // Pass 2: the first rule that says keep wins.
  for (const entry of entries) {
    const { stat } = entry;
    if (!stat || stat.isSymbolicLink()) continue;
    const typeMatches = entry.kind === 'extract-dir' ? stat.isDirectory() : stat.isFile();
    if (!typeMatches) continue;
    if (!isOlderThan(stat, now, maxAgeMs)) continue;
    if (entry.kind !== 'helper' && protectedPids.has(entry.pid)) continue;
    if (alive(entry.pid)) continue;
    try {
      await fs.promises.rm(entry.full, { recursive: entry.kind === 'extract-dir', force: true });
      result.removed.push(entry.name);
    } catch (err) {
      result.failed.push({ name: entry.name, code: (err as NodeJS.ErrnoException)?.code ?? 'UNKNOWN' });
    }
  }
  return result;
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
    // The console belongs to this script (see the header), so it introduces
    // itself. The title is re-set inside the loop because Windows renames a
    // console after whichever child is currently running in it — which is how
    // this window came to be reported as "findstr.exe".
    'title wmux update',
    'set "SYS=%SystemRoot%\\System32"',
    'set "PID=%~1"',
    'set "SRC=%~2"',
    'set "DST=%~3"',
    'set "EXE=%~4"',
    'if not defined PID exit /b 1',
    'if not exist "%SRC%\\wmux.exe" exit /b 1',
    'echo.',
    'echo   Installing the wmux update.',
    'echo   This window closes by itself. Leave it open; nothing to type here.',
    'echo.',
    'echo   Waiting for wmux to close...',
    ':wait',
    'title wmux update',
    // waitfor, not timeout: this script is spawned with stdio 'ignore', so its
    // stdin is NUL, and timeout.exe refuses a redirected stdin outright
    // ("ERROR: Input redirection is not supported") — measured at 66 ms for a
    // /t 3, which turned the wait into a tasklist spin with no pause at all.
    // waitfor honours /t with NUL stdin (2.1 s measured for /t 2) and times out
    // by design, so its own "Timed out waiting" goes to nul. Not `ping -n`,
    // which is the textbook batch-sleep idiom in droppers — the one shape this
    // helper is trying not to have. Where waitfor.exe is absent the loop
    // degrades to the spin it already had, never to a wrong answer.
    '"%SYS%\\waitfor.exe" /t 1 wmuxUpdateWait >nul 2>nul',
    '"%SYS%\\tasklist.exe" /FI "PID eq %PID%" 2>nul | "%SYS%\\findstr.exe" /I /C:" %PID% " >nul',
    'if not errorlevel 1 goto wait',
    '"%SYS%\\waitfor.exe" /t 2 wmuxUpdateWait >nul 2>nul',
    'title wmux update',
    'echo   Copying files...',
    '"%SYS%\\robocopy.exe" "%SRC%" "%DST%" /E /IS /IT /R:5 /W:1 /NFL /NDL /NJH /NJS /NC /NS',
    'if %ERRORLEVEL% GEQ 8 goto relaunch',
    // The relaunch is unconditional, including after a failed copy. wmux has
    // already quit by the time this runs, so bailing out here is the one
    // outcome the user cannot recover from without finding wmux.exe by hand.
    // A robocopy failure (install root not writable, a leftover child still
    // holding a DLL past /R:5) usually leaves the old build in place, so
    // %EXE% still starts — on the old version, which beats not starting.
    ':relaunch',
    'echo   Starting wmux...',
    'start "" "%EXE%"',
    'rmdir /s /q "%SRC%"',
    // Deliberately does NOT delete itself (no `del "%~f0"`). A hidden,
    // detached script that silently overwrites an unsigned .exe, launches
    // it, and then erases its own file is a textbook dropper/self-cleanup
    // signature — exactly what AV behavioral engines (e.g. Norton SONAR)
    // are built to flag, and a plausible contributor to reports of the
    // updater triggering a heavy AV scan/lockdown. %TEMP% is NOT reclaimed
    // on its own (only Storage Sense does that, and it is off by default),
    // so the leftover .cmd is removed by sweepUpdateLeftovers() instead —
    // from a later wmux process, long after this script has exited.
  ].join('\r\n');
}

/**
 * cmd.exe arguments that run `helper` with `args`, for a VERBATIM spawn.
 *
 * Handing the pieces to spawn() separately is not enough. Node quotes each one
 * that contains a space, and `cmd /c` then applies its own rule to the result:
 * when the command line starts with a quote and holds more than two, it strips
 * the first and the LAST quote on the line. A %TEMP% with a space in it — any
 * Windows account named "First Last" — made the helper path arrive as
 * `C:\Users\First`, "is not recognized", and cmd.exe exited having done
 * nothing, after wmux had already quit into the update. cmd.exe itself had
 * started, so no spawn error could report it.
 *
 * `/s` plus one outer pair of quotes is the documented way out: cmd strips
 * exactly that pair and leaves every inner quote alone. That only holds if
 * nothing inside adds a quote of its own, which a Windows path cannot contain;
 * one that somehow does is refused rather than allowed to re-split the line.
 *
 * Quotes do not stop the other rewrite cmd performs on a command line: a
 * `%NAME%` naming a defined variable is expanded inside them (measured:
 * `"C:\x\%OS%\y"` arrives as `C:\x\Windows_NT\y`). `%` is legal in a Windows
 * path, and a path that changes on the way in is the same silent no-restart
 * as the space was. A lone `%` survives, so only a pair is refused — here,
 * while wmux is still running to say so.
 */
export function buildHelperArgs(helper: string, args: string[]): string[] {
  const parts = [helper, ...args];
  if (parts.some((p) => p.includes('"'))) {
    throw new Error('update helper argument contains a double quote');
  }
  if (parts.some((p) => /%[^%]*%/.test(p))) {
    throw new Error('update helper argument contains a %…% pair that cmd.exe would expand');
  }
  return ['/d', '/s', '/c', `"${parts.map((p) => `"${p}"`).join(' ')}"`];
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
  const zipPath = path.join(os.tmpdir(), updateZipName(version, process.pid));
  const extractDir = path.join(os.tmpdir(), updateStampName(version, process.pid));
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

/**
 * Hands the swap to the detached helper and quits — but only once the helper
 * is actually running. Every failure wmux can still observe rejects WITHOUT
 * quitting, because a quit whose helper never runs leaves the user with no
 * wmux and nothing to restart it (#3):
 *
 *   - the payload is gone (Storage Sense, a temp cleanup, days after "Later"):
 *     rejects with code PAYLOAD_MISSING, and only a fresh download can help;
 *   - the helper cannot be written, or cmd.exe fails to start (an antivirus
 *     blocking either): rejects with that error, and the payload is still good.
 *
 * The 'error' listener stays attached after 'spawn', so a late error on the
 * child is a no-op rather than an uncaught exception in main.
 */
export async function applyStagedPortableUpdate(staged: StagedZipUpdate): Promise<void> {
  if (!fs.existsSync(path.join(staged.extractDir, 'wmux.exe'))) {
    throw Object.assign(
      new Error('the downloaded update is no longer on disk — download it again'),
      { code: 'PAYLOAD_MISSING' },
    );
  }
  const helper = path.join(os.tmpdir(), updateHelperName(process.pid));
  fs.writeFileSync(helper, buildApplyUpdateCmd(), 'utf8');
  const cmd = process.env.ComSpec || system32('cmd.exe');
  const child = spawn(cmd, buildHelperArgs(helper, [
    String(process.pid),
    staged.extractDir,
    staged.installDir,
    staged.exePath,
  ]), {
    detached: true,
    stdio: 'ignore',
    // `windowsHide` does NOT hide this one: DETACHED_PROCESS makes Windows
    // ignore CREATE_NO_WINDOW, so cmd.exe opens a console anyway (see the
    // header). It stays because dropping `detached` to make it work would
    // put the helper's life back in wmux's hands, and the helper outliving
    // wmux is the whole point. The console is where `buildApplyUpdateCmd`'s
    // title and messages land.
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.on('error', reject);
  });
  child.unref();
  app.quit();
}
