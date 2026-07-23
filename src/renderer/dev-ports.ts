/**
 * dev-ports.ts — Pure helpers for dev-server port detection.
 *
 * wmux auto-navigates a workspace's browser to a detected dev-server port. The
 * recognized set is the built-in defaults plus any the user adds via
 * `[browser] dev-ports = [...]` in ~/.wmux/config.toml. Kept separate from
 * App.tsx so the logic is unit-testable without the React/Electron surface.
 */

/** Built-in dev-server ports that trigger browser auto-navigation. */
export const DEFAULT_DEV_PORTS = [3000, 3001, 4000, 4200, 5000, 5173, 5174, 8000, 8080, 8888];

/**
 * Merge user-configured dev ports with the built-in defaults.
 * Additive and de-duped: configured ports JOIN the defaults (order preserved,
 * defaults first) rather than replacing them, so adding one port never drops
 * the sensible built-ins. An empty/absent config leaves the defaults untouched.
 */
export function mergeDevPorts(defaults: number[], configured?: number[] | null): number[] {
  if (!Array.isArray(configured) || configured.length === 0) return defaults;
  return Array.from(new Set([...defaults, ...configured]));
}

/** Filter a set of detected ports down to those recognized as dev-server ports. */
export function matchDevPorts(allPorts: number[], activeDevPorts: number[]): number[] {
  return allPorts.filter((p) => activeDevPorts.includes(p));
}

/**
 * Pick which recognized dev port to auto-open: the first one the workspace hasn't
 * seen yet. Diffing the whole set against the known ports — rather than blindly
 * taking index 0 — means a freshly-started server opens even when other recognized
 * ports are already listening (netstat order is arbitrary). Returns undefined when
 * nothing is new, so an already-open port never re-navigates the browser.
 */
export function firstNewDevPort(devPorts: number[], knownPorts: number[]): number | undefined {
  return devPorts.find((p) => !knownPorts.includes(p));
}
