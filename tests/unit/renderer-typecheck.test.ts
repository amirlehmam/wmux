import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as path from 'path';

// The renderer had no type gate. `npm run build` typechecks only
// tsconfig.node.json (main/preload/cli); the renderer goes through Vite, and
// Vite transpiles TSX with esbuild, which strips types without checking them.
//
// That gap shipped 0.35.0 broken. WorkspaceRow's TRACE memo listed
// `isClaudeActive` in its dependency array 17 lines before the `const` that
// declares it. A useMemo deps array is a plain array literal evaluated at the
// call site — only the callback is deferred — so the read happened on every
// render, in classic mode too, and every row threw
// "Cannot access 'te' before initialization" straight into the ErrorBoundary.
//
// tsc reports exactly that as TS2448, in under two seconds. Nothing ran it.
// This test runs it.

const ROOT = path.join(__dirname, '..', '..');

describe('renderer typecheck', () => {
  it('compiles with no type errors', () => {
    // The tsc entrypoint via `node`, not `npx`/`npx.cmd`. Since the
    // CVE-2024-27980 fix, spawnSync refuses to launch a .cmd without
    // shell:true, and shell:true both triggers DEP0190 and concatenates args
    // unescaped — fatal in this repo, whose path contains a space
    // ("OneDrive - Pulsa"). This form needs no shell on any platform.
    const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    const result = spawnSync(
      process.execPath,
      [tsc, '--noEmit', '-p', 'tsconfig.json'],
      { cwd: ROOT, encoding: 'utf-8' },
    );

    // Assert the process actually ran before judging its output: a failed spawn
    // yields status null and empty stdout, which would otherwise read as a
    // clean typecheck and turn this gate into a no-op.
    expect(result.error, `failed to spawn tsc: ${result.error?.message}`).toBeUndefined();
    expect(result.status, 'tsc did not run to completion').not.toBeNull();

    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    expect(output, `tsc reported errors:\n${output}`).toBe('');
    expect(result.status).toBe(0);
  }, 120_000);
});
