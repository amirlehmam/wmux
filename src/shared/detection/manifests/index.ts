/**
 * The bundled manifest set.
 *
 * TypeScript modules rather than TOML, deliberately. The prior art ships TOML
 * because it fetches rule updates from a server at runtime and needs a format
 * it can parse; wmux does not do that (see the note on remote fetching in
 * docs and in user-manifests.ts) so the format buys nothing and costs a parser,
 * a schema validator and a class of "the file on disk disagrees with the type"
 * bugs. Authored as TS, `tsc` is the validator.
 *
 * Every manifest here was written from screens captured out of a live agent
 * pane running under ConPTY on Windows, and each is pinned by those captures in
 * tests/fixtures/detection/. That provenance is the point: agent UIs render
 * differently under ConPTY than they do elsewhere, and rules copied from
 * another project's observations would be both unverified here and someone
 * else's authored work.
 */
import { Manifest } from '../types';
import { claudeManifest } from './claude';
import { codexManifest } from './codex';
import { opencodeManifest } from './opencode';

export const BUNDLED_MANIFESTS: Manifest[] = [
  claudeManifest,
  codexManifest,
  opencodeManifest,
];

export { claudeManifest, codexManifest, opencodeManifest };
