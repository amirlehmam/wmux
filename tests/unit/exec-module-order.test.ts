import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Loading any ssh-*, wsl-* or exec-* module FIRST, in a fresh module registry, must work.
 * These modules import each other only from inside functions; a `const x = { run: other }`
 * or a call at load time would make the load order matter. The git-view/diff-provider pair is
 * the one pair that imports each other, so both orders of it are tried too.
 */
const MAIN = path.resolve(__dirname, '../../src/main');
const modules = fs.readdirSync(MAIN)
  .filter((f) => /^(ssh|wsl|exec)-.*\.ts$/.test(f))
  .map((f) => f.slice(0, -3))
  .sort();

afterEach(() => vi.resetModules());

/** Runtime (value) imports between ssh-*, wsl-* and exec-* modules; `import type` and all-type braces are erased by tsc. */
function valueImports(name: string): string[] {
  const source = fs.readFileSync(path.join(MAIN, `${name}.ts`), 'utf8');
  const found = new Set<string>();
  for (const m of source.matchAll(/^(?:import|export)\s+(type\s+)?([^;]*?)\s+from\s+'\.\/([\w-]+)'/gms)) {
    const [, isType, clause, target] = m;
    if (isType || !(target in graph)) continue;
    const braces = /\{([^}]*)\}/.exec(clause)?.[1];
    const onlyTypes = braces !== undefined && !/^\s*\w/.test(clause)
      && braces.split(',').map((x) => x.trim()).filter(Boolean).every((x) => x.startsWith('type '));
    if (!onlyTypes) found.add(target);
  }
  return [...found];
}
const graph: Record<string, string[]> = {};
for (const name of modules) graph[name] = [];
for (const name of Object.keys(graph)) graph[name] = valueImports(name);

describe('module graph', () => {
  it('has no import cycle among the ssh, wsl and exec modules', () => {
    const cycles: string[] = [];
    const visit = (node: string, stack: string[]): void => {
      if (stack.includes(node)) { cycles.push([...stack.slice(stack.indexOf(node)), node].join(' -> ')); return; }
      for (const next of graph[node]) visit(next, [...stack, node]);
    };
    for (const name of Object.keys(graph)) visit(name, []);
    expect(cycles).toEqual([]);
  });
});

describe('module load order', () => {
  it('finds the modules it is about', () => {
    expect(modules).toEqual(expect.arrayContaining(['ssh-explorer', 'ssh-git', 'exec-snapshot', 'exec-worker', 'ssh-command', 'wsl-local']));
  });

  it.each(modules)('%s loads first, with nothing else loaded', async (name) => {
    vi.resetModules();
    const loaded = await import(`../../src/main/${name}.ts`);
    expect(Object.keys(loaded).length).toBeGreaterThan(0);
  });

  it.each([['git-view', 'diff-provider'], ['diff-provider', 'git-view']])('%s then %s', async (first, second) => {
    vi.resetModules();
    await import(`../../src/main/${first}.ts`);
    await import(`../../src/main/${second}.ts`);
  });
});
