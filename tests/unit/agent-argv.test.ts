import { describe, it, expect } from 'vitest';
import { identifyAgentCommand, AGENT_ALIASES } from '../../src/main/agent-argv';

describe('identifyAgentCommand — direct invocations', () => {
  it('names the agent for a bare command', () => {
    expect(identifyAgentCommand('claude')).toBe('claude');
    expect(identifyAgentCommand('codex')).toBe('codex');
    expect(identifyAgentCommand('opencode')).toBe('opencode');
  });

  it('ignores arguments after the executable', () => {
    expect(identifyAgentCommand('claude --resume --model opus')).toBe('claude');
    expect(identifyAgentCommand('codex exec "fix the build"')).toBe('codex');
  });

  it('strips a full path and a Windows extension', () => {
    expect(identifyAgentCommand('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd')).toBe('claude');
    expect(identifyAgentCommand('/usr/local/bin/codex')).toBe('codex');
    expect(identifyAgentCommand('claude.exe')).toBe('claude');
    expect(identifyAgentCommand('claude.ps1')).toBe('claude');
  });

  it('handles a quoted path with spaces', () => {
    expect(identifyAgentCommand('"C:\\Program Files\\claude\\claude.exe" --resume')).toBe('claude');
  });

  it('is case-insensitive', () => {
    expect(identifyAgentCommand('CLAUDE.EXE')).toBe('claude');
  });

  it('returns null for an ordinary command', () => {
    expect(identifyAgentCommand('git status')).toBeNull();
    expect(identifyAgentCommand('npm run dev')).toBeNull();
    expect(identifyAgentCommand('pwsh')).toBeNull();
  });

  it('returns null for empty or whitespace input', () => {
    expect(identifyAgentCommand('')).toBeNull();
    expect(identifyAgentCommand('   ')).toBeNull();
  });

  /** A pane running `claude-monitor` is not a pane running Claude. */
  it('does not match a command that merely starts with an agent name', () => {
    expect(identifyAgentCommand('claudia')).toBeNull();
    expect(identifyAgentCommand('codex-review-helper')).toBeNull();
  });
});

describe('identifyAgentCommand — wrapper unwrapping', () => {
  it('unwraps cmd /c', () => {
    expect(identifyAgentCommand('cmd /c claude')).toBe('claude');
    expect(identifyAgentCommand('C:\\Windows\\system32\\cmd.exe /d /s /c "claude --resume"')).toBe('claude');
  });

  it('unwraps powershell -File', () => {
    expect(identifyAgentCommand('powershell -NoProfile -File C:\\npm\\claude.ps1')).toBe('claude');
    expect(identifyAgentCommand('pwsh -File codex.ps1')).toBe('codex');
  });

  it('unwraps a node script', () => {
    expect(identifyAgentCommand('node C:\\npm\\node_modules\\.bin\\claude.js')).toBe('claude');
    expect(identifyAgentCommand('"C:\\Program Files\\nodejs\\node.exe" opencode.mjs')).toBe('opencode');
  });

  it('unwraps npx and its flags', () => {
    expect(identifyAgentCommand('npx claude')).toBe('claude');
    expect(identifyAgentCommand('npx -y opencode')).toBe('opencode');
    expect(identifyAgentCommand('npx --yes -p @anthropic-ai/claude-code claude')).toBe('claude');
  });

  it('unwraps bun, bunx and dlx', () => {
    expect(identifyAgentCommand('bunx opencode')).toBe('opencode');
    expect(identifyAgentCommand('pnpm dlx codex')).toBe('codex');
  });

  it('unwraps a python script', () => {
    expect(identifyAgentCommand('python C:\\tools\\aider.py')).toBe('aider');
    expect(identifyAgentCommand('py -3 aider.py')).toBe('aider');
  });

  it('unwraps nested wrappers', () => {
    expect(identifyAgentCommand('cmd /c npx -y claude')).toBe('claude');
  });

  it('gives up rather than looping on a pathological nest', () => {
    const deep = 'cmd /c '.repeat(40) + 'claude';
    expect(identifyAgentCommand(deep)).toBeNull();
  });
});

/**
 * The security-relevant half. An interpreter given an inline program can print,
 * open or name ANYTHING — `python -c "..." /tmp/codex` has an argument that
 * looks exactly like an agent path and is not one. Guessing here does not fail
 * loudly; it silently mislabels a pane, and every later layer trusts the label.
 */
describe('identifyAgentCommand — refusals', () => {
  it('refuses an inline program and does not scan its arguments', () => {
    expect(identifyAgentCommand('python -c "import time; time.sleep(99)" /tmp/codex')).toBeNull();
    expect(identifyAgentCommand('node -e "while(1){}" claude')).toBeNull();
    expect(identifyAgentCommand('node --eval "0" claude.js')).toBeNull();
    expect(identifyAgentCommand('py -c pass claude')).toBeNull();
  });

  it('refuses powershell -Command and -EncodedCommand', () => {
    expect(identifyAgentCommand('powershell -Command "claude"')).toBeNull();
    expect(identifyAgentCommand('powershell -enc YwBsAGEAdQBkAGUA')).toBeNull();
    expect(identifyAgentCommand('pwsh -EncodedCommand YwBsAGEAdQBkAGUA')).toBeNull();
  });

  it('refuses a wrapper with nothing after it', () => {
    expect(identifyAgentCommand('cmd /c')).toBeNull();
    expect(identifyAgentCommand('npx')).toBeNull();
    expect(identifyAgentCommand('node')).toBeNull();
  });

  /**
   * A pane running a shell is running a shell. Reporting the agent the user
   * happened to name in a redirect or a comment would attribute the whole pane
   * to it for as long as that shell lives.
   */
  it('does not scan past an unrecognised interpreter', () => {
    expect(identifyAgentCommand('bash -lc "claude"')).toBeNull();
    expect(identifyAgentCommand('sh -c claude')).toBeNull();
  });

  it('refuses an npx invocation that only names a package flag', () => {
    expect(identifyAgentCommand('npx -p @anthropic-ai/claude-code')).toBeNull();
  });
});

describe('AGENT_ALIASES', () => {
  it('has no duplicate alias across kinds — a name resolves to one agent', () => {
    const seen = new Map<string, string>();
    for (const [kind, names] of Object.entries(AGENT_ALIASES)) {
      for (const name of names) {
        expect(seen.has(name), `"${name}" claimed by both ${seen.get(name)} and ${kind}`).toBe(false);
        seen.set(name, kind);
      }
    }
  });

  it('lists every kind under its own name', () => {
    for (const [kind, names] of Object.entries(AGENT_ALIASES)) {
      expect(names, `${kind} must alias itself`).toContain(kind);
    }
  });

  it('uses lowercase, extension-free aliases — the matcher normalizes before lookup', () => {
    for (const names of Object.values(AGENT_ALIASES)) {
      for (const name of names) {
        expect(name).toBe(name.toLowerCase());
        expect(name).not.toMatch(/\.(exe|cmd|ps1|js|mjs|cjs|py)$/);
      }
    }
  });
});

/**
 * PowerShell resolves parameters by unambiguous prefix, so a fixed flag list
 * lets `-comm` and `-en` through — and everything after either is an arbitrary
 * expression, not a program name.
 */
describe('identifyAgentCommand — PowerShell prefix flags', () => {
  it('refuses every prefix of -Command', () => {
    for (const flag of ['-c', '-co', '-com', '-comm', '-comma', '-command']) {
      expect(identifyAgentCommand(`powershell ${flag} "claude"`), flag).toBeNull();
    }
  });

  it('refuses every prefix of -EncodedCommand, and the -ec alias', () => {
    for (const flag of ['-e', '-en', '-enc', '-ec', '-encodedcommand']) {
      expect(identifyAgentCommand(`powershell ${flag} YwBsAGEAdQBkAGUA`), flag).toBeNull();
    }
  });

  it('still accepts -File and its prefixes', () => {
    for (const flag of ['-f', '-fi', '-fil', '-file']) {
      expect(identifyAgentCommand(`pwsh ${flag} claude.ps1`), flag).toBe('claude');
    }
  });

  it('is not confused by the ordinary flags that precede them', () => {
    expect(identifyAgentCommand('powershell -NoProfile -NonInteractive -File codex.ps1')).toBe('codex');
    expect(identifyAgentCommand('powershell -ExecutionPolicy Bypass -File opencode.ps1')).toBe('opencode');
  });

  it('unwraps cmd /k as well as /c', () => {
    expect(identifyAgentCommand('cmd /k claude')).toBe('claude');
  });
});
