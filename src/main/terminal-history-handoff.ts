import fs from 'fs';
import path from 'path';
import { getAppDataDir } from '../shared/instance';
import type { TerminalHistoryReference } from '../shared/terminal-history';
import { isTerminalHistoryReference } from './terminal-history';
import { loadNamedSession, sessionBackupFingerprint, type AutoSessionBackup, type SessionData } from './session-persistence';
import { terminalSurfaceIds } from './session-windows';

interface Handoff {
  version: 1;
  generation: number;
  backup: AutoSessionBackup;
  sourceFingerprint: string;
  references: Record<string, TerminalHistoryReference>;
}

/**
 * The update transaction's small durable link, not an output archive. Its exact
 * backup fingerprint survives crashes between backup, auto removal and stamping.
 * It lives beside session.json, outside the record cleaner's filename namespace.
 */
export class TerminalHistoryHandoff {
  private readonly file: string;
  constructor(directory = path.join(getAppDataDir(), 'sessions')) {
    this.file = path.join(directory, 'terminal-history-handoff.json');
  }

  read(generation: number): Handoff | null {
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Handoff;
      if (data.version !== 1 || data.generation !== generation || !data.backup
        || typeof data.backup.name !== 'string' || typeof data.sourceFingerprint !== 'string'
        || !data.references || typeof data.references !== 'object' || Array.isArray(data.references)) return null;
      const backup = loadNamedSession(data.backup.name);
      if (!backup || sessionBackupFingerprint(backup) !== data.backup.fingerprint) return null;
      const members = terminalSurfaceIds({ workspaces: backup.workspaces } as SessionData['windows'][number]);
      if (!Object.entries(data.references).every(([surface, ref]) => members.has(surface)
        && isTerminalHistoryReference(ref) && ref.generation === generation)) return null;
      return data;
    } catch { return null; }
  }

  prepare(backup: AutoSessionBackup, session: SessionData, generation: number): boolean {
    const references: Record<string, TerminalHistoryReference> = Object.create(null);
    for (const window of session.windows) {
      for (const surface of terminalSurfaceIds(window)) {
        const ref = window.terminalHistory?.[surface];
        if (isTerminalHistoryReference(ref) && ref.generation === generation) {
          if (references[surface]) return false;
          references[surface] = { recordId: ref.recordId, generation };
        }
      }
    }
    if (!Object.keys(references).length) return true;
    return this.write({ version: 1, generation, backup, references,
      sourceFingerprint: sessionBackupFingerprint(session) });
  }

  /** A destructive close cannot leave its restore reference in an unretired handoff. */
  forget(recordIds: ReadonlySet<string>, generation: number): boolean {
    const data = this.read(generation);
    if (!data || !Object.values(data.references).some((ref) => recordIds.has(ref.recordId))) return true;
    data.references = Object.fromEntries(Object.entries(data.references).filter(([, ref]) => !recordIds.has(ref.recordId)));
    if (!Object.keys(data.references).length) return this.invalidate();
    return this.write(data);
  }

  private write(data: Handoff): boolean {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (fs.existsSync(this.file)) {
        const stat = fs.lstatSync(this.file);
        if (!stat.isFile() || stat.isSymbolicLink()) return false;
      }
      if (!this.remove(this.file + '.tmp')) return false;
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(data), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(this.file + '.tmp', this.file);
      return true;
    } catch { return false; }
    finally { this.remove(this.file + '.tmp'); }
  }

  invalidate(): boolean {
    const removed = this.remove(this.file);
    return this.remove(this.file + '.tmp') && removed;
  }

  /** Only our two exact control filenames are eligible for deletion/retry. */
  cleanup(generation: number): boolean {
    const removed = this.remove(this.file + '.tmp');
    return (this.read(generation) ? true : this.remove(this.file)) && removed;
  }

  private remove(file: string): boolean {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      fs.unlinkSync(file);
      return true;
    } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
  }
}
