---
name: wmux-release
description: How a wmux release is cut and shipped - the version bump and tag, the CI workflow (.github/workflows/release.yml) that tests, packages, optionally signs and publishes it, the release notes and the Scoop bucket. Use when releasing or bumping the version, writing release notes, when a release run fails, when editing bucket/wmux.json, release.yml or electron-builder.json, when adding anything that must ship outside the asar (resources/, a new src/cli/ module, a process.resourcesPath lookup), or when checking whether a fix is in a release.
---

# Releasing wmux

CI builds and publishes every release. Pushing a `v<version>` tag runs `.github/workflows/release.yml` on `windows-latest`, which publishes three assets to a GitHub release:

- `wmux-<version>-setup.exe`, the NSIS installer
- `wmux-<version>-win-x64.zip`, the portable zip
- `latest.yml`, which installed copies read to auto-update through the installer

Don't build or upload a release by hand. Only this workflow produces the installer that `latest.yml` points at.

The `gh` commands below pass `--repo amirlehmam/wmux`, because a checkout may have a fork remote beside `origin`.

## Cut a release

1. Start from an up-to-date `master` with everything that should ship merged. Every release leaves a bot commit there (the Scoop manifest), so pull first:

   ```bash
   git switch master && git pull --ff-only origin master
   ```

2. Run what the CI gates run, so the tag doesn't fail:

   ```bash
   npm test
   rm -rf dist && npm run build:main && npm run verify:resources
   npx vite build && WMUX_REQUIRE_BUILD=1 npx vitest run tests/unit/remote-ui-build.test.ts
   ```

   `verify:resources` fails when a checked-in copy under `resources/` has drifted from its source. Regenerate both copies and commit them before tagging. Don't rely on the copy commands it prints, which cover only two of the CLI files:

   ```bash
   cp -r src/shell-integration/* resources/shell-integration/
   cp dist/cli/*.js resources/cli/
   ```

   Build from a clean `dist/`: a `.js` left there by a deleted source would be copied into `resources/cli/`, and CI then fails it with "has no source".

3. Bump, commit, push, then tag the bump commit. The workflow names its files after the `package.json` version and never checks it against the tag, so a tag without the bump publishes the old version number.

   ```bash
   npm version <version> --no-git-tag-version
   git add package.json package-lock.json
   git commit -m "chore(release): bump to <version>"
   git push origin master
   git tag -a v<version> -m "wmux <version>"
   git push origin v<version>
   ```

4. Watch the run. A tag run reports the tag as its branch:

   ```bash
   gh run list --repo amirlehmam/wmux --workflow release.yml --branch v<version> --limit 1
   gh run watch <id> --repo amirlehmam/wmux --exit-status
   ```

## After it publishes

- **Write the release notes.** The workflow publishes GitHub's generated notes, which are only a compare link. Replace them with a written summary: `gh release edit v<version> --repo amirlehmam/wmux --notes-file <file>`. These notes are what the in-app changelog shows (`src/main/changelog.ts`).
- **Check the Scoop commit.** `chore(scoop): bucket manifest for <version>` should land on `master` from `github-actions[bot]`. Pull it before your next commit.
- **Compare asset sizes with the previous release:** `gh release view v<previous> --repo amirlehmam/wmux --json assets --jq '.assets[] | "\(.name) \(.size)"'`. A jump that no change explains means something new is being packaged.
- **winget is not updated.** `.github/workflows/winget.yml` triggers on a published release, but a release created with the workflow's `GITHUB_TOKEN` starts no other workflow, so it does not run for CI releases.

## What the workflow checks

In order. Each of these fails the run before anything is published:

| Step | Fails when |
|---|---|
| `npm test` | Any unit test fails, including the renderer typecheck (`tests/unit/renderer-typecheck.test.ts`) and `tests/unit/packaging.test.ts`, which is where a missing `extraResources` entry shows up. |
| `npm run build:main` | `tsc` fails for main, preload, shared or the CLI. |
| `npm run verify:resources` | A `resources/` copy differs from its source. |
| `npx vite build` | The renderer build fails. |
| Remote Console build output | `remote-manifest.json`, `remote/index.html` or `remote-console/runtime.js` is missing, or `remote-ui-build.test.ts` fails with `WMUX_REQUIRE_BUILD=1` (the phone page, its asset references and its manifest closure). The console fails silently at runtime without these (#254). |
| `electron-builder --win --publish never` | Packaging fails. |
| Remote Console files in the packaged asar | The same three files are missing from `release/win-unpacked/resources/app.asar`. |

SignPath signing runs only when its secrets are set. A rejected submission ships the release unsigned with a `SignPath submission failed` warning in the run log, which is how to tell whether a release is signed. A submission that is accepted and then denied, fails, or takes more than 10 minutes fails the run.

The comments in `release.yml` explain why each step is shaped the way it is; read them before changing one. Two rules there look removable and are not:

- `latest.yml` points at `setup.exe`, never the zip. electron-updater's NSIS updater can download a zip but cannot install it, so clients loop on "update ready" (#96).
- `latest.yml` is generated after signing, because SignPath rewrites the installer and an earlier hash would not match.

## When a release run fails

A run that fails before the "Create or update GitHub Release" step publishes nothing. Fix the problem on `master`, then either:

- **Move the tag to the fix commit,** as 2.38.0, 2.40.0 and 2.42.0 did. Only do this when nothing was published, because anyone who already fetched the tag keeps the old one:

  ```bash
  git tag -d v<version> && git push origin :refs/tags/v<version>
  git tag -a v<version> -m "wmux <version>" && git push origin v<version>
  ```

- **Or release the next patch version,** as 2.43.1 did for 2.43.0, and say in its notes that the previous version was tagged but never released.

Don't use `workflow_dispatch` to rebuild a release. The run checks out the branch it was dispatched on (`master` by default); the `tag` input only names the release it uploads into. Any dispatched run publishes, re-uploading the assets with new hashes and skipping the Scoop step, so `bucket/wmux.json` stops matching the zip.

The Scoop step is `continue-on-error`, so when it fails the run still ends green and the bucket stays behind. GitHub cannot re-run a single step, and re-running the job rebuilds and re-uploads everything. Update the bucket by hand from the published zip instead:

```bash
D=$(mktemp -d)
gh release download v<version> --repo amirlehmam/wmux --pattern '*-win-x64.zip' --dir "$D"
node scripts/update-scoop-manifest.mjs <version> "$D/wmux-<version>-win-x64.zip"
git add bucket/wmux.json
git commit -m "chore(scoop): bucket manifest for <version>"
git push origin master
```

## Packaging changes

`electron-builder.json` decides what ships: `files` for the asar, `asarUnpack` for node-pty's native prebuilds, and `extraResources` for everything that has to live outside the asar.

- A runtime resource that `src/main/` resolves through `process.resourcesPath` needs an `extraResources` entry. `packaging.test.ts` finds these only as a string literal right after `process.resourcesPath` (`path.join(process.resourcesPath, '<name>', …)`) in a top-level `src/main/*.ts` file. A computed path, or a lookup in a subdirectory, escapes the test; `codex-bin` and `codex-bin-ps` are already computed in `codex-launcher.ts`. Check those in a packaged build.
- The CLI ships file by file under `resources/cli/`, outside the asar. A new `src/cli/` module that a shipped CLI file imports needs its own entry, and so does an npm package the CLI imports (as `node_modules/ws` is). `packaging.test.ts` follows only `./` sibling imports, so keep CLI imports that way: a `../shared/…` import would ship a CLI that fails with `MODULE_NOT_FOUND`.
- `src/shell-integration/` ships whole through `extraResources`, so every file added there reaches users.
- To try a packaging change before tagging, build it locally. Never dispatch `release.yml` to test, since every run publishes. On a checkout path without spaces (node-gyp and electron-builder's winCodeSign both break on one), run `npm run build:main && npx vite build && npx electron-builder --win --dir --publish never`. Then inspect `release/win-unpacked/resources/` and `npx asar list release/win-unpacked/resources/app.asar`.

## Check that a fix shipped

Download the release and look inside the asar. Run this from the repo root, where `npx asar` resolves to the installed copy:

```bash
D=$(mktemp -d)
gh release download v<version> --repo amirlehmam/wmux --pattern '*-win-x64.zip' --dir "$D"
unzip -q "$D"/wmux-<version>-win-x64.zip -d "$D/unpacked"
npx asar extract "$D/unpacked/resources/app.asar" "$D/app"
grep -rl '<marker>' "$D/app/dist/main" "$D/app/dist/preload" "$D/app/dist/shared" "$D/app/dist/renderer/assets" || echo MISSING
grep -rl '<marker>' "$D/unpacked/resources/cli" || echo MISSING
ls "$D/unpacked/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/" "$D/unpacked/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/conpty/"
```

- `tsc` compiles main file by file, so a fix in `pty-manager.ts` is in `dist/main/pty-manager.js`, not `index.js`.
- Grep every renderer chunk, not only `index-*.js`. Code that both the desktop and the phone entries import (React, xterm, `src/shared/*`) lands in a shared chunk (#254).
- Files mapped by `extraResources`, such as `resources/cli/` and `resources/shell-integration/`, sit beside the asar in `$D/unpacked/resources/`, not inside it.
- The prebuilds folder should hold `conpty.node`, `conpty_console_list.node`, `pty.node` and a `conpty/` folder with `conpty.dll` and `OpenConsole.exe`. Without `conpty/`, every spawn falls back to the inbox ConPTY (see `pty-manager.ts`), which garbles fast TUI repaints.
