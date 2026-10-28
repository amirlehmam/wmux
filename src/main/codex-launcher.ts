// ─── Codex resume, launcher side (#261) ──────────────────────────────────────
//
// Codex conversation restore (#261, contributed), behind
// `workspacePrefs.restoreCodexSessions` (default off). No hooks: a private PATH
// shim (`src/codex-bin`, `src/codex-bin-ps`) runs `cli/wmux-codex.js`, which
// starts `codex app-server` behind an authenticated 127.0.0.1 relay
// (`codex-relay.ts`, the one CLI file that needs an npm package — `ws`, shipped
// in `cli/node_modules`) and reads the thread id off its responses. This module
// picks which shim dirs a pane gets; codex-resume.ts stamps the id it reports.
//
// Three rules from review, each enforced where it applies:
//
//   1. With the pref OFF a pane gets no shim and pays no `where codex.exe` —
//      `codex` must be exactly what the shell would run, and pane create is
//      the #176 hot path. Gated in pty-manager.ts (`codexShimDirsForPane`)
//      before this function is ever called.
//   2. PowerShell gets the `.ps1` shim or NOTHING, never the `.cmd` (#154:
//      cmd.exe re-parses the argv). The `powershell` branch below.
//   3. The relay is `require`d lazily and a failure falls back to plain codex,
//      so a packaging miss costs the feature and never every `codex` launch
//      (`startRelay` in cli/wmux-codex.ts).

import fs from 'fs';
import path from 'path';
import { stripMarkOfTheWeb } from './powershell-shim';

/** Private shims affect only wmux's native Windows shells, never the global PATH. */
export function codexShimDirs(options: {
  shellType: string;
  executable: string | undefined;
  cliBinDir: string;
  psVerified: boolean;
  env: Record<string, string>;
  runtime: string;
  launcher: string;
}): string[] {
  if (process.platform !== 'win32' || !['powershell', 'cmd'].includes(options.shellType) || !options.executable) return [];
  const root = path.dirname(options.cliBinDir);
  const cmd = path.join(root, 'codex-bin');
  if (!fs.existsSync(path.join(cmd, 'codex.cmd')) || !fs.existsSync(options.launcher)) return [];
  let dirs: string[] = [cmd];
  if (options.shellType === 'powershell') {
    // PowerShell must get the .ps1 or nothing. Handing it codex.cmd puts
    // cmd.exe's parser back between the user and codex — `codex "a > b"`
    // redirects to a file named b — which is the #154 trap the wmux shim
    // already refuses to fall into. Unverified, codex simply runs unwrapped.
    const ps = path.join(root, 'codex-bin-ps');
    const script = path.join(ps, 'codex.ps1');
    dirs = [];
    if (options.psVerified && fs.existsSync(script)) {
      stripMarkOfTheWeb(script);
      if (!fs.existsSync(script + ':Zone.Identifier')) dirs = [ps, cmd];
    }
  }
  if (dirs.length > 0) {
    Object.assign(options.env, {
      WMUX_CODEX_EXE: options.executable,
      WMUX_CODEX_RUNTIME: options.runtime,
      WMUX_CODEX_LAUNCHER: options.launcher,
    });
  }
  return dirs;
}
