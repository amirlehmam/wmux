import { app, BrowserWindow, net } from 'electron';
import { IPC_CHANNELS } from '../shared/types';

// wmux has two distinct update paths:
//   1. updater.ts (electron-updater) — actually downloads/installs, now gated by a
//      quarantine window + an explicit user-confirmed install (see issue #29).
//   2. this module — a notify-only poll of GitHub /releases/latest that broadcasts
//      a badge; clicking it opens the GitHub release page in the OS browser.
// The release flow does emit latest.yml, so path 1 is live; this path remains as a
// lightweight, zero-trust-install notification and a source of release metadata
// (published_at) that updater.ts reuses to compute release age.

const REPO_OWNER = 'amirlehmam';
const REPO_NAME = 'wmux';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 5_000;

export interface UpdateAvailableInfo {
  version: string;
  url: string;
  body?: string;
  publishedAt?: string;
}

export interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
  digest?: string;
}

export interface GithubRelease {
  tag_name: string;
  html_url: string;
  body?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GithubReleaseAsset[];
}

let latest: UpdateAvailableInfo | null = null;

export function getLatestUpdate(): UpdateAvailableInfo | null {
  return latest;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

export function fetchLatestRelease(): Promise<GithubRelease | null> {
  return new Promise((resolve) => {
    const req = net.request({
      method: 'GET',
      url: `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
      redirect: 'follow',
    });
    req.setHeader('Accept', 'application/vnd.github+json');
    req.setHeader('User-Agent', `wmux/${app.getVersion()}`);
    let body = '';
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        res.on('data', () => {});
        res.on('end', () => resolve(null));
        return;
      }
      res.on('data', (chunk) => { body += chunk.toString('utf8'); });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function checkOnce(): Promise<void> {
  const release = await fetchLatestRelease();
  if (!release || release.draft || release.prerelease) return;
  const current = app.getVersion();
  if (compareVersions(release.tag_name, current) <= 0) return;

  latest = {
    version: release.tag_name.replace(/^v/, ''),
    url: release.html_url,
    body: release.body,
    publishedAt: release.published_at,
  };

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.UPDATE_AVAILABLE, latest);
    }
  }
}

export function initUpdateChecker(): void {
  setTimeout(() => { checkOnce().catch(() => {}); }, FIRST_CHECK_DELAY_MS);
  setInterval(() => { checkOnce().catch(() => {}); }, CHECK_INTERVAL_MS);
}
