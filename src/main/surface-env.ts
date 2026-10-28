// A surface's extra environment, as it reaches the shell (#284).
//
// Workspace manifests are COMMITTED, so the issue's own guardrail is that a
// secret must never be written into one: a value can instead name a variable
// from the environment wmux itself was started with, `${env:NAME}`. That
// reference is what the manifest, the store (`SurfaceRef.env`) and session.json
// all carry; it is resolved here, at spawn, and nowhere earlier, so the
// resolved value exists only in the shell's environment block.
//
// Applied on the IPC `pty:create` path only (ipc-handlers.ts). agent-manager
// passes its own `WMUX_AGENT_ID` straight to `PtyManager.create()`, and that
// must not be filtered — `isReservedEnvKey` would drop it.

/** A key a manifest may set. POSIX-ish names; nothing else reaches CreateProcess. */
export const ENV_KEY_RE = /^[A-Za-z_]\w{0,127}$/;

/** `${env:NAME}` — the only substitution, so a literal `$` stays literal. */
const ENV_REF_RE = /\$\{env:([A-Za-z_]\w{0,127})\}/g;

/**
 * Keys wmux owns in every pane. A surface setting one would detach the pane
 * from its own identity (WMUX_SURFACE_ID), point hooks at another pipe
 * (WMUX_PIPE) or swap the CLI an agent runs (WMUX_CLI) — so they are dropped
 * rather than merged, even though PtyManager writes its own afterwards anyway.
 */
export function isReservedEnvKey(key: string): boolean {
  return /^WMUX(_|$)/i.test(key);
}

/** Expand `${env:NAME}` against `source`; an unset name expands to ''. */
export function expandEnvRefs(value: string, source: NodeJS.ProcessEnv): string {
  return value.replace(ENV_REF_RE, (_m, name: string) => source[name] ?? '');
}

/** The env to merge into a spawn: valid keys only, references resolved. */
export function resolveSurfaceEnv(
  env: Record<string, unknown> | undefined,
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env || typeof env !== 'object') return out;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || !ENV_KEY_RE.test(key) || isReservedEnvKey(key)) continue;
    out[key] = expandEnvRefs(value, source);
  }
  return out;
}
