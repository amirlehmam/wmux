/**
 * The `sh` text a direct-route remote command carries. The ssh argv's last word is
 * `sh -c 'eval "$(echo <base64>|base64 -d)"'` (`loginShellNeutralCommand`), which a test that wants
 * to look at the script (`meta=$(find`, the quoting of a value) has to decode first.
 */
export function remoteCommandText(args: readonly string[]): string {
  const command = args[args.length - 1];
  const encoded = /^sh -c 'eval "\$\(echo ([A-Za-z0-9+/=]*)\|base64 -d\)"'$/.exec(command)?.[1];
  return encoded === undefined ? command : Buffer.from(encoded, 'base64').toString('utf8');
}
