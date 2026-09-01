/**
 * Release notes, in the app (issue #211).
 *
 * "I have to google wmux, select the right gh repo and find the notes there."
 * wmux already fetches a release from GitHub — `update-checker.ts` polls
 * `/releases/latest` to raise the update badge — so the app knows what the
 * newest version is and has never been able to say what changed in it.
 *
 * ## Cached, because a changelog is worth reading offline
 *
 * The fetch is a plain `net.request` to the public releases API. It needs no
 * token, so it is also rate-limited by IP (60/hour unauthenticated), and it is
 * the kind of thing a user opens on a plane. So every successful fetch is
 * written to wmux's own data directory and every failure falls back to it:
 * opening the panel a second time is free, and opening it with no network
 * shows what was there last time rather than an error.
 *
 * The cache is inside `%APPDATA%\wmux`, so it needs no part of the #132 consent
 * gate — that gate is about writes OUTSIDE wmux's own directory.
 *
 * ## What is deliberately not here
 *
 * No `Authorization` header and no token plumbing, ever. This reads public
 * release notes from a public repo; the moment it could carry a credential it
 * becomes a thing that can leak one.
 *
 * Nor does it parse or reformat the notes. They are GitHub-flavoured markdown
 * and the renderer already has a sanitising markdown renderer for exactly that
 * (`markdown-utils.renderMarkdown`, which is where the security boundary is).
 * Rewriting them here would be a second, worse markdown implementation living
 * on the wrong side of the wire.
 */
import { app, net } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { getAppDataDir } from '../shared/instance';
import { compareVersions, type GithubRelease } from './update-checker';

const REPO_OWNER = 'amirlehmam';
const REPO_NAME = 'wmux';

/**
 * How many releases to show. wmux ships often; a changelog is for "what changed
 * recently", and someone who wants the full history has the repo.
 */
export const CHANGELOG_LIMIT = 20;

/** How long a cached copy is served without going back to the network. */
const CACHE_TTL_MS = 60 * 60 * 1000;

/** Notes are prose and can be long; this caps one pathological release. */
const MAX_BODY_CHARS = 40_000;

export interface ChangelogEntry {
  /** Version without the leading `v`, so it compares against `app.getVersion()`. */
  version: string;
  tag: string;
  name: string;
  publishedAt: string | null;
  url: string;
  /** Raw markdown, rendered (and sanitised) by the renderer. */
  body: string;
  prerelease: boolean;
}

export interface ChangelogResult {
  entries: ChangelogEntry[];
  /** When these entries were fetched, epoch ms. Null when nothing was ever fetched. */
  fetchedAt: number | null;
  /** True when the network failed and this is what was on disk. */
  stale: boolean;
  /** The version this install is running, so the panel can mark "you are here". */
  currentVersion: string;
}

/**
 * Turn the API payload into what the panel shows. Pure, and separated from the
 * fetch because everything that can be wrong about a changelog is in here:
 * drafts that must not appear, a `body` that is null rather than absent, and
 * ordering — GitHub returns releases by CREATION date, which is not version
 * order once a patch for an older line is published after a newer minor.
 */
export function toChangelogEntries(releases: unknown, limit = CHANGELOG_LIMIT): ChangelogEntry[] {
  if (!Array.isArray(releases)) return [];
  return releases
    .filter((r): r is GithubRelease => !!r && typeof (r as GithubRelease).tag_name === 'string')
    // A draft is not published — it is visible only to maintainers and only
    // with a token, but filtering it costs nothing and the API contract may
    // change under us. A prerelease IS shown, and labelled.
    .filter((r) => !r.draft)
    .map((r) => ({
      version: r.tag_name.replace(/^v/, ''),
      tag: r.tag_name,
      // `name` is optional and is empty on a release published from a tag with
      // no title, which is most of wmux's. The tag is always something.
      name: (r as { name?: string }).name?.trim() || r.tag_name,
      publishedAt: r.published_at ?? null,
      url: r.html_url,
      body: (r.body ?? '').slice(0, MAX_BODY_CHARS),
      prerelease: !!r.prerelease,
    }))
    .sort((a, b) => compareVersions(b.version, a.version))
    .slice(0, limit);
}

function cachePath(): string {
  return path.join(getAppDataDir(), 'cache', 'releases.json');
}

function readCache(): { entries: ChangelogEntry[]; fetchedAt: number } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(), 'utf-8'));
    if (!Array.isArray(raw?.entries) || typeof raw?.fetchedAt !== 'number') return null;
    return { entries: raw.entries, fetchedAt: raw.fetchedAt };
  } catch {
    return null;
  }
}

function writeCache(entries: ChangelogEntry[], fetchedAt: number): void {
  try {
    const file = cachePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ entries, fetchedAt }), 'utf-8');
  } catch {
    // A changelog that cannot cache is still a changelog.
  }
}

/** GET /releases. Resolves null on any failure — this is never worth throwing over. */
export function fetchReleases(limit = CHANGELOG_LIMIT): Promise<unknown | null> {
  return new Promise((resolve) => {
    const req = net.request({
      method: 'GET',
      url: `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=${limit}`,
      redirect: 'follow',
    });
    req.setHeader('Accept', 'application/vnd.github+json');
    req.setHeader('User-Agent', `wmux/${app.getVersion()}`);
    let body = '';
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        // Drained rather than ignored: an undrained response keeps the socket
        // and its listeners alive for the life of the app.
        res.on('data', () => {});
        res.on('end', () => resolve(null));
        return;
      }
      res.on('data', (chunk) => { body += chunk.toString('utf8'); });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

/**
 * What the panel asks for.
 *
 * `refresh` is the user pressing Refresh, which bypasses the TTL but NOT the
 * cache fallback: a manual refresh that fails must not blank the list the user
 * was already reading.
 */
export async function getChangelog(opts: { refresh?: boolean } = {}): Promise<ChangelogResult> {
  const currentVersion = app.getVersion();
  const cached = readCache();
  const fresh = cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS;
  if (cached && fresh && !opts.refresh) {
    return { entries: cached.entries, fetchedAt: cached.fetchedAt, stale: false, currentVersion };
  }

  const raw = await fetchReleases();
  if (raw === null) {
    return cached
      ? { entries: cached.entries, fetchedAt: cached.fetchedAt, stale: true, currentVersion }
      : { entries: [], fetchedAt: null, stale: true, currentVersion };
  }

  const entries = toChangelogEntries(raw);
  const fetchedAt = Date.now();
  writeCache(entries, fetchedAt);
  return { entries, fetchedAt, stale: false, currentVersion };
}
