// OSC 9 is overloaded. iTerm2 defines `OSC 9;<text>` as "show a notification",
// but ConEmu — followed by Windows Terminal, and by wmux's own cmd shell
// integration — uses `OSC 9;<n>;<args>` as a namespace of numeric subcommands
// (`9;4;<state>;<pct>` progress, `9;9;<cwd>` cwd report, and others).
//
// A payload whose first field is bare digits is therefore a ConEmu subcommand,
// not notification text. wmux declines those so they continue down xterm's
// handler chain (see the OSC 9 handler in useTerminal.ts).
export function isConEmuSubcommand(data: string): boolean {
  return /^\d+;/.test(data);
}
