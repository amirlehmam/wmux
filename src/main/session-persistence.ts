import fs from 'fs';
import path from 'path';
import os from 'os';

const APPDATA_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'wmux');
const SESSIONS_DIR = path.join(APPDATA_DIR, 'sessions');
const SESSION_FILE = path.join(SESSIONS_DIR, 'session.json');

export interface SessionData {
  version: 1;
  windows: Array<{
    bounds: { x: number; y: number; width: number; height: number };
    sidebarWidth: number;
    activeWorkspaceId: string | null;
    workspaces: Array<{
      id: string;
      title: string;
      customColor?: string;
      pinned: boolean;
      shell: string;
      splitTree: any; // SplitNode serialized
    }>;
  }>;
}

export function ensureDirectories(): void {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

export function saveSession(data: SessionData): void {
  ensureDirectories();
  // Atomic write: write to temp file, then rename
  const tmpFile = SESSION_FILE + '.tmp';
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
    // On Windows, rename won't overwrite, so remove first
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
    }
    fs.renameSync(tmpFile, SESSION_FILE);
  } catch (err) {
    // Clean up temp file if it exists
    try { fs.unlinkSync(tmpFile); } catch {}
    console.error('Failed to save session:', err);
  }
}

export function loadSession(): SessionData | null {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const raw = fs.readFileSync(SESSION_FILE, 'utf-8');
    const data = JSON.parse(raw) as SessionData;
    if (data.version !== 1) return null;
    return data;
  } catch {
    // Corrupted file — fall back to default
    return null;
  }
}

export function getSessionPath(): string {
  return SESSION_FILE;
}
