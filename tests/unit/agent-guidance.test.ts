import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Repo skills have one source, `.agents/skills/`, which is where Codex reads
 * them. Claude Code reads only `.claude/skills/`, so that tree is a generated
 * copy written by `npm run sync:skills` (#368).
 *
 * A copy rather than a symlink: Git for Windows checks a committed symlink out
 * as a one-line text file unless `core.symlinks` is on and the user may create
 * symlinks, and Claude Code then finds no skills without reporting anything.
 * The copy is the same shape as `resources/shell-integration/`, and like that
 * mirror (resources-sync.test.ts, #168/#169) it is only safe because a test
 * fails the moment it drifts.
 */
const ROOT = path.join(__dirname, '..', '..');
const SOURCE = path.join(ROOT, '.agents', 'skills');
const COPY = path.join(ROOT, '.claude', 'skills');
const SYNC_HINT = 'edit .agents/skills/, then run `npm run sync:skills`';

/**
 * The fields the Agent Skills spec defines. Claude Code accepts more (`paths`,
 * `disable-model-invocation`, …) but other agents reject or ignore them, and
 * the point of one source is that the same file loads everywhere.
 */
const SPEC_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) out.push(...filesUnder(full).map((f) => path.join(entry, f)));
    else out.push(entry);
  }
  return out.sort();
}

/** Newline-normalised: these are checked in on Windows with core.autocrlf. */
function read(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * The leading `---` block as top-level `key: value` lines. Skill frontmatter
 * here is held to single-line scalars, so a line that is not one is reported
 * as an error rather than parsed generously.
 */
function frontmatterOf(text: string): { fields: Map<string, string>; errors: string[] } {
  const fields = new Map<string, string>();
  const errors: string[] = [];
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return { fields, errors: ['no frontmatter block'] };
  for (const line of match[1].split('\n')) {
    const kv = /^([a-z][a-z-]*): (.+)$/.exec(line);
    if (!kv) {
      errors.push(`not a single-line "key: value": ${JSON.stringify(line)}`);
      continue;
    }
    const [, key, value] = kv;
    // An unquoted ": " or " #" changes what a YAML parser reads the value as.
    if (!/^["']/.test(value) && (value.includes(': ') || value.includes(' #'))) {
      errors.push(`${key} needs quoting: it contains ": " or " #"`);
    }
    fields.set(key, value);
  }
  return { fields, errors };
}

const skills = fs.existsSync(SOURCE) ? fs.readdirSync(SOURCE).sort() : [];

describe('repo skills: one source for every agent (#368)', () => {
  it('has skills to check, so the checks below are not vacuous', () => {
    expect(skills.length).toBeGreaterThan(0);
  });

  it('.claude/skills/ has exactly the files of .agents/skills/', () => {
    expect(filesUnder(COPY), SYNC_HINT).toEqual(filesUnder(SOURCE));
  });

  it.each(filesUnder(SOURCE))('%s is identical in .claude/skills/', (file) => {
    const copy = path.join(COPY, file);
    expect(fs.existsSync(copy), SYNC_HINT).toBe(true);
    expect(read(copy), SYNC_HINT).toBe(read(path.join(SOURCE, file)));
  });

  it.each(skills)('%s uses only Agent Skills spec frontmatter', (skill) => {
    const { fields, errors } = frontmatterOf(read(path.join(SOURCE, skill, 'SKILL.md')));
    expect(errors).toEqual([]);
    expect([...fields.keys()].filter((k) => !SPEC_FIELDS.has(k))).toEqual([]);
    expect(fields.get('name')).toBe(skill);
    expect(skill).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(skill.length).toBeLessThanOrEqual(64);
    const description = fields.get('description') ?? '';
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  it('the frontmatter check catches a Claude-only field and an unquoted colon', () => {
    const { fields, errors } = frontmatterOf('---\nname: x\npaths: src/**\ndescription: Use when: editing\n---\n');
    expect([...fields.keys()].filter((k) => !SPEC_FIELDS.has(k))).toEqual(['paths']);
    expect(errors).toEqual(['description needs quoting: it contains ": " or " #"']);
  });
});
