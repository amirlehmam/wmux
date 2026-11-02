// OSC 9 is overloaded. iTerm2 defines `OSC 9;<text>` as "show a notification",
// but ConEmu — followed by Windows Terminal, and by wmux's own cmd shell
// integration — uses `OSC 9;<n>;<args>` as a namespace of numeric subcommands
// (`9;4;<state>;<pct>` progress, `9;9;<cwd>` cwd report, and others).
//
// A payload whose first field is bare digits is therefore a ConEmu subcommand,
// not notification text. After handling cwd reports, wmux declines the other
// subcommands so they continue down xterm's handler chain.
export function isConEmuSubcommand(data: string): boolean {
  return /^\d+;/.test(data);
}

/** Encode CMD's literal path for the existing main-process OSC 7 security gate. */
export function osc9CwdToOsc7(data: string): string | null {
  if (!data.startsWith('9;') || data.length === 2) return null;
  try {
    return `file://localhost/${encodeURIComponent(data.slice(2))}`;
  } catch {
    return null;
  }
}
