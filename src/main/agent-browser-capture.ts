/**
 * Capture density is fixed at launch: viewport scale alone does not increase the
 * native stream's pixel count. Keep CSS dimensions unchanged when resizing.
 * Native configuration repeats custom args on later commands. Overriding them
 * only at launch can replace the page, so custom args remain authoritative.
 * Automatic project configuration intentionally cannot supply Chrome flags.
 */
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const AGENT_BROWSER_CAPTURE_SCALE = 2;
export const AGENT_BROWSER_STREAM_DEFAULTS = {
  AGENT_BROWSER_STREAM_QUALITY: '95',
  AGENT_BROWSER_STREAM_MAX_WIDTH: '16384',
  AGENT_BROWSER_STREAM_MAX_HEIGHT: '16384',
};

/** Leave explicit Chrome args to native configuration rather than changing its launch recipe. */
export function nativeCaptureArgs(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  if (env.AGENT_BROWSER_ARGS !== undefined) return [];
  const configPath = env.AGENT_BROWSER_CONFIG ?? join(home, '.agent-browser', 'config.json');
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    if (typeof config?.args === 'string') return [];
  } catch {
    // Native CLI still owns normal configuration validation and error reporting.
  }
  return ['--args', `--force-device-scale-factor=${AGENT_BROWSER_CAPTURE_SCALE}`];
}
