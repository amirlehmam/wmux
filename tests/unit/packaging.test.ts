import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Guards against runtime-referenced files missing from the packaged app.
 *
 * claude-context.ts writes Claude Code hooks into ~/.claude/settings.json that
 * exec `node <resources>/cli/wmux-hook.js` in installed builds. The script must
 * live OUTSIDE the asar (bare node can't read asar archives), i.e. it must be
 * listed in electron-builder extraResources. It was missing until v0.29.1:
 * every hook silently failed, so the sidebar never received PostToolUse/Stop
 * events and workspaces stayed pinned on "Running" while Claude idled.
 */
describe('electron-builder packaging', () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../electron-builder.json'), 'utf8'),
  );
  const extraResources: Array<{ from: string; to: string }> = config.extraResources;

  it('ships the CLI entry point outside the asar', () => {
    expect(extraResources).toContainEqual({ from: 'dist/cli/wmux.js', to: 'cli/wmux.js' });
  });

  it('ships the Claude Code hook helper outside the asar', () => {
    expect(extraResources).toContainEqual({ from: 'dist/cli/wmux-hook.js', to: 'cli/wmux-hook.js' });
  });
});
